"""Postgres access for the Runner.

Wraps the *exact* claim SQL from CONTRACT §2.2, the heartbeat from §2.3, the
content-hash back-fill (§2.1), and the result upsert / simulation finalisation.

Supports psycopg (v3) or psycopg2 transparently.
"""

from __future__ import annotations

import json
from typing import Any, Optional

# --- driver shim ------------------------------------------------------------
try:  # prefer psycopg v3
    import psycopg as _pg  # type: ignore

    _DRIVER = "psycopg3"

    def _connect(dsn: str):
        return _pg.connect(dsn, autocommit=True, row_factory=_pg.rows.dict_row)

except ImportError:  # fall back to psycopg2
    import psycopg2 as _pg  # type: ignore
    import psycopg2.extras as _pg_extras  # type: ignore

    _DRIVER = "psycopg2"

    def _connect(dsn: str):
        conn = _pg.connect(dsn)
        conn.autocommit = True
        return conn


# CONTRACT §2.2 — the one true claim query. Params: runner_id, engine_version,
# per_user_cap, lease_seconds.
CLAIM_SQL = """
UPDATE app.simulations s
SET state='running', runner_id=%(runner_id)s, started_at=now(),
    lease_expires_at=now()+make_interval(secs => %(lease_seconds)s), attempts=attempts+1
WHERE s.id = (
  SELECT s2.id FROM app.simulations s2
  WHERE s2.state='queued' AND s2.engine_version=%(engine_version)s
    AND (SELECT count(*) FROM app.simulations r
         WHERE r.user_id=s2.user_id AND r.state='running') < %(per_user_cap)s
  ORDER BY s2.priority DESC, s2.created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING s.*;
"""

# CONTRACT §2.3 — heartbeat (renew the lease while still owning the row).
HEARTBEAT_SQL = """
UPDATE app.simulations
SET lease_expires_at = now() + make_interval(secs => %(lease_seconds)s)
WHERE id = %(sim_id)s AND runner_id = %(runner_id)s
"""

# H-2: make the per-user cap a HARD ceiling. The cap predicate in CLAIM_SQL is a
# count-then-claim that is racy across runners (TOCTOU) — N runners each read
# `count < cap` before any of them locks, so the cap overshoots by up to N-1.
# Serialise the count+claim with a single global transaction-scoped advisory
# lock so claims can't interleave. Claims are sub-millisecond, so global
# serialisation is fine at our scale.
CLAIM_LOCK_KEY = 42


def _dict_cursor(conn):
    if _DRIVER == "psycopg2":
        return conn.cursor(cursor_factory=_pg_extras.RealDictCursor)
    return conn.cursor()


class Database:
    def __init__(self, dsn: str):
        self.dsn = dsn
        self.conn = _connect(dsn)

    @property
    def driver(self) -> str:
        return _DRIVER

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:  # noqa: BLE001
            pass

    def _reconnect(self) -> None:
        try:
            self.conn.close()
        except Exception:  # noqa: BLE001
            pass
        self.conn = _connect(self.dsn)

    # -- claim ---------------------------------------------------------------

    def claim(
        self, *, runner_id: str, engine_version: str, per_user_cap: int, lease_seconds: int
    ) -> Optional[dict]:
        params = {
            "runner_id": runner_id,
            "engine_version": engine_version,
            "per_user_cap": per_user_cap,
            "lease_seconds": lease_seconds,
        }
        # H-2: take a transaction-scoped advisory lock so the cap count+claim is
        # atomic across runners. pg_advisory_xact_lock is released on COMMIT, so
        # the lock and the UPDATE MUST live in the same explicit transaction
        # (the connection is otherwise autocommit). The lock serialises only the
        # ~sub-ms claim, never the actual simulation run.
        cur = _dict_cursor(self.conn)
        try:
            cur.execute("BEGIN")
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (CLAIM_LOCK_KEY,))
            cur.execute(CLAIM_SQL, params)
            row = cur.fetchone()
            cur.execute("COMMIT")
        except Exception:
            try:
                cur.execute("ROLLBACK")
            except Exception:  # noqa: BLE001
                pass
            raise
        finally:
            cur.close()
        return dict(row) if row else None

    # -- heartbeat -----------------------------------------------------------

    def heartbeat(self, *, sim_id: str, runner_id: str, lease_seconds: int) -> int:
        cur = self.conn.cursor()
        cur.execute(
            HEARTBEAT_SQL,
            {"sim_id": sim_id, "runner_id": runner_id, "lease_seconds": lease_seconds},
        )
        n = cur.rowcount
        cur.close()
        return n

    # -- content-hash back-fill (CONTRACT §2.1) ------------------------------

    def backfill_hashes(
        self, *, sim_id: str, model_sha256: str, weather_sha256: str, content_hash: str
    ) -> None:
        cur = self.conn.cursor()
        cur.execute(
            """
            UPDATE app.simulations
            SET model_sha256 = %(m)s, weather_sha256 = %(w)s, content_hash = %(c)s
            WHERE id = %(id)s
            """,
            {"m": model_sha256, "w": weather_sha256, "c": content_hash, "id": sim_id},
        )
        cur.close()

    # -- result upsert + finalise -------------------------------------------

    def upsert_result(
        self,
        *,
        content_hash: str,
        verdict: str,
        metrics: dict[str, Any],
        artifact_uri: str,
        artifact_ttl_days: Optional[int] = None,
    ) -> None:
        # L-1: stamp artifact_expires_at = now() + TTL when configured (ADR-0008;
        # the GC sweep that actually prunes stays Phase-4). NULL = keep forever.
        cur = self.conn.cursor()
        cur.execute(
            """
            INSERT INTO app.results (content_hash, verdict, metrics, artifact_uri, artifact_expires_at)
            VALUES (
              %(ch)s, %(v)s, %(m)s, %(uri)s,
              CASE WHEN %(ttl)s::int IS NULL THEN NULL
                   ELSE now() + make_interval(days => %(ttl)s::int) END
            )
            ON CONFLICT (content_hash) DO UPDATE
              SET verdict = EXCLUDED.verdict,
                  metrics = EXCLUDED.metrics,
                  artifact_uri = EXCLUDED.artifact_uri,
                  artifact_expires_at = EXCLUDED.artifact_expires_at
            """,
            {
                "ch": content_hash,
                "v": verdict,
                "m": json.dumps(metrics),
                "uri": artifact_uri,
                "ttl": artifact_ttl_days,
            },
        )
        cur.close()

    def lookup_result(self, content_hash: str) -> Optional[dict]:
        cur = _dict_cursor(self.conn)
        cur.execute(
            "SELECT content_hash, verdict, metrics, artifact_uri "
            "FROM app.results WHERE content_hash = %(ch)s",
            {"ch": content_hash},
        )
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else None

    def finish_simulation(
        self, *, sim_id: str, runner_id: str, succeeded: bool, error: Optional[str] = None
    ) -> int:
        # M-4: fence the terminal write on runner_id (same guard heartbeat uses).
        # If the reaper requeued this sim and another runner already claimed and
        # finished it, a late-waking zombie of the original runner must NOT
        # clobber the new owner's row. Returns rows affected (0 = lost the fence).
        state = "succeeded" if succeeded else "failed"
        cur = self.conn.cursor()
        cur.execute(
            """
            UPDATE app.simulations
            SET state = %(state)s, finished_at = now(), error = %(error)s,
                lease_expires_at = NULL
            WHERE id = %(id)s AND runner_id = %(runner_id)s
            """,
            {"state": state, "error": error, "id": sim_id, "runner_id": runner_id},
        )
        n = cur.rowcount
        cur.close()
        return n
