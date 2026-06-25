# SynergyPlus on AWS — Pulumi IaC, fully cloud-native (all-managed)

Infrastructure-as-code to stand up **SynergyPlus** on AWS using **AWS managed
services throughout**. This is the deliberate **opposite** of the self-managed
stack in [`infra/pulumi`](../pulumi): where that variant keeps Postgres,
registry, ingress, TLS, and secrets self-managed (S3 the only managed app
service), this one hands every one of those to AWS.

> **Status: groundwork / scaffolding.** Type-checks (`npx tsc --noEmit` clean)
> and is structured for `pulumi up`, but has **not** been deployed (managed
> services cost real money — no AWS spend incurred here). `pulumi up` is left to
> the operator. See [What's complete vs stubbed](#whats-complete-vs-groundwork-stubbed).

---

## Architecture

```
        Route53 (ALIAS) ─────────┐         ACM (TLS, auto-renew)
        ExternalDNS publishes     ▼
                       ┌────────────────────────────────────────────┐
   Internet ─────────▶│  ALB  (AWS Load Balancer Controller)         │
                       │   HTTPS → /api apiserver(:8090) · / portal   │
                       └───────────────┬────────────────────────────┘
                                       │
┌───────────────────── EKS cluster (managed CP + KMS-encrypted etcd) ─────────────────┐
│  Karpenter autoscales nodes (spot+on-demand)   ·   bootstrap managed node group      │
│                                                                                      │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────────────────────┐ │
│  │ Better Auth  │   │ apiserver    │   │ operator                                 │ │
│  │ + portal     │──▶│ (Go) IRSA SA │   │  • RunnerPool → Deployment + KEDA SO      │ │
│  │ (TS)  SES ✉  │   │ S3 presign + │   │  • Reaper · Batch Expander                │ │
│  └──────────────┘   │ Secrets/AMP  │   └──────────────────┬───────────────────────┘ │
│                     └──────┬───────┘                      │ reconciles              │
│        ExternalSecrets ┌───┘ SQL (TLS)                    ▼                          │
│        syncs env ◀─────┼──────────────┐   ┌──────────────────────────────────────┐  │
│                        ▼              │   │ Kubernetes API  (RunnerPool CRD)     │  │
│  (k8s Secret synergyplus-env)         │   │  → per-version runner Deployments    │  │
│   DATABASE_URL → Aurora writer        │   └──────────────┬───────────────────────┘  │
│                        │              │      KEDA scales │ on Aurora queue depth     │
│  ┌─────────────────────┼──────────────┼──────────────────▼──────────────────────┐  │
│  │ RUNNER POOLS (per EnergyPlus version) — runner SA via IRSA                    │  │
│  │  claim → fetch (S3) → run real EnergyPlus → parse .err → upload (S3)          │  │
│  └─────────────────────┼──────────────┼───────────────────────────────────────────┘ │
└────────────────────────┼──────────────┼─────────────────────────────────────────────┘
   IRSA (keyless, scoped) │              │ ADOT → AMP remote-write ; Fluent Bit → CW Logs
                          ▼              ▼
   ┌──────────────────────────────┐   ┌────────────────────────────────────────────┐
   │ Amazon Aurora PostgreSQL      │   │ Amazon Managed Prometheus + Grafana         │
   │ Serverless v2, Multi-AZ, PITR │   │ CloudWatch Container Insights               │
   │ queue · index · cache · auth  │   └────────────────────────────────────────────┘
   └──────────────────────────────┘
   ┌──────────────────────────────┐   ┌────────────────────────────────────────────┐
   │ S3 (SSE-KMS, versioned, TTL)  │   │ ECR (apiserver/operator/runner/portal/seed)│
   │ models · weather · results    │   │ nodes pull via node role (no pull secret)  │
   └──────────────────────────────┘   └────────────────────────────────────────────┘
   ┌──────────────────────────────┐
   │ AWS Secrets Manager           │  DB creds · Better Auth secret · app env
   │ (KMS) ← External Secrets Op   │
   └──────────────────────────────┘

AWS foundation: VPC · 2×public + 2×private subnets · IGW · NAT per AZ · EKS
control plane (KMS etcd) + bootstrap node group + Karpenter · OIDC (IRSA) ·
KMS keys (EKS/S3/Aurora/Secrets) · IAM.
```

The Pulumi project builds these layers in dependency order (`index.ts`):

| Module | File | Responsibility |
|---|---|---|
| config        | `src/config.ts`        | Typed view of all stack config + ECR image refs. |
| network       | `src/network.ts`       | VPC, 2 public + 2 private subnets (EKS/Karpenter/DB-tagged), IGW, **NAT per AZ**, routes. |
| storage       | `src/storage.ts`       | S3 `models`/`weather`/`results` + **SSE-KMS** + versioning + lifecycle TTL + public-access block. |
| registry      | `src/registry.ts`      | **ECR** repos (apiserver/operator/runner/portal/seed) + scan-on-push + lifecycle. |
| cluster       | `src/cluster.ts`       | EKS control plane (**KMS-encrypted etcd**), bootstrap node group, EBS CSI addon, OIDC, k8s provider. |
| database      | `src/database.ts`      | **Aurora PostgreSQL Serverless v2** (Multi-AZ, PITR, KMS) — replaces in-cluster Postgres. |
| ingress       | `src/ingress.ts`       | **ACM** cert + **Route53** zone + **SES** identity (phase 1); **AWS LB Controller / ALB**, **ExternalDNS**, **Karpenter**, **External Secrets** Helm (phase 2). |
| observability | `src/observability.ts` | **Amazon Managed Prometheus** + **Amazon Managed Grafana** (phase 1); **ADOT** → AMP + **CloudWatch Container Insights / Fluent Bit** (phase 2). |
| secrets       | `src/secrets.ts`       | **AWS Secrets Manager** (KMS): `DATABASE_URL`→Aurora writer, app-env, Better Auth secret. |
| iam           | `src/iam.ts`           | **IRSA** roles for app pods (S3/Secrets/AMP/SES) **and every platform controller**. |
| app           | `src/app.ts`           | _(gated by `deployApp`)_ namespace, IRSA SAs, **ExternalSecret → `synergyplus-env`**, **KEDA**, **Karpenter NodePool**, **ALB Ingress**. **No in-cluster Postgres.** |

---

## Managed vs self-managed decision table (flipped to all-managed)

This is the mirror of the self-managed table. Constraint here: **prefer the AWS
managed service for every concern.**

| Need | Choice | Managed? | Why this, not the self-managed alt |
|---|---|---|---|
| **Kubernetes** | **Amazon EKS** (managed CP) **+ Karpenter** | ✅ managed | Managed/HA control plane; **Karpenter** does fast, bin-packed, spot-aware node autoscaling (vs the self-managed stack's fixed node-group ceiling). **Fargate profiles** are an option for bursty/system pods — noted below. |
| **Node autoscaling** | **Karpenter** | ✅ managed (operator) | Provisions exactly the nodes unschedulable runner pods need, consolidates idle ones. Cluster Autoscaler is the lower-tech alternative. |
| **Database** | **Amazon Aurora PostgreSQL Serverless v2** (Multi-AZ, PITR) | ✅ managed | **Replaces the in-cluster Postgres entirely.** AWS owns backups, PITR, failover, patching, storage + capacity autoscaling. `DATABASE_URL` → the **writer endpoint** (via Secrets Manager). One logical Postgres satisfies ADR-0010. |
| **Object storage** | **S3** + **SSE-KMS** + versioning + lifecycle TTL | ✅ managed | Same as self-managed, hardened: customer-managed KMS (vs SSE-S3/AES256). |
| **Container registry** | **ECR** (5 repos) | ✅ managed | **Replaces GHCR.** Nodes pull via the node role (`AmazonEC2ContainerRegistryReadOnly`) — **no `imagePullSecret`**. CI pushes via OIDC, or an **ECR pull-through cache from GHCR** keeps the existing publish flow. |
| **Ingress / LB** | **AWS Load Balancer Controller + ALB** | ✅ managed | **Replaces ingress-nginx/NLB.** `Ingress` objects become ALB rules directly; L7 routing, ACM integration, WAF-ready. |
| **TLS** | **ACM** (DNS-validated, auto-renew) | ✅ managed | **Replaces cert-manager + Let's Encrypt.** No renewal cron, no HTTP-01 over :80. |
| **DNS** | **Route53 + ExternalDNS** | ✅ managed | **Replaces external/self-managed DNS.** ExternalDNS publishes the ALB ALIAS for `domain`. |
| **Secrets** | **AWS Secrets Manager + External Secrets Operator** | ✅ managed | **Replaces hand-written k8s Secrets.** DB creds + Better Auth secret live in Secrets Manager (KMS); ESO syncs them into `synergyplus-env`. Pulumi never writes a plaintext DB password into a k8s Secret. |
| **Observability** | **AMP + AMG + CloudWatch Container Insights + Fluent Bit** | ✅ managed | **Replaces in-cluster Prometheus/Grafana/Loki.** ADOT remote-writes to AMP; AMG dashboards; Fluent Bit ships logs to CloudWatch. |
| **Email (Better Auth)** | **SES** | ✅ managed | **Replaces self-hosted SMTP.** apiserver sends magic-link/verification mail via its IRSA `ses:SendEmail`. |
| **Pod→AWS auth** | **IRSA** | ✅ managed (EKS-native) | Keyless, scoped roles for **every** pod that touches an AWS API (app + all controllers). No static keys anywhere. |
| **Encryption** | **KMS** keys for EKS etcd, S3, Aurora, Secrets Manager | ✅ managed | Envelope encryption end-to-end (the self-managed stack uses KMS only incidentally via EBS). |
| **Pod autoscaling** | **KEDA** (Postgres queue-depth trigger) | ❌ self-managed | **Stays** — no managed equivalent, and it's core to the app (ADR-0005). The **HPA + CloudWatch-metrics-adapter** alternative is noted below. |
| **Networking** | VPC, subnets, IGW, **NAT per AZ**, SGs, EIP | n/a (primitives) | Primitives, in scope; HA NAT (one per AZ) vs the self-managed single NAT. |

### Notes on the two "stay" / "option" cases

- **KEDA stays (the one self-managed piece).** There is no managed KEDA on AWS,
  and the whole design scales each RunnerPool `0→ceiling` on the *eligible*
  Postgres queue depth (the claim predicate from CONTRACT §2.2). The KEDA
  postgres trigger reads `DATABASE_URL` from `synergyplus-env` — now Aurora.
  **Alternative:** emit queue depth as a custom CloudWatch metric and drive a
  plain **HPA via the CloudWatch metrics adapter** (`k8s-cloudwatch-adapter`).
  That's more "managed" but loses scale-to-zero and the exact claim-aware
  predicate, so KEDA is the better fit; the adapter path is documented, not wired.
- **Fargate profiles (option).** EKS Fargate can run system/bursty pods with no
  node management at all. We use **Karpenter + EC2** for the runners because
  EnergyPlus is long-lived, CPU-bound, and benefits from spot + bin-packing
  (Fargate has no spot and a per-pod overhead). A Fargate profile for
  `kube-system`/`karpenter` is a reasonable add-on; documented, not wired.

---

## Side-by-side: cloud-native vs self-managed

The honest trade-off. Same app, opposite operating philosophy.

| Dimension | Self-managed (`infra/pulumi`) | Cloud-native (this stack) | Verdict |
|---|---|---|---|
| **Cost** | Lower steady-state $: one Postgres pod on an EBS PV, GHCR (free-ish), nginx, k8s Secrets, in-cluster Prometheus. You pay for EC2 + EBS + S3 + the NLB and little else. | Higher $: **Aurora Serverless v2** (min ACUs bill 24/7), **AMP/AMG** ingestion + per-user, **ALB** hourly + LCU, **Secrets Manager** per-secret, **NAT per AZ**, CloudWatch ingestion, ECR storage. Managed = a premium. | **Self-managed cheaper**, especially at low/idle load. Cloud-native cost scales with usage and is largely opex. |
| **Ops burden** | **You own** Postgres backups/PITR/HA/patching (the single biggest liability — ADR-0010 assumes one instance, so HA PG is a real project), nginx upgrades, cert renewals, Prometheus storage, GHCR PAT rotation. | **AWS owns** DB HA/backups/failover/patching, LB, cert renewal, metric/log storage, registry availability, DNS. You own app manifests + Karpenter/KEDA tuning. | **Cloud-native far lighter.** This is the main reason to pick it. |
| **Vendor lock-in** | **Lower.** Postgres/MinIO/nginx/Prometheus/GHCR are portable; the same compose stack runs on-prem. S3 is the only hard AWS dependency. | **Higher.** Aurora, AMP/AMG, ALB-ingress annotations, Secrets Manager, SES, IRSA, Karpenter CRDs are AWS-specific. Migrating off AWS is a real port. | **Self-managed more portable.** Matches the proposal's "on-prem or burst to cloud" stance. |
| **Time to production** | Slower: you must build the Postgres HA/backup story, cert-manager, secrets hygiene, and a metrics stack before you're production-safe. | Faster: HA DB, TLS, DNS, secrets, metrics, and logs are turn-key. Flip `deployApp=true`, apply manifests, point DNS. | **Cloud-native faster** to a production-grade posture. |
| **Reliability / HA** | Single Postgres + single NLB by default; HA is your homework. | Multi-AZ Aurora w/ automatic failover, multi-AZ ALB, NAT per AZ, managed CP. | **Cloud-native more resilient** out of the box. |
| **Security posture** | k8s Secrets (base64, not encrypted unless you add KMS/sealed-secrets), GHCR PAT to rotate. | KMS everywhere (etcd/S3/Aurora/Secrets), Secrets Manager rotation-ready, IRSA-only (no static keys), private ECR. | **Cloud-native stronger** defaults. |
| **Scaling** | Fixed node-group ceiling; KEDA scales pods. | **Karpenter** scales nodes elastically (spot); KEDA scales pods; Aurora scales capacity. | **Cloud-native scales further** with less planning. |

### Which to choose when

- **Choose self-managed** when: cost sensitivity is high, you need on-prem/hybrid
  portability (the lab's own cluster + MinIO, per the proposal), you have the
  ops muscle to run HA Postgres, or you want to avoid AWS lock-in.
- **Choose cloud-native** when: you want production-grade HA/backups/observability
  **now** with a small team, you're AWS-committed, time-to-market beats steady-state
  cost, and you'd rather pay AWS than carry the on-call for stateful infra.

A common path: **prototype self-managed** (compose/on-prem), **go to production
cloud-native** once the lab is AWS-committed and needs the SLA.

---

## Prerequisites

- **Pulumi CLI** ≥ 3.120 — https://www.pulumi.com/docs/install/
- **Node.js** ≥ 18 and npm
- **AWS credentials** with rights to create VPC/EKS/EC2/IAM/S3/RDS/ECR/ACM/
  Route53/SecretsManager/AMP/AMG/SES/KMS (e.g. `aws configure` / `AWS_PROFILE`)
- **kubectl** + **helm** (for app-apply + fetching the ALB hostname)
- A **Pulumi backend** (Pulumi Cloud `pulumi login`, or `pulumi login --local`)
- A **public Route53 hosted zone** for `route53ZoneName` (this stack looks it up)
- **SES**: out of the sandbox if you'll send to arbitrary recipients (sandbox is
  fine for verified addresses during testing)

---

## Deploy runbook

```bash
cd infra/pulumi-cloud-native
npm install
npx tsc --noEmit          # type-check (the minimum bar; passes clean)

pulumi stack init dev     # or: pulumi stack select dev

# --- configure the stack ---
pulumi config set aws:region us-east-1
pulumi config set synergyplus-infra-cloud-native:adminCidr        "<YOUR.IP/32>"   # lock the EKS API
pulumi config set synergyplus-infra-cloud-native:domain           synergyplus.example.com
pulumi config set synergyplus-infra-cloud-native:route53ZoneName  example.com
pulumi config set synergyplus-infra-cloud-native:sesFromAddress   noreply@example.com
pulumi config set synergyplus-infra-cloud-native:imageTag         latest

# --- 1) provision AWS infra only (VPC/EKS/Aurora/S3/ECR/IRSA/Secrets/AMP/ACM) ---
pulumi up                 # deployApp defaults to false

# Finish ACM DNS validation: add the CNAME the cert's domain_validation_options
# emits to the Route53 zone (or let a follow-up aws_route53_record do it).

# --- 2) push images to ECR (or set up an ECR pull-through cache from GHCR) ---
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin <acct>.dkr.ecr.us-east-1.amazonaws.com
# docker tag + push each of synergyplus-{apiserver,operator,runner,portal,seed}:latest
# (Stack outputs imageApiserver/imageRunner/... give the exact refs.)

# --- 3) export kubeconfig + verify ---
pulumi stack output kubeconfig --show-secrets > kubeconfig.json
export KUBECONFIG=$PWD/kubeconfig.json
kubectl get nodes

# --- 4) bring up in-cluster controllers + app wiring ---
#     installs Karpenter, AWS LB Controller, ExternalDNS, External Secrets, KEDA,
#     ADOT, CloudWatch Container Insights, the ExternalSecret->synergyplus-env,
#     the Karpenter NodePool, and the ALB Ingress.
pulumi config set synergyplus-infra-cloud-native:deployApp true
pulumi up

# --- 5) apply the app manifests from the repo (operator, apiserver, portal, CRD) ---
#     The IRSA SAs + the synced synergyplus-env Secret are already in place.
#     Point image: fields at the ECR refs (kustomize image override or edit).
kubectl apply -f ../../config/crd/
kubectl apply -f ../../config/rbac/
kubectl apply -f ../../config/manager/      # operator + apiserver Deployments (ECR images)
kubectl apply -f ../../config/keda/         # or let the operator template per-pool SOs
kubectl apply -f ../../config/samples/runnerpool.yaml

# seed buckets/sample data + a dev API key (after apiserver applies migrations)
kubectl apply -f ../../deploy/k8s-local/seed-job.yaml

# --- 6) DNS is automatic ---
# ExternalDNS publishes <domain> -> the ALB; ACM serves TLS. Browse https://<domain>.

# tear down
pulumi destroy
```

> **Wire the app to Aurora + S3 via IRSA + External Secrets (no static keys).**
> The Deployments in `config/manager/` must (a) run under the IRSA
> ServiceAccounts this project creates — `synergyplus-apiserver` /
> `synergyplus-runner` (the operator stamps the runner SA onto RunnerPool pods),
> and (b) load env from the **`synergyplus-env` Secret** that External Secrets
> assembles. `DATABASE_URL` already points at the **Aurora writer** (with
> `sslmode=require`); the S3 bucket names + region come from the same Secret;
> there are **no** `S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_ENDPOINT` (IRSA + default
> AWS endpoint). Set the image refs to the **ECR** outputs.

---

## What's complete vs groundwork-stubbed

**Complete (type-checks; resources fully declared):**
- VPC + 2 public / 2 private subnets (EKS/Karpenter/DB-tagged) + IGW + **NAT per AZ** + routes.
- EKS cluster with **KMS-encrypted etcd**, bootstrap managed node group, EBS CSI addon, OIDC.
- **Aurora PostgreSQL Serverless v2**: writer + reader instances, Multi-AZ, KMS, automated backups + PITR window, serverless scaling config.
- **S3** (models/weather/results) with **SSE-KMS**, versioning, lifecycle TTL, public-access block.
- **ECR** repos (5) with scan-on-push + untagged-image lifecycle.
- **Secrets Manager** secrets (KMS): `DATABASE_URL`→Aurora writer, app-env JSON, generated Better Auth secret.
- **AMP** + **AMG** workspaces (+ AMG query role).
- **ACM** cert (DNS-validated) + **Route53** zone lookup + **SES** sender identity.
- **IRSA** roles (least-priv) for: apiserver, runner, AWS LB Controller, ExternalDNS, External Secrets, Karpenter, ADOT, Fluent Bit.
- KMS keys for **EKS etcd / S3 / Aurora / Secrets Manager** (rotation on).
- _(gated by `deployApp`)_ Helm releases: AWS LB Controller, ExternalDNS, Karpenter, External Secrets, KEDA, ADOT; the CloudWatch Observability addon; the `ClusterSecretStore` + `ExternalSecret`→`synergyplus-env`; the Karpenter `NodePool`/`EC2NodeClass`; the **ALB `Ingress`**.
- Stack outputs: kubeconfig, cluster name, OIDC ARN, Aurora endpoints, bucket names, ECR image refs, secret ARN prefix, AMP/Grafana, ACM ARN, IRSA role ARNs.

**Groundwork-stubbed / documented-but-not-wired (deliberate, to keep scope clean):**
- **App Deployments (operator/apiserver/portal) + RunnerPool CRD** are applied
  from the repo's existing `config/` via `kubectl` (runbook step 5) rather than
  re-authored as Pulumi resources — owned by another track, change often. The
  pieces they depend on (IRSA SAs, the synced `synergyplus-env`, the ALB Ingress)
  **are** created here.
- **ACM DNS-validation record** is documented (add the CNAME / a follow-up
  Route53 record) rather than wired, to avoid a validation deadlock in the graph.
- **ECR image push / pull-through cache**: documented (CI OIDC push, or a GHCR
  pull-through rule); the repos exist, the push is out-of-band.
- **IAM policy breadth**: the AWS LB Controller + Karpenter policies are
  representative scoped subsets of the upstream policies — paste the full
  upstream documents for production.
- **SES domain + DKIM**: only the from-*address* identity is verified here;
  production should verify the domain + DKIM and exit the sandbox.
- **HPA + CloudWatch-adapter** pod-autoscaling alternative, **Fargate profiles**,
  and per-bucket-tightened IRSA: documented, not enabled.
- **`pulumi up` not run** — verified by `npx tsc --noEmit` only (managed services
  cost money; no AWS creds / no spend, per the task).
