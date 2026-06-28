"""The Runner pull-loop: claim → fetch → run → parse → extract → upload → write.

Implements CONTRACT §2.2 (claim), §2.3 (heartbeat), §5 (Core Metrics), §2.1
(content-hash back-fill), and ADR-0003 (input-keyed idempotent results).
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import tempfile
import time
import traceback

from . import storage
from .config import RunnerConfig
from .db import Database
from .engine import run_engine
from .heartbeat import Heartbeat
from .parse_err import classify


def content_hash(model_sha256: str, weather_sha256: str, engine_version: str) -> str:
    """CONTRACT §2.1: sha256(model_sha256 || ":" || weather_sha256 || ":" || engine_version)."""
    payload = f"{model_sha256}:{weather_sha256}:{engine_version}".encode()
    return hashlib.sha256(payload).hexdigest()


def process_simulation(cfg: RunnerConfig, db: Database, sim: dict) -> bool:
    """Run one claimed simulation end-to-end. Returns True on success.

    The caller has already claimed the row (state='running', lease set). This
    starts the heartbeat, does the work, writes results, and finalises the row.
    """
    sim_id = str(sim["id"])
    workspace = tempfile.mkdtemp(prefix=f"sim-{sim_id[:8]}-", dir=_ensure_root(cfg))
    model_path = os.path.join(workspace, "model.idf")
    weather_path = os.path.join(workspace, "weather.epw")
    out_dir = os.path.join(workspace, "out")

    print(
        f"[loop] claimed sim={sim_id} user={sim['user_id']} "
        f"prio={sim['priority']} attempt={sim['attempts']}",
        flush=True,
    )

    hb = Heartbeat(
        dsn=cfg.database_url,
        sim_id=sim_id,
        runner_id=cfg.runner_id,
        lease_seconds=cfg.lease_seconds,
        interval=cfg.heartbeat_seconds,
    )
    hb.start()

    try:
        # --- fetch inputs ----------------------------------------------------
        # The object MUST exist (short retry, then fail the sim). A bad ref must
        # surface as a failure rather than silently "succeed" (QA L-3).
        _fetch_input(cfg, sim["model_ref"], model_path)
        _fetch_input(cfg, sim["weather_ref"], weather_path)

        # --- content hash (CONTRACT §2.1) ------------------------------------
        # ALWAYS recompute the real hash from the actually-fetched bytes. The
        # API may have stored a PLACEHOLDER content_hash (sha256(":"+":"+ver))
        # when the SDK supplied no digests; trusting it collides every no-sha
        # sim onto one results row (QA C-1). So compute the true model/weather
        # digests here and derive content_hash from them, then back-fill all
        # three columns unconditionally.
        model_sha = storage.sha256_file(model_path)
        weather_sha = storage.sha256_file(weather_path)
        ch = content_hash(model_sha, weather_sha, sim["engine_version"])
        db.backfill_hashes(
            sim_id=sim_id,
            model_sha256=model_sha,
            weather_sha256=weather_sha,
            content_hash=ch,
        )

        # --- run the engine --------------------------------------------------
        metrics = run_engine(
            cfg,
            model_path=model_path,
            weather_path=weather_path,
            out_dir=out_dir,
        )

        # --- parse the .err → verdict ---------------------------------------
        v = classify(os.path.join(out_dir, "eplusout.err"))

        # --- write the run summary (kept forever, ADR-0008) -----------------
        summary = {
            "simulation": sim_id,
            "engineVersion": sim["engine_version"],
            "contentHash": ch,
            "verdict": v.verdict,
            "warnings": v.warnings,
            "severe": v.severe,
            "fatal": v.fatal,
            "metrics": metrics,
        }
        with open(os.path.join(out_dir, "synergy-summary.json"), "w") as fh:
            json.dump(summary, fh, indent=2)

        # --- upload all artifacts to s3://results/<content_hash>/ -----------
        artifact_uri = f"s3://{cfg.bucket_results}/{ch}/"
        uploaded = False
        try:
            storage.upload_dir(out_dir, artifact_uri, cfg=cfg)
            uploaded = True
            print(f"[loop] uploaded artifacts -> {artifact_uri}", flush=True)
        except Exception as exc:  # noqa: BLE001 — surface but keep the verdict
            print(f"[loop] WARNING artifact upload failed: {exc}", flush=True)

        # --- upsert the content-addressed result (idempotent) ---------------
        db.upsert_result(
            content_hash=ch,
            verdict=v.verdict,
            metrics=metrics,
            artifact_uri=artifact_uri if uploaded else None,
            artifact_ttl_days=cfg.artifact_ttl_days,
        )

        # --- finalise the simulation row (fenced on runner_id, M-4) ---------
        succeeded = v.succeeded
        n = db.finish_simulation(
            sim_id=sim_id,
            runner_id=cfg.runner_id,
            succeeded=succeeded,
            error=None if succeeded else f"verdict={v.verdict}",
        )
        if n == 0:
            print(
                f"[loop] sim={sim_id} lost the fence (re-claimed by another runner); "
                "not overwriting the terminal row",
                flush=True,
            )
        else:
            print(
                f"[loop] sim={sim_id} verdict={v.verdict} -> "
                f"{'succeeded' if succeeded else 'failed'}",
                flush=True,
            )
        return succeeded

    except Exception as exc:  # noqa: BLE001 — any failure fails the sim, not the runner
        print(f"[loop] ERROR sim={sim_id}: {exc}\n{traceback.format_exc()}", flush=True)
        try:
            db.finish_simulation(
                sim_id=sim_id, runner_id=cfg.runner_id, succeeded=False, error=str(exc)[:1000]
            )
        except Exception as exc2:  # noqa: BLE001
            print(f"[loop] ERROR could not mark sim failed: {exc2}", flush=True)
        return False
    finally:
        hb.stop()
        shutil.rmtree(workspace, ignore_errors=True)


def _fetch_input(cfg: RunnerConfig, ref: str, dest: str) -> None:
    """Download ``ref`` to ``dest``, requiring the object to exist.

    A short retry absorbs transient blips / a just-uploaded object that's still
    settling; if it still can't be fetched the exception propagates and the sim
    fails — a bogus ref must surface as a real failure (QA L-3)."""
    attempts = max(1, cfg.fetch_attempts)
    last: Exception | None = None
    for i in range(attempts):
        try:
            storage.download(ref, dest, cfg=cfg)
            return
        except Exception as exc:  # noqa: BLE001
            last = exc
            if i + 1 < attempts:
                print(
                    f"[loop] fetch {ref} attempt {i + 1}/{attempts} failed ({exc}); retrying",
                    flush=True,
                )
                time.sleep(cfg.fetch_retry_seconds)
    raise RuntimeError(f"could not fetch input {ref}: {last}")


def _ensure_root(cfg: RunnerConfig) -> str:
    os.makedirs(cfg.workspace_root, exist_ok=True)
    return cfg.workspace_root


class _Stopper:
    def __init__(self) -> None:
        self.stop = False

    def request(self, *_a) -> None:
        print("[loop] shutdown requested; finishing current sim then exiting", flush=True)
        self.stop = True


def run_forever(cfg: RunnerConfig) -> None:
    db = Database(cfg.database_url)
    print(
        f"[runner] id={cfg.runner_id} engine={cfg.engine_version} "
        f"energyplus={cfg.energyplus_bin} driver={db.driver} "
        f"cap={cfg.per_user_cap} lease={cfg.lease_seconds}s hb={cfg.heartbeat_seconds}s",
        flush=True,
    )

    stopper = _Stopper()
    signal.signal(signal.SIGTERM, stopper.request)
    signal.signal(signal.SIGINT, stopper.request)

    try:
        while not stopper.stop:
            try:
                sim = db.claim(
                    runner_id=cfg.runner_id,
                    engine_version=cfg.engine_version,
                    per_user_cap=cfg.per_user_cap,
                    lease_seconds=cfg.lease_seconds,
                )
            except Exception as exc:  # noqa: BLE001 — DB blip: reconnect and retry
                print(f"[runner] claim error: {exc}; reconnecting", flush=True)
                db.reconnect()
                time.sleep(cfg.poll_seconds)
                continue

            if sim is None:
                time.sleep(cfg.poll_seconds)
                continue

            process_simulation(cfg, db, sim)
    finally:
        db.close()
        print("[runner] stopped", flush=True)
