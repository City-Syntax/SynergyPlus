// Amazon EKS cluster — managed control plane + a bootstrap managed node group,
// with Karpenter doing the real node autoscaling for RunnerPools.
//
// Cloud-native differences from infra/pulumi/src/cluster.ts:
//   - a dedicated KMS key provides ENVELOPE ENCRYPTION of EKS Secrets (etcd),
//   - the managed node group is a small, fixed BOOTSTRAP pool (system pods +
//     Karpenter itself); workload nodes are provisioned by Karpenter
//     (ingress.ts/app.ts install the Karpenter controller + NodePools),
//   - no EBS CSI dependency for Postgres (Aurora replaces in-cluster PG), though
//     the EBS CSI addon is still installed for any incidental PVCs.
//   - AWS Fargate profiles are noted as an alternative compute backend in the
//     README; this stack uses EC2 nodes (Karpenter) because EnergyPlus runners
//     are long-lived, CPU-bound, and benefit from spot + bin-packing.
//
// `@pulumi/eks` wires the cluster IAM role, the node IAM role, the OIDC
// provider, the aws-auth mapping, and exports a kubeconfig + a `k8s.Provider`.

import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SynergyConfig } from "./config";
import { Network } from "./network";

export interface Cluster {
  eksCluster: eks.Cluster;
  clusterName: pulumi.Output<string>;
  // OIDC provider ARN + URL — the basis for IRSA trust policies (iam.ts).
  oidcProviderArn: pulumi.Output<string>;
  oidcProviderUrl: pulumi.Output<string>;
  // ARN of the bootstrap node group's IAM role — Karpenter reuses it for the
  // nodes it launches (an aws-auth entry + an instance profile in app.ts).
  nodeRoleArn: pulumi.Output<string>;
  // KMS key encrypting EKS Secrets at rest (etcd envelope encryption).
  secretsKmsKeyArn: pulumi.Output<string>;
  // kubeconfig for `kubectl` / CI.
  kubeconfig: pulumi.Output<any>;
  // Provider bound to the cluster — every in-cluster module deploys through it.
  k8sProvider: k8s.Provider;
}

const TAGS = { Project: "synergyplus", ManagedBy: "pulumi", Variant: "cloud-native" };

export function createCluster(c: SynergyConfig, net: Network): Cluster {
  // KMS key for EKS Secrets envelope encryption (etcd). One of three app-data
  // KMS keys in this stack (the others: S3 in storage.ts, Aurora in database.ts).
  const secretsKmsKey = new aws.kms.Key("synergy-eks-secrets-kms", {
    description: "Envelope encryption for SynergyPlus EKS Secrets (etcd).",
    deletionWindowInDays: 7,
    enableKeyRotation: true,
    tags: { ...TAGS, Name: "synergy-eks-secrets-kms" },
  });
  new aws.kms.Alias("synergy-eks-secrets-kms-alias", {
    name: "alias/synergyplus-eks-secrets",
    targetKeyId: secretsKmsKey.keyId,
  });

  // IAM role assumed by the managed node group's worker nodes (and reused by
  // Karpenter for the nodes it provisions).
  const nodeRole = new aws.iam.Role("synergy-node-role", {
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "ec2.amazonaws.com" },
        },
      ],
    }),
    tags: TAGS,
  });

  // Standard managed-node-group policies. ECR read-only matters here: nodes
  // pull the SynergyPlus images from ECR via this node role (no imagePullSecret).
  // SSM is included so Karpenter/managed nodes are reachable for debugging.
  for (const [name, arn] of [
    ["worker", "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"],
    ["cni", "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"],
    ["ecr", "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"],
    ["ssm", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"],
  ] as const) {
    new aws.iam.RolePolicyAttachment(`synergy-node-${name}`, {
      role: nodeRole.name,
      policyArn: arn,
    });
  }

  // The EKS cluster. @pulumi/eks creates the control-plane role + OIDC provider,
  // places nodes on private subnets, restricts the public API to the admin CIDR,
  // and enables KMS Secrets encryption.
  const eksCluster = new eks.Cluster("synergy", {
    version: c.k8sVersion,
    vpcId: net.vpc.id,
    publicSubnetIds: net.publicSubnetIds,
    privateSubnetIds: net.privateSubnetIds,
    nodeAssociatePublicIpAddress: false,
    endpointPublicAccess: true,
    endpointPrivateAccess: true,
    publicAccessCidrs: [c.adminCidr],

    // We manage the bootstrap node group explicitly (below).
    skipDefaultNodeGroup: true,
    instanceRoles: [nodeRole],

    // IRSA basis.
    createOidcProvider: true,

    // Envelope-encrypt Kubernetes Secrets in etcd with our KMS key.
    encryptionConfigKeyArn: secretsKmsKey.arn,

    tags: TAGS,
  });

  // Bootstrap managed node group: small + fixed. Runs CoreDNS, the AWS LB
  // Controller, ExternalDNS, External Secrets, KEDA, the ADOT collector, and
  // the Karpenter controller. Karpenter then provisions the runner nodes.
  new eks.ManagedNodeGroup("synergy-bootstrap-ng", {
    cluster: eksCluster,
    nodeRole: nodeRole,
    subnetIds: net.privateSubnetIds,
    instanceTypes: [c.nodeInstanceType],
    diskSize: c.nodeVolumeSizeGb,
    scalingConfig: {
      desiredSize: c.nodeDesiredCount,
      minSize: c.nodeMinCount,
      maxSize: c.nodeMaxCount,
    },
    labels: { "synergyplus.io/pool": "bootstrap" },
    tags: { ...TAGS, "karpenter.sh/discovery": "synergy" },
  });

  const clusterName = eksCluster.eksCluster.apply((cl) => cl.name);

  // EBS CSI driver as a managed EKS addon — for any incidental PVCs (Aurora
  // means Postgres no longer needs a PV, but observability sidecars etc. might).
  new aws.eks.Addon("synergy-ebs-csi", {
    clusterName: clusterName,
    addonName: "aws-ebs-csi-driver",
    resolveConflictsOnCreate: "OVERWRITE",
    tags: TAGS,
  });

  // Standalone k8s.Provider from the exported kubeconfig.
  const k8sProvider = new k8s.Provider("synergy-k8s", {
    kubeconfig: eksCluster.kubeconfigJson,
  });

  return {
    eksCluster,
    clusterName,
    oidcProviderArn: eksCluster.oidcProviderArn,
    oidcProviderUrl: eksCluster.oidcProviderUrl,
    nodeRoleArn: nodeRole.arn,
    secretsKmsKeyArn: secretsKmsKey.arn,
    kubeconfig: eksCluster.kubeconfig,
    k8sProvider,
  };
}
