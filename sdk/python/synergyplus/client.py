"""HTTP client for the SynergyPlus apiserver (CONTRACT §3).

Researchers can pass **local filesystem paths** for ``model``/``weather`` and the
client uploads them to object storage transparently, and can **download result
artifacts** straight to a local directory:

    from synergyplus import SynergyClient

    sp = SynergyClient("http://localhost:8090", token="synergy-dev-key")
    sim = sp.submit_simulation(
        engine_version="24.1.0",
        model="./tower.idf",            # local path → uploaded automatically
        weather="./chicago.epw",        # local path → uploaded automatically
    )
    sp.wait(sim["id"])
    paths = sp.download_results(sim["id"], "./out")   # → list of local files
    print(sp.get_metrics(sim["id"]))                  # → metrics dict

``model``/``weather`` still accept ``s3://...`` strings and :class:`ArtifactRef`
unchanged.

**Backend selection.** With no S3 endpoint/creds configured (the example above),
local-file upload and result download go through the apiserver's presigned-URL
endpoints using **only the API key** — no boto3, no S3 credentials. Supplying any
of ``s3_endpoint``/``s3_access_key``/``s3_secret_key`` (or the ``S3_*`` env vars)
switches to the direct-S3 backend (static creds, ``pip install 'synergyplus[s3]'``).
Either way the call sites are identical.
"""

from __future__ import annotations

import time
from typing import List, Optional, Sequence, Union

import requests

from .models import ArtifactRef, Variant, as_ref, is_local_path, sha256_file
from .storage import (
    PresignedURLBackend,
    ResultLocation,
    S3StorageBackend,
    StorageBackend,
    StorageError,
)

import os

_TERMINAL = {"succeeded", "failed"}

# Default bucket per input kind (CONTRACT §4).
_BUCKET_MODELS = "models"
_BUCKET_WEATHER = "weather"


def _s3_configured(endpoint, access_key, secret_key) -> bool:
    """True if any direct-S3 configuration is present (kwargs or env). When false,
    the client is API-key-only and uses the presigned-URL backend (B2)."""
    return any(
        [
            endpoint or os.environ.get("S3_ENDPOINT"),
            access_key or os.environ.get("S3_ACCESS_KEY"),
            secret_key or os.environ.get("S3_SECRET_KEY"),
        ]
    )


class SynergyClient:
    def __init__(
        self,
        base_url: str,
        token: Optional[str] = None,
        timeout: float = 30.0,
        *,
        s3_endpoint: Optional[str] = None,
        s3_access_key: Optional[str] = None,
        s3_secret_key: Optional[str] = None,
        s3_region: Optional[str] = None,
        storage: Optional[StorageBackend] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._session = requests.Session()
        if token:
            self._session.headers["Authorization"] = f"Bearer {token}"

        # Storage backend for local-file upload / result download.
        #
        # Selection (ACCEPTANCE B2):
        #   * an injected ``storage=`` backend always wins;
        #   * else, if any S3 endpoint/creds are configured (kwargs or env), use
        #     the direct-S3 backend (boto3, static creds);
        #   * else (API-key-only researcher), use the presigned-URL backend, which
        #     needs no boto3 and no S3 credentials — only the API key.
        if storage is not None:
            self._storage: StorageBackend = storage
        elif _s3_configured(s3_endpoint, s3_access_key, s3_secret_key):
            self._storage = S3StorageBackend(
                endpoint=s3_endpoint,
                access_key=s3_access_key,
                secret_key=s3_secret_key,
                region=s3_region,
            )
        else:
            self._storage = PresignedURLBackend(self.base_url, self._session, timeout=timeout)

    # -- input resolution ------------------------------------------------------

    def _resolve_input(
        self, value: Union[str, ArtifactRef], bucket: str
    ) -> Union[str, ArtifactRef]:
        """Turn a local path into an uploaded :class:`ArtifactRef`.

        ``s3://`` strings and existing :class:`ArtifactRef` values pass through
        unchanged so the apiserver content-hash cache behaves exactly as before.
        """
        if not is_local_path(value):
            return value
        ref, digest = self._storage.upload_input(str(value), bucket)
        return ArtifactRef(ref=ref, sha256=digest)

    def _resolve_variant(self, v: Union[Variant, dict]) -> dict:
        """Resolve a batch variant's model (local paths uploaded) → request dict.

        Accepts a :class:`Variant` or a raw dict. For dicts, ``model`` may be a
        bare string (``"./a.idf"`` or ``"s3://..."``) or a ``{ref, sha256?}``
        mapping; only bare local-path strings trigger an upload.
        """
        if isinstance(v, Variant):
            return Variant(
                model=self._resolve_input(v.model, _BUCKET_MODELS), name=v.name
            ).to_dict()

        out = dict(v)
        model = out.get("model")
        if isinstance(model, str) and is_local_path(model):
            out["model"] = as_ref(self._resolve_input(model, _BUCKET_MODELS))
        return out

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
        """POST /v1/simulations → ``{id, state}`` (CONTRACT §3).

        ``model``/``weather`` accept an ``s3://...`` string, an
        :class:`ArtifactRef`, **or a local filesystem path** (e.g.
        ``"./tower.idf"``). Local paths are uploaded to the ``models``/``weather``
        bucket, sha256-hashed, and submitted as ``{ref, sha256}`` so the
        content-hash cache works (CONTRACT §2.1). Identical files are not
        re-uploaded. Local-path upload needs S3 config + boto3.
        """
        model = self._resolve_input(model, _BUCKET_MODELS)
        weather = self._resolve_input(weather, _BUCKET_WEATHER)
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

    def get_metrics(self, sim_id: str) -> dict:
        """Convenience: just the metrics dict for *sim_id* (CONTRACT §5).

        Equivalent to ``get_results(sim_id)["metrics"]`` — keys like
        ``site_eui``, ``total_site_energy``, ``run_seconds``.
        """
        return self.get_results(sim_id).get("metrics") or {}

    def download_results(self, sim_id: str, dest_dir: str) -> List[str]:
        """Download every result artifact for *sim_id* into *dest_dir*.

        Resolves the result's ``artifactUri`` (``s3://results/<content_hash>/``,
        CONTRACT §4) via ``GET /v1/results/{id}``, then downloads all objects
        under that prefix — ``eplusout.err``, ``*.sql``, ``synergy-summary.json``,
        etc. Returns the list of local file paths written.

        Needs S3 config + boto3 (same as local-path upload). Raises
        :class:`~synergyplus.storage.StorageError` if no artifacts are present
        (e.g. a failed run that produced none).
        """
        results = self.get_results(sim_id)
        uri = results.get("artifactUri")
        # The presigned backend keys off sim_id (it lists per-result GETs); the
        # direct-S3 backend keys off the artifactUri. ResultLocation carries both
        # so this call is identical for either backend (B2).
        location = ResultLocation(sim_id=sim_id, artifact_uri=uri)
        return self._storage.download_result(location, dest_dir)

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
        """POST /v1/batches → ``{batchId, state:"expanding"}`` (CONTRACT §3).

        ``weather`` and each variant's ``model`` accept ``s3://...`` strings,
        :class:`ArtifactRef`, or **local paths** — local paths are uploaded
        transparently (see :meth:`submit_simulation`). A local model that repeats
        across variants is hashed and uploaded only once (content-addressed).
        """
        weather = self._resolve_input(weather, _BUCKET_WEATHER)
        body: dict = {
            "engineVersion": engine_version,
            "weather": as_ref(weather),
            "variants": [
                self._resolve_variant(v) for v in variants
            ],
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
        ref: Optional[str] = None,
        *,
        bucket: Optional[str] = None,
        prefix: str = "uploads",
    ) -> ArtifactRef:
        """Upload a local model/weather file and return an :class:`ArtifactRef`
        carrying its sha256. Mostly you don't need this — just pass a local path
        to :meth:`submit_simulation` / :meth:`submit_batch`.

        Two modes:

        * ``upload_input(path)`` or ``upload_input(path, bucket="models")`` —
          content-addressed upload to ``s3://{bucket}/{prefix}/{sha256}-{name}``
          (skips re-upload of identical content). Defaults to the ``models``
          bucket.
        * ``upload_input(path, "s3://bucket/key")`` — upload to an explicit
          ``s3://`` destination (backward-compatible form).

        Uses the client's configured storage backend; needs S3 config + boto3.
        """
        if ref is not None:
            from .storage import parse_s3_uri  # explicit-destination form

            dest_bucket, key = parse_s3_uri(ref)
            backend = self._storage
            if not isinstance(backend, S3StorageBackend):
                raise StorageError(
                    "explicit-ref upload_input(path, 's3://...') requires the "
                    "default S3 storage backend"
                )
            client = backend._s3()  # noqa: SLF001 - same package
            backend._ensure_bucket(dest_bucket)  # noqa: SLF001
            if not __import__("os").path.isfile(local_path):
                raise StorageError(f"local file not found: {local_path!r}")
            client.upload_file(local_path, dest_bucket, key)
            return ArtifactRef(ref=ref, sha256=sha256_file(local_path))

        uploaded_ref, digest = self._storage.upload_input(
            local_path, bucket or _BUCKET_MODELS, prefix=prefix
        )
        return ArtifactRef(ref=uploaded_ref, sha256=digest)
