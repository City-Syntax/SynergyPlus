"""Background lease-renewal thread (CONTRACT §2.3).

While a Runner owns a claimed simulation it must renew the lease every
``SP_HEARTBEAT_SECONDS`` so the apiserver reaper does not re-queue it. The
heartbeat uses its *own* DB connection so it never races the main thread's
connection/cursor.
"""

from __future__ import annotations

import threading

from .db import Database


class Heartbeat:
    def __init__(self, *, dsn: str, sim_id: str, runner_id: str, lease_seconds: int, interval: float):
        self._dsn = dsn
        self._sim_id = sim_id
        self._runner_id = runner_id
        self._lease_seconds = lease_seconds
        self._interval = max(1.0, float(interval))
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._db: Database | None = None

    def __enter__(self) -> "Heartbeat":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop()

    def start(self) -> None:
        self._db = Database(self._dsn)
        self._thread = threading.Thread(target=self._run, name="hb-" + self._sim_id[:8], daemon=True)
        self._thread.start()

    def _run(self) -> None:
        # Renew immediately, then on the interval, until told to stop.
        while not self._stop.is_set():
            try:
                assert self._db is not None
                self._db.heartbeat(
                    sim_id=self._sim_id,
                    runner_id=self._runner_id,
                    lease_seconds=self._lease_seconds,
                )
            except Exception as exc:  # noqa: BLE001 — keep the thread alive
                print(f"[heartbeat] WARNING renew failed: {exc}", flush=True)
                try:
                    assert self._db is not None
                    self._db._reconnect()
                except Exception:  # noqa: BLE001
                    pass
            self._stop.wait(self._interval)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self._interval + 5)
        if self._db is not None:
            self._db.close()
