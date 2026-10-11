# Batch 3 · generality: real datasets, per-dataset eval scores

Status: implemented and measured 2026-10-11; merged into `main`.
Workstream 3 of [plan-batch-3.md](../plan-batch-3.md).

**Result:** the engine works on three real public datasets of different shapes without code that
knows them. The default model (`openai/gpt-oss-120b`, Groq, reasoning `low`) scores **85–88 %
on time-series data, 85 % on a three-table event set and 77 % on a non-temporal two-table set**
(vessels: 90 %). Two prompt changes measurably helped and are in: time examples that name the
dataset's own time column, and a list of column names shared between tables. The renderer needed
one fix (a lone latitude/longitude). The rollup rewrite stayed exact on 691 statements.

## Datasets

All in `public/data/<name>/`, listed in `public/data/datasets.json` (manifest contract of
plan-batch-3). Rebuilt deterministically (same bytes on rerun) by `node scripts/fetch-datasets.mjs [name|all]`
(Node + DuckDB-Wasm's node bundle, no new dependencies; raw downloads cached in `.cache/datasets/`).

| Name | Shape | Tables (rows) | Parquet | License / source |
|---|---|---|---|---|
| `weather` | multi-entity hourly time series; time column `time`, no `ts` | weather (210,528: 12 cities × 2023–2024) | 1.3 MB | CC BY 4.0, Open-Meteo historical API (ERA5) |
| `flights` | event table, 21 columns, 15-value and ~400-value categoricals, DATE + TIMESTAMP; needs JOINs | flights (611,132, June 2024), carriers (15), airports (340) | 8.4 MB | Public domain: US DOT BTS on-time data; OurAirports (public domain); carrier names from BTS's code list |
| `cities` | non-temporal, geographic, JOIN on country | cities (34,159, GeoNames cities15000), countries (252) | 0.75 MB | CC BY 4.0, GeoNames |

**Committed, not fetched at deploy:** 10.5 MB in total, every file below 9 MB; the evals need the
exact bytes (BTS revises months, Open-Meteo reprocesses). The vessels entry in `datasets.json`
mirrors the plan for the integrator; its file comes from the cold-start workstream.

Found while building them: DuckDB-Wasm's node runtime does not truncate an existing file, so
`COPY … TO` over an older, longer Parquet file kept the old footer and read back stale rows. The
script deletes the target first.

## Eval: corpora and runner

- `evals/sql-corpus-{weather,flights,cities}.json`: 34, 34 and 31 questions with hand-written
  reference SQL, same scoring as `evals/sql-corpus.json` (aggregates, buckets, relative windows,
  top-N, joins, maps, scatters, ambiguous one-word and half-typed questions, unknown entities).
  `$SINCE` now expands on the corpus's `time` column.
- `node scripts/eval-sql.mjs --dataset <name>|all` opens each dataset with the engine's own
  manifest loader (`DuckDatabaseNode`, `{kind:'fixture', name}`, Parquet tables, `prebuilt: false`),
  waits for the background rollups and sends the CONTEXT that node returns. The scores below were
  measured before the cold-start loader was merged, through an equivalent shim that kept the
  manifest's table order; the merged loader lists tables alphabetically (flights: airports,
  carriers, flights), which changes the flights prompt's table order (not re-measured).
- Also new: `--rollup-check` (rollups/compression/cache on vs. off, every statement),
  `--export-arrow` (results for the renderer check), `--print-prompt`, `--no-description`.
  Database timeouts are retried twice (the shared host reached load 140 during these runs).
- Scorer: latitude/longitude columns are exempt from the column-order rule, because the renderer
  finds them by name anywhere.

## Scores

Release server on this host, default profile, server cache off, sequential, 4 runs per prompt
(runs are **not** deterministic: the same vessels prompt scored 39–41/45). Latency is client-side
from INFER send; the host was heavily loaded during part of the runs, so treat it as indicative.

| Dataset | n | prompt v3 (main) | **prompt v6 (this branch)** | v6 categories, 4 runs (exact/equiv/shape/wrong/sql-err) | first delta p50 / p95 ms | cost / run |
|---|---:|---:|---:|---|---:|---:|
| vessels | 45 | 91.1 % | **89.4 %** (prompt bytes unchanged; 8-run mean of both 90.3 %) | 12/149/0/19/0 | 287 / 567 | $0.0069 |
| weather | 34 | 83.1 % | **88.2 %** | 8/112/4/11/1 | 265 / 580 | $0.0056 |
| flights | 34 | 82.4 % | **84.6 %** | 0/115/2/9/10 | 294–385 / 570–1009 | $0.0067 |
| cities | 31 | 70.2 % | **77.4 %** | 7/89/17/10/1 | 259–280 / 580–846 | $0.0047 |

Raw rows (>5000 or `result_limit`), foreign dialect and unasked view hints: 0 on every dataset
(one unasked `-- view:` per cities run). Reports: `docs/batch-3/eval-<dataset>-gpt-oss-120b-2026-10-11-<label>.json`
(`b3-baseline*` = v3, `b3-v5*`, `b3-v6*`, single-run ablations `b3-v5-{T,A,L,TALR}`).
**Spend: $0.37** provider-reported over 58 reports, plus one aborted run (< $0.01). Cap $1.00.

Where the remaining misses are (v6): extra informative columns (a country next to a city, a
name next to a code: `shape-violation`), judgment calls on ambiguous questions (O'Hare delay as
origin-or-destination, "delays" excluding cancelled flights), bare keyword aliases
(`flight_date day,` is a DuckDB syntax error: 1–2 per flights run in every prompt version), and
2–3 replies per run without valid SQL after the repair turn.

## What changed, by evidence

Prompt (both twins byte-identical; goldens in `crates/inference-server/tests/fixtures/`, new
fixtures for the three datasets):

| Change | Evidence | Kept |
|---|---|---|
| **T** Time examples use the dataset's first TIMESTAMP (else DATE) column, not a hard-coded `ts`; no time-bucket text and no Time section without a time column | weather 83 → 88 % (4 runs each); flights, cities within noise; vessels prompt unchanged | yes |
| **Q** "Columns in more than one table: name, population. Qualify them …" (computed from the context) | cities 71 → 77 % (24/31 in all 4 runs), ambiguous-column binder errors 16 → 1; flights 82 → 85 %; single-table prompts unchanged | yes |
| A: "alias (written with AS)" | vessels 91 → 80 % (1 run, outside the 39–41 noise band) | no |
| L: "Never cut a longer result with LIMIT" | flights 88 → 82 %, vessels 91 → 87 % (1 run) | no |
| R: "a ranking … without a number, return the top 10" | flights 56 %: every "per carrier" became a top 10 | no |

- **Join hints from the description:** dropping the manifest description cost cities 3 questions
  (one wrong join key, one lost feature-code meaning) and flights nothing (1 run). Descriptions with
  join keys and code meanings stay in the manifest; automatic join-key inference is not needed yet.
- **Bare keyword alias check** (`sql::keyword_alias` / `keywordAlias`, shared cases in
  `sql-cases.json`): on DuckDB, a date-part keyword used as a bare alias gets the existing repair
  turn on attempt 1. Unit-tested in both twins; **not yet measured live**.
- **Twin bug found by real data:** serde_json's default float parsing rendered
  `-99.68190002440001` as `-99.6819000244` while JavaScript kept all digits, so the Rust and TS
  prompts differed for the flights context. The inference server now enables `float_roundtrip`.

Renderer (`crates/tb-render/src/schema.rs`, `public/wasm/tb-render.wasm` rebuilt):
`tests/render_generality.py` feeds 280 real results (every reference plus the model's SQL) through
the Rust/Wasm renderer in headless Chromium (SwiftShader WebGPU) and compares the automatic choice
with what a reader expects from the shape ([render-generality-2026-10-11.json](render-generality-2026-10-11.json)).
- Fixed: a lone latitude or longitude (`avg(lat)` per continent, the easternmost `lon`) took the geo
  role, left no value and fell back to a table. Geo roles now need both; the column is a value.
- Open: a one-row result with five measures picks a one-point scatter (numeric x); a text column
  that is unique per x (largest city per country) becomes a 244-series heatmap instead of a label.
  Both need data-aware choice in `view/`, not role inference.

Rollups (no code change): `--rollup-check` ran 691 statements (all references and model SQL) on
rollups+compression+cache vs. plain: **0 mismatches**. Flights got hour (12,084 rows, 0.35–1.3 s)
and day (1,038) rollups keyed by carrier and cancellation reason; cities none (no time column);
weather none, wrongly: `rollupSpecs` estimates cells × product of dimension cardinalities
((12+1)·(10+1) = 143 combos for city × country), but city determines country (12 real combos), so
even the day grain (8,772 rows, 24× smaller) looks useless. Measured by hand on a day rollup:
monthly precipitation per city 55 → 9 ms (loaded host, indicative).

## Contract changes needed

- None to `contracts.ts`. `describe()` now lists a manifest entry's tables in manifest order (the
  fact table first), as these scores were measured (fixed on `main` after the merge).

## Next

- Rollup estimate: count distinct dimension combinations (one cheap query in `buildRollups`)
  instead of multiplying cardinalities, so weather gets its day rollup (database owner).
- Measure the keyword-alias repair live (flights: expect +1–2 questions per run).
- Data-aware view choice for one-row wide results and label-like text columns (renderer owner).
- `approx_count_distinct` overstates small tables (airports.code: 393 distinct of 340 rows); use an
  exact count below ~100k rows (database owner).
- More runs per prompt: at n ≈ 30 and run-to-run spread of ±2 questions, single runs cannot rank prompts.
