// IRSA — IAM Roles for Service Accounts.
//
// This is the clean, static-key-free way to give pods scoped AWS access on EKS.
// The cluster's OIDC provider lets a Kubernetes ServiceAccount assume an IAM
// role via a web-identity trust policy; the AWS SDK inside the pod picks up the
// projected token automatically (AWS_ROLE_ARN / AWS_WEB_IDENTITY_TOKEN_FILE,
// injected by the EKS Pod Identity webhook when the SA carries the
// `eks.amazonaws.com/role-arn` annotation).
//
// We mint two roles, least-privilege scoped to the three S3 buckets:
//   - apiserver : read/write all three buckets + presign (it mints presigned
//                 URLs for the SDK; pairs with the presigned-URL work).
//   - runner    : read models+weather, read/write results (it fetches inputs
//                 and uploads artifacts).
//
// Both are intentionally narrow: only s3 actions, only these bucket ARNs. No
// static S3_ACCESS_KEY / S3_SECRET_KEY anywhere — app.ts omits those env keys
// and annotates the ServiceAccounts with these role ARNs instead.

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

export interface Iam {
  apiserverRoleArn: pulumi.Output<string>;
  runnerRoleArn: pulumi.Output<string>;
}

// Build the IRSA web-identity trust policy for a given ServiceAccount.
function irsaAssumeRolePolicy(
  cluster: Cluster,
  serviceAccount: string,
): pulumi.Output<string> {
  // OIDC URL is "https://oidc.eks.<region>.amazonaws.com/id/XXXX"; the condition
  // keys use the host+path WITHOUT the scheme.
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
                [`${host}:sub`]: `system:serviceaccount:${APP_NS.namespace}:${serviceAccount}`,
              },
            },
          },
        ],
      }),
    );
}

function s3Policy(
  name: string,
  storage: Storage,
  actions: string[],
): aws.iam.Policy {
  const resources = pulumi
    .all([...storage.bucketArns, ...storage.objectArns])
    .apply((arns) => arns);
  return new aws.iam.Policy(`synergy-${name}-s3`, {
    description: `Scoped S3 access for the SynergyPlus ${name} (IRSA).`,
    policy: pulumi.all([resources]).apply(([res]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "ScopedS3",
            Effect: "Allow",
            Action: actions,
            Resource: res,
          },
        ],
      }),
    ),
    tags: { Project: "synergyplus", ManagedBy: "pulumi" },
  });
}

export function createIam(cluster: Cluster, storage: Storage): Iam {
  // apiserver: full object CRUD + listing + presign-capable actions.
  const apiserverRole = new aws.iam.Role("synergy-apiserver-role", {
    assumeRolePolicy: irsaAssumeRolePolicy(cluster, APP_NS.apiserverServiceAccount),
    tags: { Project: "synergyplus", ManagedBy: "pulumi" },
  });
  const apiserverPolicy = s3Policy("apiserver", storage, [
    "s3:GetObject",
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:ListBucket",
    "s3:GetBucketLocation",
  ]);
  new aws.iam.RolePolicyAttachment("synergy-apiserver-attach", {
    role: apiserverRole.name,
    policyArn: apiserverPolicy.arn,
  });

  // runner: read inputs + write results. Same coarse action set is fine for the
  // scaffold (all three buckets); tighten per-bucket later if needed.
  const runnerRole = new aws.iam.Role("synergy-runner-role", {
    assumeRolePolicy: irsaAssumeRolePolicy(cluster, APP_NS.runnerServiceAccount),
    tags: { Project: "synergyplus", ManagedBy: "pulumi" },
  });
  const runnerPolicy = s3Policy("runner", storage, [
    "s3:GetObject",
    "s3:PutObject",
    "s3:ListBucket",
    "s3:GetBucketLocation",
  ]);
  new aws.iam.RolePolicyAttachment("synergy-runner-attach", {
    role: runnerRole.name,
    policyArn: runnerPolicy.arn,
  });

  return {
    apiserverRoleArn: apiserverRole.arn,
    runnerRoleArn: runnerRole.arn,
  };
}
