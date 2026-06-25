// Centralised, typed view of the Pulumi stack configuration.
//
// All knobs live in Pulumi.<stack>.yaml (see Pulumi.dev.yaml) and are read once
// here so the component modules consume a plain typed object instead of poking
// at `pulumi.Config` everywhere.
//
// This is the CLOUD-NATIVE (all-managed) mirror of infra/pulumi/src/config.ts.
// Differences from the self-managed config: no GHCR fields (images come from
// ECR repos this stack creates), no in-cluster Postgres password (Aurora
// generates + stores creds in Secrets Manager), plus Aurora / DNS / SES /
// Karpenter knobs.

import * as pulumi from "@pulumi/pulumi";

const cfg = new pulumi.Config(); // namespace defaults to the project name
const awsCfg = new pulumi.Config("aws");

export interface SynergyConfig {
  region: string;

  // EKS cluster sizing (bootstrap managed node group; Karpenter scales the rest)
  k8sVersion: string;
  nodeInstanceType: string;
  nodeDesiredCount: number;
  nodeMinCount: number;
  nodeMaxCount: number;
  nodeVolumeSizeGb: number;
  karpenterCapacityTypes: string; // comma-sep: "spot,on-demand"

  // access
  adminCidr: string;

  // Aurora PostgreSQL Serverless v2
  pgUser: string;
  pgDatabase: string;
  auroraMinAcu: number;
  auroraMaxAcu: number;
  auroraReplicas: number;
  auroraBackupRetentionDays: number;

  // images (ECR)
  imageTag: string;

  // DNS / TLS / email
  domain: string;
  route53ZoneName: string;
  sesFromAddress: string;

  // app
  allowedEngineVersions: string;

  // bring-up toggle
  deployApp: boolean;
}

export function loadConfig(): SynergyConfig {
  return {
    region: awsCfg.get("region") ?? "us-east-1",

    k8sVersion: cfg.get("k8sVersion") ?? "1.30",
    nodeInstanceType: cfg.get("nodeInstanceType") ?? "t3.large",
    nodeDesiredCount: cfg.getNumber("nodeDesiredCount") ?? 2,
    nodeMinCount: cfg.getNumber("nodeMinCount") ?? 2,
    nodeMaxCount: cfg.getNumber("nodeMaxCount") ?? 4,
    nodeVolumeSizeGb: cfg.getNumber("nodeVolumeSizeGb") ?? 80,
    karpenterCapacityTypes: cfg.get("karpenterCapacityTypes") ?? "spot,on-demand",

    adminCidr: cfg.get("adminCidr") ?? "0.0.0.0/0",

    pgUser: cfg.get("pgUser") ?? "synergy",
    pgDatabase: cfg.get("pgDatabase") ?? "synergy",
    auroraMinAcu: cfg.getNumber("auroraMinAcu") ?? 0.5,
    auroraMaxAcu: cfg.getNumber("auroraMaxAcu") ?? 8,
    auroraReplicas: cfg.getNumber("auroraReplicas") ?? 1,
    auroraBackupRetentionDays: cfg.getNumber("auroraBackupRetentionDays") ?? 7,

    imageTag: cfg.get("imageTag") ?? "latest",

    domain: cfg.get("domain") ?? "synergyplus.example.com",
    route53ZoneName: cfg.get("route53ZoneName") ?? "example.com",
    sesFromAddress: cfg.get("sesFromAddress") ?? "noreply@example.com",

    allowedEngineVersions: cfg.get("allowedEngineVersions") ?? "24.1.0",

    deployApp: cfg.getBoolean("deployApp") ?? false,
  };
}

// The five application images. In the cloud-native stack these resolve to ECR
// repos (registry.ts builds them); the refs are derived from the registry's
// account/region URL at runtime, so this list is just the logical component +
// tag pairs the app wiring needs.
export const IMAGE_COMPONENTS = ["apiserver", "operator", "runner", "portal", "seed"] as const;
export type ImageComponent = (typeof IMAGE_COMPONENTS)[number];

// Build a fully-qualified ECR image ref from a repo URL + tag, e.g.
//   <acct>.dkr.ecr.<region>.amazonaws.com/synergyplus-apiserver:latest
export function ecrImage(repoUrl: pulumi.Input<string>, tag: string): pulumi.Output<string> {
  return pulumi.interpolate`${repoUrl}:${tag}`;
}
