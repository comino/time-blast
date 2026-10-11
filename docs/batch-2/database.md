# Batch 2 · database first batch

Status: implemented, measured, on branch (2026-10-11). Owner: database-latency agent. Workstream 1 of
[plan-batch-2.md](../plan-batch-2.md).

## Result

EXEC → first Arrow batch over **all 308 statements** (45 corpus questions with every `$SINCE`
spelling, plus every model SQL saved in `docs/batch-1/eval-*.json`), paired, 5 repeats each, Node
23 on this ARM host with the same DuckDB-Wasm 1.32 build as the browser:

| Class (optimized path chosen) | n | before p50 / p95 ms | after p50 / p95 ms |
|---|---:|---:|---:|
| **all statements** | 281 | 24.5 / 158.9 | **4.7 / 24.1** |
| corpus references | 112 | 18.3 / 160.3 | 4.8 / 24.1 |
| saved model SQL | 169 | 33.6 / 158.9 | 4.7 / 36.0 |
| rollup, day grain (no time filter) | 70 | 79.3 / 129.1 | 2.6 / 4.3 |
| rollup, hour grain | 35 | 122.0 / 179.3 | 3.4 / 6.7 |
| rollup, hour grain + raw edge cells | 80 | 17.5 / 76.1 | 5.2 / 8.2 |
| rollup, minute grain | 6 | 6.9 / 160.3 | 3.6 / 19.3 |
| not rewritten (compressed storage only) | 90 | 8.9 / 213.8 | 7.4 / 219.3 |
| result-cache hit (any statement, replay) | 281 | — | **0.11** p50 |

p50/p95 are over the per-statement medians; 27 statements are errors in both paths (raw-row
`result_limit`, SQLite dialect) and are not timed. **308/308 results identical** to the batch-1
path (names, Arrow types, rows, order; values within the eval scorer's 1e-6 relative tolerance;
largest relative difference seen 1.7e-13). Raw: [database-bench-2026-10-11.json](database-bench-2026-10-11.json),
`node scripts/bench-database.mjs --repeats 5 --json …` (exits non-zero on any mismatch).

Browser (headless Chromium 145, worker, same queries, 9 paired repeats,
[engine-smoke-2026-10-11.json](engine-smoke-2026-10-11.json), `python3 tests/engine_smoke.py`):

| Query | raw p50 / p95 ms | optimized p50 / p95 ms | path | cache hit p50 ms |
|---|---:|---:|---|---:|
| avg speed per vessel | 36.1 / 45.4 | 4.1 / 7.3 | day rollup | 0.04 |
| hourly wind per vessel | 112.0 / 138.3 | 4.5 / 7.2 | hour rollup | 0.05 |
| daily max wave per vessel | 74.0 / 101.2 | 3.2 / 6.4 | day rollup | 0.04 |
| hourly speed, last 7 days | 44.5 / 63.1 | 6.1 / 7.0 | hour rollup + edges | 0.06 |
| minute × vessel, one week (60,480 rows) | 89.5 / 190.1 | 46.2 / 67.5 | minute rollup | 0.05 |
| Aurora 15 min, last day | 5.9 / 14.7 | 6.0 / 15.4 | raw (short range) | 0.05 |
| count where wave_height > 4 | 7.0 / 7.4 | 7.1 / 7.8 | raw (measure filter) | 0.04 |
| arg_max position per vessel | 254 / 274 | 251 / 345 | raw (arg_max) | 0.04 |

End to end (full app, fake inference, SwiftShader, `tests/e2e_fake_inference.py`, 12 samples,
same host and hour, Vite started with the switches below):

| Database features | last keystroke → first draw p50 / p95 ms | DB first batch p50 / p95 ms |
|---|---:|---:|
| all off (`VITE_TB_RESULT_CACHE=0 VITE_TB_ROLLUPS=0 VITE_TB_COMPRESSED=0`) | 106.7 / 163.6 | 102.2 / 159.2 |
| compressed + rollups, no cache (`VITE_TB_RESULT_CACHE=0`) | 51.3 / 88.5 | 38.2 / 74.1 |
| all on (default) | **39.2 / 64.5** | 32.8 / 51.4 |

[e2e-*-2026-10-11.json](e2e-all-on-2026-10-11.json). The host was quiet for this run (load ~1–6); batch 1's 331–372 ms was measured at
load ~30. Draw submission, not photons.

## What is built

All in the database node; no protocol or contract change.

1. **Compressed storage** (`compressed`, default on). Every connection uses
   `ATTACH ':memory:' AS tb_data (COMPRESS)`. DuckDB's in-memory default is uncompressed;
   compressed, `vessel` is dictionary/FSST and `GROUP BY vessel` uses compressed keys:
   per-vessel aggregates 80–130 → 11–40 ms, corpus total −21 %, table memory 102.6 → 24 MiB
   (including rollups). Generation time unchanged within noise. Works after lockdown (no external access).
2. **Result cache** (`resultCache`, default on, [result-cache.ts](../../src/engine/result-cache.ts)). Completed
   results replayed for the same statement (key = text without leading comments, so `-- view:`
   variants share). Replay uses the same frames, stamps, time slicing and cancellation as a
   live result; the stored `RecordBatch`es are the ones first emitted (views into DuckDB's message
   copies, never mutated). Bounded 24 MiB / 64 entries / 8 MiB per entry, LRU, cleared on every
   open. Never caches statements calling volatile or per-query functions (`now()`, `random()`, …;
   list from `duckdb_functions()` stability). Hit: ~0.1 ms Node, ~0.05 ms browser. The coordinator only
   dedups against the live slot's request, so this covers returns to earlier SQL.
3. **Time rollups + exact rewrite** (`rollups`, default on, [rollup.ts](../../src/engine/rollup.ts)).
   - **Build** (background, after `open`): for each table with a `TIMESTAMP` column and numeric
     columns, rollups at minute/hour/day grain (a grain is built when it shrinks the table ≥ 4×),
     keyed by time bucket × every text column whose full value set the statistics listed (≤ 32),
     with `count(*)` and sum/min/max (+ count when NULLs exist) per numeric column; coarser grains
     from finer. Vessels: minute 120,960 rows in 515–730 ms, hour 2,016 in ~50 ms, day 84 in ~9 ms.
     Each DuckDB step waits until no EXEC is running or queued before every poll, so queries
     during the build were not slowed (browser: 78–186 ms, same spread as the raw path); a new
     `open` aborts it.
   - **Rewrite** (per EXEC, memoized per text): parse with DuckDB's own parser
     (`json_serialize_sql`), accept only a whitelisted subset, print with `json_deserialize_sql`,
     splice in the rollup source. Exactness argument (also in the module header): the time column
     may only appear inside expressions constant on each grain cell (`time_bucket` widths that are
     multiples of the grain, `date_trunc`/`date_part`/`extract`/`hour()`/`dayname()`/`strftime`
     formats at grain or coarser, `ts::DATE`, `ts < c`/`ts >= c` with a grain-aligned literal), so
     evaluating them on the cell start gives the same value for every raw row; text dimensions are
     keys; aggregates are decomposable (count, sum, min, max, avg = Σsum/Σcount, FILTER kept) or
     duplicate-insensitive over keys (min/max/count DISTINCT/bool_and/or); types are preserved.
     Top-level time bounds need not be aligned: whole cells come from the rollup, the ≤ 2 partial
     cells from zone-map-pruned raw scans aggregated to the same layout; the three parts are
     disjoint by construction. Unaliased output columns keep DuckDB's names. Everything else
     (joins, subqueries, CTEs, window functions, measure predicates, `avg(a/b)`, corr, arg_max,
     `GROUP BY ts`, sub-minute buckets, …) runs on the raw table; a rewritten statement that fails
     to start is rerun raw.
   - **Short ranges** stay raw: when the bounds' estimated raw rows are < 245,760 (minute grain)
     or < 30,720 (hour grain), the zone-map-pruned raw scan is as fast (measured: minute + edges
     5.4 ms vs raw 4.0 ms on these; hour + edges 5.3 vs 10.4, hence the lower hour threshold).
   - **Cost on the hot path:** first sight of a statement 3.2 ms p50 / 6.4 ms p95 Node, 3–6 ms
     browser (first ever ~18 ms, JIT); memo hits ~µs. Statements naming no rolled-up table skip
     the parse.
   - `lockDown` now also loads the `json` extension (from extensions.duckdb.org, like parquet):
     **+250–270 ms cold boot** (browser cache warm afterwards). Without it, everything works,
     unrewritten.

## Experiments that lost

- **Threads.** The blocking API ships only the mvp/eh builds, compiled without threads (`SET
  threads = 2` → "DuckDB was compiled without threads"). The COI build is only reachable through
  the async API (own worker + pthread workers + a postMessage hop). Run 1 (load ~10): async COI at
  1/2/4 threads 98–188 ms vs blocking eh 87–152 ms on the same aggregates, no consistent gain,
  instantiate 7.6 s vs 1.7 s. Run 2 (quieter): COI with 1 and 2 threads failed with `RangeError:
  offset is out of bounds`; 4 threads mixed (hourly × vessel 112 vs 135 ms, minute × vessel 226 vs
  139 ms). Not adopted. [threads-…-run1.json](threads-2026-10-11-run1.json),
  [run2](threads-2026-10-11-run2.json), `python3 tests/engine_threads.py`.
- **Physical order / row-group size.** `vessels` is already in `ts` order (zone maps prune time
  ranges). Re-sorting by `(vessel, ts)` helped vessel filters (107 → 67 ms) and hurt time ranges
  (up to 2×), and costs a sort at load; rollups serve both. `ROW_GROUP_SIZE` on the in-memory
  attach had no effect (still 10 row groups). TIMESTAMP vs BIGINT epoch: hourly bucket 85 vs 46 ms
  on raw, but changing the user's column type is not generic and rollups remove the bucket cost.
- **ENUM for text dimensions:** per-vessel 82 → 11 ms, but changes the Arrow type (dictionary)
  the model and renderer see. Compressed VARCHAR (21 ms) kept instead.
- **Superset reuse** from cached results: not built; rollups make the near-identical next
  keystroke 3–6 ms already, with no exactness proof needed per cache entry.
- **First-bucket split** (experiment 5): not built. After rollups the remaining large first-batch
  costs are statements that cannot be rewritten (arg_max 250 ms, corr, measure filters 7–35 ms)
  and one wide output (60,480-row minute × vessel, 35–46 ms browser). A split helps only the
  latter; it is the next candidate if large time-ordered outputs matter.

## Remaining gap and next steps

- Non-rewritable shapes dominate the tail (p95 24 ms all, 219 ms raw class): `arg_max`/latest
  value (could get a per-cell `arg_max` state), `avg(expr)` (linear expressions are
  decomposable), measure predicates (no rollup can help; compressed storage only).
- Rewrite cold cost: ~1.3 ms parse + ~1.5 ms print per new statement; a JS printer for the
  whitelisted subset would remove the print query (correctness risk, not done).
- Wide minute outputs (60k rows): first batch waits for the whole hash aggregate; a first-bucket
  split or a projection-only rewrite when the query's groups equal the rollup key.

## Correctness evidence

- `scripts/bench-database.mjs`: 308/308 identical (above).
- `tests/engine-rollup.test.ts`: a synthetic table with NULL measures and a NULL dimension, BIGINT
  and DOUBLE, gaps, unaligned timestamps; 33 shapes must rewrite and match, 20 must fall back and
  match (incl. `GROUP BY ts` shadowing, `ts > aligned`, sub-minute buckets, now(), DISTINCT sums,
  joins, CTEs, windows), plus the short-range rule, memoization, cache keys/bounds/volatility.
- `pnpm test` green; eval self-test unchanged (`node scripts/eval-sql.mjs --self-test`).

## Notes for other areas

- `ExecStats` gained `source` (`raw|rollup|cache`), `rewriteMs`, `rewrite`, `grain`, `fallback`.
- **Requested contract change:** a way to tell the coordinator/UI where a result came from (a flag
  on RESULT_SCHEMA or a stamp), so TIMING can show "cache"/"rollup" — today it is only in ExecStats.
- **Known risks:** float sums/averages are re-associated (differences ~1e-13 relative); a tie
  between float aggregates under `ORDER BY … LIMIT` could in principle resolve differently. The
  rewrite trusts DuckDB's printer (`json_deserialize_sql`) for the whitelisted node types. The
  `json` extension is a second boot-time fetch from extensions.duckdb.org.
