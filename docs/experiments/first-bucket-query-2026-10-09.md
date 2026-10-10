# First complete bucket, then the remaining window

Status: implemented and measured on the bundled large dataset, 2026-10-09. Native model generation was paused during measurement. This changes the local database execution strategy, not inference.

The adapter executes the earliest complete *query group* first, streams its final aggregate into the existing card, then executes the remaining groups. The week/minute six-vessel query drew its first six points in median 13.85 ms, versus 55.65 ms with the whole-window statement. Median paired total-database overhead was 6.30 ms. Shorter queries have a smaller first-point benefit and still pay the extra query setup.

## Exact partition

The current Rust compiler groups on `floor(t / bucket_ms) * bucket_ms`, not on a bucket anchored at the requested lower bound. Let:

```text
L = max(dataset.start, dataset.end - requested_hours * 3_600_000)
E = dataset.end
B = bucket_minutes * 60_000
C = min(E, (floor(L / B) + 1) * B)
```

Run the unchanged aggregate/projection/filter over `[L, C)`, followed by `[C, E)` when `C < E`. Keep `ORDER BY x, series` in each statement. Every original group lies entirely in one interval, so the two ordered streams concatenate without sorting, merging aggregate states or copying columns. The logical plan and its original context remain unchanged.

This means the prefix has at most six rows here: one per available vessel, or one fleet aggregate/named vessel. It is a final aggregate for that requested group, not an average of an incomplete slice presented as final. Empty groups produce no invented point; an empty prefix continues to the remainder without another search query.

Using `L + B` as the cut is incorrect when `L` is not aligned. For example, a 25-hour window ending at midnight with six-hour buckets starts at 23:00: its first group contains only the requested hour before midnight, with an 18:00 bucket label. Splitting six hours after 23:00 would divide the next group and duplicate its timestamp/series. A one-hour window with daily buckets has no remainder and should use the original statement directly. Windows beyond available coverage retain their requested window but partition only its available overlap.

The renderer already expands its horizontal domain to include the first bucket label, which can precede `L` for a partial bucket. Preserve that label; moving it to `L` would change the query result. Named-vessel, grouped-vessel and fleet aggregation keep their existing compiler expressions. `avg(lat)` and `avg(lon)` must use the same rows as the corresponding metric group.

## Restrictions and costs

- **Snapshot:** production uses one `BEGIN TRANSACTION READ ONLY` transaction across both statements, with `COMMIT` only after both readers finish and rollback/close on failure. This syntax was exercised on the actual bundled engine. The private adapter owns the bundled telemetry table and checks dataset ID, bounds, row count and ordered vessel names, plus the original logical SQL identity. This optimization is advertised only by that browser adapter; arbitrary remote/live tables and ClickHouse have no equivalent capability claim. Physical SQL is internal compiler-produced metadata, not a new untrusted SQL API.
- **Floating point:** group membership is mathematically identical, but a changed execution plan can change floating-point accumulation order. DuckDB documents `avg` as order-sensitive. This affects metric averages and both coordinate averages, even when the selected metric aggregate is min/max. The harness reports strict numeric equality and drift separately; it does not silently use a tolerance to declare the optimization exact. [DuckDB aggregate documentation](https://duckdb.org/docs/current/sql/functions/aggregates#avgarg).
- **Storage layout:** the large generator emits nearby timestamps together. Range predicates may let DuckDB skip unrelated row groups through zonemaps; this is a plausible explanation, not a measured pruning rate or execution-plan analysis. [DuckDB indexing documentation](https://duckdb.org/docs/current/guides/performance/indexing#zonemaps).
- **Extra work:** bounded SQL compilation, two query setups and Arrow schemas, plus transaction start/commit can cost more than the saved first scan. Production uses one connection. The first source row group may be visited by both statements. First-point and full-completion measurements are reported separately.
- **Transport:** two separate calls to `connection.send(sql, true)` are needed. Combining statements with `UNION ALL ... ORDER BY` recreates a global blocking operator. A streaming output API does not guarantee an aggregate before its input group is complete. [DuckDB-Wasm query API](https://duckdb.org/docs/current/clients/wasm/query#query-execution).
- **Cancellation and budgets:** production retains one logical request, signal, admission owner and active connection, and shares row/unique-buffer limits across both statements. Abort or consumer return skips the remainder; canceling an old connection cannot affect a newer query. Prefix delivery followed by remainder or commit failure is a partial failed result, never completion. Speculative staging and the card retain their existing request identities.
- **Copies:** deliver each retained Arrow `ColumnBatch` unchanged. Do not merge the streams into a table, construct rows, concatenate arrays, pass values through the Rust heap or re-encode local Arrow. The existing unavoidable DuckDB worker/IPC boundary remains.

## Paired measurements

DuckDB-Wasm 1.32.0, Arrow 17.0.0 and Chromium 145.0.7632.0; large bundled dataset with 1,209,600 readings. Six paired warm trials per case, with one warmup per strategy. Values below are milliseconds. Paired differences are medians of each pair's difference and need not equal a difference of medians.

| Query | Original first draw, median | Production first draw, median | Paired first-draw saving | Paired DB completion overhead |
|---|---:|---:|---:|---:|
| Minute / week / six vessels | 55.65 | 13.85 | 42.40 | +6.30 |
| Hour / day / six vessels | 20.25 | 14.80 | 4.35 | +8.55 |
| Six hours / partial 25-hour window | 20.25 | 15.15 | 4.80 | +6.25 |
| Minute / week / named vessel | 28.75 | 13.85 | 15.05 | +8.00 |
| Hour / week / combined fleet | 41.50 | 14.55 | 26.90 | +7.75 |
| One partial daily bucket, original statement fallback | 14.05 | 13.95 | 0.40 | -0.75 |

All 36 production pairs matched every ordered timestamp, series ID, metric, latitude and longitude exactly (`Object.is`, no tolerance). Every logical query used one observed connection. Partitioned first draws used six points or one named/fleet point. The final fallback row executes the same statement in both modes; its sub-millisecond variation is not evidence of a speedup. Full-chart completion and descriptive p95 values are retained in the raw report.

- [Production report](../benchmarks/first-bucket-production-2026-10-09.json): one connection and one read-only transaction, including planning/setup overhead.
- [Original experiment](../benchmarks/first-bucket-experimental-2026-10-09.json): two adapter calls/connections, also 36 exact pairs. Its week/minute paired first-draw saving was 42.05 ms with +9.50 ms database overhead. Its old source hashes and execution description are preserved.

These are local warm database-to-draw measurements on a prepared line card, not inference, network, cold-start, mobile-device or physical display latency guarantees.

[`tests/browser_first_bucket_experiment.py`](../../tests/browser_first_bucket_experiment.py) uses the actual adapter, Rust/Wasm compiler and line card without loading an LLM. The harness is intentionally separate from application code.

```sh
# Inspect the bounded plan without starting Chromium or DuckDB:
python3 tests/browser_first_bucket_experiment.py --dry-run

# Only after other CPU/GPU jobs finish, with Vite running:
python3 tests/browser_first_bucket_experiment.py --implementation production --trials 6 --warmups 1 \
  --output /tmp/time-blast-first-bucket-production.json
```

Six cases cover a dense minute/week result, hourly results, a partially covered six-hour bucket, one named vessel, fleet aggregation, and a single partial daily bucket. Both dataset profiles are selectable. The comparison alternates baseline/partition order in each pair and records raw trials, first-batch time, first draw submission, half-data delivery, database completion, complete-chart time, unique retained bytes and additional statement count. Startup is separate; timings start with an already prepared line card and compiled original logical SQL. Partition planning/extra SQL compilation is included in the candidate's database timing. These are warm trials; a six-sample p95 is descriptive, not a robust tail estimate.

The default harness invokes the production `compileFirstBucket` and adapter metadata path. It observes actual connection and `send` calls, so skipped remainder calls and one-connection ownership are checked rather than inferred from planned statements. `--implementation experimental` retains the original two-call comparison. Only that historical experiment uses temporary compilation bounds; the application uses the explicit `compile_query_range` Rust ABI with the unchanged original snapshot and time-window anchor. The ABI rejects out-of-window bounds and cuts that divide an aggregate group. No application SQL rewriting or context substitution is used.

Only borrowed batch references are retained for the post-timing correctness oracle, bounded by two result budgets. It traverses the numeric views with cursors, checks complete timestamp/series order and every metric/coordinate value, and reports any difference. A mismatch produces a nonzero exit after the report is saved. No numeric buffers or per-row objects are created by the oracle. Retaining a reference result is measurement machinery and must not enter the application's first-point path. A separate untimed check cancels after the prefix and verifies that the remainder never starts and a subsequent normal query succeeds.

## Implementation checks

The coordinator's `firstBucket` option additionally requires browser placement and an explicit adapter capability. It retains compiled execution metadata with prepared SQL and preserves it on promotion; query IDs, logical SQL, plans and contexts stay unchanged. The single-bucket case omits metadata and uses the original path. Main enables the option only for the browser database. No heuristic based on unmeasured row counts was added.

Rust and checked-in-Wasm tests cover partial bucket alignment, original window anchoring, wide-window clipping, fixed identifiers and invalid execution ranges. Controlled adapter tests cover one connection, read-only transaction setup/commit failures, producer-buffer retention, empty prefix, remainder send/stream failures, abort, early consumer return, cancellation between phases, admission ownership and shared row/unique-buffer budgets. The real browser comparison also aborts after the prefix, observes exactly one statement, and verifies that the next normal query returns all 60,480 points. Coordinator tests cover capability gating and prepared-query promotion. Floating-point equivalence should be rechecked when the engine, data generator or query algebra changes.

The separate untimed [`browser_first_bucket_safety.py`](../../tests/browser_first_bucket_safety.py) probe passed on the actual demo database. An injected `UPDATE` in either physical statement failed specifically because the transaction was read-only, before any mutation. Subsequent baseline results matched all 144 original points and every numeric column exactly. Early consumer return skipped the remainder, and cancellation during the remainder returned `AbortError` with an unchanged subsequent result. This probe is separate from the timing harness so the measurement source hashes remain reproducible.

```sh
python3 tests/browser_first_bucket_safety.py
```
