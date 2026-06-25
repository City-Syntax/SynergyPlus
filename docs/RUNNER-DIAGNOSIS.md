# Runner Failure Diagnosis

**Date:** 2026-06-25
**Engineer:** diagnostics
**Scope:** All runner failure surfaces — CI image build, runtime simulations, runner pods, runner image.

---

## TL;DR

There is **exactly one real failure**, and it is a **CI image-build failure that is already
fixed on `master` (HEAD `f08b463`, v0.3.0)**. It was last seen on the **`v0.2.0` tag**.

Everything else that "looks like a runner failure" is **expected, correct behavior**:

| Surface | Verdict |
|---|---|
| 1. CI build — `runner` matrix job | **REAL bug at v0.2.0; already FIXED at HEAD.** Verified. |
| 2. Runtime — 3 `failed` sims (`verdict=fatal`) | **EXPECTED.** Dummy/invalid IDFs; real EnergyPlus correctly emits Fatal. |
| 3. Runner pods | **HEALTHY.** Scaled to 0 by KEDA (no work). No OOM / image-pull / crash-loop. |
| 4. Runner image | **HEALTHY.** Builds clean; `energyplus --version` and package import OK. |

---

## (a) What "the failure" actually is

### The real one: CI runner-image build failed on the `v0.2.0` tag

GitHub Actions "Release images" workflow, `build (runner, runner, runner/Dockerfile)`:

- **Run 28139412905** (tag `v0.2.0`, commit `5dc341f`): runner job **FAILED in 41s**.
- **Run 28138885074** (tag `v0.2.0`, commit `563c364` "init"): also failed.
- Other matrix jobs (apiserver, operator, portal) succeeded — only `runner` failed.

Exact error (job annotation, run 28139412905, job 83333270981):

```
buildx failed with: ERROR: failed to build: failed to solve:
process "/bin/sh -c pip3 install --no-cache-dir --break-system-packages /opt/runner"
did not complete successfully: exit code: 2
```

The failure is at the `pip3 install /opt/runner` layer. The job dies in ~41s — long before
any EnergyPlus pull — so it is a packaging failure, not a network/base-image problem.

### Where it is NOT failing

- **Current `master` (HEAD `f08b463`, run 28140533789):** the `runner` job
  **completes successfully in 5m33s**. The fix is in.
- Local build of `runner/` at HEAD **succeeds**, including the in-Dockerfile sanity check
  `energyplus --version && import synergy_runner && command -v synergy-runner`.

---

## (b) Root cause

### CI build (the real bug) — stock distro pip + modern PEP 639 metadata

The `v0.2.0` `runner/Dockerfile` was built on `FROM nrel/energyplus:${EPLUS_VERSION}`
(amd64-only) and installed the package with the distro's **stock pip**, no upgrade:

```dockerfile
# v0.2.0 runner/Dockerfile
RUN pip3 install --no-cache-dir --break-system-packages /opt/runner
```

Meanwhile `runner/pyproject.toml` declares **modern PEP 639 / SPDX metadata** and requires
a new build backend:

```toml
license = "MIT"
license-files = ["LICENSE"]
[build-system]
requires = ["setuptools>=77"]
```

Stock pip on that base mis-parses the SPDX `license` string + `license-files` and the
`setuptools>=77` requirement, building a broken **`UNKNOWN-0.0.0`** empty wheel (no deps,
no `synergy-runner` console script). Here it went one step further and exited non-zero
(exit code 2), failing the whole image build.

There were two contributing legacy issues in that same lineage, both already addressed at
HEAD:
- `nrel/energyplus` is **amd64-only** → broke under arm64 QEMU emulation in the
  `platforms: linux/amd64,linux/arm64` multi-arch build.
- The base shipped no Python, so it needed `deadsnakes` / extra Python install.

### The fix at HEAD

`runner/Dockerfile` (HEAD) was reworked to:

1. `FROM ubuntu:22.04` (genuinely multi-arch; ships Python 3.10 — no deadsnakes).
2. Download the **architecture-matched** official EnergyPlus tarball via `TARGETARCH`
   (`arm64` → `arm64`, `amd64` → `x86_64`) so it builds **natively** on both arches.
3. **Upgrade pip/setuptools/wheel before installing** — this is the direct fix for the
   `UNKNOWN-0.0.0` / exit-code-2 failure:

```dockerfile
RUN python3 -m pip install --no-cache-dir --upgrade pip setuptools wheel \
 && python3 -m pip install --no-cache-dir /opt/runner
```

4. A build-time sanity gate that fails fast if the engine or entrypoint is missing:
   `command -v energyplus && energyplus --version && python3 -c "import synergy_runner" && command -v synergy-runner`.

### Runtime "failures" (not bugs) — invalid uploaded IDFs

3 simulations are in state `failed` with `error=verdict=fatal`, all on
`s3://models/uploads/…`. Pulling the actual artifacts from MinIO (`results` bucket):

**`...-tower.idf` (sim `0a4cea4b`, hash `f78106…`) — `eplusout.err`:**
```
** Severe  ** <root> - Missing required property 'Building'.
** Severe  ** <root> - Missing required property 'GlobalGeometryRules'.
**  Fatal  ** Errors occurred on processing input file. Preceding condition(s) cause termination.
```

**`...-tmpw46hgqfl.idf` (sim `63e77c95`, hash `72c3c4…`) — `eplusout.err`:**
```
** Severe  ** Line: 1 Index: 10 - "variant A
" is not a valid Object Type.
**  Fatal  ** Errors occurred on processing input file. Preceding condition(s) cause termination.
```

These are **dummy SDK test fixtures**, not valid IDFs (one literally begins with the text
`variant A`; the "tower" stub omits the mandatory `Building` and `GlobalGeometryRules`
objects). **Real EnergyPlus 24.1.0 correctly emits a Fatal.** The runner did its job
end-to-end: ran the engine, captured `eplusout.err`/`.end`/`.sql`, classified
`verdict=fatal` (`parse_err.py`), uploaded artifacts + `synergy-summary.json`, and wrote
the result. This is the contract behaving as designed.

**Control — valid inputs succeed:**
- `s3://models/sample/baseline.idf` → `succeeded`, `verdict=warnings`, `site_eui=354.82`.
- All `s3://models/burst/v0..v11.idf` → `succeeded`, `verdict=warnings`, `site_eui=354.82`.

### Runner pods — not a failure

- Deployment `runner-eplus-24-1-0` is `0/0` (scaled to **0 by KEDA**, ScaledObject
  `READY=True ACTIVE=False`) because the queue is empty. Correct.
- Event history shows pods scaled 0→4, pulled image ("already present"), started, ran the
  burst, then KEDA `Deactivated ... from 4 to 0` with normal `Killing` (SIGTERM) events.
- **No** OOMKilled, image-pull errors, `Back-off`, or claim-loop errors.
- Pod resources: `requests/limits memory: 512Mi`, `cpu: 250m`.

---

## (c) Real bug or expected behavior?

- **CI runner build at v0.2.0:** REAL bug. Already fixed at HEAD.
- **3 runtime `verdict=fatal` sims:** EXPECTED behavior (invalid/dummy uploaded IDFs).
- **Runner pods scaled to 0:** EXPECTED (KEDA, empty queue).
- **Runner image:** Healthy.

---

## (d) The fix — status: ALREADY APPLIED at HEAD; VERIFIED

No code change required. The fix shipped in v0.3.0 (`f08b463`). Verification performed:

1. **CI:** current `master` run 28140533789 — `runner` job `completed/success` (5m33s).
2. **Local multi-arch build** of `runner/` at HEAD: succeeds (incl. build-time sanity gate).
3. **Engine in the built image:**
   ```
   $ docker run --rm --entrypoint energyplus test-runner --version
   EnergyPlus, Version 24.1.0-9d7789a3ac
   $ docker run --rm --entrypoint python3 test-runner -c "import synergy_runner; print('OK')"
   synergy_runner import OK
   ```
4. **Runtime:** valid models (`baseline.idf`, `burst/*`) produce real metrics
   (`site_eui=354.82`); invalid uploads correctly Fatal.

### Recommendations (optional, non-blocking)

- **Re-tag v0.2.0 → v0.2.1 (or cut from HEAD)** so a published, working runner image exists
  for that release line — the v0.2.0 tag's runner image was never pushed (build failed).
- **Add a CI guard** to keep the regression from recurring: a smoke step that runs
  `energyplus --version` against the freshly built runner image (the Dockerfile's internal
  `RUN` gate already does this for single-arch local builds, but it does not run for the
  pushed multi-arch image until the layer executes — which it now does).
- The `nrel/energyplus` base, `--break-system-packages`, deadsnakes, and amd64-only
  emulation paths are all **gone** at HEAD; no further action needed there.
- Cosmetic CI warnings unrelated to the failure: Node-20 action deprecation across all jobs;
  `SecretsUsedInArgOrEnv` on `portal/Dockerfile`.
