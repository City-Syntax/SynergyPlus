// SynergyPlus AWS infrastructure — Pulumi entrypoint.
//
// Composition root: load config, then build each layer in dependency order and
// export the handful of outputs an operator needs to finish bring-up.
//
//   network  -> VPC, public/private subnets, NAT (AWS primitives)
//   storage  -> S3 buckets (models/weather/results) + lifecycle  (the one
//               allowed AWS application managed service)
//   cluster  -> EKS control plane + managed node group + EBS CSI + OIDC
//   iam      -> IRSA roles (keyless, scoped S3) for apiserver + runner SAs
//   app      -> [optional, gated by deployApp] in-cluster bring-up via the
//               Pulumi kubernetes provider: namespace, gp3 SC, GHCR pull
//               secret, synergyplus-env Secret, in-cluster Postgres, IRSA SAs,
//               KEDA + ingress-nginx
//
// See infra/pulumi/README.md for the architecture, the managed-vs-self-managed
// decision table, honest trade-offs, and the deploy runbook.

import * as pulumi from "@pulumi/pulumi";
import { loadConfig, images } from "./src/config";
import { createNetwork } from "./src/network";
import { createStorage } from "./src/storage";
import { createCluster } from "./src/cluster";
import { createIam, APP_NS } from "./src/iam";
import { deployApp } from "./src/app";

const c = loadConfig();

const net = createNetwork(c);
const storage = createStorage(c);
const cluster = createCluster(c, net);
const iam = createIam(cluster, storage);

// In-cluster software only when explicitly enabled (see Pulumi.dev.yaml).
const app = c.deployApp ? deployApp(c, cluster, storage, iam) : undefined;

// ---- Stack outputs ---------------------------------------------------------
export const region = c.region;
export const vpcId = net.vpc.id;

// EKS
export const kubeconfig = pulumi.secret(cluster.kubeconfig);
export const clusterName = cluster.eksCluster.eksCluster.apply((cl) => cl.name);
export const oidcProviderArn = cluster.oidcProviderArn;

// S3
export const bucketModels = storage.names.models;
export const bucketWeather = storage.names.weather;
export const bucketResults = storage.names.results;

// IRSA role ARNs (annotate the app ServiceAccounts with these).
export const apiserverRoleArn = iam.apiserverRoleArn;
export const runnerRoleArn = iam.runnerRoleArn;
export const appNamespace = APP_NS.namespace;

// GHCR image refs that the manifests should use.
export const imageRefs = images(c);

// App bring-up status.
export const appDeployed = c.deployApp;
export const ingressRelease = app?.ingressReleaseName;
