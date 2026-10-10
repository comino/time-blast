#!/usr/bin/env python3
"""Regenerate public, deterministic vessel telemetry. Requires duckdb==1.4.1.

python3 -m venv /tmp/time-blast-data-venv
/tmp/time-blast-data-venv/bin/pip install duckdb==1.4.1
/tmp/time-blast-data-venv/bin/python scripts/generate-dataset.py

All positions and measurements are invented; no real vessel or private data is used.
"""
from pathlib import Path
import duckdb

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "public" / "data"
DEST.mkdir(parents=True, exist_ok=True)
PARQUET = DEST / "telemetry.parquet"
CONTEXT = {
    "id": "synthetic-vessels-2026-09-v1",
    "label": "North Atlantic · synthetic vessel telemetry",
    "rowCount": 120960,
    "start": 1788220800000,
    "end": 1789430400000,
    "vessels": ["Aurora", "Meridian", "Kestrel", "Solstice", "Atlas", "Nomad"],
    "description": "Six fictional vessels, one reading per minute, 1–14 September 2026 UTC. Deterministic synthetic data; speed and wind in knots, wave height in metres, water temperature in °C.",
}

db = duckdb.connect()
db.execute("SET threads=1")
db.execute("""
CREATE TABLE telemetry AS
WITH grid AS (
  SELECT v::INTEGER vessel, m::DOUBLE AS minute_index,
         m / 1440.0 AS day,
         exp(-pow((m / 1440.0 - 7.0 - v * 0.18) / 1.2, 2)) AS storm
  FROM range(6) AS vessels(v) CROSS JOIN range(14 * 24 * 60) AS minutes(m)
)
SELECT (1788220800000 + minute_index * 60000)::DOUBLE AS t,
       vessel,
       round(12.8 + vessel * 0.7 + 2.1 * sin(minute_index / 420 + vessel) - storm * 4.7, 2)::DOUBLE AS speed,
       round(11.0 + 4.0 * sin(minute_index / 660 + vessel * 0.8) + storm * 25.0 + vessel * 0.4, 2)::DOUBLE AS wind,
       round(1.3 + 0.35 * sin(minute_index / 720 + vessel) + storm * 3.7 + vessel * 0.08, 3)::DOUBLE AS wave_height,
       round(18.0 - vessel * 0.5 + 0.65 * cos(minute_index / 1440 * 6.283185307179586) - day * 0.08, 2)::DOUBLE AS water_temp,
       round(36.0 + vessel * 2.3 + day * 0.48 + 1.2 * sin(day * 0.5 + vessel), 5)::DOUBLE AS lat,
       round(-61.0 + vessel * 1.2 + day * 2.1 + 1.5 * cos(day * 0.37 + vessel), 5)::DOUBLE AS lon
FROM grid ORDER BY t, vessel
""")
db.execute("COPY telemetry TO ? (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 8192)", [str(PARQUET)])
assert db.execute("SELECT count(*), min(t), max(t) FROM telemetry").fetchone() == (
    CONTEXT["rowCount"], CONTEXT["start"], CONTEXT["end"] - 60000
)
print(f"Generated {CONTEXT['rowCount']:,} rows, {PARQUET.stat().st_size:,} bytes: {PARQUET}")
