#!/usr/bin/env python3
"""Wall time of representative analytical queries on a DuckDB database file with the native
DuckDB CLI. For the server-side nyc-taxi database
(`node scripts/fetch-datasets.mjs nyc-taxi-server`).

  cold  a new CLI process per run, the query run once: DuckDB's buffer pool is empty; the OS page
        cache is whatever earlier runs left (not dropped: that needs root)
  warm  one CLI process: the query once unmeasured, then --runs measured repeats

  python3 scripts/bench-duckdb-cli.py --db ../time-blast-data/nyc-taxi.duckdb [--runs 5] [--threads 4]
      [--memory 2GB] [--duckdb .cache/duckdb-cli-v1.4.3/duckdb] [--json out.json]

Times are the CLI's `.timer` real time (query execution and printing 'csv' output to /dev/null);
process start-up and the database open are not included.
"""
import argparse
import json
import os
import platform
import re
import statistics
import subprocess
import time

QUERIES = [
    ("count_by_hour", "SELECT hour(pickup_time) AS hour, count(*) AS trips FROM trips GROUP BY 1 ORDER BY 1"),
    ("trips_per_day", "SELECT pickup_time::DATE AS day, count(*) AS trips FROM trips GROUP BY 1 ORDER BY 1"),
    ("avg_fare_by_borough_join", "SELECT z.borough, avg(t.fare_amount) AS fare FROM trips t JOIN zones z ON t.pickup_zone_id = z.zone_id GROUP BY 1 ORDER BY 1"),
    ("duration_p50_p90_by_month", "SELECT date_trunc('month', pickup_time) AS month, quantile_cont(date_diff('second', pickup_time, dropoff_time) / 60.0, [0.5, 0.9]) AS minutes FROM trips GROUP BY 1 ORDER BY 1"),
    ("window_rolling_7d", "WITH d AS (SELECT pickup_time::DATE AS day, count(*) AS trips FROM trips GROUP BY 1) SELECT day, trips, avg(trips) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS rolling FROM d ORDER BY day"),
    ("window_top_zone_per_borough", "WITH r AS (SELECT z.borough, z.zone, sum(t.total_amount) AS revenue, row_number() OVER (PARTITION BY z.borough ORDER BY sum(t.total_amount) DESC) AS rn FROM trips t JOIN zones z ON t.pickup_zone_id = z.zone_id GROUP BY 1, 2) SELECT borough, zone, revenue FROM r WHERE rn <= 3 ORDER BY borough, revenue DESC"),
    ("top10_routes", "SELECT p.zone AS pickup, d.zone AS dropoff, count(*) AS trips FROM trips t JOIN zones p ON t.pickup_zone_id = p.zone_id JOIN zones d ON t.dropoff_zone_id = d.zone_id GROUP BY ALL ORDER BY trips DESC LIMIT 10"),
    ("one_week_by_hour_pruned", "SELECT date_trunc('hour', pickup_time) AS hour, count(*) AS trips, avg(total_amount) AS total FROM trips WHERE pickup_time >= TIMESTAMP '2024-06-01' AND pickup_time < TIMESTAMP '2024-06-08' GROUP BY 1 ORDER BY 1"),
    ("tip_pct_by_year_payment", "SELECT year(pickup_time) AS year, payment_type, 100.0 * sum(tip_amount) / sum(fare_amount) AS tip_pct FROM trips GROUP BY ALL ORDER BY 1, 2"),
]

p = argparse.ArgumentParser()
p.add_argument("--db", required=True)
p.add_argument("--runs", type=int, default=5)
p.add_argument("--threads", type=int, default=4)
p.add_argument("--memory", default="2GB")
p.add_argument("--duckdb", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".cache", "duckdb-cli-v1.4.3", "duckdb"))
p.add_argument("--only")
p.add_argument("--json")
args = p.parse_args()
queries = [q for q in QUERIES if not args.only or q[0] in args.only.split(",")]
SETUP = f"SET threads = {args.threads}; SET memory_limit = '{args.memory}';\n.mode csv\n.output /dev/null\n.timer on\n"
TIMER = re.compile(r"Run Time \(s\): real ([0-9.]+)")


def run(script):
    out = subprocess.run([args.duckdb, "-readonly", "-batch", args.db], input=SETUP + script, capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"duckdb failed: {out.stderr[:2000]}")
    return [float(m) * 1000 for m in TIMER.findall(out.stdout + out.stderr)]


def stats(values):
    return {"p50": round(statistics.median(values), 1), "max": round(max(values), 1), "min": round(min(values), 1), "n": len(values)}


version = subprocess.run([args.duckdb, "-version"], capture_output=True, text=True).stdout.strip()
result = {"db": os.path.abspath(args.db), "bytes": os.path.getsize(args.db), "duckdb": version, "threads": args.threads,
          "memory_limit": args.memory, "runs": args.runs, "host": platform.machine(), "cpus": os.cpu_count(),
          "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "loadavgStart": [round(v, 1) for v in os.getloadavg()], "queries": {}}
rows = run("SELECT count(*) FROM trips;")  # opens the file once (and warms the OS cache for the catalog)
for name, sql in queries:
    cold = [run(sql + ";")[-1] for _ in range(args.runs)]
    warm = run((sql + ";\n") * (args.runs + 1))[1:]
    result["queries"][name] = {"sql": sql, "cold": stats(cold), "warm": stats(warm)}
    print(f"{name:30s} cold p50 {stats(cold)['p50']:8.1f} max {stats(cold)['max']:8.1f} ms | warm p50 {stats(warm)['p50']:8.1f} max {stats(warm)['max']:8.1f} ms", flush=True)
result["loadavgEnd"] = [round(v, 1) for v in os.getloadavg()]
if args.json:
    with open(args.json, "w") as f:
        json.dump(result, f, indent=1)
        f.write("\n")
