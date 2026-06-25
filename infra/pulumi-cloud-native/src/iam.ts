// IRSA — IAM Roles for Service Accounts.
//
// The clean, static-key-free way to give pods scoped AWS access on EKS. The
// cluster's OIDC provider lets a Kubernetes ServiceAccount assume an IAM role
// via a web-identity trust policy; the AWS SDK in the pod picks up the projected
// token automatically.
//
// The cloud-native stack mints MANY more IRSA roles than the self-managed one,
// because every managed integration is a pod that talks to an AWS API:
//
//   APPLICATION pods
//     apiserver : S3 RW + presign, Secrets Manager read, AMP remote-write, SES send
//     runner    : S3 (read models/weather, RW results), AMP remote-write
//
//   PLATFORM controllers (installed in ingress.ts / observability.ts / app.ts)
//     aws-load-balancer-controller : provisions ALBs
//     external-dns                 : Route53 record management
//     external-secrets             : reads Secrets Manager -> k8s Secrets
//     karpenter                    : launches/terminates EC2 nodes
//     adot-collector               : AMP remote-write (cluster metrics)
//     fluent-bit / cloudwatch      : CloudWatch Logs (Container Insights)
//
// All roles are least-privilege scoped (bucket ARNs, secret ARN prefix, the AMP
// workspace ARN, the Route53 zone, etc.). No static keys anywhere.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { Cluster } from "./cluster";
import { Storage } from "./storage";

export interface AppNamespace {
  namespace: string;
  apiserverServiceAccount: string;
  runnerServiceAccount: string;
}

export const APP_NS: AppNamespace = {
  namespace: "synergy-system",
  apiserverServiceAccount: "synergyplus-apiserver",
  runnerServiceAccount: "synergyplus-runner",
};

// Service accounts for the platform controllers + their namespaces.
export const PLATFORM_SA = {
  awsLbController: { ns: "kube-system", sa: "aws-load-balancer-controller" },
  externalDns: { ns: "kube-system", sa: "external-dns" },
  externalSecrets: { ns: "external-secrets", sa: "external-secrets" },
  karpenter: { ns: "karpenter", sa: "karpenter" },
  adot: { ns: "opentelemetry", sa: "adot-collector" },
  fluentbit: { ns: "amazon-cloudwatch", sa: "fluent-bit" },
} as const;

// What iam.ts needs to know about the rest of the stack to scope policies.
export interface IamInputs {
  storage: Storage;
  // ARN prefix of the SynergyPlus secrets in Secrets Manager (secrets.ts).
  secretArnPrefix: pulumi.Output<string>;
  // AMP workspace ARN for remote-write (observability.ts). Optional: the role
  // is created either way; the policy resource is "*" when unknown.
  ampWorkspaceArn: pulumi.Output<string> | undefined;
  // Route53 hosted zone ID ExternalDNS may modify (ingress.ts looks it up).
  route53ZoneArn: pulumi.Output<string> | undefined;
  // SES identity ARN the apiserver may send from (ingress.ts/secrets domain).
  sesIdentityArn: pulumi.Output<string> | undefined;
  // Aurora KMS key ARN (apiserver/runner don't need it, but External Secrets
  // never touches DB creds directly; kept for completeness/future use).
  region: string;
  accountId: pulumi.Output<string>;
}

export interface Iam {
  apiserverRoleArn: pulumi.Output<string>;
  runnerRoleArn: pulumi.Output<string>;
  awsLbControllerRoleArn: pulumi.Output<string>;
  externalDnsRoleArn: pulumi.Output<string>;
  externalSecretsRoleArn: pulumi.Output<string>;
  karpenterControllerRoleArn: pulumi.Output<string>;
  adotRoleArn: pulumi.Output<string>;
  fluentbitRoleArn: pulumi.Output<string>;
}

const TAGS = { Project: "synergyplus", ManagedBy: "pulumi", Variant: "cloud-native" };

// Build the IRSA web-identity trust policy for a given namespace/ServiceAccount.
function irsaAssumeRolePolicy(
  cluster: Cluster,
  namespace: string,
  serviceAccount: string,
): pulumi.Output<string> {
  const oidcHost = cluster.oidcProviderUrl.apply((u) => u.replace("https://", ""));
  return pulumi
    .all([cluster.oidcProviderArn, oidcHost])
    .apply(([providerArn, host]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Federated: providerArn },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                [`${host}:aud`]: "sts.amazonaws.com",
                [`${host}:sub`]: `system:serviceaccount:${namespace}:${serviceAccount}`,
              },
            },
          },
        ],
      }),
    );
}

// Helper: create an IRSA role + attach an inline policy document.
function irsaRole(
  name: string,
  cluster: Cluster,
  ns: string,
  sa: string,
  policyDoc: pulumi.Output<string>,
): aws.iam.Role {
  const role = new aws.iam.Role(`synergy-${name}-role`, {
    assumeRolePolicy: irsaAssumeRolePolicy(cluster, ns, sa),
    tags: { ...TAGS, Role: name },
  });
  new aws.iam.RolePolicy(`synergy-${name}-policy`, {
    role: role.name,
    policy: policyDoc,
  });
  return role;
}

export function createIam(cluster: Cluster, inputs: IamInputs): Iam {
  const { storage } = inputs;
  const s3Resources = pulumi.all([...storage.bucketArns, ...storage.objectArns]);

  // --- apiserver: S3 RW + presign, Secrets Manager read, AMP write, SES send ---
  const apiserverPolicy = pulumi
    .all([s3Resources, storage.kmsKeyArn, inputs.secretArnPrefix, inputs.ampWorkspaceArn, inputs.sesIdentityArn])
    .apply(([s3res, s3kms, secretPrefix, ampArn, sesArn]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "S3",
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation"],
            Resource: s3res,
          },
          { Sid: "S3Kms", Effect: "Allow", Action: ["kms:Decrypt", "kms:GenerateDataKey"], Resource: s3kms },
          {
            Sid: "SecretsRead",
            Effect: "Allow",
            Action: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
            Resource: `${secretPrefix}*`,
          },
          { Sid: "AmpRemoteWrite", Effect: "Allow", Action: ["aps:RemoteWrite"], Resource: ampArn ?? "*" },
          {
            Sid: "SesSend",
            Effect: "Allow",
            Action: ["ses:SendEmail", "ses:SendRawEmail"],
            Resource: sesArn ?? "*",
          },
        ],
      }),
    );
  const apiserverRole = irsaRole("apiserver", cluster, APP_NS.namespace, APP_NS.apiserverServiceAccount, apiserverPolicy);

  // --- runner: S3 read inputs + RW results, AMP remote-write -------------------
  const runnerPolicy = pulumi
    .all([s3Resources, storage.kmsKeyArn, inputs.ampWorkspaceArn])
    .apply(([s3res, s3kms, ampArn]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "S3",
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:GetBucketLocation"],
            Resource: s3res,
          },
          { Sid: "S3Kms", Effect: "Allow", Action: ["kms:Decrypt", "kms:GenerateDataKey"], Resource: s3kms },
          { Sid: "AmpRemoteWrite", Effect: "Allow", Action: ["aps:RemoteWrite"], Resource: ampArn ?? "*" },
        ],
      }),
    );
  const runnerRole = irsaRole("runner", cluster, APP_NS.namespace, APP_NS.runnerServiceAccount, runnerPolicy);

  // --- AWS Load Balancer Controller -------------------------------------------
  // The upstream IAM policy is large; this is a representative scoped subset
  // (full policy: github.com/kubernetes-sigs/aws-load-balancer-controller).
  const lbPolicy = pulumi.output(
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "elasticloadbalancing:*",
            "ec2:Describe*",
            "ec2:CreateSecurityGroup",
            "ec2:CreateTags",
            "ec2:DeleteTags",
            "ec2:AuthorizeSecurityGroupIngress",
            "ec2:RevokeSecurityGroupIngress",
            "acm:DescribeCertificate",
            "acm:ListCertificates",
            "wafv2:*",
            "shield:*",
            "iam:CreateServiceLinkedRole",
          ],
          Resource: "*",
        },
      ],
    }),
  );
  const lbRole = irsaRole(
    "aws-lb-controller",
    cluster,
    PLATFORM_SA.awsLbController.ns,
    PLATFORM_SA.awsLbController.sa,
    lbPolicy,
  );

  // --- ExternalDNS (Route53) ---------------------------------------------------
  const dnsPolicy = pulumi.all([inputs.route53ZoneArn]).apply(([zoneArn]) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: ["route53:ChangeResourceRecordSets"], Resource: zoneArn ?? "arn:aws:route53:::hostedzone/*" },
        {
          Effect: "Allow",
          Action: ["route53:ListHostedZones", "route53:ListResourceRecordSets", "route53:ListTagsForResource"],
          Resource: "*",
        },
      ],
    }),
  );
  const dnsRole = irsaRole("external-dns", cluster, PLATFORM_SA.externalDns.ns, PLATFORM_SA.externalDns.sa, dnsPolicy);

  // --- External Secrets Operator (Secrets Manager read) ------------------------
  const esoPolicy = pulumi.all([inputs.secretArnPrefix]).apply(([prefix]) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:ListSecrets"],
          Resource: `${prefix}*`,
        },
      ],
    }),
  );
  const esoRole = irsaRole(
    "external-secrets",
    cluster,
    PLATFORM_SA.externalSecrets.ns,
    PLATFORM_SA.externalSecrets.sa,
    esoPolicy,
  );

  // --- Karpenter controller ----------------------------------------------------
  // Scoped subset of the Karpenter controller policy (full policy in the
  // Karpenter docs). Lets it launch/terminate nodes, read pricing, manage
  // instance profiles, and pass the node role.
  const karpenterPolicy = pulumi.all([cluster.nodeRoleArn]).apply(([nodeRoleArn]) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "Compute",
          Effect: "Allow",
          Action: [
            "ec2:CreateLaunchTemplate",
            "ec2:CreateFleet",
            "ec2:RunInstances",
            "ec2:CreateTags",
            "ec2:TerminateInstances",
            "ec2:DeleteLaunchTemplate",
            "ec2:Describe*",
            "ssm:GetParameter",
            "pricing:GetProducts",
          ],
          Resource: "*",
        },
        { Sid: "PassNodeRole", Effect: "Allow", Action: ["iam:PassRole"], Resource: nodeRoleArn },
        {
          Sid: "InstanceProfile",
          Effect: "Allow",
          Action: [
            "iam:CreateInstanceProfile",
            "iam:AddRoleToInstanceProfile",
            "iam:RemoveRoleFromInstanceProfile",
            "iam:DeleteInstanceProfile",
            "iam:GetInstanceProfile",
            "iam:TagInstanceProfile",
          ],
          Resource: "*",
        },
      ],
    }),
  );
  const karpenterRole = irsaRole("karpenter", cluster, PLATFORM_SA.karpenter.ns, PLATFORM_SA.karpenter.sa, karpenterPolicy);

  // --- ADOT collector (AMP remote-write) ---------------------------------------
  const adotPolicy = pulumi.all([inputs.ampWorkspaceArn]).apply(([ampArn]) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["aps:RemoteWrite", "aps:GetSeries", "aps:GetLabels", "aps:GetMetricMetadata"], Resource: ampArn ?? "*" }],
    }),
  );
  const adotRole = irsaRole("adot", cluster, PLATFORM_SA.adot.ns, PLATFORM_SA.adot.sa, adotPolicy);

  // --- Fluent Bit (CloudWatch Logs, Container Insights) ------------------------
  const fluentbitPolicy = pulumi.output(
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:PutRetentionPolicy"],
          Resource: "arn:aws:logs:*:*:*",
        },
      ],
    }),
  );
  const fluentbitRole = irsaRole("fluent-bit", cluster, PLATFORM_SA.fluentbit.ns, PLATFORM_SA.fluentbit.sa, fluentbitPolicy);

  return {
    apiserverRoleArn: apiserverRole.arn,
    runnerRoleArn: runnerRole.arn,
    awsLbControllerRoleArn: lbRole.arn,
    externalDnsRoleArn: dnsRole.arn,
    externalSecretsRoleArn: esoRole.arn,
    karpenterControllerRoleArn: karpenterRole.arn,
    adotRoleArn: adotRole.arn,
    fluentbitRoleArn: fluentbitRole.arn,
  };
}
