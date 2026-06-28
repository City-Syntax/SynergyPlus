"""Object-storage shim for the Runner.

Supports ``s3://bucket/key`` (S3 / MinIO via boto3) and ``file://`` / bare local
paths (handy for tests). Includes explicit credentials + region so it can talk to
a self-hosted MinIO.
"""

from __future__ import annotations

import hashlib
import os
import shutil
from typing import Optional
from urllib.parse import urlparse

from .config import RunnerConfig


def s3_client(cfg: RunnerConfig):
    """Build a boto3 S3 client from runner config (lazy import)."""
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=cfg.s3_endpoint,
        region_name=cfg.s3_region,
        aws_access_key_id=cfg.s3_access_key,
        aws_secret_access_key=cfg.s3_secret_key,
    )


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _resolve_bucket(netloc: str, cfg: RunnerConfig) -> str:
    """Map a ref's *logical* bucket name to the configured real bucket.

    Refs are stored with logical names (``s3://models/...``, ``s3://weather/...``,
    ``s3://results/...``) so the same row works in every environment. Locally
    (MinIO) the configured buckets ARE ``models``/``weather``/``results``, so the
    map is an identity; in AWS they are ``synergyplus-models-…`` etc., so this
    rewrites the netloc to the real bucket. A netloc that is already a real bucket
    name (e.g. one minted by the apiserver upload endpoint) isn't in the map and
    passes through unchanged — so both logical and real refs resolve correctly.
    Using the netloc literally is what made ``s3://models/...`` hit a third-party
    bucket named ``models`` and fail with 403 in production.
    """
    return {
        "models": cfg.bucket_models,
        "weather": cfg.bucket_weather,
        "results": cfg.bucket_results,
    }.get(netloc, netloc)


def download(ref: str, dest: str, *, cfg: Optional[RunnerConfig] = None) -> None:
    """Download ``ref`` to local path ``dest``."""
    parsed = urlparse(ref)
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)

    if parsed.scheme == "s3":
        if cfg is None:
            raise ValueError("cfg required to download an s3:// ref")
        bucket, key = _resolve_bucket(parsed.netloc, cfg), parsed.path.lstrip("/")
        s3_client(cfg).download_file(bucket, key, dest)
    elif parsed.scheme in ("file", ""):
        shutil.copyfile(parsed.path or ref, dest)
    else:
        raise ValueError(f"unsupported storage scheme: {ref!r}")


def upload_dir(local_dir: str, ref_prefix: str, *, cfg: Optional[RunnerConfig] = None) -> str:
    """Upload every file under ``local_dir`` to ``ref_prefix``; return the prefix."""
    parsed = urlparse(ref_prefix)

    if parsed.scheme == "s3":
        if cfg is None:
            raise ValueError("cfg required to upload to an s3:// ref")
        client = s3_client(cfg)
        bucket, base = _resolve_bucket(parsed.netloc, cfg), parsed.path.strip("/")
        for root, _, files in os.walk(local_dir):
            for name in files:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, local_dir)
                key = f"{base}/{rel}" if base else rel
                client.upload_file(full, bucket, key)
    elif parsed.scheme in ("file", ""):
        target = parsed.path or ref_prefix
        shutil.copytree(local_dir, target, dirs_exist_ok=True)
    else:
        raise ValueError(f"unsupported storage scheme: {ref_prefix!r}")

    return ref_prefix
