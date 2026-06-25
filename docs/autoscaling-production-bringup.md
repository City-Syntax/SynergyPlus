# Production autoscaling bring-up — diagnosis & verification (v0.6.2)

Goal: get RunnerPool autoscaling working end-to-end in the EKS production
deployment (cluster `synergyplus`, SynergyPlusIAC `prod` stack). Status: **done
and verified**.

## Symptom

Jobs weren't starting. KEDA + the queue looked healthy, but no work ran.

## Root causes (four, layered)

1. **No RunnerPool existed.** KEDA scales an existing RunnerPool's Deployment on
   queue depth; with no pool, queued sims just sat there. → Added a declarative
   production RunnerPool (`deploy/overlays/prod/runnerpool.yaml`).

2. **Operator's runner-image default 404s.** Per ADR-0015 the operator defaults
   the runner image to `…/synergyplus-runner:<engineVersion>` (e.g. `:24.1.0`).
   CI (`release-images.yml`) only tags the runner image by **platform semver**
   (`:0.6.2`, `:latest`) — never by engine version — so the default resolves to a
   non-existent tag. → Pin `spec.image` on the prod RunnerPool + sample; corrected
   the overlay note. (Deeper fix is a follow-up: tag runner by engine version in
   CI, or change the operator default.)

3. **Runner pods had no AWS identity.** The operator created runner pods with no
   `serviceAccountName`, so they ran as the namespace `default` SA — no IRSA role —
   and every S3 fetch failed with `Unable to locate credentials`. → Operator now
   sets `serviceAccountName` from `SP_RUNNER_SERVICE_ACCOUNT` (PR #23); the prod
   `synergyplus-env` Secret sets it to the IRSA-annotated `synergyplus-runner` SA
   (SynergyPlusIAC). Default empty so local/OrbStack keeps `default` + static keys.

4. **Stale sims referenced logical bucket names.** Old test sims carried
   `s3://models/...` / `s3://weather/...` refs. The runner's `storage.py` uses the
   URI's `netloc` as the literal bucket (works on local MinIO, where buckets are
   literally `models`/`weather`/`results`). In real S3 those names are owned by
   other accounts → `403 Forbidden`. The apiserver's upload endpoint
   (`internal/api/uploads.go`) builds refs from `S3_BUCKET_*`, so **real API
   submissions get correct real-bucket refs** — only the old seed/test data was
   wrong. The sample inputs were also never uploaded to the prod buckets. → Uploaded
   `deploy/seed/sample/{baseline.idf,chicago.epw}` to the real model/weather
   buckets and rewrote the test sims' refs to the real buckets for verification.

### Also fixed along the way

- **Postgres kept getting evicted.** EKS Auto Mode consolidated nodes as runner
  pods scaled up/down, repeatedly moving the single Postgres pod (Multi-Attach EBS
  wait + DB downtime each time). → Added `karpenter.sh/do-not-disrupt: "true"` to
  the Postgres pod (SynergyPlusIAC) so Karpenter won't voluntarily disrupt its node.

## Rollout performed

- Cut release **v0.6.2** (all packages lockstep) — PR #23 (also folds in the
  portal mobile-sidebar change, #22). Tag `v0.6.2` → CI built images.
- Pinned prod overlay to `:0.6.2` — PR #24 — and `kubectl apply -k deploy/overlays/prod`.
- SynergyPlusIAC: `SP_RUNNER_SERVICE_ACCOUNT` + Postgres `do-not-disrupt`
  (`pulumi up`).

## Verification (the full autoscaling cycle)

Requeued 10 sims pointing at the real buckets:

```
[t=10s] pods_running=4 | running=4 succeeded=6
[t=20s] pods_running=8 | succeeded=10     # queue drained
```

- KEDA scaled the runner Deployment **0 → up** on queue depth.
- Runners fetched inputs from the real bucket via **IRSA** (no 403), ran
  **EnergyPlus** (full artifacts — `eplusout.eso/.csv/.err`, ~4 MB — in
  `s3://synergyplus-results-…/<contentHash>/`), and marked sims `succeeded`
  (verdict `warnings`). Duplicate content hashes deduped onto one results prefix
  (idempotency, ADR-0003).
- After the queue drained, KEDA scaled the Deployment back to **0** (scale-to-zero
  after the default 300s cooldown). ScaledObject: `READY=True ACTIVE=False`.

## Open follow-ups

- **SES is still in sandbox** — magic-link mail only reaches verified addresses.
  Request production access before onboarding real users.
- **Runner image tagging** — decide whether CI should tag the runner image by
  engine version (restoring ADR-0015's intent) or whether RunnerPools must always
  pin `spec.image` (current prod behaviour).
- **Scale factor** — the ScaledObject uses `targetQueryValue: 1` (one runner pod
  per eligible sim, up to `maxReplicas: 200`). Aggressive for large batches; tune
  if cost/throughput needs balancing.
- **Logical vs real bucket refs** — the local seeder writes `s3://models/...`
  logical refs that can't work against real S3. Fine for OrbStack; just don't seed
  those rows into a real cluster. Consider mapping logical→`S3_BUCKET_*` in the
  runner if portable refs are ever wanted.
- **60 leftover test sims** remain in `failed` (harmless, not eligible).
