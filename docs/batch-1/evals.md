# Batch 1 · NL→SQL eval by executed results

Status: implemented and run live (2026-10-10). Replaces the prototype's QueryPlan meaning corpus.

## What it measures

`evals/sql-corpus.json` holds **45 questions** over the `vessels` fixture with hand-written
reference SQL: aggregates, buckets, relative windows ("last 7 days" counted back from the data's
latest `ts`), vessel filters, top-N, comparisons, geo, and 13 ambiguous or unfinished questions
("wind", "speed last week", "average wave height per ves", an unknown vessel, a raw-row trap for
maps and scatters). Ambiguous questions list several acceptable references. `$SINCE(n unit)`
expands into three spellings of a window (`>=`, `>`, whole units).

`scripts/eval-sql.mjs` (logic in `evals/sql-eval.ts`, loaded with Vite's module runner):

1. Generates `vessels` with the engine's own `DuckDatabaseNode` on DuckDB-Wasm 1.32's
   **node-blocking** bundle (works on this ARM64 host; 4–14 s depending on load). Model SQL runs
   through the **same guard, limits and lockdown** as in the browser.
2. Sends HELLO and the **CONTEXT that node returns**, JSON-encoded like the engine host does, over
   tb1/WebSocket (`src/protocol/frame.ts`, Node's built-in WebSocket), then one INFER at a time.
3. Executes reference and model SQL and compares results:

| Category | Meaning |
|---|---|
| exact | same columns in the same order with the same names, same rows, values within 1e-6 relative |
| equivalent | same values, but other column names, value columns reordered, or values rounded to 2 decimals |
| shape-violation | right values, convention broken: x not first, series after a value, extra columns, time/number returned as text, right rows in the wrong order for a ranking |
| wrong | different values or row count |
| sql-error | database error (incl. `result_limit` from raw rows, `timeout`) or no SQL from inference |
| rejected-by-guard | `sql_rejected` (several statements), or a non-query that fails the guard's subquery wrapper |

Rows are compared order-insensitively unless the case says `ordered` (rankings). Column roles
come from the reference (x first, text series, values). Correct = exact + equivalent.
Known-issue counters: unasked `-- view:` hint, invalid view name, raw rows (> 5000 rows or
`result_limit`), foreign dialect (`DATETIME()`, `julianday`, `'now'`, …), wall clock (`now()`).

Latency is client-side from INFER send (loopback, server on the same host), plus the server's
provider-request → first-token span from the SQL frame's stamps. Cost and tokens are the
provider-reported `INFER_STATS`. Server SQL cache off (`TIME_BLAST_CACHE_ENTRIES=0`).

```sh
node scripts/eval-sql.mjs --self-test          # scorer check on the full corpus, no tokens (~25 s)
node scripts/eval-sql.mjs --endpoint ws://127.0.0.1:8787/session [--label x] [--only id,id]
node scripts/eval-sql.mjs --rescore docs/batch-1/eval-….json   # re-score saved SQL after corpus/scorer changes
```

`pnpm test` runs `tests/eval-sql.test.ts`: unit checks of the scorer plus the 13 scripted
fake-model answers against DuckDB (~12 s, dominated by fixture generation).

## Results (2026-10-10, OpenRouter, release server on this host, 45 questions, sequential)

| Model · prompt | exact | equiv. | shape | wrong | sql-err | guard | **correct** | first delta p50 / p95 ms | SQL p50 / p95 ms | cost / req | unasked view / raw rows / foreign dialect |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Gemini 2.5 Flash Lite · v1 (before) | 5 | 17 | 3 | 8 | 12 | 0 | **49 %** | 371 / 521 | 457 / 658 | $0.000110 | 42 / 8 / 7 |
| Gemini 2.5 Flash Lite · v2 (intermediate) | 6 | 23 | 2 | 8 | 6 | 0 | 64 % | 428 / 652 | 502 / 670 | $0.000116 | 42 / 8 / 0 |
| **Gemini 2.5 Flash Lite · v3 (now)** | 5 | 27 | 2 | 5 | 6 | 0 | **71 %** | 348 / 541 | 471 / 686 | $0.000118 | 27 / 7 / 0 |
| Gemini 2.5 Flash Lite · v3, repeat | 5 | 27 | 2 | 5 | 6 | 0 | 71 % | 353 / 525 | 488 / 699 | $0.000118 | 27 / 7 / 0 |
| Gemini 3.1 Flash Lite (reasoning minimal) · v1 | 8 | 32 | 0 | 5 | 0 | 0 | **89 %** | 527 / 805 | 631 / 831 | $0.000291 | 41 / 1 / 0 |
| Gemini 3.1 Flash Lite (reasoning minimal) · v3 | 5 | 34 | 0 | 6 | 0 | 0 | **87 %** | 482 / 665 | 570 / 866 | $0.000323 | 29 / 1 / 0 |

Reports: `docs/batch-1/eval-<model>-2026-10-10-<label>.json` (every SQL, verdict, reason, latency,
stats). Prompt tokens per request: ~868 (v1) → ~992 (v3); completion ~47–57. No cached tokens.
Total spend for all runs: **$0.053**. n = 45 per run, so p95 is the third-highest value.

Findings:

- **3.1 Flash Lite is far more correct** (87–89 % vs 49 % → 71 %), at 2.7× the price and
  ~100–130 ms more to first delta. Its misses are mostly judgment calls (hourly series for "average
  water temperature across the fleet", a 6-hour bucket, raw `LIMIT 5000` for a scatter).
- **2.5 Flash Lite v1 failures:** SQLite `DATETIME('…', '-1 day')` in 7 answers (all failed), raw
  rows of the 1.2 M-row table in 8 (`result_limit`), times formatted with `strftime` (category axis
  instead of time), bucket aliased as `ts` so `GROUP BY ts` grouped raw rows, and a `-- view:` hint on
  all 42 answers to questions that name no presentation.
- **Repeatability:** two v3 runs of 2.5 gave identical verdicts (temperature 0).

## Prompt changes (v1 → v3, both twins, golden fixtures regenerated)

In `crates/inference-server/src/prompt.rs` and `src/inference-node/prompt.ts`:

1. Time: "Write a relative window as `ts >= TIMESTAMP '<now>' - INTERVAL '7 days'`. Use DuckDB
   functions only (no SQLite DATETIME() or strftime)." (ClickHouse: `toDateTime(…) - INTERVAL 7 DAY`;
   `DATE` columns get a `DATE` literal.) → foreign dialect 7 → 0, sql-errors 12 → 6.
2. "Keep times as timestamps: bucket them with a function such as `time_bucket(…)`, never format
   them as text." → strftime x axes 3 → 1.
3. Aliases "that are not the name of a column" (stops `… AS ts GROUP BY ts`).
4. Rows: "A query on a table with more than 5000 rows fails without GROUP BY or LIMIT, also for a
   map, tracks or a scatter plot" → raw rows 8 → 7 only: 2.5 still returns raw rows for maps,
   scatters and one-word questions.
5. View hint reworded as an exception ("Most questions contain none; then the reply starts with
   SELECT or WITH") → unasked hints 42 → 27 (2.5) and 41 → 29 (3.1).

Cost: +124 prompt tokens (+7 % per request on 2.5). Latency within run-to-run noise.

## Known gaps

- One provider, one fixture, 45 questions: an integration check, not a model ranking.
- Arbitrary text labels are not matched to references: "first week vs second week" with labels
  `'First Week'` scores `wrong` although the numbers are right (both models).
- Unasked view hints still matter: the coordinator picks the view from a valid `-- view:` hint, so
  e.g. `-- view: table` on a time series would override the automatic chart choice. Options: ignore
  hints unless the question contains a view word (coordinator), or a model that follows the rule.
- Raw-row answers from 2.5 Flash Lite remain the largest failure (7/45). A cheap server-side fix to
  measure next: on `result_limit`, one repair turn with the error (needs the database error to
  reach inference; today only invalid SQL is repaired).
- DuckDB-Wasm returns parser errors as a JSON string (`{"exception_type":"Parser",…}`), so
  `unwrapError` in `src/engine/sql-guard.ts` does not strip the wrapper from those (engine area).
- WebLLM models are not evaluated (no GPU here); the runner can drive any tb1 inference endpoint.
