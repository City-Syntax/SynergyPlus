"""Run the EnergyPlus engine and extract Core Metrics.

    energyplus -w weather.epw -d out/ -r model.idf

Reads ``eplusout.sql`` (a SQLite DB) for the Core Metrics; if the engine never
produced one, the metrics come back as nulls and the verdict (from ``eplusout.err``)
carries the failure.
"""

from __future__ import annotations

import os
import subprocess
import time

from .config import RunnerConfig
from .metrics import CORE_KEYS, empty_metrics, extract


def run_engine(
    cfg: RunnerConfig,
    *,
    model_path: str,
    weather_path: str,
    out_dir: str,
    content_hash: str,
) -> dict:
    """Execute EnergyPlus. Returns the Core Metrics dict (run_seconds filled in)."""
    os.makedirs(out_dir, exist_ok=True)
    sql_path = os.path.join(out_dir, "eplusout.sql")
    started = time.monotonic()

    # EnergyPlus CLI: -w weather, -d output dir, -r run ExpandObjects + ReadVars.
    cmd = [cfg.energyplus_bin, "-w", weather_path, "-d", out_dir, "-r", model_path]
    print(f"[engine] {' '.join(cmd)}", flush=True)
    proc = subprocess.run(cmd, cwd=out_dir)
    print(f"[engine] exit={proc.returncode}", flush=True)
    elapsed = time.monotonic() - started

    if os.path.exists(sql_path):
        metrics = extract(sql_path)
    else:
        metrics = empty_metrics()
    metrics["run_seconds"] = round(elapsed, 3)
    # Guarantee all core keys are present.
    for k in CORE_KEYS:
        metrics.setdefault(k, None)
    return metrics
