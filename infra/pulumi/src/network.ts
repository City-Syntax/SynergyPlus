// VPC and networking primitives for the EKS cluster.
//
// AWS *primitives* only (VPC, subnets, IGW, NAT, route tables) — infrastructure,
// not application managed services, so in scope under the "self-managed except
// S3" stance.
//
// EKS needs subnets across at least two AZs. Layout:
//   - 2 public subnets  : for the internet-facing load balancers that the
//                         ingress controller provisions (an NLB by default).
//   - 2 private subnets : where the managed node group's worker nodes run
//                         (egress to ghcr.io / S3 via a NAT gateway).
//
// Subnets carry the EKS discovery tags so the in-cluster controllers
// (LB controller / ALB) can find them:
//   kubernetes.io/role/elb            = 1   (public,  internet-facing LBs)
//   kubernetes.io/role/internal-elb   = 1   (private, internal LBs)

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { SynergyConfig } from "./config";

export interface Network {
  vpc: aws.ec2.Vpc;
  publicSubnetIds: pulumi.Output<string>[];
  privateSubnetIds: pulumi.Output<string>[];
}

const TAGS = { Project: "synergyplus", ManagedBy: "pulumi" };

export function createNetwork(c: SynergyConfig): Network {
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

  // Two AZs (EKS requires >= 2).
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
        // EKS discovery: this subnet hosts internal load balancers + nodes.
        "kubernetes.io/role/internal-elb": "1",
      },
    });
    privateSubnets.push(priv);
  }

  // One NAT gateway (in the first public subnet) for private-subnet egress.
  // A single NAT keeps the scaffold cheap; production HA wants one NAT per AZ.
  const natEip = new aws.ec2.Eip("synergy-nat-eip", {
    domain: "vpc",
    tags: { ...TAGS, Name: "synergy-nat-eip" },
  });
  const nat = new aws.ec2.NatGateway("synergy-nat", {
    allocationId: natEip.id,
    subnetId: publicSubnets[0].id,
    tags: { ...TAGS, Name: "synergy-nat" },
  });
  const privateRt = new aws.ec2.RouteTable("synergy-private-rt", {
    vpcId: vpc.id,
    routes: [{ cidrBlock: "0.0.0.0/0", natGatewayId: nat.id }],
    tags: { ...TAGS, Name: "synergy-private-rt" },
  });
  privateSubnets.forEach((s, i) => {
    new aws.ec2.RouteTableAssociation(`synergy-private-rta-${i}`, {
      subnetId: s.id,
      routeTableId: privateRt.id,
    });
  });

  return {
    vpc,
    publicSubnetIds: publicSubnets.map((s) => s.id),
    privateSubnetIds: privateSubnets.map((s) => s.id),
  };
}
