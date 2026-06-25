"""Runner configuration, sourced from the environment (CONTRACT §6)."""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass


@dataclass(frozen=True)
class RunnerConfig:
    # --- Postgres -----------------------------------------------------------
    database_url: str

    # --- Object storage (MinIO / S3) ---------------------------------------
    s3_endpoint: str | None
    s3_region: str
    s3_access_key: str | None
    s3_secret_key: str | None
    bucket_models: str
    bucket_weather: str
    bucket_results: str

    # --- Runner identity & policy ------------------------------------------
    runner_id: str
    engine_version: str
    per_user_cap: int
    lease_seconds: int
    heartbeat_seconds: int

    # --- Loop tuning --------------------------------------------------------
    poll_seconds: float
    workspace_root: str
    fetch_attempts: int
    fetch_retry_seconds: float

    # --- Engine -------------------------------------------------------------
    energyplus_bin: str

    # --- Retention (ADR-0008; GC itself is Phase-4) ------------------------
    artifact_ttl_days: int | None

    @classmethod
    def from_env(cls) -> "RunnerConfig":
        def required(key: str) -> str:
            val = os.environ.get(key)
            if not val:
                raise SystemExit(f"missing required env var {key}")
            return val

        ttl_raw = os.environ.get("SP_ARTIFACT_TTL_DAYS")
        artifact_ttl_days = int(ttl_raw) if ttl_raw not in (None, "") else None

        return cls(
            database_url=required("DATABASE_URL"),
            s3_endpoint=os.environ.get("S3_ENDPOINT") or None,
            s3_region=os.environ.get("S3_REGION", "us-east-1"),
            s3_access_key=os.environ.get("S3_ACCESS_KEY") or None,
            s3_secret_key=os.environ.get("S3_SECRET_KEY") or None,
            bucket_models=os.environ.get("S3_BUCKET_MODELS", "models"),
            bucket_weather=os.environ.get("S3_BUCKET_WEATHER", "weather"),
            bucket_results=os.environ.get("S3_BUCKET_RESULTS", "results"),
            runner_id=os.environ.get("SP_RUNNER_ID") or socket.gethostname(),
            engine_version=os.environ.get("SP_ENGINE_VERSION", "24.1.0"),
            per_user_cap=int(os.environ.get("SP_PER_USER_CAP", "50")),
            lease_seconds=int(os.environ.get("SP_LEASE_SECONDS", "90")),
            heartbeat_seconds=int(os.environ.get("SP_HEARTBEAT_SECONDS", "30")),
            poll_seconds=float(os.environ.get("SP_POLL_SECONDS", "2")),
            workspace_root=os.environ.get("SP_WORKSPACE", "/tmp/synergy-runner"),
            fetch_attempts=int(os.environ.get("SP_FETCH_ATTEMPTS", "3")),
            fetch_retry_seconds=float(os.environ.get("SP_FETCH_RETRY_SECONDS", "1")),
            energyplus_bin=os.environ.get("SP_ENERGYPLUS_BIN", "energyplus"),
            artifact_ttl_days=artifact_ttl_days,
        )
