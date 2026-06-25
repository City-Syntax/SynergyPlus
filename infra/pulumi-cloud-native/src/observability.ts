// Observability — all AWS-managed.
//
// Self-managed variant: Prometheus + Grafana + Loki, all in-cluster (you run +
// store + scale them).
// Cloud-native variant:
//   - Amazon Managed Prometheus (AMP)   : metrics store (remote-write target),
//   - Amazon Managed Grafana (AMG)      : dashboards (queries AMP),
//   - CloudWatch Container Insights     : cluster/pod metrics + the console view,
//   - Fluent Bit -> CloudWatch Logs     : pod logs.
//
// Metrics flow: an ADOT (AWS Distro for OpenTelemetry) collector scrapes
// cluster + app metrics (incl. the apiserver's queue-depth gauges) and
// remote-writes to AMP via its IRSA role. The runner/apiserver can also
// remote-write directly (they hold aps:RemoteWrite). AMG reads AMP for the
// "queue depth / throughput / $ per run" dashboards (PROPOSAL G7).
//
// Split like ingress.ts: createObservabilityFoundation() makes the AWS
// resources (AMP/AMG) BEFORE iam.ts (so the AMP ARN scopes the remote-write
// roles); deployObservabilityAgents() installs the in-cluster agents (gated by
// deployApp) AFTER iam.ts.

import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SynergyConfig } from "./config";
import { Cluster } from "./cluster";
import { Iam, PLATFORM_SA } from "./iam";

const TAGS = { Project: "synergyplus", ManagedBy: "pulumi", Variant: "cloud-native" };

export interface ObservabilityFoundation {
  ampWorkspaceArn: pulumi.Output<string>;
  ampRemoteWriteUrl: pulumi.Output<string>;
  ampQueryUrl: pulumi.Output<string>;
  amgWorkspaceEndpoint: pulumi.Output<string>;
}

// Phase 1: AMP + AMG (plain AWS resources).
export function createObservabilityFoundation(c: SynergyConfig): ObservabilityFoundation {
  // Amazon Managed Prometheus workspace.
  const amp = new aws.amp.Workspace("synergy-amp", {
    alias: "synergyplus",
    tags: { ...TAGS, Name: "synergy-amp" },
  });

  // IAM role AMG assumes to query data sources (AMP). AMG requires an
  // account-level role with a Grafana-service trust + the Prometheus access
  // managed policy.
  const amgRole = new aws.iam.Role("synergy-amg-role", {
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Principal: { Service: "grafana.amazonaws.com" }, Action: "sts:AssumeRole" },
      ],
    }),
    tags: TAGS,
  });
  new aws.iam.RolePolicyAttachment("synergy-amg-amp-access", {
    role: amgRole.name,
    policyArn: "arn:aws:iam::aws:policy/AmazonPrometheusQueryAccess",
  });

  // Amazon Managed Grafana workspace (AWS SSO / IAM Identity Center auth).
  const amg = new aws.grafana.Workspace("synergy-amg", {
    accountAccessType: "CURRENT_ACCOUNT",
    authenticationProviders: ["AWS_SSO"],
    permissionType: "SERVICE_MANAGED",
    dataSources: ["PROMETHEUS", "CLOUDWATCH"],
    roleArn: amgRole.arn,
    tags: { ...TAGS, Name: "synergy-amg" },
  });

  return {
    ampWorkspaceArn: amp.arn,
    ampRemoteWriteUrl: pulumi.interpolate`${amp.prometheusEndpoint}api/v1/remote_write`,
    ampQueryUrl: pulumi.interpolate`${amp.prometheusEndpoint}api/v1/query`,
    amgWorkspaceEndpoint: amg.endpoint,
  };
}

export interface ObservabilityAgents {
  containerInsightsEnabled: boolean;
}

// Phase 2: in-cluster agents (ADOT collector + Fluent Bit), gated by deployApp.
export function deployObservabilityAgents(
  c: SynergyConfig,
  cluster: Cluster,
  iam: Iam,
  foundation: ObservabilityFoundation,
): ObservabilityAgents {
  const provider = cluster.k8sProvider;
  const opts = { provider };

  // CloudWatch Observability EKS addon = Container Insights + the CloudWatch
  // agent + Fluent Bit, managed by AWS. The addon's pods use the fluent-bit
  // IRSA role for CloudWatch Logs access.
  new aws.eks.Addon("synergy-cloudwatch-observability", {
    clusterName: cluster.clusterName,
    addonName: "amazon-cloudwatch-observability",
    resolveConflictsOnCreate: "OVERWRITE",
    serviceAccountRoleArn: iam.fluentbitRoleArn,
    tags: TAGS,
  });

  // ADOT collector (Helm) — scrapes Prometheus-format metrics and remote-writes
  // to AMP. Its SA carries the ADOT IRSA role (aps:RemoteWrite to the workspace).
  const adotSa = new k8s.core.v1.ServiceAccount(
    "adot-collector-sa",
    {
      metadata: {
        name: PLATFORM_SA.adot.sa,
        namespace: PLATFORM_SA.adot.ns,
        annotations: { "eks.amazonaws.com/role-arn": iam.adotRoleArn },
      },
    },
    opts,
  );
  new k8s.helm.v3.Release(
    "adot",
    {
      chart: "adot-exporter-for-eks-on-ec2",
      version: "0.18.0",
      namespace: PLATFORM_SA.adot.ns,
      createNamespace: true,
      repositoryOpts: { repo: "https://aws-observability.github.io/aws-otel-helm-charts" },
      values: {
        awsRegion: c.region,
        clusterName: cluster.clusterName,
        serviceAccount: { create: false, name: PLATFORM_SA.adot.sa },
        adotCollector: {
          daemonSet: {
            service: {
              metrics: {
                receivers: ["prometheus"],
                exporters: ["prometheusremotewrite"],
              },
            },
            prometheusRemoteWriteEndpoint: foundation.ampRemoteWriteUrl,
          },
        },
      },
    },
    { provider, dependsOn: [adotSa] },
  );

  return { containerInsightsEnabled: true };
}
