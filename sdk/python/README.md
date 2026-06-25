# SynergyPlus Python SDK

`synergyplus` is the official Python client for the [SynergyPlus](https://github.com/City-Syntax/SynergyPlus)
distributed EnergyPlus runner. It wraps the apiserver's HTTP API for submitting
simulations and parametric batches, polling their state, and fetching results.

## Install

```bash
pip install synergyplus

# Optional: enable local-file upload (submit a "./model.idf" path) and result
# download (download_results) against S3-compatible storage (MinIO, AWS S3, ...).
pip install "synergyplus[s3]"
```

Requires Python 3.9+. `boto3` is an **optional** dependency, needed **only** for
the direct-S3 backend (see below). The default, API-key-only backend uses plain
`requests` and never imports `boto3`.

## File transfer: two backends (API-key-only by default)

Local-file upload (`submit_simulation(model="./f.idf")`) and result download
(`download_results`) go through a pluggable `StorageBackend`. The client picks
one automatically:

| When | Backend | What it uses |
| --- | --- | --- |
| **No S3 endpoint/creds configured** (default) | `PresignedURLBackend` | The apiserver's `POST /v1/uploads` + `GET /v1/results/{id}/artifacts` endpoints, then plain HTTP `PUT`/`GET`. **Only the API key** — no S3 credentials, no `boto3`. |
| S3 endpoint/creds given (kwargs or `S3_*` env) | `S3StorageBackend` | Direct S3 with static credentials (needs the `s3` extra / `boto3`). |
| `storage=` injected | your backend | always wins. |

`submit_simulation(...)` and `download_results(...)` behave **identically** on
either backend — no caller changes.

**No-static-keys posture (recommended for production):** with the default
presigned backend, the researcher's machine holds only its API key. The apiserver
mints short-lived presigned URLs (default 5 min) with its **own** S3 credentials,
which never leave the cluster — closing the static-credential / no-IRSA gap. A
minted upload URL is bound to one bucket+key; download URLs only expose the
caller's own result prefix.

## Quickstart (API key only — recommended)

No S3 credentials on the client. Pass **local paths**; the SDK uploads them via
the apiserver's presigned-URL endpoints and downloads results the same way.

```python
from synergyplus import SynergyClient

# Only the API key — no s3_* kwargs, no S3 env. The client auto-selects the
# presigned-URL backend (no boto3 needed).
sp = SynergyClient("http://localhost:8090", token="synergy-dev-key")

sim = sp.submit_simulation(
    engine_version="24.1.0",
    model="./baseline.idf",      # local path → presigned PUT upload
    weather="./chicago.epw",
)
sp.wait(sim["id"])
paths = sp.download_results(sim["id"], "./out")  # presigned GETs → local files
print(sp.get_metrics(sim["id"]))
```

You can still pass `s3://...` strings or `ArtifactRef`s directly:

```python
from synergyplus import SynergyClient, ArtifactRef

sp = SynergyClient("http://localhost:8090", token="synergy-dev-key")
sim = sp.submit_simulation(
    engine_version="24.1.0",
    model=ArtifactRef("s3://models/sample/baseline.idf"),
    weather=ArtifactRef("s3://weather/sample/chicago.epw"),
)
sp.wait(sim["id"])
print(sp.get_results(sim["id"]))
```

## Direct-S3 opt-in (local MinIO / AWS-with-creds)

When you *do* configure S3 (kwargs or `S3_ENDPOINT` / `S3_ACCESS_KEY` /
`S3_SECRET_KEY` / `S3_REGION` env), the client uses the direct-S3 backend
instead, transferring files straight to object storage with static credentials.
This needs the `s3` extra (`pip install "synergyplus[s3]"`).

```python
from synergyplus import SynergyClient

# Configuring s3_* selects the direct-S3 backend (boto3, static creds).
sp = SynergyClient(
    "http://localhost:8090",
    token="synergy-dev-key",
    s3_endpoint="http://localhost:9000",   # omit on AWS to use the default endpoint
    s3_access_key="synergy",
    s3_secret_key="synergypass",
    s3_region="us-east-1",
)

sim = sp.submit_simulation(engine_version="24.1.0", model="./tower.idf", weather="./chicago.epw")
sp.wait(sim["id"])
paths = sp.download_results(sim["id"], "./out")
print(sp.get_metrics(sim["id"]))   # {'site_eui': ..., 'total_site_energy': ..., ...}
```

Either backend uploads to `uploads/<sha256>-<basename>` (content-addressed;
identical files aren't re-uploaded) and submits `{ref, sha256}` so the
content-hash cache works. Batches work the same way — a variant's `model` (and
the shared `weather`) may be a local path, an `s3://...` string, or an
`ArtifactRef`.

## API

### `SynergyClient(base_url, token=None, timeout=30.0, *, s3_endpoint=None, s3_access_key=None, s3_secret_key=None, s3_region=None, storage=None)`

With **no** `s3_*` kwargs/env (and no `storage=`), the client uses the
API-key-only presigned backend — the default. Supplying any of the `s3_*` kwargs
(each also falls back to `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` /
`S3_REGION`) switches to the direct-S3 backend (needs the `s3` extra). `storage=`
injects an alternative `StorageBackend` and always wins (see *How the presigned
backend works* below).

| Method | Description |
| --- | --- |
| `healthz()` | `GET /healthz` — returns `True` if the apiserver is up. |
| `submit_simulation(*, engine_version, model, weather, priority=None, extraction_spec=None)` | `POST /v1/simulations` → `{id, state}`. `model`/`weather` may be a local path (auto-uploaded), an `s3://...` string, or an `ArtifactRef`. |
| `get_simulation(sim_id)` | `GET /v1/simulations/{id}` → `{id, state, verdict?, result?}`. |
| `get_results(sim_id)` | `GET /v1/results/{simId}` → `{verdict, metrics, artifactUri}`. |
| `get_metrics(sim_id)` | Convenience → just the `metrics` dict (CONTRACT §5). |
| `download_results(sim_id, dest_dir)` | Download every result artifact into `dest_dir`; returns local file paths. Presigned backend: via `GET /v1/results/{id}/artifacts`. Direct-S3: under the `artifactUri` prefix (needs the `s3` extra). |
| `wait(sim_id, *, poll=2.0, deadline=None)` | Block until the simulation reaches a terminal state (`succeeded`/`failed`). |
| `submit_batch(*, engine_version, weather, variants, priority=None, max_parallelism=None, idempotency_key=None)` | `POST /v1/batches` → `{batchId, state}`. Variant `model` / shared `weather` may be local paths (auto-uploaded). |
| `get_batch(batch_id)` | `GET /v1/batches/{id}` → `{id, state, total, succeeded, failed}`. |
| `list_batch_simulations(batch_id, *, limit=100, offset=0)` | `GET /v1/batches/{id}/simulations` → `{items, total}`. |
| `upload_input(local_path, ref=None, *, bucket=None, prefix="uploads")` | Manually upload a local file → `ArtifactRef` (sha256). Content-addressed into `bucket` (default `models`); the explicit `ref="s3://..."` form is direct-S3 only (needs the `s3` extra). |

`model`/`weather`/variant `model` accept a **local path**, an `s3://...` string,
or an `ArtifactRef`. With the default presigned backend, local-path upload and
`download_results` need only the API key (no `boto3`); with the direct-S3 backend
they need S3 config + the `s3` extra. A missing file or transfer failure raises a
clear `StorageError`.

### Batch example

```python
from synergyplus import SynergyClient, ArtifactRef, Variant

sp = SynergyClient("http://localhost:8090", token="synergy-dev-key")

batch = sp.submit_batch(
    engine_version="24.1.0",
    weather=ArtifactRef("s3://weather/sample/chicago.epw"),
    variants=[
        Variant(model=ArtifactRef("s3://models/a.idf")),
        Variant(model=ArtifactRef("s3://models/b.idf")),
    ],
    max_parallelism=8,
)
print(batch["batchId"])
```

## How the presigned (default) backend works

`PresignedURLBackend` (`synergyplus/storage.py`) needs only the API key — **no
boto3, no S3 credentials**:

- **Upload** — `POST /v1/uploads {kind, filename, sha256}` → `{url, ref, method,
  headers?, expiresIn}`. The apiserver mints a short-lived presigned `PUT` into
  the correct `models`/`weather` bucket; the SDK `PUT`s the file bytes to `url`
  (plain HTTP) and submits the returned `ref` + the locally computed `sha256` (so
  the content-hash cache works).
- **Download** — `GET /v1/results/{id}/artifacts` → `{artifacts:[{name, url}]}`,
  a list of short-lived presigned `GET` URLs the SDK streams to disk.

The apiserver signs these URLs with its **own** S3 credentials (which never leave
the cluster) against the client-reachable host, and bounds them to one bucket+key
(upload) / the caller's own result prefix (download), with a short expiry. Inject
your own `StorageBackend` via `storage=` if you need different behavior.

## License

MIT — see [LICENSE](./LICENSE).
