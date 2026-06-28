"""Object-storage backend for direct local-file upload / result download.

The SDK lets researchers pass *local filesystem paths* to ``submit_simulation``
and download result artifacts to a local directory. Both need to talk to the
S3-compatible object store (MinIO locally, AWS S3 in the cloud).

This module isolates **all** S3/boto3 knowledge behind a small interface so the
rest of the SDK never imports boto3 directly:

    StorageBackend
      ├─ upload_input(local_path, bucket, *, prefix) -> (ref, sha256)
      └─ download_result(ResultLocation, dest_dir)   -> [local paths]

``S3StorageBackend`` is the concrete implementation that uses static S3
credentials (works for local MinIO and AWS-with-creds). It is intentionally the
*only* place boto3 is imported, and that import is lazy (deferred to first use)
so plain ``pip install synergyplus`` users who only submit ``s3://`` refs never
need boto3.

``PresignedURLBackend`` is the API-key-only implementation that asks the
apiserver to mint short-lived upload/download URLs — so the researcher needs
only their API key, no static S3 credentials. Both backends implement the same
:class:`StorageBackend` interface and slot in transparently behind the
``SynergyClient`` methods.
"""

from __future__ import annotations

import os
from typing import List, Optional, Tuple
from urllib.parse import urlparse

import requests

from .models import sha256_file


class StorageError(RuntimeError):
    """Raised for storage configuration / transfer problems with a clear message."""


def parse_s3_uri(uri: str) -> Tuple[str, str]:
    """Split ``s3://bucket/key`` into ``(bucket, key)``.

    Raises :class:`StorageError` if *uri* is not an ``s3://`` URI.
    """
    parsed = urlparse(uri)
    if parsed.scheme != "s3":
        raise StorageError(f"expected an s3:// URI, got {uri!r}")
    bucket = parsed.netloc
    key = parsed.path.lstrip("/")
    if not bucket:
        raise StorageError(f"s3:// URI is missing a bucket: {uri!r}")
    return bucket, key


class ResultLocation:
    """Identifies a finished simulation's artifacts, carrying *both* coordinates a
    backend might need: the ``sim_id`` (presigned backend asks the apiserver to
    mint per-result GET URLs) and the ``artifact_uri`` (``s3://results/<hash>/``,
    used by the direct-S3 backend). The client fills both in; each backend reads
    whichever it needs, so ``download_results`` is identical across backends (B2).
    """

    def __init__(self, sim_id: str, artifact_uri: Optional[str] = None) -> None:
        self.sim_id = sim_id
        self.artifact_uri = artifact_uri


class StorageBackend:
    """Interface every storage backend implements.

    Implemented by :class:`S3StorageBackend` (direct S3 with static creds) and
    :class:`PresignedURLBackend` (API-key-only, via the apiserver endpoints).
    """

    def upload_input(
        self, local_path: str, bucket: str, *, prefix: str = "uploads"
    ) -> Tuple[str, str]:  # pragma: no cover - interface
        """Upload *local_path* into *bucket* and return ``(s3_ref, sha256)``."""
        raise NotImplementedError

    def download_result(self, location: ResultLocation, dest_dir: str) -> List[str]:  # pragma: no cover
        """Download every artifact for *location* into *dest_dir*; return local paths."""
        raise NotImplementedError


class S3StorageBackend(StorageBackend):
    """Direct S3 transfers using static credentials (boto3, lazily imported).

    Configuration resolves in this order for each value: explicit kwarg →
    environment variable (``S3_ENDPOINT`` / ``S3_ACCESS_KEY`` / ``S3_SECRET_KEY``
    / ``S3_REGION``) → boto3/AWS defaults. For local MinIO supply the endpoint
    and the dev key/secret; on AWS the endpoint can be omitted and credentials
    can come from the standard AWS chain.
    """

    def __init__(
        self,
        *,
        endpoint: Optional[str] = None,
        access_key: Optional[str] = None,
        secret_key: Optional[str] = None,
        region: Optional[str] = None,
    ) -> None:
        self.endpoint = endpoint or os.environ.get("S3_ENDPOINT")
        self.access_key = access_key or os.environ.get("S3_ACCESS_KEY")
        self.secret_key = secret_key or os.environ.get("S3_SECRET_KEY")
        self.region = region or os.environ.get("S3_REGION") or "us-east-1"
        self._client = None  # lazily built on first transfer

    # -- boto3 plumbing -------------------------------------------------------

    def _s3(self):
        """Build (once) and return the boto3 S3 client, with friendly errors."""
        if self._client is not None:
            return self._client
        try:
            import boto3  # lazy: only needed on the upload/download path
        except ImportError as exc:  # pragma: no cover - depends on env
            raise StorageError(
                "boto3 is required for local-file upload/download but is not "
                "installed. Install it with:  pip install 'synergyplus[s3]'"
            ) from exc

        self._client = boto3.client(
            "s3",
            endpoint_url=self.endpoint,
            region_name=self.region,
            aws_access_key_id=self.access_key,
            aws_secret_access_key=self.secret_key,
        )
        return self._client

    def _ensure_bucket(self, bucket: str) -> None:
        """Create *bucket* if it does not already exist (idempotent)."""
        client = self._s3()
        try:
            from botocore.exceptions import ClientError
        except ImportError:  # pragma: no cover
            ClientError = Exception  # type: ignore[assignment]
        try:
            client.head_bucket(Bucket=bucket)
        except Exception:  # noqa: BLE001 - head_bucket 404/403 → try create
            try:
                client.create_bucket(Bucket=bucket)
            except Exception:  # noqa: BLE001 - racey/exists/forbidden: best-effort
                pass

    # -- StorageBackend -------------------------------------------------------

    def upload_input(
        self, local_path: str, bucket: str, *, prefix: str = "uploads"
    ) -> Tuple[str, str]:
        """Upload *local_path* to ``s3://{bucket}/{prefix}/{sha256}-{basename}``.

        The content's sha256 is part of the key, so an identical file always
        maps to the same object; if that object already exists the upload is
        skipped (content-addressed dedupe). Returns ``(s3_ref, sha256)``; the
        sha256 feeds the apiserver's content-hash cache (CONTRACT §2.1).
        """
        if not os.path.isfile(local_path):
            raise StorageError(f"local file not found: {local_path!r}")

        digest = sha256_file(local_path)
        basename = os.path.basename(local_path)
        key = f"{prefix.strip('/')}/{digest}-{basename}"
        ref = f"s3://{bucket}/{key}"

        client = self._s3()
        self._ensure_bucket(bucket)

        # Skip re-upload if a byte-identical object already exists.
        try:
            client.head_object(Bucket=bucket, Key=key)
            return ref, digest
        except Exception:  # noqa: BLE001 - not present (404) → upload below
            pass

        try:
            client.upload_file(local_path, bucket, key)
        except Exception as exc:  # noqa: BLE001
            raise StorageError(
                f"failed to upload {local_path!r} to {ref}: {exc}"
            ) from exc
        return ref, digest

    def download_result(self, location: "ResultLocation", dest_dir: str) -> List[str]:
        """Download every artifact under the result's ``artifact_uri`` into
        *dest_dir* (direct S3). Returns the local file paths written.
        """
        if not location.artifact_uri:
            raise StorageError(
                f"simulation {location.sim_id} has no artifactUri yet; is it finished?"
            )
        return self._download_prefix(location.artifact_uri, dest_dir)

    def _download_prefix(self, s3_uri: str, dest_dir: str) -> List[str]:
        """Download every object under *s3_uri* (an ``s3://bucket/prefix``) into
        *dest_dir*, preserving the key path below the prefix. Returns the local
        file paths written.
        """
        bucket, prefix = parse_s3_uri(s3_uri)
        client = self._s3()
        os.makedirs(dest_dir, exist_ok=True)

        paginator = client.get_paginator("list_objects_v2")
        written: List[str] = []
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if key.endswith("/"):
                    continue  # pseudo-directory marker
                rel = key[len(prefix):].lstrip("/") if prefix else key
                rel = rel or os.path.basename(key)
                local = os.path.join(dest_dir, rel)
                os.makedirs(os.path.dirname(local) or dest_dir, exist_ok=True)
                client.download_file(bucket, key, local)
                written.append(local)

        if not written:
            raise StorageError(f"no objects found under {s3_uri}")
        return written


class PresignedURLBackend(StorageBackend):
    """API-key-only storage backend — **no boto3, no S3 credentials**.

    All transfers go through the apiserver's presigned-URL endpoints plus plain
    HTTP ``PUT``/``GET`` (ACCEPTANCE B1):

    * ``upload_input`` → ``POST /v1/uploads`` mints a short-lived presigned PUT;
      the file bytes are PUT straight to object storage at the returned URL.
    * ``download_result(ResultLocation, dest_dir)`` →
      ``GET /v1/results/{sim_id}/artifacts`` returns short-lived presigned GET
      URLs for every artifact; each is streamed to disk.

    The S3 credentials never leave the cluster: the only secret this backend holds
    is the researcher's API key (carried by the shared ``requests`` session). The
    sha256 is still computed locally and submitted so the content-hash cache works
    (ACCEPTANCE B4).

    The presigned GETs are scoped per-result by the apiserver, so
    ``download_result`` keys off ``location.sim_id`` (the ``artifact_uri`` is
    unused here).
    """

    # Maps the bucket name a caller passes to upload_input → the endpoint's kind.
    _BUCKET_KIND = {"models": "model", "weather": "weather"}

    def __init__(self, base_url: str, session: "requests.Session", timeout: float = 60.0) -> None:
        self.base_url = base_url.rstrip("/")
        self._session = session  # carries Authorization: Bearer <api key>
        self.timeout = timeout

    # -- StorageBackend -------------------------------------------------------

    def upload_input(
        self, local_path: str, bucket: str, *, prefix: str = "uploads"
    ) -> Tuple[str, str]:
        """Upload *local_path* via a presigned PUT; return ``(s3_ref, sha256)``.

        The bucket is mapped to the endpoint's ``kind`` (``models``→``model``,
        ``weather``→``weather``). The sha256 is computed locally and sent so the
        apiserver mints a content-addressed key and the cache stays correct (B4).
        """
        if not os.path.isfile(local_path):
            raise StorageError(f"local file not found: {local_path!r}")

        kind = self._BUCKET_KIND.get(bucket)
        if kind is None:
            raise StorageError(
                f"presigned upload supports the models/weather buckets, got {bucket!r}"
            )

        digest = sha256_file(local_path)
        basename = os.path.basename(local_path)

        minted = self._mint_upload(kind, basename, digest)
        url = minted.get("url")
        ref = minted.get("ref")
        method = (minted.get("method") or "PUT").upper()
        headers = minted.get("headers") or {}
        if not url or not ref:
            raise StorageError(f"apiserver returned an incomplete upload mint: {minted!r}")

        # Plain HTTP PUT of the bytes to object storage — no S3 creds, no boto3.
        with open(local_path, "rb") as fh:
            try:
                resp = requests.request(
                    method, url, data=fh, headers=headers, timeout=self.timeout
                )
            except requests.RequestException as exc:
                raise StorageError(f"failed to upload {local_path!r} to presigned URL: {exc}") from exc
        if not resp.ok:
            raise StorageError(
                f"presigned upload of {local_path!r} failed: {resp.status_code} {resp.text[:200]}"
            )
        return ref, digest

    def download_result(self, location: "ResultLocation", dest_dir: str) -> List[str]:
        """Download every artifact for the result via presigned GETs.

        Returns the local file paths written.
        """
        sim_id = location.sim_id
        artifacts = self._list_artifacts(sim_id)
        if not artifacts:
            raise StorageError(f"no artifacts found for simulation {sim_id}")

        os.makedirs(dest_dir, exist_ok=True)
        written: List[str] = []
        for art in artifacts:
            name = art.get("name")
            url = art.get("url")
            if not name or not url:
                continue
            # Names are relative to the result prefix; keep subdirs, block escape.
            rel = name.lstrip("/")
            local = os.path.normpath(os.path.join(dest_dir, rel))
            if not os.path.abspath(local).startswith(os.path.abspath(dest_dir)):
                raise StorageError(f"artifact name escapes dest dir: {name!r}")
            os.makedirs(os.path.dirname(local) or dest_dir, exist_ok=True)
            self._download_to(url, local)
            written.append(local)

        if not written:
            raise StorageError(f"no artifacts downloaded for simulation {sim_id}")
        return written

    # -- endpoint plumbing ----------------------------------------------------

    def _mint_upload(self, kind: str, filename: str, sha256: str) -> dict:
        body = {"kind": kind, "filename": filename, "sha256": sha256}
        try:
            resp = self._session.post(
                f"{self.base_url}/v1/uploads", json=body, timeout=self.timeout
            )
        except requests.RequestException as exc:
            raise StorageError(f"POST /v1/uploads failed: {exc}") from exc
        if resp.status_code == 503:
            raise StorageError(
                "the apiserver has presigned uploads disabled (no S3 endpoint "
                "configured); use the direct-S3 backend instead"
            )
        if not resp.ok:
            raise StorageError(f"POST /v1/uploads failed: {resp.status_code} {resp.text[:200]}")
        return resp.json()

    def _list_artifacts(self, sim_id: str) -> List[dict]:
        try:
            resp = self._session.get(
                f"{self.base_url}/v1/results/{sim_id}/artifacts", timeout=self.timeout
            )
        except requests.RequestException as exc:
            raise StorageError(f"GET /v1/results/{sim_id}/artifacts failed: {exc}") from exc
        if resp.status_code == 404:
            raise StorageError(f"no result artifacts for simulation {sim_id} (not finished or not yours)")
        if resp.status_code == 503:
            raise StorageError(
                "the apiserver has presigned downloads disabled (no S3 endpoint configured)"
            )
        if not resp.ok:
            raise StorageError(
                f"GET /v1/results/{sim_id}/artifacts failed: {resp.status_code} {resp.text[:200]}"
            )
        return resp.json().get("artifacts") or []

    def _download_to(self, url: str, local: str) -> None:
        try:
            with requests.get(url, stream=True, timeout=self.timeout) as resp:
                resp.raise_for_status()
                with open(local, "wb") as fh:
                    for chunk in resp.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            fh.write(chunk)
        except requests.RequestException as exc:
            raise StorageError(f"failed to download {url!r}: {exc}") from exc
