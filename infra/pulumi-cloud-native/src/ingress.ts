// Ingress + DNS + TLS + email — all AWS-managed.
//
// Self-managed variant: ingress-nginx (provisions an NLB) + cert-manager/LE +
// external DNS + self-hosted SMTP.
// Cloud-native variant:
//   - AWS Load Balancer Controller turns `Ingress` objects into ALB rules,
//   - ACM issues + auto-renews the TLS cert (DNS-validated via Route53),
//   - ExternalDNS creates the A/ALIAS record for `domain` in the Route53 zone,
//   - SES is the Better Auth email sender (magic links / verification).
//
// Split into two phases to break the iam<->ingress dependency cycle:
//   createIngressFoundation()   AWS resources (ACM cert, Route53 lookup, SES
//                               identity) — created BEFORE iam.ts so their ARNs
//                               can scope the ExternalDNS / apiserver-SES roles.
//   deployIngressControllers()  Helm installs (LB controller, ExternalDNS,
//                               Karpenter, External Secrets) — gated by
//                               deployApp, run AFTER iam.ts (need role ARNs).

import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SynergyConfig } from "./config";
import { Cluster } from "./cluster";
import { Iam, PLATFORM_SA } from "./iam";

const TAGS = { Project: "synergyplus", ManagedBy: "pulumi", Variant: "cloud-native" };

export interface IngressFoundation {
  certificateArn: pulumi.Output<string>;
  route53ZoneId: pulumi.Output<string>;
  route53ZoneArn: pulumi.Output<string>;
  sesIdentityArn: pulumi.Output<string>;
}

// Phase 1: ACM + Route53 + SES (plain AWS resources).
export function createIngressFoundation(c: SynergyConfig): IngressFoundation {
  // Look up the existing public hosted zone (you own example.com in Route53).
  const zone = aws.route53.getZoneOutput({ name: c.route53ZoneName, privateZone: false });

  // ACM cert for the app FQDN, DNS-validated. (Validation records are created
  // out-of-band or by a follow-up Route53 record; documented in the README to
  // keep the scaffold's resource graph simple and avoid a validation deadlock.)
  const cert = new aws.acm.Certificate("synergy-cert", {
    domainName: c.domain,
    validationMethod: "DNS",
    tags: { ...TAGS, Name: "synergy-cert" },
  });

  // SES sender identity (verify the from-address; in production verify the whole
  // domain + DKIM). Better Auth sends through this identity via the apiserver
  // IRSA role's ses:SendEmail permission.
  const sesIdentity = new aws.ses.EmailIdentity("synergy-ses-from", {
    email: c.sesFromAddress,
  });

  return {
    certificateArn: cert.arn,
    route53ZoneId: zone.zoneId,
    route53ZoneArn: pulumi.interpolate`arn:aws:route53:::hostedzone/${zone.zoneId}`,
    sesIdentityArn: sesIdentity.arn,
  };
}

export interface IngressControllers {
  albControllerReleaseName: pulumi.Output<string>;
}

// Phase 2: the in-cluster controllers (Helm), gated by deployApp.
export function deployIngressControllers(
  c: SynergyConfig,
  cluster: Cluster,
  iam: Iam,
  foundation: IngressFoundation,
): IngressControllers {
  const provider = cluster.k8sProvider;
  const opts = { provider };

  // ServiceAccount for the AWS LB Controller (IRSA-annotated).
  const lbSa = new k8s.core.v1.ServiceAccount(
    "aws-lb-controller-sa",
    {
      metadata: {
        name: PLATFORM_SA.awsLbController.sa,
        namespace: PLATFORM_SA.awsLbController.ns,
        annotations: { "eks.amazonaws.com/role-arn": iam.awsLbControllerRoleArn },
      },
    },
    opts,
  );

  const albController = new k8s.helm.v3.Release(
    "aws-load-balancer-controller",
    {
      chart: "aws-load-balancer-controller",
      version: "1.8.1",
      namespace: PLATFORM_SA.awsLbController.ns,
      repositoryOpts: { repo: "https://aws.github.io/eks-charts" },
      values: {
        clusterName: cluster.clusterName,
        region: c.region,
        vpcId: cluster.eksCluster.eksCluster.vpcConfig.vpcId,
        serviceAccount: { create: false, name: PLATFORM_SA.awsLbController.sa },
      },
    },
    { provider, dependsOn: [lbSa] },
  );

  // ExternalDNS — manages the Route53 record for `domain`.
  const dnsSa = new k8s.core.v1.ServiceAccount(
    "external-dns-sa",
    {
      metadata: {
        name: PLATFORM_SA.externalDns.sa,
        namespace: PLATFORM_SA.externalDns.ns,
        annotations: { "eks.amazonaws.com/role-arn": iam.externalDnsRoleArn },
      },
    },
    opts,
  );
  new k8s.helm.v3.Release(
    "external-dns",
    {
      chart: "external-dns",
      version: "1.15.0",
      namespace: PLATFORM_SA.externalDns.ns,
      repositoryOpts: { repo: "https://kubernetes-sigs.github.io/external-dns" },
      values: {
        provider: "aws",
        policy: "sync",
        domainFilters: [c.route53ZoneName],
        serviceAccount: { create: false, name: PLATFORM_SA.externalDns.sa },
      },
    },
    { provider, dependsOn: [dnsSa] },
  );

  // Karpenter — node autoscaling. Provisions EC2 nodes (spot + on-demand) for
  // unschedulable runner pods, replacing the self-managed stack's reliance on a
  // fixed managed-node-group ceiling. NodePools/EC2NodeClasses are applied as
  // CRs (documented in the README); here we install the controller.
  const karpenterSa = new k8s.core.v1.ServiceAccount(
    "karpenter-sa",
    {
      metadata: {
        name: PLATFORM_SA.karpenter.sa,
        namespace: PLATFORM_SA.karpenter.ns,
        annotations: { "eks.amazonaws.com/role-arn": iam.karpenterControllerRoleArn },
      },
    },
    opts,
  );
  new k8s.helm.v3.Release(
    "karpenter",
    {
      chart: "karpenter",
      version: "1.0.6",
      namespace: PLATFORM_SA.karpenter.ns,
      createNamespace: true,
      repositoryOpts: { repo: "oci://public.ecr.aws/karpenter" },
      values: {
        settings: { clusterName: cluster.clusterName },
        serviceAccount: { create: false, name: PLATFORM_SA.karpenter.sa },
      },
    },
    { provider, dependsOn: [karpenterSa] },
  );

  // External Secrets Operator — syncs Secrets Manager -> k8s Secrets (app.ts
  // creates the SecretStore + ExternalSecret that builds `synergyplus-env`).
  const esoSa = new k8s.core.v1.ServiceAccount(
    "external-secrets-sa",
    {
      metadata: {
        name: PLATFORM_SA.externalSecrets.sa,
        namespace: PLATFORM_SA.externalSecrets.ns,
        annotations: { "eks.amazonaws.com/role-arn": iam.externalSecretsRoleArn },
      },
    },
    opts,
  );
  new k8s.helm.v3.Release(
    "external-secrets",
    {
      chart: "external-secrets",
      version: "0.10.4",
      namespace: PLATFORM_SA.externalSecrets.ns,
      createNamespace: true,
      repositoryOpts: { repo: "https://charts.external-secrets.io" },
      values: {
        installCRDs: true,
        serviceAccount: { create: false, name: PLATFORM_SA.externalSecrets.sa },
      },
    },
    { provider, dependsOn: [esoSa] },
  );

  return { albControllerReleaseName: albController.name };
}
