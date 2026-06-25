// In-cluster bring-up of SynergyPlus on the EKS cluster.
//
// Gated by config `deployApp`: when false this module is a no-op, so a first
// `pulumi up` provisions ONLY AWS infra (VPC / EKS / node group / S3 / IRSA).
// Flip `deployApp=true` once the cluster is reachable to install the in-cluster
// software through the Pulumi kubernetes provider (which uses the EKS
// kubeconfig the cluster exported — no manual fetch needed).
//
// What this lays down (groundwork — see README for what is complete vs stubbed):
//   1. namespace `synergy-system`
//   2. a gp3 StorageClass (EBS CSI) for the Postgres PV
//   3. the GHCR imagePullSecret (private-repo pulls)
//   4. the `synergyplus-env` Secret — DATABASE_URL -> in-cluster Postgres,
//      S3 bucket NAMES + region, SP_ALLOWED_ENGINE_VERSIONS. NO static S3 keys:
//      pods reach S3 via IRSA (the SA annotations below).
//   5. an in-cluster Postgres StatefulSet (gp3 PVC) + Service
//   6. the two IRSA-annotated ServiceAccounts (apiserver, runner)
//   7. KEDA (Helm) + ingress-nginx (Helm)
//
// The operator / apiserver / portal Deployments and the RunnerPool CRD live in
// the repo's config/ + deploy/k8s-local/ manifests. Rather than re-author them
// here, the README documents `kubectl apply -k config/` against the exported
// kubeconfig. The ServiceAccounts + Secret + Postgres this module creates are
// exactly what those manifests expect (CONTRACT §6), so they drop straight in.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SynergyConfig } from "./config";
import { Cluster } from "./cluster";
import { Storage } from "./storage";
import { Iam } from "./iam";
import { APP_NS } from "./iam";

export interface AppOutputs {
  // Helm release name of the ingress controller. Fetch the provisioned NLB
  // hostname with:
  //   kubectl -n ingress-nginx get svc ingress-nginx-controller \
  //     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
  ingressReleaseName: pulumi.Output<string>;
}

export function deployApp(
  c: SynergyConfig,
  cluster: Cluster,
  storage: Storage,
  iam: Iam,
): AppOutputs {
  const provider = cluster.k8sProvider;
  const opts = { provider };

  // 1. Namespace --------------------------------------------------------------
  const ns = new k8s.core.v1.Namespace(
    "synergy-system",
    { metadata: { name: APP_NS.namespace } },
    opts,
  );
  const nsOpts = { provider, dependsOn: [ns] };

  // 2. gp3 StorageClass via the EBS CSI driver -------------------------------
  const gp3 = new k8s.storage.v1.StorageClass(
    "synergy-gp3",
    {
      metadata: { name: "synergy-gp3" },
      provisioner: "ebs.csi.aws.com",
      volumeBindingMode: "WaitForFirstConsumer",
      allowVolumeExpansion: true,
      parameters: { type: "gp3", encrypted: "true" },
    },
    opts,
  );

  // 3. GHCR image pull secret (only when a token is configured) ---------------
  const pullSecretName = "ghcr-pull";
  if (c.ghcrToken && c.ghcrUsername) {
    const dockerConfig = pulumi
      .all([c.ghcrUsername, c.ghcrToken])
      .apply(([user, token]) => {
        const auth = Buffer.from(`${user}:${token}`).toString("base64");
        return JSON.stringify({
          auths: { "ghcr.io": { username: user, password: token, auth } },
        });
      });
    new k8s.core.v1.Secret(
      "ghcr-pull",
      {
        metadata: { name: pullSecretName, namespace: APP_NS.namespace },
        type: "kubernetes.io/dockerconfigjson",
        stringData: { ".dockerconfigjson": dockerConfig },
      },
      nsOpts,
    );
  }

  // 4. synergyplus-env Secret (CONTRACT §6) -----------------------------------
  // DATABASE_URL -> in-cluster Postgres service; S3 bucket NAMES + region.
  // Deliberately NO S3_ACCESS_KEY / S3_SECRET_KEY / S3_ENDPOINT: on AWS the SDK
  // talks to real S3 via IRSA, so static keys are absent and the endpoint is the
  // default AWS endpoint for the region.
  const databaseUrl = pulumi
    .all([c.pgUser, c.pgPassword, c.pgDatabase])
    .apply(
      ([user, pass, db]) =>
        `postgres://${user}:${pass}@postgres.${APP_NS.namespace}.svc.cluster.local:5432/${db}?sslmode=disable`,
    );

  new k8s.core.v1.Secret(
    "synergyplus-env",
    {
      metadata: { name: "synergyplus-env", namespace: APP_NS.namespace },
      type: "Opaque",
      stringData: {
        DATABASE_URL: databaseUrl,
        S3_REGION: c.region,
        S3_BUCKET_MODELS: storage.names.models,
        S3_BUCKET_WEATHER: storage.names.weather,
        S3_BUCKET_RESULTS: storage.names.results,
        SP_LEASE_SECONDS: "90",
        SP_HEARTBEAT_SECONDS: "30",
        SP_ALLOWED_ENGINE_VERSIONS: c.allowedEngineVersions,
      },
    },
    nsOpts,
  );

  // 5. In-cluster Postgres: StatefulSet on a gp3 PVC + headless Service --------
  const pgLabels = { app: "postgres" };
  new k8s.core.v1.Service(
    "postgres",
    {
      metadata: { name: "postgres", namespace: APP_NS.namespace },
      spec: { selector: pgLabels, ports: [{ port: 5432, targetPort: 5432 }] },
    },
    nsOpts,
  );
  new k8s.apps.v1.StatefulSet(
    "postgres",
    {
      metadata: { name: "postgres", namespace: APP_NS.namespace },
      spec: {
        serviceName: "postgres",
        replicas: 1,
        selector: { matchLabels: pgLabels },
        template: {
          metadata: { labels: pgLabels },
          spec: {
            containers: [
              {
                name: "postgres",
                image: "postgres:16-alpine",
                env: [
                  { name: "POSTGRES_USER", value: c.pgUser },
                  {
                    name: "POSTGRES_PASSWORD",
                    valueFrom: {
                      secretKeyRef: { name: "postgres-credentials", key: "password" },
                    },
                  },
                  { name: "POSTGRES_DB", value: c.pgDatabase },
                  { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
                ],
                ports: [{ containerPort: 5432 }],
                volumeMounts: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
                readinessProbe: {
                  exec: { command: ["pg_isready", "-U", c.pgUser, "-d", c.pgDatabase] },
                  initialDelaySeconds: 5,
                  periodSeconds: 3,
                },
              },
            ],
          },
        },
        volumeClaimTemplates: [
          {
            metadata: { name: "data" },
            spec: {
              accessModes: ["ReadWriteOnce"],
              storageClassName: gp3.metadata.name,
              resources: { requests: { storage: `${c.postgresVolumeSizeGb}Gi` } },
            },
          },
        ],
      },
    },
    nsOpts,
  );
  // Postgres password lives in its own Secret so it isn't duplicated in env.
  new k8s.core.v1.Secret(
    "postgres-credentials",
    {
      metadata: { name: "postgres-credentials", namespace: APP_NS.namespace },
      type: "Opaque",
      stringData: { password: c.pgPassword },
    },
    nsOpts,
  );

  // 6. IRSA-annotated ServiceAccounts -----------------------------------------
  // The annotation is what makes IRSA work: the EKS admission webhook injects
  // AWS_ROLE_ARN + the projected token into pods using these SAs.
  new k8s.core.v1.ServiceAccount(
    "synergyplus-apiserver",
    {
      metadata: {
        name: APP_NS.apiserverServiceAccount,
        namespace: APP_NS.namespace,
        annotations: { "eks.amazonaws.com/role-arn": iam.apiserverRoleArn },
      },
    },
    nsOpts,
  );
  new k8s.core.v1.ServiceAccount(
    "synergyplus-runner",
    {
      metadata: {
        name: APP_NS.runnerServiceAccount,
        namespace: APP_NS.namespace,
        annotations: { "eks.amazonaws.com/role-arn": iam.runnerRoleArn },
      },
    },
    nsOpts,
  );

  // 7. KEDA + ingress-nginx via Helm ------------------------------------------
  // KEDA scales the RunnerPool Deployments on Postgres queue depth (CONTRACT
  // §2.2 / config/keda). ingress-nginx provisions an internet-facing NLB and
  // fronts the apiserver + portal. (ALB alternative documented in the README.)
  new k8s.helm.v3.Release(
    "keda",
    {
      chart: "keda",
      version: "2.15.1",
      namespace: "keda",
      createNamespace: true,
      repositoryOpts: { repo: "https://kedacore.github.io/charts" },
    },
    opts,
  );

  const ingress = new k8s.helm.v3.Release(
    "ingress-nginx",
    {
      chart: "ingress-nginx",
      version: "4.11.2",
      namespace: "ingress-nginx",
      createNamespace: true,
      repositoryOpts: { repo: "https://kubernetes.github.io/ingress-nginx" },
      values: {
        controller: {
          service: {
            // Provision an NLB (network LB) rather than a classic ELB.
            annotations: {
              "service.beta.kubernetes.io/aws-load-balancer-type": "nlb",
            },
          },
        },
      },
    },
    opts,
  );

  return { ingressReleaseName: ingress.name };
}
