"""Classify an EnergyPlus run from its ``eplusout.err`` file.

EnergyPlus signals problems with ``** Severe  **`` and ``**  Fatal  **`` markers
and a terminating summary line. The verdict here mirrors the API contract
(CONTRACT §2 / results.verdict): clean | warnings | severe | fatal.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_SEVERE = re.compile(r"\*\*\s*Severe\s*\*\*", re.IGNORECASE)
_FATAL = re.compile(r"\*\*\s*Fatal\s*\*\*", re.IGNORECASE)
_WARNING = re.compile(r"\*\*\s*Warning\s*\*\*", re.IGNORECASE)


@dataclass
class Verdict:
    verdict: str
    warnings: int
    severe: int
    fatal: int

    @property
    def succeeded(self) -> bool:
        return self.verdict in ("clean", "warnings")


def classify(err_path: str) -> Verdict:
    warnings = severe = fatal = 0
    try:
        with open(err_path, "r", errors="replace") as fh:
            for line in fh:
                if _FATAL.search(line):
                    fatal += 1
                elif _SEVERE.search(line):
                    severe += 1
                elif _WARNING.search(line):
                    warnings += 1
    except FileNotFoundError:
        # No .err at all means EnergyPlus never started — treat as fatal.
        return Verdict("fatal", 0, 0, 1)

    if fatal:
        verdict = "fatal"
    elif severe:
        verdict = "severe"
    elif warnings:
        verdict = "warnings"
    else:
        verdict = "clean"
    return Verdict(verdict, warnings, severe, fatal)
