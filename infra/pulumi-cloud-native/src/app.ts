// In-cluster wiring of SynergyPlus on the EKS cluster — the all-managed mirror
// of infra/pulumi/src/app.ts.
//
// Gated by config `deployApp`: when false this is a no-op, so a first
// `pulumi up` provisions ONLY AWS infra. Flip `deployApp=true` to install the
// in-cluster wiring through the Pulumi kubernetes provider.
//
// KEY DIFFERENCES from the self-managed app.ts:
//   - NO in-cluster Postgres StatefulSet / gp3 PVC / postgres Secret. The app's
//     DATABASE_URL points at the AURORA WRITER endpoint, delivered via External
//     Secrets (below). This is the headline cloud-native swap.
//   - NO GHCR imagePullSecret. Images come from ECR; nodes pull via the node
//     role. The operator stamps the runner SA + ECR runner image onto pods.
//   - `synergyplus-env` is NOT authored by Pulumi as a plaintext Secret. It is
//     SYNCED from AWS Secrets Manager by the External Secrets Operator: a
//     ClusterSecretStore (IRSA-backed) + an ExternalSecret that assembles the
//     env Secret from `synergyplus/app-env`, `synergyplus/db`, and
//     `synergyplus/better-auth`.
//   - Ingress is an ALB (ingressClassName: alb) with ACM TLS + ExternalDNS,
//     NOT ingress-nginx.
//   - A Karpenter NodePool + EC2NodeClass provide node autoscaling for runners.
//
// The operator / apiserver / portal Deployments + the RunnerPool CRD still live
// in the repo's config/ and are applied by `kubectl` (README runbook). The
// ServiceAccounts + `synergyplus-env` Secret this module produces are exactly
// what those manifests consume (CONTRACT §6), so they drop straight in.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SynergyConfig } from "./config";
import { Cluster } from "./cluster";
import { Iam, APP_NS, PLATFORM_SA } from "./iam";
import { Secrets } from "./secrets";
import { Registry } from "./registry";
import { IngressFoundation } from "./ingress";

export interface AppOutputs {
  ingressName: pulumi.Output<string>;
}

export function deployApp(
  c: SynergyConfig,
  cluster: Cluster,
  iam: Iam,
  secrets: Secrets,
  registry: Registry,
  ingressFoundation: IngressFoundation,
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

  // 2. IRSA-annotated ServiceAccounts (apiserver, runner) ---------------------
  // The annotation makes IRSA work: the EKS webhook injects AWS_ROLE_ARN + the
  // projected token into pods using these SAs. The apiserver SA also carries
  // SES + Secrets Manager + S3 + AMP perms; the runner SA carries S3 + AMP.
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

  // 3. External Secrets: ClusterSecretStore + ExternalSecret ------------------
  // The store authenticates to Secrets Manager via the External Secrets IRSA
  // role (its controller SA). The ExternalSecret assembles `synergyplus-env`
  // from three Secrets Manager secrets. NB: these are ESO CRDs (installed by
  // the external-secrets Helm release in ingress.ts) — we declare them as
  // untyped CustomResources so this module type-checks without the CRD schema.
  const secretStore = new k8s.apiextensions.CustomResource(
    "synergy-secretstore",
    {
      apiVersion: "external-secrets.io/v1beta1",
      kind: "ClusterSecretStore",
      metadata: { name: "synergy-aws-sm" },
      spec: {
        provider: {
          aws: {
            service: "SecretsManager",
            region: c.region,
            // Uses the external-secrets controller SA's IRSA role.
            auth: {
              jwt: {
                serviceAccountRef: {
                  name: PLATFORM_SA.externalSecrets.sa,
                  namespace: PLATFORM_SA.externalSecrets.ns,
                },
              },
            },
          },
        },
      },
    },
    nsOpts,
  );

  // ExternalSecret -> the `synergyplus-env` k8s Secret the manifests expect
  // (CONTRACT §6). DATABASE_URL comes from synergyplus/db (Aurora writer); the
  // rest from synergyplus/app-env; BETTER_AUTH_SECRET from synergyplus/better-auth.
  new k8s.apiextensions.CustomResource(
    "synergy-externalsecret-env",
    {
      apiVersion: "external-secrets.io/v1beta1",
      kind: "ExternalSecret",
      metadata: { name: "synergyplus-env", namespace: APP_NS.namespace },
      spec: {
        refreshInterval: "1h",
        secretStoreRef: { name: "synergy-aws-sm", kind: "ClusterSecretStore" },
        target: { name: "synergyplus-env", creationPolicy: "Owner" },
        data: [
          {
            secretKey: "DATABASE_URL",
            remoteRef: { key: secrets.dbSecretName, property: "DATABASE_URL" },
          },
          {
            secretKey: "BETTER_AUTH_SECRET",
            remoteRef: { key: secrets.betterAuthSecretName, property: "BETTER_AUTH_SECRET" },
          },
        ],
        // dataFrom pulls the whole app-env JSON (S3 bucket names, region, engine
        // allow-list, SES) so every key lands in the Secret without enumerating.
        dataFrom: [{ extract: { key: secrets.appEnvSecretName } }],
      },
    },
    { provider, dependsOn: [ns, secretStore] },
  );

  // 4. KEDA via Helm ----------------------------------------------------------
  // KEDA stays — there is no managed equivalent, and it is core to the app's
  // design (scale each RunnerPool 0->ceiling on eligible Postgres queue depth,
  // ADR-0005 / config/keda). The KEDA postgres trigger reads DATABASE_URL from
  // the `synergyplus-env` Secret (now Aurora). The HPA + CloudWatch-adapter
  // alternative is noted in the README.
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

  // 5. Karpenter NodePool + EC2NodeClass --------------------------------------
  // Karpenter (controller installed in ingress.ts) provisions nodes for
  // unschedulable runner pods. The NodePool allows spot + on-demand across a
  // broad instance family; the EC2NodeClass points at the cluster's discovery
  // tag for subnets + security groups, and uses the bootstrap node role.
  const ec2NodeClass = new k8s.apiextensions.CustomResource(
    "synergy-karpenter-nodeclass",
    {
      apiVersion: "karpenter.k8s.aws/v1",
      kind: "EC2NodeClass",
      metadata: { name: "synergy-default" },
      spec: {
        amiFamily: "AL2023",
        role: cluster.nodeRoleArn.apply((arn) => arn.split("/").pop() ?? "synergy-node-role"),
        subnetSelectorTerms: [{ tags: { "karpenter.sh/discovery": "synergy" } }],
        securityGroupSelectorTerms: [{ tags: { "karpenter.sh/discovery": "synergy" } }],
      },
    },
    opts,
  );
  new k8s.apiextensions.CustomResource(
    "synergy-karpenter-nodepool",
    {
      apiVersion: "karpenter.sh/v1",
      kind: "NodePool",
      metadata: { name: "synergy-runners" },
      spec: {
        template: {
          spec: {
            nodeClassRef: { group: "karpenter.k8s.aws", kind: "EC2NodeClass", name: "synergy-default" },
            requirements: [
              {
                key: "karpenter.sh/capacity-type",
                operator: "In",
                values: c.karpenterCapacityTypes.split(",").map((s) => s.trim()),
              },
              { key: "kubernetes.io/arch", operator: "In", values: ["amd64", "arm64"] },
            ],
          },
        },
        // Consolidate to drain underutilised nodes (scale-to-zero-friendly).
        disruption: { consolidationPolicy: "WhenEmptyOrUnderutilized", consolidateAfter: "30s" },
        limits: { cpu: "1000" },
      },
    },
    { provider, dependsOn: [ec2NodeClass] },
  );

  // 6. Ingress (ALB) ----------------------------------------------------------
  // An Ingress the AWS LB Controller turns into an internet-facing ALB:
  // HTTPS via the ACM cert, ExternalDNS publishes `domain`. Routes /api -> the
  // apiserver Service (:8090) and / -> the portal Service (:3000). Those
  // Services are created by the repo's config/ manifests (README runbook); this
  // Ingress references them by name.
  const ingress = new k8s.networking.v1.Ingress(
    "synergyplus",
    {
      metadata: {
        name: "synergyplus",
        namespace: APP_NS.namespace,
        annotations: {
          "kubernetes.io/ingress.class": "alb",
          "alb.ingress.kubernetes.io/scheme": "internet-facing",
          "alb.ingress.kubernetes.io/target-type": "ip",
          "alb.ingress.kubernetes.io/listen-ports": '[{"HTTP":80},{"HTTPS":443}]',
          "alb.ingress.kubernetes.io/ssl-redirect": "443",
          "alb.ingress.kubernetes.io/certificate-arn": ingressFoundation.certificateArn,
          "external-dns.alpha.kubernetes.io/hostname": c.domain,
        },
      },
      spec: {
        ingressClassName: "alb",
        rules: [
          {
            host: c.domain,
            http: {
              paths: [
                {
                  path: "/api",
                  pathType: "Prefix",
                  backend: { service: { name: "apiserver", port: { number: 8090 } } },
                },
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: { service: { name: "portal", port: { number: 3000 } } },
                },
              ],
            },
          },
        ],
      },
    },
    nsOpts,
  );

  return { ingressName: ingress.metadata.name };
}
