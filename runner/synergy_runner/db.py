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
#
# ADR-0013: the queued->running transition now lives behind the guarded Postgres
# function app.claim_simulation (migration 0007). The function owns the legal
# from-state, the eligibility membership gate (ADR-0011), the base-table row lock,
# the ordering/LIMIT, AND the H-2 hard-ceiling advisory lock (key 42) — so a caller
# cannot express an illegal transition. We still wrap the call in an explicit
# BEGIN/COMMIT: the function takes pg_advisory_xact_lock(42) inside the CALLER's
# transaction, which is released on COMMIT, so the lock+claim must stay in one txn
# (the connection is otherwise autocommit). RETURNING SETOF -> at most one row.
CLAIM_SQL = """
SELECT * FROM app.claim_simulation(
  %(runner_id)s, %(engine_version)s, %(per_user_cap)s, %(lease_seconds)s
)
"""

# CONTRACT §2.3 — heartbeat (renew the lease while still owning the row). The
# from-state, the M-4 runner_id fence, and the lease bump are owned by the guarded
# function app.renew_lease (ADR-0013); it returns rows affected.
HEARTBEAT_SQL = """
SELECT app.renew_lease(%(sim_id)s, %(runner_id)s, %(lease_seconds)s)
"""

# ADR-0013 — the terminal running->succeeded|failed transition. The from-state,
# the M-4 runner_id fence, the lease clear, and the success/failure mapping are
# owned by the guarded function app.finish_simulation; it returns rows affected.
FINISH_SQL = """
SELECT app.finish_simulation(%(sim_id)s, %(runner_id)s, %(succeeded)s, %(error)s)
"""


def _dict_cursor(conn):
    if _DRIVER == "psycopg2":
        return conn.cursor(cursor_factory=_pg_extras.RealDictCursor)
    return conn.cursor()


def _scalar(row: Any) -> int:
    """Extract the single int a function-returning SELECT yields.

    psycopg3's default connection uses dict_row, so a one-column row arrives as
    a dict; psycopg2's plain cursor yields a tuple. Handle both (None -> 0).
    """
    if row is None:
        return 0
    if isinstance(row, dict):
        return int(next(iter(row.values())))
    return int(row[0])


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
        # H-2: app.claim_simulation takes pg_advisory_xact_lock(42) so the cap
        # count+claim is atomic across runners. The lock is transaction-scoped and
        # released on COMMIT, so the function call MUST live in an explicit
        # transaction (the connection is otherwise autocommit) for the hard cap to
        # hold. The lock serialises only the ~sub-ms claim, never the actual run.
        cur = _dict_cursor(self.conn)
        try:
            cur.execute("BEGIN")
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
        # app.renew_lease owns the from-state + M-4 fence and returns rows affected.
        cur = self.conn.cursor()
        cur.execute(
            HEARTBEAT_SQL,
            {"sim_id": sim_id, "runner_id": runner_id, "lease_seconds": lease_seconds},
        )
        row = cur.fetchone()
        cur.close()
        return _scalar(row)

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
        # M-4: app.finish_simulation owns the from-state + the runner_id fence. If
        # the reaper requeued this sim and another runner already claimed and
        # finished it, a late-waking zombie of the original runner must NOT clobber
        # the new owner's row. Returns rows affected (0 = lost the fence).
        cur = self.conn.cursor()
        cur.execute(
            FINISH_SQL,
            {
                "sim_id": sim_id,
                "runner_id": runner_id,
                "succeeded": succeeded,
                "error": error,
            },
        )
        row = cur.fetchone()
        cur.close()
        return _scalar(row)
