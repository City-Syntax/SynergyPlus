"""Object-storage backend for direct local-file upload / result download.

The SDK lets researchers pass *local filesystem paths* to ``submit_simulation``
and download result artifacts to a local directory. Both need to talk to the
S3-compatible object store (MinIO locally, AWS S3 in the cloud).

This module isolates **all** S3/boto3 knowledge behind a small interface so the
rest of the SDK never imports boto3 directly:

    StorageBackend
      ├─ upload_input(local_path, bucket, *, prefix) -> (ref, sha256)
      ├─ download_prefix(s3_uri, dest_dir)           -> [local paths]
      └─ get_text(s3_uri)                            -> str

``S3StorageBackend`` is the concrete implementation that uses static S3
credentials (works for local MinIO and AWS-with-creds). It is intentionally the
*only* place boto3 is imported, and that import is lazy (deferred to first use)
so plain ``pip install synergyplus`` users who only submit ``s3://`` refs never
need boto3.

Design note (see README "Production: presigned URLs"): a future
``PresignedURLBackend`` that asks the apiserver to mint short-lived upload/
download URLs — so the researcher needs only their API key, no static S3
credentials — can implement this same interface and slot in behind the
unchanged ``SynergyClient`` methods.
"""

from __future__ import annotations

import os
from typing import List, Optional, Tuple
from urllib.parse import urlparse

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


class StorageBackend:
    """Interface every storage backend implements.

    Implemented today by :class:`S3StorageBackend` (direct S3 with static creds);
    a presigned-URL backend can implement the same three methods later.
    """

    def upload_input(
        self, local_path: str, bucket: str, *, prefix: str = "uploads"
    ) -> Tuple[str, str]:  # pragma: no cover - interface
        """Upload *local_path* into *bucket* and return ``(s3_ref, sha256)``."""
        raise NotImplementedError

    def download_prefix(self, s3_uri: str, dest_dir: str) -> List[str]:  # pragma: no cover
        """Download every object under *s3_uri* into *dest_dir*; return local paths."""
        raise NotImplementedError

    def get_text(self, s3_uri: str) -> str:  # pragma: no cover - interface
        """Fetch a single object's body and decode it as UTF-8 text."""
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

    def download_prefix(self, s3_uri: str, dest_dir: str) -> List[str]:
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

    def get_text(self, s3_uri: str) -> str:
        bucket, key = parse_s3_uri(s3_uri)
        client = self._s3()
        try:
            obj = client.get_object(Bucket=bucket, Key=key)
        except Exception as exc:  # noqa: BLE001
            raise StorageError(f"failed to read {s3_uri}: {exc}") from exc
        return obj["Body"].read().decode("utf-8")
