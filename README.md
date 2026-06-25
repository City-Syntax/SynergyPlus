<p align="center">
  <img src="assets/logo/synergyplus.svg" alt="SynergyPlus" width="440">
</p>

<p align="center">
  A Kubernetes-native orchestrator for distributed <a href="https://energyplus.net/">EnergyPlus</a> simulations —<br>
  queue and run single runs or large parametric sweeps across on-prem and cloud capacity from one API.
</p>

## How it works

1. You submit a `Simulation` (or a `SimulationBatch` of thousands of variants)
   via the REST API or the Python SDK. Each becomes a row in a Postgres-backed
   work queue.
2. A dynamically-scaled pool of **runners** (a KEDA-driven `RunnerPool`) pulls
   queued simulations, runs the version-pinned EnergyPlus engine, extracts the
   core metrics, and uploads result artifacts to object storage.
3. You poll the simulation (or batch) until it reaches a terminal state and read
   back its verdict, metrics, and artifact URI.

## Quickstart (local stack)

The whole system runs locally with Docker Compose — Postgres, object storage
(MinIO), the API server, a runner, and the developer portal:

```bash
make up      # build + start the stack
make smoke   # end-to-end smoke test against it
make down    # stop (use `make clean` to also wipe data)
```

After `make up`:

- API → http://localhost:8090
- Portal → http://localhost:3000
- MinIO console → http://localhost:9001

## Running on Kubernetes

```bash
make keda         # install KEDA into the current cluster
make k8s-deploy   # apply CRDs, RBAC, the operator, and a sample RunnerPool
make k8s-undeploy # tear it back down
```

## Python SDK

```bash
pip install synergyplus
```

You only need your **API key** — no S3 credentials. Pass **local file paths**: the SDK
uploads them through short-lived **presigned URLs** the API mints with its own
credentials (which never leave the cluster), and downloads results the same way.

```python
from synergyplus import SynergyClient

sp = SynergyClient("http://localhost:8090", token="synergy-dev-key")

sim = sp.submit_simulation(
    engine_version="24.1.0",
    model="./baseline.idf",        # local file → uploaded via a presigned URL
    weather="./chicago.epw",
)

sp.wait(sim["id"])
print(sp.get_metrics(sim["id"]))           # site EUI, energy, unmet hours, …
sp.download_results(sim["id"], "./out/")   # result artifacts → local folder
```

This presigned, API-key-only flow is the **default**. If you have direct S3/MinIO
access you can instead pass `s3://…` refs (or `ArtifactRef`) and S3 credentials to
transfer directly — see [`sdk/python/README.md`](sdk/python/README.md) for both backends
and the full client reference.

## License

MIT — see [LICENSE](LICENSE).
