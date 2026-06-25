// SynergyPlus AWS infrastructure — Pulumi entrypoint (CLOUD-NATIVE variant).
//
// Composition root: load config, then build each layer in dependency order and
// export the outputs an operator needs to finish bring-up. This is the
// all-managed mirror of infra/pulumi/index.ts.
//
//   network        -> VPC, public/private subnets, per-AZ NAT (primitives)
//   storage        -> S3 (models/weather/results) + SSE-KMS + lifecycle
//   registry       -> ECR repos (apiserver/operator/runner/portal/seed)
//   cluster        -> EKS control plane + bootstrap node group + KMS Secrets
//                     encryption + OIDC (IRSA basis); Karpenter scales nodes
//   database       -> Aurora PostgreSQL Serverless v2 (Multi-AZ, PITR) —
//                     REPLACES in-cluster Postgres
//   ingress (fnd)  -> ACM cert + Route53 zone + SES identity (AWS resources)
//   observ. (fnd)  -> Amazon Managed Prometheus + Amazon Managed Grafana
//   secrets        -> Secrets Manager (DATABASE_URL->Aurora, app-env, BetterAuth)
//   iam            -> IRSA roles for app pods + every platform controller
//   [deployApp]    -> in-cluster controllers (Karpenter/LB/ExternalDNS/ESO/ADOT/
//                     CloudWatch) + the app wiring (SAs, ExternalSecret->env,
//                     KEDA, Karpenter NodePool, ALB Ingress)
//
// The foundations (ACM/Route53/SES, AMP/AMG) and Secrets Manager are created
// BEFORE iam so their ARNs scope the IRSA policies; the in-cluster controllers
// run AFTER iam because they need the role ARNs. See README.md for the
// architecture, the all-managed decision table, the side-by-side comparison vs
// the self-managed variant, and the deploy runbook.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { loadConfig } from "./src/config";
import { createNetwork } from "./src/network";
import { createStorage } from "./src/storage";
import { createRegistry } from "./src/registry";
import { createCluster } from "./src/cluster";
import { createDatabase } from "./src/database";
import { createIngressFoundation, deployIngressControllers } from "./src/ingress";
import { createObservabilityFoundation, deployObservabilityAgents } from "./src/observability";
import { createSecrets } from "./src/secrets";
import { createIam, APP_NS } from "./src/iam";
import { deployApp } from "./src/app";

const c = loadConfig();
const accountId = aws.getCallerIdentityOutput().accountId;

// --- AWS infra (always) -----------------------------------------------------
const net = createNetwork(c);
const storage = createStorage(c);
const registry = createRegistry(c);
const cluster = createCluster(c, net);
const database = createDatabase(c, net, cluster);

// Foundations whose ARNs IAM needs (created before iam).
const ingressFoundation = createIngressFoundation(c);
const observability = createObservabilityFoundation(c);
const secrets = createSecrets(c, database, storage, accountId);

// IRSA roles (app pods + platform controllers), scoped to the above ARNs.
const iam = createIam(cluster, {
  storage,
  secretArnPrefix: secrets.arnPrefix,
  ampWorkspaceArn: observability.ampWorkspaceArn,
  route53ZoneArn: ingressFoundation.route53ZoneArn,
  sesIdentityArn: ingressFoundation.sesIdentityArn,
  region: c.region,
  accountId,
});

// --- In-cluster software (only when deployApp=true) -------------------------
const controllers = c.deployApp
  ? deployIngressControllers(c, cluster, iam, ingressFoundation)
  : undefined;
const agents = c.deployApp
  ? deployObservabilityAgents(c, cluster, iam, observability)
  : undefined;
const app = c.deployApp
  ? deployApp(c, cluster, iam, secrets, registry, ingressFoundation)
  : undefined;

// ---- Stack outputs ---------------------------------------------------------
export const region = c.region;
export const vpcId = net.vpc.id;

// EKS
export const kubeconfig = pulumi.secret(cluster.kubeconfig);
export const clusterName = cluster.clusterName;
export const oidcProviderArn = cluster.oidcProviderArn;

// Aurora (DATABASE_URL lives in Secrets Manager; endpoints exported for ops).
export const auroraWriterEndpoint = database.writerEndpoint;
export const auroraReaderEndpoint = database.readerEndpoint;

// S3
export const bucketModels = storage.names.models;
export const bucketWeather = storage.names.weather;
export const bucketResults = storage.names.results;

// ECR image refs the manifests should use.
export const imageApiserver = registry.imageRefs.apiserver;
export const imageOperator = registry.imageRefs.operator;
export const imageRunner = registry.imageRefs.runner;
export const imagePortal = registry.imageRefs.portal;
export const imageSeed = registry.imageRefs.seed;

// Secrets Manager
export const secretArnPrefix = secrets.arnPrefix;

// Observability
export const ampWorkspaceArn = observability.ampWorkspaceArn;
export const ampRemoteWriteUrl = observability.ampRemoteWriteUrl;
export const grafanaEndpoint = observability.amgWorkspaceEndpoint;

// DNS / TLS
export const certificateArn = ingressFoundation.certificateArn;
export const appDomain = c.domain;

// IRSA role ARNs (the app SAs + controllers are annotated with these).
export const apiserverRoleArn = iam.apiserverRoleArn;
export const runnerRoleArn = iam.runnerRoleArn;
export const appNamespace = APP_NS.namespace;

// App bring-up status.
export const appDeployed = c.deployApp;
export const albControllerRelease = controllers?.albControllerReleaseName;
export const ingressName = app?.ingressName;
export const containerInsights = agents?.containerInsightsEnabled;
