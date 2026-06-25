// Amazon EKS cluster — managed control plane + a managed node group.
//
// Why EKS (was k3s-on-EC2): the user opted into EKS, removing the
// EC2/user-data/k3s bootstrap. We still avoid the OTHER managed services
// (Postgres stays in-cluster, registry stays GHCR, ingress stays nginx, secrets
// stay k8s Secrets). EKS buys us:
//   - a managed, HA control plane (no etcd to babysit),
//   - an OIDC provider for IRSA (keyless, scoped S3 access for pods),
//   - the EBS CSI driver for gp3-backed PVs (in-cluster Postgres data).
//
// `@pulumi/eks` is the ergonomic wrapper: it wires the cluster IAM role, the
// node IAM role, the OIDC provider, the aws-auth mapping, and exports a ready
// kubeconfig + a `k8s.Provider` we hand to app.ts.

import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SynergyConfig } from "./config";
import { Network } from "./network";

export interface Cluster {
  eksCluster: eks.Cluster;
  // OIDC provider ARN + URL — the basis for IRSA trust policies (iam.ts).
  oidcProviderArn: pulumi.Output<string>;
  oidcProviderUrl: pulumi.Output<string>;
  // kubeconfig for `kubectl` / CI.
  kubeconfig: pulumi.Output<any>;
  // Provider bound to the cluster — app.ts deploys through this.
  k8sProvider: k8s.Provider;
}

export function createCluster(c: SynergyConfig, net: Network): Cluster {
  // IAM role assumed by the managed node group's worker nodes.
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
    tags: { Project: "synergyplus", ManagedBy: "pulumi" },
  });

  // Standard managed-node-group policies (no application S3 access here — pods
  // get S3 via IRSA, not the node role).
  for (const [name, arn] of [
    ["worker", "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"],
    ["cni", "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"],
    ["ecr", "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"],
    // EBS CSI driver runs as a managed addon using IRSA, but giving the node
    // role SSM read-only is handy for debugging; omitted to stay least-priv.
  ] as const) {
    new aws.iam.RolePolicyAttachment(`synergy-node-${name}`, {
      role: nodeRole.name,
      policyArn: arn,
    });
  }

  // The EKS cluster. We let @pulumi/eks create the control-plane role and OIDC
  // provider, place nodes in the private subnets, and expose the public API
  // endpoint restricted to the admin CIDR.
  const eksCluster = new eks.Cluster("synergy", {
    version: c.k8sVersion,
    vpcId: net.vpc.id,
    publicSubnetIds: net.publicSubnetIds,
    privateSubnetIds: net.privateSubnetIds,
    // Nodes go on private subnets; LBs land on the public ones.
    nodeAssociatePublicIpAddress: false,
    endpointPublicAccess: true,
    endpointPrivateAccess: true,
    publicAccessCidrs: [c.adminCidr],

    // We manage the node group explicitly (below) for clarity.
    skipDefaultNodeGroup: true,
    instanceRoles: [nodeRole],

    // Install the EBS CSI driver via the managed addon so gp3 PVs work for the
    // in-cluster Postgres StatefulSet.
    // (Addon wired below after the cluster exists.)
    createOidcProvider: true,
    tags: { Project: "synergyplus", ManagedBy: "pulumi" },
  });

  // Managed node group (simplest path; self-managed nodes are an option).
  new eks.ManagedNodeGroup("synergy-ng", {
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
    labels: { "synergyplus.io/pool": "workers" },
    tags: { Project: "synergyplus", ManagedBy: "pulumi" },
  });

  // The AWS eks.Cluster name (eksCluster.eksCluster is Output<aws.eks.Cluster>).
  const clusterName = eksCluster.eksCluster.apply((cl) => cl.name);

  // EBS CSI driver as a managed EKS addon (gp3 StorageClass for Postgres PVs).
  new aws.eks.Addon("synergy-ebs-csi", {
    clusterName: clusterName,
    addonName: "aws-ebs-csi-driver",
    resolveConflictsOnCreate: "OVERWRITE",
    tags: { Project: "synergyplus", ManagedBy: "pulumi" },
  });

  // In @pulumi/eks v3 the in-cluster provider lives on core.provider; build a
  // standalone k8s.Provider from the exported kubeconfig so app.ts can deploy
  // through it (and so it is usable outside the CoreData Output).
  const k8sProvider = new k8s.Provider("synergy-k8s", {
    kubeconfig: eksCluster.kubeconfigJson,
  });

  return {
    eksCluster,
    oidcProviderArn: eksCluster.oidcProviderArn,
    oidcProviderUrl: eksCluster.oidcProviderUrl,
    kubeconfig: eksCluster.kubeconfig,
    k8sProvider,
  };
}
