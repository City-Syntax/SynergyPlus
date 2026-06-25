"""HTTP client for the SynergyPlus apiserver (CONTRACT §3).

    from synergyplus import SynergyClient, ArtifactRef

    sp = SynergyClient("http://localhost:8090", token="synergy-dev-key")
    sim = sp.submit_simulation(
        engine_version="24.1.0",
        model=ArtifactRef("s3://models/sample/baseline.idf"),
        weather=ArtifactRef("s3://weather/sample/chicago.epw"),
    )
    sp.wait(sim["id"])
    print(sp.get_results(sim["id"]))
"""

from __future__ import annotations

import time
from typing import Optional, Sequence, Union
from urllib.parse import urlparse

import requests

from .models import ArtifactRef, Variant, as_ref, sha256_file

_TERMINAL = {"succeeded", "failed"}


class SynergyClient:
    def __init__(self, base_url: str, token: Optional[str] = None, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._session = requests.Session()
        if token:
            self._session.headers["Authorization"] = f"Bearer {token}"

    # -- health ----------------------------------------------------------------

    def healthz(self) -> bool:
        resp = self._session.get(f"{self.base_url}/healthz", timeout=self.timeout)
        return resp.ok

    # -- simulations -----------------------------------------------------------

    def submit_simulation(
        self,
        *,
        engine_version: str,
        model: Union[str, ArtifactRef],
        weather: Union[str, ArtifactRef],
        priority: Optional[int] = None,
        extraction_spec: Optional[dict] = None,
    ) -> dict:
        """POST /v1/simulations → ``{id, state}`` (CONTRACT §3)."""
        body: dict = {
            "engineVersion": engine_version,
            "model": as_ref(model),
            "weather": as_ref(weather),
        }
        if priority is not None:
            body["priority"] = priority
        if extraction_spec is not None:
            body["extractionSpec"] = extraction_spec

        resp = self._session.post(
            f"{self.base_url}/v1/simulations", json=body, timeout=self.timeout
        )
        resp.raise_for_status()
        return resp.json()

    def get_simulation(self, sim_id: str) -> dict:
        """GET /v1/simulations/{id} → ``{id, state, verdict?, result?}``."""
        resp = self._session.get(
            f"{self.base_url}/v1/simulations/{sim_id}", timeout=self.timeout
        )
        resp.raise_for_status()
        return resp.json()

    def get_results(self, sim_id: str) -> dict:
        """GET /v1/results/{simId} → ``{verdict, metrics, artifactUri}``."""
        resp = self._session.get(
            f"{self.base_url}/v1/results/{sim_id}", timeout=self.timeout
        )
        resp.raise_for_status()
        return resp.json()

    def wait(self, sim_id: str, *, poll: float = 2.0, deadline: Optional[float] = None) -> dict:
        """Block until the simulation reaches a terminal state (or the deadline)."""
        start = time.monotonic()
        while True:
            sim = self.get_simulation(sim_id)
            state = (sim.get("state") or "").lower()
            if state in _TERMINAL:
                return sim
            if deadline is not None and time.monotonic() - start > deadline:
                raise TimeoutError(f"simulation {sim_id} still {state!r} after {deadline}s")
            time.sleep(poll)

    # -- batches ---------------------------------------------------------------

    def submit_batch(
        self,
        *,
        engine_version: str,
        weather: Union[str, ArtifactRef],
        variants: Sequence[Union[Variant, dict]],
        priority: Optional[int] = None,
        max_parallelism: Optional[int] = None,
        idempotency_key: Optional[str] = None,
    ) -> dict:
        """POST /v1/batches → ``{batchId, state:"expanding"}`` (CONTRACT §3)."""
        body: dict = {
            "engineVersion": engine_version,
            "weather": as_ref(weather),
            "variants": [v.to_dict() if isinstance(v, Variant) else v for v in variants],
        }
        if priority is not None:
            body["priority"] = priority
        if max_parallelism is not None:
            body["maxParallelism"] = max_parallelism
        if idempotency_key is not None:
            body["idempotencyKey"] = idempotency_key

        resp = self._session.post(
            f"{self.base_url}/v1/batches", json=body, timeout=self.timeout
        )
        resp.raise_for_status()
        return resp.json()

    def get_batch(self, batch_id: str) -> dict:
        """GET /v1/batches/{id} → ``{id, state, total, succeeded, failed}``."""
        resp = self._session.get(
            f"{self.base_url}/v1/batches/{batch_id}", timeout=self.timeout
        )
        resp.raise_for_status()
        return resp.json()

    def list_batch_simulations(self, batch_id: str, *, limit: int = 100, offset: int = 0) -> dict:
        """GET /v1/batches/{id}/simulations → ``{items:[...], total}``."""
        resp = self._session.get(
            f"{self.base_url}/v1/batches/{batch_id}/simulations",
            params={"limit": limit, "offset": offset},
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()

    # -- input upload convenience ---------------------------------------------

    def upload_input(
        self,
        local_path: str,
        ref: str,
        *,
        s3_endpoint: Optional[str] = None,
        s3_region: str = "us-east-1",
        s3_access_key: Optional[str] = None,
        s3_secret_key: Optional[str] = None,
    ) -> ArtifactRef:
        """Upload a local model/weather file to ``ref`` (``s3://bucket/key``) via
        boto3 and return an :class:`ArtifactRef` carrying its sha256.

        boto3 is imported lazily so the rest of the SDK has no hard dependency.
        """
        import boto3  # lazy

        parsed = urlparse(ref)
        if parsed.scheme != "s3":
            raise ValueError(f"upload_input requires an s3:// ref, got {ref!r}")
        bucket, key = parsed.netloc, parsed.path.lstrip("/")

        client = boto3.client(
            "s3",
            endpoint_url=s3_endpoint,
            region_name=s3_region,
            aws_access_key_id=s3_access_key,
            aws_secret_access_key=s3_secret_key,
        )
        client.upload_file(local_path, bucket, key)
        return ArtifactRef(ref=ref, sha256=sha256_file(local_path))
