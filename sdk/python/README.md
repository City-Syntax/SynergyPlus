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

Requires Python 3.9+. `boto3` is an **optional** dependency — it is imported
lazily and only on the upload/download code path, so submitting `s3://...` refs
or `ArtifactRef`s never requires it.

## Quickstart (S3 refs)

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

## Worked example: local file → wait → download results

Pass **local filesystem paths** for `model`/`weather` and the SDK uploads them
to object storage, hashes them (sha256), and submits `{ref, sha256}` so the
content-hash cache works. Then download the result artifacts straight to disk.

```python
from synergyplus import SynergyClient

# S3 config can come from kwargs (shown) or env: S3_ENDPOINT / S3_ACCESS_KEY /
# S3_SECRET_KEY / S3_REGION.
sp = SynergyClient(
    "http://localhost:8090",
    token="synergy-dev-key",
    s3_endpoint="http://localhost:9000",   # omit on AWS to use the default endpoint
    s3_access_key="synergy",
    s3_secret_key="synergypass",
    s3_region="us-east-1",
)

# 1. Submit with LOCAL paths — uploaded to the models/ and weather/ buckets at
#    uploads/<sha256>-<basename>. Identical files are not re-uploaded.
sim = sp.submit_simulation(
    engine_version="24.1.0",
    model="./tower.idf",
    weather="./chicago.epw",
)

# 2. Wait for it to finish.
sp.wait(sim["id"])

# 3. Download every result artifact (eplusout.err, *.sql, synergy-summary.json,
#    ...) into a local directory; returns the local file paths.
paths = sp.download_results(sim["id"], "./out")
print(paths)

# 4. Or just grab the metrics dict.
print(sp.get_metrics(sim["id"]))   # {'site_eui': ..., 'total_site_energy': ..., ...}
```

Batches work the same way — a variant's `model` (and the shared `weather`) may be
a local path, an `s3://...` string, or an `ArtifactRef`; a local model repeated
across variants is hashed and uploaded only once (content-addressed).

## API

### `SynergyClient(base_url, token=None, timeout=30.0, *, s3_endpoint=None, s3_access_key=None, s3_secret_key=None, s3_region=None, storage=None)`

The `s3_*` kwargs configure direct object-storage access for local-file upload
and result download (each also falls back to the `S3_ENDPOINT` / `S3_ACCESS_KEY`
/ `S3_SECRET_KEY` / `S3_REGION` env vars). `storage=` lets you inject an
alternative `StorageBackend` (see *Production* below).

| Method | Description |
| --- | --- |
| `healthz()` | `GET /healthz` — returns `True` if the apiserver is up. |
| `submit_simulation(*, engine_version, model, weather, priority=None, extraction_spec=None)` | `POST /v1/simulations` → `{id, state}`. `model`/`weather` may be a local path (auto-uploaded), an `s3://...` string, or an `ArtifactRef`. |
| `get_simulation(sim_id)` | `GET /v1/simulations/{id}` → `{id, state, verdict?, result?}`. |
| `get_results(sim_id)` | `GET /v1/results/{simId}` → `{verdict, metrics, artifactUri}`. |
| `get_metrics(sim_id)` | Convenience → just the `metrics` dict (CONTRACT §5). |
| `download_results(sim_id, dest_dir)` | Download every artifact under the result's `artifactUri` (`s3://results/<hash>/`) into `dest_dir`; returns local file paths. Requires the `s3` extra. |
| `wait(sim_id, *, poll=2.0, deadline=None)` | Block until the simulation reaches a terminal state (`succeeded`/`failed`). |
| `submit_batch(*, engine_version, weather, variants, priority=None, max_parallelism=None, idempotency_key=None)` | `POST /v1/batches` → `{batchId, state}`. Variant `model` / shared `weather` may be local paths (auto-uploaded). |
| `get_batch(batch_id)` | `GET /v1/batches/{id}` → `{id, state, total, succeeded, failed}`. |
| `list_batch_simulations(batch_id, *, limit=100, offset=0)` | `GET /v1/batches/{id}/simulations` → `{items, total}`. |
| `upload_input(local_path, ref=None, *, bucket=None, prefix="uploads")` | Manually upload a local file → `ArtifactRef` (sha256). With `ref="s3://..."` uploads to that exact key; otherwise content-addressed into `bucket` (default `models`). Requires the `s3` extra. |

`model`/`weather`/variant `model` accept a **local path**, an `s3://...` string,
or an `ArtifactRef`. Local-path upload and `download_results` need S3 config +
the `s3` extra; a missing file, missing S3 config, or missing `boto3` raises a
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

## Production: presigned URLs (recommended)

The local-file upload/download implemented here talks to object storage
**directly with static S3 credentials**. That is great for local MinIO and for
AWS-with-credentials, but it is **not ideal for production**: handing every
researcher's laptop long-lived S3 keys is exactly the static-credential / no-IRSA
problem called out in the gap analysis.

The production-grade approach is **presigned upload/download URLs minted by the
apiserver**, so the researcher needs only their API key — no S3 credentials ever
leave the cluster:

- `POST /v1/uploads` → `{url, ref, fields?}` — the API issues a short-lived
  presigned `PUT` (or POST-policy) into the correct `models`/`weather` bucket;
  the SDK `PUT`s the file bytes to `url` and submits the returned `ref` + the
  locally computed sha256.
- `GET /v1/results/{id}/artifacts` (or adding presigned `download` URLs to the
  existing `GET /v1/results/{id}` payload) → a list of `{name, url}` short-lived
  `GET` URLs the SDK streams to disk.

This SDK is already structured for that swap: all S3/boto3 knowledge lives behind
the `StorageBackend` interface (`synergyplus/storage.py`), and `SynergyClient`
takes a `storage=` injection point. A future `PresignedURLBackend` implements the
same `upload_input` / `download_prefix` methods (calling the endpoints above with
the API key) and slots in behind the **unchanged** `submit_simulation` /
`download_results` methods — no caller changes, and `boto3` stops being needed on
the client at all.

## License

MIT — see [LICENSE](./LICENSE).
