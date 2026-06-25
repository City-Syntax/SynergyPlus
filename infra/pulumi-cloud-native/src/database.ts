// Amazon Aurora PostgreSQL (Serverless v2) — REPLACES the in-cluster Postgres.
//
// This is the headline cloud-native swap. The self-managed variant runs a
// single Postgres pod on a gp3 PV (you own backups/HA/patching). Here AWS owns
// all of that:
//   - Aurora Serverless v2 writer + reader, Multi-AZ → automatic failover,
//   - automated backups + point-in-time-restore (configurable retention),
//   - storage auto-scales, capacity (ACUs) auto-scales between min/max,
//   - KMS encryption at rest, TLS in transit,
//   - minor-version patching handled by AWS.
//
// The app data model assumes ONE logical Postgres (queue + index + cache + auth,
// ADR-0010); Aurora satisfies that with a single writer endpoint. The app's
// DATABASE_URL points at the WRITER endpoint (secrets.ts builds the URL and
// publishes it to Secrets Manager; External Secrets syncs it into the cluster).
//
// Credentials: a strong random password is generated and stored in AWS Secrets
// Manager (no plaintext in Pulumi state config). The writer endpoint + creds
// flow to the app exclusively via Secrets Manager + the External Secrets
// Operator — the cluster never holds a static DB password in a hand-written
// k8s Secret.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { SynergyConfig } from "./config";
import { Network } from "./network";
import { Cluster } from "./cluster";

export interface Database {
  cluster: aws.rds.Cluster;
  writerEndpoint: pulumi.Output<string>;
  readerEndpoint: pulumi.Output<string>;
  port: pulumi.Output<number>;
  dbName: string;
  user: string;
  password: pulumi.Output<string>; // secret
  kmsKeyArn: pulumi.Output<string>;
  securityGroupId: pulumi.Output<string>;
}

const TAGS = { Project: "synergyplus", ManagedBy: "pulumi", Variant: "cloud-native" };

export function createDatabase(c: SynergyConfig, net: Network, cluster: Cluster): Database {
  // KMS key for Aurora encryption at rest.
  const kms = new aws.kms.Key("synergy-aurora-kms", {
    description: "Encryption at rest for the SynergyPlus Aurora cluster.",
    deletionWindowInDays: 7,
    enableKeyRotation: true,
    tags: { ...TAGS, Name: "synergy-aurora-kms" },
  });
  new aws.kms.Alias("synergy-aurora-kms-alias", {
    name: "alias/synergyplus-aurora",
    targetKeyId: kms.keyId,
  });

  // Strong random master password (secret; never the dev default of the
  // self-managed stack). Lives only in Secrets Manager + Pulumi secret state.
  const password = new random.RandomPassword("synergy-aurora-password", {
    length: 32,
    special: true,
    // RDS forbids a handful of characters in master passwords.
    overrideSpecial: "!#$%^&*()-_=+[]{}",
  });

  // DB subnet group across the private subnets (Multi-AZ placement).
  const subnetGroup = new aws.rds.SubnetGroup("synergy-aurora-subnets", {
    subnetIds: net.privateSubnetIds,
    tags: { ...TAGS, Name: "synergy-aurora-subnets" },
  });

  // Security group: Postgres (5432) reachable only from inside the VPC (the
  // EKS pods). No public access. Tightening to the node/pod SG is a later step.
  const sg = new aws.ec2.SecurityGroup("synergy-aurora-sg", {
    vpcId: net.vpc.id,
    description: "Aurora PostgreSQL — ingress 5432 from within the VPC only.",
    ingress: [
      {
        protocol: "tcp",
        fromPort: 5432,
        toPort: 5432,
        cidrBlocks: ["10.42.0.0/16"], // VPC CIDR (see network.ts)
        description: "Postgres from EKS pods/nodes in-VPC",
      },
    ],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    tags: { ...TAGS, Name: "synergy-aurora-sg" },
  });

  // The Aurora PostgreSQL cluster (provisioned engine mode, Serverless v2
  // capacity via the ServerlessV2ScalingConfiguration).
  const rdsCluster = new aws.rds.Cluster("synergy-aurora", {
    engine: "aurora-postgresql",
    engineMode: "provisioned", // Serverless v2 runs under provisioned mode
    engineVersion: "16.4",
    databaseName: c.pgDatabase,
    masterUsername: c.pgUser,
    masterPassword: password.result,
    dbSubnetGroupName: subnetGroup.name,
    vpcSecurityGroupIds: [sg.id],
    storageEncrypted: true,
    kmsKeyId: kms.arn,
    backupRetentionPeriod: c.auroraBackupRetentionDays, // automated backups + PITR window
    preferredBackupWindow: "03:00-04:00",
    copyTagsToSnapshot: true,
    deletionProtection: false, // scaffold convenience; enable in production
    skipFinalSnapshot: true, // scaffold convenience; set a final snapshot id in production
    serverlessv2ScalingConfiguration: {
      minCapacity: c.auroraMinAcu,
      maxCapacity: c.auroraMaxAcu,
    },
    tags: { ...TAGS, Name: "synergy-aurora" },
  });

  // Writer instance + optional reader(s). Multi-AZ failover = >=2 instances in
  // different AZs; Aurora promotes a reader automatically on writer failure.
  new aws.rds.ClusterInstance("synergy-aurora-writer", {
    clusterIdentifier: rdsCluster.id,
    instanceClass: "db.serverless", // Serverless v2
    engine: "aurora-postgresql",
    engineVersion: rdsCluster.engineVersion,
    publiclyAccessible: false,
    performanceInsightsEnabled: true,
    tags: { ...TAGS, Name: "synergy-aurora-writer", Role: "writer" },
  });
  for (let i = 0; i < c.auroraReplicas; i++) {
    new aws.rds.ClusterInstance(`synergy-aurora-reader-${i}`, {
      clusterIdentifier: rdsCluster.id,
      instanceClass: "db.serverless",
      engine: "aurora-postgresql",
      engineVersion: rdsCluster.engineVersion,
      publiclyAccessible: false,
      performanceInsightsEnabled: true,
      tags: { ...TAGS, Name: `synergy-aurora-reader-${i}`, Role: "reader" },
    });
  }

  return {
    cluster: rdsCluster,
    writerEndpoint: rdsCluster.endpoint,
    readerEndpoint: rdsCluster.readerEndpoint,
    port: rdsCluster.port,
    dbName: c.pgDatabase,
    user: c.pgUser,
    password: password.result,
    kmsKeyArn: kms.arn,
    securityGroupId: sg.id,
  };
}
