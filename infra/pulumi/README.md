# SynergyPlus on AWS — Pulumi IaC (TypeScript)

Infrastructure-as-code to stand up **SynergyPlus** on AWS using **Amazon EKS** for
the Kubernetes layer, while staying **self-managed everywhere it still makes
sense** — in-cluster Postgres (not RDS), GHCR images (not ECR), nginx ingress
(not ALB by default), and k8s Secrets (not Secrets Manager). **S3 is the only
AWS _application_ managed service** in the data path; pods reach it **keylessly
via IRSA** (no static access keys anywhere).

> **Status: groundwork / scaffolding.** This project type-checks and is structured
> for `pulumi up`, but has **not** been deployed (no AWS spend incurred, creds may
> be absent). See [What's complete vs stubbed](#whats-complete-vs-groundwork-stubbed).

---

## Architecture

```
                            ┌────────────────────────────────────────────┐
   DNS (external) ─────────▶│  ingress-nginx  (provisions an NLB)         │
   cert-manager + LE TLS    │   → apiserver (:8090) · portal (:3000)      │
                            └───────────────┬────────────────────────────┘
                                            │
┌───────────────────────────── EKS cluster (synergy-system ns) ──────────────────────┐
│                                                                                     │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────────────────────┐│
│  │ Better Auth  │   │ apiserver    │   │ operator                                 ││
│  │ + portal     │──▶│ (Go) IRSA SA │   │  • RunnerPool → Deployment + KEDA SO      ││
│  │ (TS)         │   │ presign S3   │   │  • Reaper · Batch Expander                ││
│  └──────────────┘   └──────┬───────┘   └──────────────────┬───────────────────────┘│
│                            │ SQL                           │ reconciles             │
│                            ▼                               ▼                         │
│  ┌──────────────────────────────────────┐   ┌──────────────────────────────────┐  │
│  │ Postgres StatefulSet (gp3 PV, EBS CSI)│   │ Kubernetes API  (RunnerPool CRD) │  │
│  │  queue · index · cache · auth         │   │  → per-version runner Deployments│  │
│  └──────────────────────────────────────┘   └──────────────┬───────────────────┘  │
│                                                  KEDA scales │ on queue depth        │
│  ┌─────────────────────────────────────────────────────────▼───────────────────┐  │
│  │ RUNNER POOLS (one per EnergyPlus version) — runner SA via IRSA               │  │
│  │  claim → fetch (S3) → run real EnergyPlus → parse .err → upload (S3)         │  │
│  └─────────────────────────────────────────────────────────┬───────────────────┘  │
└────────────────────────────────────────────────────────────│──────────────────────┘
                  IRSA (keyless, scoped)                       ▼
                                         ┌────────────────────────────────────────┐
                                         │ S3: models · weather · results (TTL)   │
                                         │ (the ONE allowed AWS managed service)  │
                                         └────────────────────────────────────────┘

AWS foundation: VPC · 2×public + 2×private subnets · IGW · NAT · EKS control plane
                + managed node group · EBS CSI addon · OIDC provider (IRSA) · IAM.
```

The Pulumi project builds these layers in dependency order (`index.ts`):

| Module | File | Responsibility |
|---|---|---|
| config  | `src/config.ts`  | Typed view of all stack config + GHCR image refs. |
| network | `src/network.ts` | VPC, 2 public + 2 private subnets (EKS-tagged), IGW, NAT, routes. |
| storage | `src/storage.ts` | S3 buckets `models`/`weather`/`results` + lifecycle TTL + encryption + public-access block. |
| cluster | `src/cluster.ts` | EKS control plane, node IAM role, managed node group, EBS CSI addon, OIDC provider, k8s provider. |
| iam     | `src/iam.ts`     | **IRSA** roles (keyless, scoped S3) for the apiserver + runner ServiceAccounts. |
| app     | `src/app.ts`     | _(gated by `deployApp`)_ namespace, gp3 SC, GHCR pull secret, `synergyplus-env` Secret, in-cluster Postgres, IRSA SAs, KEDA + ingress-nginx (Helm). |

---

## Managed vs self-managed decision table

The constraint: **avoid AWS managed services except S3.** With the EKS pivot, the
Kubernetes _control plane_ is managed (and so are its native companions IRSA and
the EBS CSI driver), but the application data services stay self-managed.

| Need | Choice | Managed? | Why this, not the managed alt |
|---|---|---|---|
| **Kubernetes** | **Amazon EKS** (managed control plane + managed node group) | ✅ managed | User opted into EKS — removes the k3s/EC2/user-data bootstrap and the etcd babysitting. Its native companions we _do_ use: **IRSA** (keyless pod→AWS auth) and the **EBS CSI driver** (gp3 PVs). |
| **Pod→AWS auth** | **IRSA** (OIDC provider + web-identity roles) | ✅ managed (EKS-native) | The clean, **static-key-free** way to grant pods scoped S3 — no `S3_ACCESS_KEY`/`S3_SECRET_KEY` anywhere. Replaces the old EC2 instance-profile idea. Pairs with the apiserver's presigned-URL work. |
| **Block storage** | **EBS** via the **EBS CSI driver** (gp3 StorageClass) | ✅ managed (EKS-native) | Backs the in-cluster Postgres PV. EBS is an AWS primitive; the CSI driver is the standard EKS way to consume it. |
| **Database** | **In-cluster Postgres** (StatefulSet on a gp3 PV) | ❌ self-managed | NOT RDS/Aurora. Single source of truth (queue + index + cache + auth, ADR-0010). You own backups/HA — see trade-offs. |
| **Object storage** | **S3** (`models`/`weather`/`results` + lifecycle TTL) | ✅ managed | The **one allowed** managed service. One S3 API on-prem (MinIO) and cloud. |
| **Container registry** | **GHCR** (`ghcr.io/<owner>/synergyplus-*`) | ❌ self-managed | NOT ECR. CI already publishes here (`.github/workflows/release-images.yml`). Private repos wired via an `imagePullSecret`. |
| **Ingress / LB** | **ingress-nginx** (provisions an **NLB**) | ❌ self-managed (LB is a primitive) | Default. NOT the AWS Load Balancer Controller + ALB — though that's documented as an option below. |
| **TLS** | **cert-manager + Let's Encrypt** | ❌ self-managed | NOT ACM. HTTP-01 over the open :80. |
| **Secrets** | **k8s Secrets** | ❌ self-managed | NOT Secrets Manager / SSM. Optionally layer sealed-secrets or SOPS (noted below). |
| **Pod autoscaling** | **KEDA** (Postgres queue-depth trigger) | ❌ self-managed | In-cluster; scales each RunnerPool 0→ceiling on eligible queue depth (ADR-0005). |
| **Node autoscaling** | EKS managed node group `min/desired/max` | ✅ managed (EC2-level) | Cluster-autoscaler or Karpenter are optional add-ons (noted); EC2-level scaling is fine per the constraint. |
| **DNS / email** | **external DNS** + self-hosted SMTP relay | ❌ self-managed | Route53 + SES are managed and are the **honest borderline exceptions** — point your own DNS at the ingress NLB; relay mail through your own SMTP. |
| **Networking** | VPC, subnets, IGW, NAT, SGs, EIP | n/a (primitives) | Infrastructure primitives, explicitly in scope. |

### Ingress: nginx (default) vs ALB (option)

- **ingress-nginx (default, wired in `app.ts`).** Installs the controller via Helm
  with `aws-load-balancer-type: nlb`, so AWS provisions an **NLB** fronting it.
  Stays closest to the original "self-managed ingress" stance; the ingress logic
  lives in-cluster.
- **AWS Load Balancer Controller + ALB (option, not wired).** More EKS-native:
  `Ingress` objects become **ALB** rules directly. Swap by installing the
  `aws-load-balancer-controller` Helm chart (it needs its own IRSA role) and using
  `ingressClassName: alb`. Documented here, not enabled by default.

---

## Honest trade-offs

Choosing EKS + self-managed data services means **you own the parts AWS would
otherwise run for you**:

- **Postgres is yours.** No automated backups, PITR, failover, minor-version
  patching, or read replicas — all of which **RDS/Aurora would handle**. The
  scaffold runs a **single** Postgres pod on one EBS PV: a node loss or PV
  corruption is a data-loss event until you add `pg_dump`/WAL archiving to S3, a
  replica (e.g. CloudNativePG/Patroni), and a restore runbook. This is the single
  biggest operational liability here. The data model assumes one instance
  (ADR-0010), so HA Postgres is a real project, not a flag.
- **Node + OS lifecycle.** The managed node group keeps the kubelet/AMI current,
  but you still own cordon/drain windows, capacity planning, and PodDisruption
  budgets for the stateful Postgres.
- **Ingress + TLS are yours.** cert-manager renewals, nginx upgrades, and the NLB
  health all sit with you (ACM + ALB would offload cert + LB management).
- **Registry availability.** GHCR outages or rate limits hit image pulls; ECR
  would be in-region and IAM-native. The `imagePullSecret` PAT must be rotated.
- **DNS/email caveat.** Route53 + SES are genuinely managed; this design pushes
  them out of AWS (external DNS, self-hosted SMTP). That's the honest borderline —
  if you accept Route53/SES, it's a small, well-scoped exception.
- **Single NAT / single AZ data plane.** The scaffold uses one NAT gateway and a
  single-replica Postgres for cost/simplicity. Production wants a NAT per AZ and a
  multi-AZ HA Postgres story.

What you **gain** by pivoting to EKS (vs the earlier k3s-on-EC2 plan): no
user-data bootstrap, a managed/HA control plane, first-class **IRSA** (the clean
fix for the static-S3-key gap), and the **EBS CSI driver** for PVs.

---

## Prerequisites

- **Pulumi CLI** ≥ 3.120 — https://www.pulumi.com/docs/install/
- **Node.js** ≥ 18 and npm
- **AWS credentials** with rights to create VPC/EKS/EC2/IAM/S3 (e.g. `aws configure`
  or `AWS_PROFILE`)
- **kubectl** (for app-apply + fetching the ingress hostname)
- A **Pulumi backend** (Pulumi Cloud `pulumi login`, or `pulumi login --local`)
- _(private GHCR images only)_ a **PAT** with `read:packages`

---

## Deploy runbook

```bash
cd infra/pulumi
npm install
npx tsc --noEmit          # type-check (the minimum bar; passes clean)

pulumi stack init dev     # or: pulumi stack select dev

# --- configure the stack ---
pulumi config set aws:region us-east-1
pulumi config set synergyplus-infra:adminCidr      "<YOUR.IP/32>"   # lock down the EKS API
pulumi config set synergyplus-infra:ghcrOwner      city-syntax
pulumi config set synergyplus-infra:imageTag       latest
pulumi config set synergyplus-infra:domain         synergyplus.example.com
# private images: wire the pull secret
pulumi config set        synergyplus-infra:ghcrUsername <gh-user>
pulumi config set --secret synergyplus-infra:ghcrToken   <PAT>
# Postgres password (override the dev default)
pulumi config set --secret synergyplus-infra:pgPassword  <strong-pass>

# --- 1) provision AWS infra only (VPC / EKS / node group / S3 / IRSA) ---
pulumi up                 # deployApp defaults to false

# --- 2) export the kubeconfig and verify the cluster ---
pulumi stack output kubeconfig --show-secrets > kubeconfig.json
export KUBECONFIG=$PWD/kubeconfig.json
kubectl get nodes

# --- 3) bring up in-cluster software (KEDA, ingress-nginx, Postgres, Secret, SAs) ---
pulumi config set synergyplus-infra:deployApp true
pulumi up

# --- 4) apply the app manifests from the repo (operator, apiserver, portal, CRD) ---
#     The IRSA ServiceAccounts + synergyplus-env Secret + Postgres are already in
#     place (created by step 3), so the existing manifests drop straight in.
kubectl apply -f ../../config/crd/
kubectl apply -f ../../config/rbac/
kubectl apply -f ../../config/manager/      # operator + apiserver Deployments
kubectl apply -f ../../config/keda/         # (or let the operator template per-pool SOs)
kubectl apply -f ../../config/samples/runnerpool.yaml

# seed buckets/sample data + a dev API key (after apiserver applies migrations)
kubectl apply -f ../../deploy/k8s-local/seed-job.yaml

# --- 5) get the ingress address and point DNS at it ---
kubectl -n ingress-nginx get svc ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
# create a CNAME: <domain> -> <that NLB hostname>; cert-manager then issues TLS.

# tear down
pulumi destroy
```

> **Wire the app to use IRSA + S3 (no static keys).** The Deployments in
> `config/manager/` must run under the IRSA ServiceAccounts this project creates —
> `synergyplus-apiserver` and `synergyplus-runner` (the operator should stamp the
> latter onto the RunnerPool's pod spec). Drop `S3_ACCESS_KEY`/`S3_SECRET_KEY`/
> `S3_ENDPOINT` from the env (the `synergyplus-env` Secret here already omits them):
> the AWS SDK picks up the IRSA web-identity token automatically and talks to real
> S3 in `S3_REGION`. The bucket names come from the Secret (`S3_BUCKET_*`).

---

## What's complete vs groundwork-stubbed

**Complete (type-checks; resources fully declared):**
- VPC + 2 public / 2 private subnets (EKS-tagged) + IGW + NAT + routes.
- EKS cluster, node IAM role, **managed node group**, **EBS CSI** addon, OIDC provider.
- **IRSA** roles + scoped S3 policies for apiserver + runner SAs (keyless).
- **S3** buckets (models/weather/results) with lifecycle TTL, SSE, versioning,
  public-access block.
- In-cluster **Postgres** StatefulSet on a gp3 PVC + Service + credentials Secret.
- The **`synergyplus-env`** Secret (DATABASE_URL → in-cluster PG, S3 bucket names +
  region, `SP_ALLOWED_ENGINE_VERSIONS`; **no static S3 keys**).
- IRSA-annotated **ServiceAccounts**, GHCR **imagePullSecret**, gp3 **StorageClass**.
- **KEDA** + **ingress-nginx** Helm releases (gated by `deployApp`).
- Stack outputs: kubeconfig, cluster name, OIDC ARN, bucket names, IRSA role ARNs,
  image refs.

**Groundwork-stubbed / documented-but-not-wired (deliberate, to keep scope clean):**
- **App Deployments (operator/apiserver/portal) + RunnerPool CRD** are applied from
  the repo's existing `config/` via `kubectl` (runbook step 4) rather than
  re-authored as Pulumi resources — they're owned by another track and change
  often. The pieces they depend on (SAs, Secret, Postgres) **are** created here.
- **cert-manager + Let's Encrypt**: documented; install via Helm + a ClusterIssuer
  (not yet a Pulumi resource).
- **GHCR pull secret** is only created when `ghcrUsername` + `ghcrToken` are set;
  the manifests still need `imagePullSecrets: [{name: ghcr-pull}]` referenced (or
  attached to the SAs) for private pulls.
- **Postgres HA/backups**: single replica, single EBS PV — no backup/restore yet
  (see trade-offs). A real install needs WAL archiving to S3 or an operator.
- **Node autoscaler** (cluster-autoscaler/Karpenter), **ALB option**, **multi-AZ
  NAT**, and **sealed-secrets/SOPS**: documented, not enabled.
- **`pulumi up` not run** — verified by `npx tsc --noEmit` only (no AWS creds / no
  spend, per the task).
