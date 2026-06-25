"""Extract Core Metrics (CONTRACT §5 / ADR-0008) from ``eplusout.sql``.

The EnergyPlus ``.sql`` output is a SQLite database. The tabular reports live in
``TabularDataWithStrings`` (joined with ``Strings`` for the textual cell values).
We pull the standard "Annual Building Utility Performance Summary" rows.

Core Metric keys (always present, value or null):
    site_eui, source_eui, total_site_energy, total_source_energy,
    unmet_heating_hours, unmet_cooling_hours, run_seconds
"""

from __future__ import annotations

import sqlite3
from typing import Optional

CORE_KEYS = (
    "site_eui",
    "source_eui",
    "total_site_energy",
    "total_source_energy",
    "unmet_heating_hours",
    "unmet_cooling_hours",
    "run_seconds",
)


def empty_metrics() -> dict:
    return {k: None for k in CORE_KEYS}


def _to_float(val) -> Optional[float]:
    try:
        return float(str(val).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _query_rows(con: sqlite3.Connection) -> list[tuple]:
    """Return (ReportName, TableName, RowName, ColumnName, Value) tuples.

    Tries the modern denormalised ``TabularDataWithStrings`` view first, then
    falls back to joining the raw ``TabularData`` + ``Strings`` tables.
    """
    cur = con.cursor()
    try:
        cur.execute(
            "SELECT ReportName, TableName, RowName, ColumnName, Value "
            "FROM TabularDataWithStrings"
        )
        return cur.fetchall()
    except sqlite3.Error:
        pass
    # Fallback: reconstruct from normalised tables.
    cur.execute(
        """
        SELECT r.Value, t.Value, rn.Value, cn.Value, td.Value
        FROM TabularData td
        JOIN Strings r  ON td.ReportNameIndex = r.StringIndex
        JOIN Strings t  ON td.TableNameIndex  = t.StringIndex
        JOIN Strings rn ON td.RowNameIndex    = rn.StringIndex
        JOIN Strings cn ON td.ColumnNameIndex = cn.StringIndex
        """
    )
    return cur.fetchall()


def extract(sql_path: str) -> dict:
    """Best-effort extraction. Missing data → nulls (CONTRACT §5)."""
    metrics = empty_metrics()
    try:
        con = sqlite3.connect(f"file:{sql_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return metrics

    try:
        rows = _query_rows(con)
    except sqlite3.Error:
        con.close()
        return metrics
    con.close()

    # Real EnergyPlus AnnualBuildingUtilityPerformanceSummary schema:
    #   Table "Site and Source Energy":
    #     RowName  "Total Site Energy"   / "Total Source Energy"
    #     ColumnName "Total Energy"                    -> total_*_energy (GJ)
    #     ColumnName "Energy Per Total Building Area"  -> *_eui          (MJ/m2)
    #   Table "Comfort and Setpoint Not Met Summary":
    #     RowName "Time Setpoint Not Met During Occupied Heating"/"...Cooling"
    #             ColumnName "Facility" -> unmet_*_hours
    for report, table, row_name, col_name, value in rows:
        rn = (row_name or "").strip().lower()
        tn = (table or "").strip().lower()
        cn = (col_name or "").strip().lower()
        if "site and source energy" in tn:
            # EUI lives in the "energy per total building area" column, not its
            # own row; total energy lives in the "total energy" column.
            is_total_col = cn == "total energy"
            is_eui_col = "energy per total building area" in cn
            if rn == "total site energy":
                if is_total_col:
                    metrics["total_site_energy"] = _to_float(value)
                elif is_eui_col:
                    metrics["site_eui"] = _to_float(value)
            elif rn == "total source energy":
                if is_total_col:
                    metrics["total_source_energy"] = _to_float(value)
                elif is_eui_col:
                    metrics["source_eui"] = _to_float(value)
        elif "comfort and setpoint not met summary" in tn:
            # "Time Setpoint Not Met During Occupied Heating/Cooling". Exclude the
            # "Time Not Comfortable ..." rows (they contain neither word).
            if "setpoint not met" in rn and "heating" in rn:
                metrics["unmet_heating_hours"] = _to_float(value)
            elif "setpoint not met" in rn and "cooling" in rn:
                metrics["unmet_cooling_hours"] = _to_float(value)

    return metrics
