"""SynergyPlus Runner — the long-lived pull-loop worker (CONTRACT §2, §5).

Claims queued simulations for its engine version, runs EnergyPlus, parses the
verdict from eplusout.err, extracts Core Metrics from eplusout.sql, uploads
artifacts, and writes the content-addressed result.
"""

from .config import RunnerConfig
from .loop import content_hash, run_forever

__all__ = ["RunnerConfig", "run_forever", "content_hash"]
__version__ = "0.6.4"
