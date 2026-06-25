# SynergyPlus Python SDK

`synergyplus` is the official Python client for the [SynergyPlus](https://github.com/City-Syntax/SynergyPlus)
distributed EnergyPlus runner. It wraps the apiserver's HTTP API for submitting
simulations and parametric batches, polling their state, and fetching results.

## Install

```bash
pip install synergyplus

# Optional: enable SynergyClient.upload_input() for pushing local model/weather
# files to S3-compatible storage (MinIO, AWS S3, ...).
pip install "synergyplus[s3]"
```

Requires Python 3.9+.

## Quickstart

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

## API

### `SynergyClient(base_url, token=None, timeout=30.0)`

| Method | Description |
| --- | --- |
| `healthz()` | `GET /healthz` — returns `True` if the apiserver is up. |
| `submit_simulation(*, engine_version, model, weather, priority=None, extraction_spec=None)` | `POST /v1/simulations` → `{id, state}`. |
| `get_simulation(sim_id)` | `GET /v1/simulations/{id}` → `{id, state, verdict?, result?}`. |
| `get_results(sim_id)` | `GET /v1/results/{simId}` → `{verdict, metrics, artifactUri}`. |
| `wait(sim_id, *, poll=2.0, deadline=None)` | Block until the simulation reaches a terminal state (`succeeded`/`failed`). |
| `submit_batch(*, engine_version, weather, variants, priority=None, max_parallelism=None, idempotency_key=None)` | `POST /v1/batches` → `{batchId, state}`. |
| `get_batch(batch_id)` | `GET /v1/batches/{id}` → `{id, state, total, succeeded, failed}`. |
| `list_batch_simulations(batch_id, *, limit=100, offset=0)` | `GET /v1/batches/{id}/simulations` → `{items, total}`. |
| `upload_input(local_path, ref, *, s3_endpoint=None, s3_region="us-east-1", s3_access_key=None, s3_secret_key=None)` | Upload a local file to an `s3://` ref and return an `ArtifactRef` with its sha256. Requires the `s3` extra. |

`model`/`weather` accept either an `s3://...` string or an `ArtifactRef`.

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

## License

MIT — see [LICENSE](./LICENSE).
