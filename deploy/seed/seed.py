"""Idempotent local-demo seeder for SynergyPlus.

- Waits for Postgres and MinIO to be reachable.
- Creates the models / weather / results buckets.
- Uploads the sample inputs to the EXACT refs the smoke test expects:
      model:   s3://models/sample/baseline.idf
      weather: s3://weather/sample/chicago.epw
- Inserts a demo user (demo@urbanflow.co) and a known dev API key
  'synergy-dev-key' (stored as key_hash = sha256_hex("synergy-dev-key")).

Re-runnable: every step is upsert / "create if missing".

Env (CONTRACT §6): DATABASE_URL, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY,
S3_SECRET_KEY, S3_BUCKET_MODELS, S3_BUCKET_WEATHER, S3_BUCKET_RESULTS.
"""

from __future__ import annotations

import hashlib
import os
import sys
import time

DEMO_EMAIL = "demo@urbanflow.co"
DEV_API_KEY = "synergy-dev-key"

# EXACT refs agreed with the PM for the smoke test.
MODEL_REF = "s3://models/sample/baseline.idf"
WEATHER_REF = "s3://weather/sample/chicago.epw"

_HERE = os.path.dirname(os.path.abspath(__file__))


def _env(key: str, default: str | None = None) -> str | None:
    return os.environ.get(key, default)


# --- driver shim ------------------------------------------------------------
def _connect_pg(dsn: str):
    try:
        import psycopg  # type: ignore

        return psycopg.connect(dsn, autocommit=True)
    except ImportError:
        import psycopg2  # type: ignore

        conn = psycopg2.connect(dsn)
        conn.autocommit = True
        return conn


def _s3():
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=_env("S3_ENDPOINT"),
        region_name=_env("S3_REGION", "us-east-1"),
        aws_access_key_id=_env("S3_ACCESS_KEY"),
        aws_secret_access_key=_env("S3_SECRET_KEY"),
    )


def wait_for_postgres(dsn: str, timeout: float = 120.0) -> None:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            conn = _connect_pg(dsn)
            conn.close()
            print("[seed] postgres reachable", flush=True)
            return
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(2)
    raise SystemExit(f"[seed] postgres not reachable after {timeout}s: {last}")


def wait_for_minio(timeout: float = 120.0):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            client = _s3()
            client.list_buckets()
            print("[seed] minio reachable", flush=True)
            return client
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(2)
    raise SystemExit(f"[seed] minio not reachable after {timeout}s: {last}")


def ensure_bucket(client, name: str) -> None:
    try:
        client.head_bucket(Bucket=name)
        print(f"[seed] bucket exists: {name}", flush=True)
    except Exception:  # noqa: BLE001 — not found (or no head perms): create
        try:
            client.create_bucket(Bucket=name)
            print(f"[seed] bucket created: {name}", flush=True)
        except Exception as exc:  # noqa: BLE001 — tolerate "already owned"
            print(f"[seed] bucket {name}: {exc}", flush=True)


def _parse_ref(ref: str) -> tuple[str, str]:
    rest = ref[len("s3://"):]
    bucket, _, key = rest.partition("/")
    return bucket, key


def upload_input(client, local_path: str, ref: str) -> None:
    bucket, key = _parse_ref(ref)
    client.upload_file(local_path, bucket, key)
    print(f"[seed] uploaded {local_path} -> {ref}", flush=True)


def seed_db(dsn: str) -> None:
    key_hash = hashlib.sha256(DEV_API_KEY.encode()).hexdigest()
    conn = _connect_pg(dsn)
    cur = conn.cursor()

    # Demo user (idempotent).
    cur.execute(
        """
        INSERT INTO app.users (email) VALUES (%s)
        ON CONFLICT (email) DO NOTHING
        """,
        (DEMO_EMAIL,),
    )
    cur.execute("SELECT id FROM app.users WHERE email = %s", (DEMO_EMAIL,))
    user_id = cur.fetchone()[0]
    print(f"[seed] demo user {DEMO_EMAIL} -> {user_id}", flush=True)

    # Dev API key (idempotent on the unique key_hash).
    cur.execute(
        """
        INSERT INTO app.api_keys (user_id, key_hash, name)
        VALUES (%s, %s, %s)
        ON CONFLICT (key_hash) DO NOTHING
        """,
        (user_id, key_hash, "dev"),
    )
    print(f"[seed] dev api key '{DEV_API_KEY}' (sha256={key_hash})", flush=True)

    cur.close()
    conn.close()


def main() -> int:
    dsn = _env("DATABASE_URL")
    if not dsn:
        raise SystemExit("[seed] DATABASE_URL is required")

    wait_for_postgres(dsn)
    client = wait_for_minio()

    for bucket in (
        _env("S3_BUCKET_MODELS", "models"),
        _env("S3_BUCKET_WEATHER", "weather"),
        _env("S3_BUCKET_RESULTS", "results"),
    ):
        ensure_bucket(client, bucket)

    upload_input(client, os.path.join(_HERE, "sample", "baseline.idf"), MODEL_REF)
    upload_input(client, os.path.join(_HERE, "sample", "chicago.epw"), WEATHER_REF)

    seed_db(dsn)

    print("", flush=True)
    print("=" * 60, flush=True)
    print("[seed] SynergyPlus demo seed complete.", flush=True)
    print(f"[seed]   dev API key : {DEV_API_KEY}", flush=True)
    print(f"[seed]   model ref   : {MODEL_REF}", flush=True)
    print(f"[seed]   weather ref : {WEATHER_REF}", flush=True)
    print("=" * 60, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
