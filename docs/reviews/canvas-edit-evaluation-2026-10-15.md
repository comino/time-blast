# Contextual canvas edit evaluation — 2026-10-15

The Rust inference backend passed **12 executed-result checks across vessels, weather, flights and cities**, including automatic repair. Cumulative provider-reported cost was **$0.00355485**. No deployment or existing-service restart was performed.

The initial run below covered eight weather/cities cases plus a targeted automatic repair request, at **$0.0025257**. The vessels/flights extension and its separate artifact are recorded under Dataset coverage completion.

Artifacts: [main run](canvas-edit-eval-2026-10-15.json), [automatic repair run](canvas-edit-repair-eval-2026-10-15.json), [runner](../../scripts/eval-canvas.mjs), [cases and protocol client](../../evals/canvas-edit-eval.ts).

| Case | What the result established | Verdict |
|---|---|---|
| `preserve_sql_filter_and_bucket` | Changing average to maximum retained the below-freezing filter present in selected SQL, Berlin, the 2024 bounds, daily buckets and ordering. | Exact |
| `selected_branch_removal` | Monthly buckets retained a removed-filter decision and excluded the abandoned London branch. The case builds a real `CanvasModel`, restores the selected revision, and calls production `editBase()`. | Exact |
| `regenerate_from_question_and_lineage` | Regeneration recovered daily Berlin temperature averages for July from original intent plus lineage despite selected SQL containing unrelated Madrid humidity. | Equivalent; alias differs |
| `database_error_repair_keeps_context` | A real DuckDB binder error from an intentionally invalid attempted edit was supplied with the request. The provider fixed it while retaining the selected filter and requested maximum. | Exact |
| `guard_repair_alias` in main run | Requesting the alias `order` retained the changed aggregate and chart constraints. DuckDB accepts `AS order`, so this did not trigger automatic repair. | Equivalent; alias differs |
| `preserve_join_filter_grouping` | Changing sum to average retained the country join, Europe restriction, population threshold, country grouping and ordering. | Equivalent; alias differs |
| `europe_limit_refinement` | Reducing ten to five retained the selected Europe join/filter and population ordering. | Exact |
| `asia_same_request_cache_isolation` | The identical request with selected Asia SQL produced Asian results, rather than reusing the preceding European answer. Both were server-cache misses. | Exact |
| `guard_repair_alias` targeted run | The final corpus uses the known bare-date-alias trap: `date_trunc('day', time) day`. The provider used **two attempts**; the final SQL repaired the alias while retaining maximum temperature, Berlin/year bounds and daily grouping. | Exact |

The database-error case uses a seeded invalid attempt and a real database error; it does not claim the application automatically forwards database errors. The targeted guard case exercises the real backend repair path with a real provider, without injecting a canned response.

## Scoring and execution

The scorer uses the existing `compareResults` function: it executes the reference and model SQL through the engine’s `DuckDatabaseNode`, compares row values, column roles and order, and allows equivalent aliases. It does not score SQL text similarity. Every reference must return rows. Database result caching, rollups and compression are disabled to make comparisons direct.

The initial `node scripts/eval-canvas.mjs --self-test` passed **25 checks across eight cases**; the extended corpus now passes **37 checks across 11 cases**. These include executing correct references and rejecting concrete counterexamples: dropped filters, resurrected restrictions, an abandoned branch, ignored regeneration lineage, lost joins, unchanged aggregates/limits, cross-context answer reuse, and malformed aliases. These scorer checks use no provider calls.

The live protocol is `HELLO → READY → CONTEXT → EDIT_CONTEXT → EDIT_INFER`. The runner requires `edit-context-v1` before sending any inference request, registers a fresh immutable target generation per request, and records SQL, exact context, provider statistics and relevant source hashes. It saves partial reports if a connection or cost check fails.

The changed Rust service was built with the existing cached toolchain, `cargo build --locked --jobs 1 --manifest-path crates/inference-server/Cargo.toml`, then run as a temporary systemd unit on loopback port **8793**. Its environment came directly from `/etc/time-blast/inference.env`; credentials were never printed or copied into a script, report or repository file. The temporary process had a **$0.04 daily budget** and 64 cache entries. It was stopped after each run. The existing deployed service on port 8787 was untouched.

## Measurements and limits

- Model reported by the backend: `openai/gpt-oss-120b`. Provider route and warm state are not independently established by this report.
- Main run: eight requests, **$0.0020874**, client request-to-complete-SQL p50 **456 ms**, p95/p99/max **1008 ms**.
- Targeted repair: one request, two provider attempts, **$0.0004383**, request-to-complete-SQL **1109 ms**.
- Node **v23.11.1**, DuckDB-Wasm package **1.32.0**, Linux ARM64; four logical CPUs reported. This was the debug backend build, on a shared host with concurrent implementation work.
- Main run opened a fresh inference connection for each dataset. The backend was new at the start of each run; provider prompt caching still occurred. Main-run provider statistics reported 1,280 cached prompt tokens; the repair run reported 1,280. No speculative requests were made.
- Weather: 210,528 rows. Cities: 34,159 rows, joined to 252 countries. Load times and per-case execution times are in the JSON artifacts.
- These are nine targeted correctness observations, not a broad accuracy or tail-latency benchmark. With eight samples, p95/p99 equal the maximum. Timings stop at SQL or query completion; they do not measure chart drawing or photons. No browser was involved in this eval.

Reproduce after starting an isolated current backend with the normal server-only provider environment:

```sh
node scripts/eval-canvas.mjs --self-test
node scripts/eval-canvas.mjs --endpoint ws://127.0.0.1:8793/session
node scripts/eval-canvas.mjs --endpoint ws://127.0.0.1:8793/session \
  --only guard_repair_alias --output /tmp/canvas-edit-repair.json
```

The corpus now contains the targeted bare-`day` alias request. The main run preserves the earlier alias request exactly as measured; the separate targeted artifact records the corrected repair probe. No previously measured SQL or results were rewritten.

## Dataset coverage completion — 22:07 UTC

Three additional live cases passed on **vessels and flights**, closing the proposal’s four-dataset coverage requirement. The earlier weather/cities case inputs were unchanged. Exact edit bases, requests, returned SQL, expected/result row counts, view hints, timings, provider statistics and source hashes are in the [additional dataset run](canvas-edit-extra-datasets-2026-10-15.json).

| Additional case | Executed behavior | Result | SQL time | Cost |
|---|---|---|---:|---:|
| `vessels_captured_gesture_regroup` | Changed hourly wind to 30-minute buckets while preserving Aurora and the captured half-open brush interval, 2026-09-10 06:00–12:00. | Exact, 12 rows | 646 ms | $0.00029550 |
| `flights_regroup_preserves_gesture` | Changed airline grouping to destination airport names through the appropriate airport join. Retained JFK origin, June 24 lower bound, non-cancellation and the positive-delay gesture filter. | Equivalent alias, 66 rows | 1404 ms | $0.00039285 |
| `flights_explicit_bar_preserves_definition` | Changed presentation from Line to Bar with `-- view: bar`, retaining the carrier join, grouping and all selected filters. | Exact, 9 rows | 875 ms | $0.00034080 |

The gesture cases supply the captured semantic filter in selected SQL and a `gesture` lineage entry. They measure contextual inference after capture; the controller/browser suites separately verify actual pointer capture and target identity. The explicit-view scorer checks both executed data and the required view hint, and rejects an omitted hint, the previous Line hint, or a Bar answer that drops the gesture filter.

The full scorer self-test now passes **37 checks across 11 cases**. Strict TypeScript checking of the eval module also passes. Only the three new cases made provider calls in this extension. All three used one attempt, and all were server-cache misses. Additional cost was **$0.00102915**; cumulative cost across the three reports is **$0.00355485**, for **12 successful live requests** including the earlier alias probe and its targeted repair replacement. The three-request SQL p50 was 875 ms; p95/p99 equal the 1404 ms maximum because the sample is tiny.

Vessels used 1,209,600 telemetry rows. Flights used 611,132 flights, 15 carriers and 340 airports. The existing debug backend was rebuilt incrementally from current source and started only on the isolated loopback port, with a $0.018 process budget. Its provider environment stayed in the server-only environment file. The temporary service was stopped after the run; the deployed service was untouched. Provider warm state remains unknown; the extension reported 512 cached prompt tokens.

**Implementation distinction:** actual provider-quality measurements here exercise the Rust inference backend. TypeScript inference support is covered separately by protocol/cache/repair unit checks and byte-identical TS/Rust prompt goldens. This does not claim a live WebGPU-model quality run; no browser model was loaded on this host.

```sh
node scripts/eval-canvas.mjs --self-test
node scripts/eval-canvas.mjs --endpoint ws://127.0.0.1:8793/session --max-cost 0.02 \
  --only vessels_captured_gesture_regroup,flights_regroup_preserves_gesture,flights_explicit_bar_preserves_definition \
  --output docs/reviews/canvas-edit-extra-datasets-2026-10-15.json
```
