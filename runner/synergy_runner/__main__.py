"""Entrypoint: ``python -m synergy_runner`` / ``synergy-runner``."""

from __future__ import annotations

from .config import RunnerConfig
from .loop import run_forever


def main() -> None:
    cfg = RunnerConfig.from_env()
    run_forever(cfg)


if __name__ == "__main__":
    main()
