// Centralised, typed view of the Pulumi stack configuration.
//
// All knobs live in Pulumi.<stack>.yaml (see Pulumi.dev.yaml) and are read once
// here so the component modules consume a plain typed object instead of poking
// at `pulumi.Config` everywhere.

import * as pulumi from "@pulumi/pulumi";

const cfg = new pulumi.Config(); // namespace defaults to the project name
const awsCfg = new pulumi.Config("aws");

export interface SynergyConfig {
  region: string;

  // EKS cluster sizing
  k8sVersion: string;
  nodeInstanceType: string;
  nodeDesiredCount: number;
  nodeMinCount: number;
  nodeMaxCount: number;
  nodeVolumeSizeGb: number;
  postgresVolumeSizeGb: number;

  // access
  adminCidr: string;

  // GHCR images
  imageTag: string;
  ghcrOwner: string;
  ghcrUsername: string;
  ghcrToken: pulumi.Output<string> | undefined; // secret; undefined => public pulls

  // app
  domain: string;
  allowedEngineVersions: string;
  pgUser: string;
  pgDatabase: string;
  pgPassword: pulumi.Output<string>;

  // bring-up toggle
  deployApp: boolean;
}

function image(owner: string, name: string, tag: string): string {
  return `ghcr.io/${owner}/synergyplus-${name}:${tag}`;
}

export function loadConfig(): SynergyConfig {
  const ghcrOwner = cfg.get("ghcrOwner") ?? "city-syntax";
  const imageTag = cfg.get("imageTag") ?? "latest";

  // ghcrToken / pgPassword are secrets: getSecret returns undefined if unset.
  const ghcrToken = cfg.getSecret("ghcrToken");

  return {
    region: awsCfg.get("region") ?? "us-east-1",

    k8sVersion: cfg.get("k8sVersion") ?? "1.30",
    nodeInstanceType: cfg.get("nodeInstanceType") ?? "t3.xlarge",
    nodeDesiredCount: cfg.getNumber("nodeDesiredCount") ?? 2,
    nodeMinCount: cfg.getNumber("nodeMinCount") ?? 1,
    nodeMaxCount: cfg.getNumber("nodeMaxCount") ?? 6,
    nodeVolumeSizeGb: cfg.getNumber("nodeVolumeSizeGb") ?? 80,
    postgresVolumeSizeGb: cfg.getNumber("postgresVolumeSizeGb") ?? 50,

    adminCidr: cfg.get("adminCidr") ?? "0.0.0.0/0",

    imageTag,
    ghcrOwner,
    ghcrUsername: cfg.get("ghcrUsername") ?? "",
    ghcrToken,

    domain: cfg.get("domain") ?? "synergyplus.example.com",
    allowedEngineVersions: cfg.get("allowedEngineVersions") ?? "24.1.0",
    pgUser: cfg.get("pgUser") ?? "synergy",
    pgDatabase: cfg.get("pgDatabase") ?? "synergy",
    // Default password is a dev convenience; override with a Pulumi secret.
    pgPassword: cfg.getSecret("pgPassword") ?? pulumi.secret("synergy"),

    deployApp: cfg.getBoolean("deployApp") ?? false,
  };
}

// Image refs derived from config, in one place.
export function images(c: SynergyConfig) {
  return {
    apiserver: image(c.ghcrOwner, "apiserver", c.imageTag),
    operator: image(c.ghcrOwner, "operator", c.imageTag),
    runner: image(c.ghcrOwner, "runner", c.imageTag),
    portal: image(c.ghcrOwner, "portal", c.imageTag),
    seed: image(c.ghcrOwner, "seed", c.imageTag),
  };
}
