// VPC and networking primitives for the EKS cluster.
//
// AWS *primitives* (VPC, subnets, IGW, NAT, route tables) — the same in both the
// self-managed and cloud-native variants. Two differences from infra/pulumi
// here, both for the HA the all-managed stack assumes:
//   - one NAT gateway PER AZ (no single-NAT SPOF), and
//   - the private subnets are also tagged for Aurora's DB subnet group.
//
// EKS needs subnets across at least two AZs. Layout:
//   - 2 public subnets  : internet-facing ALBs the AWS Load Balancer Controller
//                         provisions, plus the NAT gateways.
//   - 2 private subnets : worker nodes (Karpenter + the bootstrap node group)
//                         AND the Aurora cluster instances. Egress to ECR /
//                         AWS APIs via the per-AZ NAT gateways.
//
// Subnets carry the EKS discovery tags so the in-cluster controllers find them:
//   kubernetes.io/role/elb            = 1   (public,  internet-facing ALBs)
//   kubernetes.io/role/internal-elb   = 1   (private, internal ALBs/nodes)

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { SynergyConfig } from "./config";

export interface Network {
  vpc: aws.ec2.Vpc;
  publicSubnetIds: pulumi.Output<string>[];
  privateSubnetIds: pulumi.Output<string>[];
}

const TAGS = { Project: "synergyplus", ManagedBy: "pulumi", Variant: "cloud-native" };

export function createNetwork(_c: SynergyConfig): Network {
  const vpc = new aws.ec2.Vpc("synergy-vpc", {
    cidrBlock: "10.42.0.0/16",
    enableDnsHostnames: true,
    enableDnsSupport: true,
    tags: { ...TAGS, Name: "synergy-vpc" },
  });

  const igw = new aws.ec2.InternetGateway("synergy-igw", {
    vpcId: vpc.id,
    tags: { ...TAGS, Name: "synergy-igw" },
  });

  // Two AZs (EKS requires >= 2; Aurora Multi-AZ wants >= 2 as well).
  const azs = aws.getAvailabilityZonesOutput({ state: "available" });

  const publicSubnets: aws.ec2.Subnet[] = [];
  const privateSubnets: aws.ec2.Subnet[] = [];

  // Public route table -> IGW (shared by both public subnets).
  const publicRt = new aws.ec2.RouteTable("synergy-public-rt", {
    vpcId: vpc.id,
    routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: igw.id }],
    tags: { ...TAGS, Name: "synergy-public-rt" },
  });

  for (let i = 0; i < 2; i++) {
    const az = azs.names.apply((n) => n[i]);

    const pub = new aws.ec2.Subnet(`synergy-public-${i}`, {
      vpcId: vpc.id,
      cidrBlock: `10.42.${i * 2 + 1}.0/24`,
      availabilityZone: az,
      mapPublicIpOnLaunch: true,
      tags: {
        ...TAGS,
        Name: `synergy-public-${i}`,
        Tier: "public",
        // EKS discovery: this subnet hosts internet-facing load balancers.
        "kubernetes.io/role/elb": "1",
      },
    });
    new aws.ec2.RouteTableAssociation(`synergy-public-rta-${i}`, {
      subnetId: pub.id,
      routeTableId: publicRt.id,
    });
    publicSubnets.push(pub);

    const priv = new aws.ec2.Subnet(`synergy-private-${i}`, {
      vpcId: vpc.id,
      cidrBlock: `10.42.${i * 2 + 2}.0/24`,
      availabilityZone: az,
      mapPublicIpOnLaunch: false,
      tags: {
        ...TAGS,
        Name: `synergy-private-${i}`,
        Tier: "private",
        // EKS discovery: internal LBs + worker nodes.
        "kubernetes.io/role/internal-elb": "1",
        // Karpenter subnet discovery.
        "karpenter.sh/discovery": "synergy",
        // Aurora DB subnet group (informational).
        "synergyplus.io/role": "db-and-nodes",
      },
    });
    privateSubnets.push(priv);

    // One NAT gateway per AZ (HA egress — the cloud-native stack avoids the
    // single-NAT SPOF the self-managed scaffold accepts for cost).
    const natEip = new aws.ec2.Eip(`synergy-nat-eip-${i}`, {
      domain: "vpc",
      tags: { ...TAGS, Name: `synergy-nat-eip-${i}` },
    });
    const nat = new aws.ec2.NatGateway(`synergy-nat-${i}`, {
      allocationId: natEip.id,
      subnetId: pub.id,
      tags: { ...TAGS, Name: `synergy-nat-${i}` },
    });
    const privateRt = new aws.ec2.RouteTable(`synergy-private-rt-${i}`, {
      vpcId: vpc.id,
      routes: [{ cidrBlock: "0.0.0.0/0", natGatewayId: nat.id }],
      tags: { ...TAGS, Name: `synergy-private-rt-${i}` },
    });
    new aws.ec2.RouteTableAssociation(`synergy-private-rta-${i}`, {
      subnetId: priv.id,
      routeTableId: privateRt.id,
    });
  }

  return {
    vpc,
    publicSubnetIds: publicSubnets.map((s) => s.id),
    privateSubnetIds: privateSubnets.map((s) => s.id),
  };
}
