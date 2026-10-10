# Batch 1: engine (worker host, links, database node)

Status: implemented and tested (2026-10-10). Owner: engine agent.

## What exists

| File | Role |
|---|---|
| `src/engine/links.ts` | `Link`s: in-process pair, MessagePort/Worker, WebSocket (`tb1`) |
| `src/engine/database-node.ts` | `DuckDatabaseNode`: EXEC/CANCEL, guard, limits, Arrow streaming, datasets, context statistics, boot lockdown |
| `src/engine/database.ts` | `createDatabase`: DuckDB-Wasm **blocking** browser bundle inside the engine worker (eh/mvp, gzip engine in production) |
| `src/engine/arrow-ipc.ts` | Decodes one Arrow IPC message at a time (`Message.decode` + `VectorLoader`) |
| `src/engine/sql-guard.ts` | Single read-only statement guard |
| `src/engine/dataset.ts` | Fixture SQL, table naming, statistics/sample SQL |
| `src/engine/host.ts` | `EngineHost`: routing, pre-ready queues, coordinator tick scheduling, inference link |
| `src/engine/engine.worker.ts` | Worker entry: real factories + `EngineHost` + `connectInference` |
| `src/engine/yield.ts`, `limits.ts`, `wasm-asset.ts` | MessageChannel yield, limits, gzip engine loader (copied from legacy) |
| `tests/engine-{links,database,host}.test.ts` | Node tests (database tests run the same DuckDB Wasm via the node-blocking bundle) |
| `tests/engine_smoke.py` + `engine-smoke.{html,ts,worker.ts}` | Headless-Chromium smoke with measurements |

## Booting the worker (for the integrator)

`new Worker(new URL('./engine/engine.worker.ts', import.meta.url), { type: 'module' })`. The host
starts creating coordinator, renderer and database the moment the worker loads. Anything the UI
posts earlier is queued (bounded, 1024 per queue, oldest dropped): `attach`/`view`/… until the
renderer exists, UI frames until the coordinator exists, EXEC until the database exists. `boot`
opens the inference link and the dataset. After `open()` the host feeds `CONTEXT` (header
`context` = id) to the coordinator and posts `{type:'context'}` to the UI. Context ids start at 1
and increase per open; opens are serialized and only the newest is announced.

- UI frames go into the coordinator still encoded (`inputEncoded`).
- Database → renderer gets the Arrow object **first**, then the coordinator a `HEADER_ONLY` copy.
  A DRAWN emitted inside `renderer.handle(batch)` therefore reaches the coordinator before that
  batch's header copy. DONE goes to both. ERROR/STATUS/CONTEXT go to the coordinator.
- The coordinator is never re-entered: inputs produced while its outbox is being routed (a small
  query completes *inside* `database.handle(EXEC)`) are queued and fed next.
- `tick()` runs at `nextDeadline()`: one armed timer; deadlines < 1 ms away use a MessageChannel
  turn (setTimeout clamps nested timers to 4 ms).
- Inference: `remote` → WebSocket link (HELLO `{node:'coordinator', name, version}`); `webgpu` →
  `new Worker(…/inference-node/webllm.worker.ts)` as a port link with HELLO `{…, model}`. A closed
  link is **not** fed to the coordinator: the host posts STATUS (`inference`, `error`) to the UI and
  reconnects after 250 ms / 1 s / 4 s…; the new link's READY makes the coordinator retry.
- A node whose factory throws is reported as a STATUS frame (`coordinator|renderer|database`, `error`)
  posted straight to the UI.

## Database node behaviour

- **Placement:** DuckDB-Wasm 1.32.0 (DuckDB v1.4.3) blocking API in the engine worker. No DuckDB
  RPC worker. The blocking browser bundle is missing from the package `exports` map, so
  `vite.config.ts` aliases `duckdb-browser-blocking` to it (`src/engine/duckdb-blocking.d.ts`).
  Production: the plugin gzips both engines, `database.ts` fetches `<url>.gz` → Blob URL (Caddy
  serves it with `Content-Encoding: gzip`). Verified with `vite preview` + headless Chromium: the
  worker fetched `duckdb-eh-*.wasm.gz`, loaded Parquet and the UI showed the `vessels` context.
- **EXEC:** guard → `startPendingQuery(stream=true)` → polls (each ≤ `queryPollingInterval` 4 ms,
  in practice one DuckDB task) with a MessageChannel yield between polls → schema → one Arrow
  message per `fetchQueryResults` → BATCH. While streaming it yields after every 4 ms of work.
  Stamps: `EXEC_RECEIVED` (on RESULT_SCHEMA and ERROR, time of receipt), `DB_FIRST_BATCH` (first
  BATCH), `DB_DONE` (DONE). Every reply echoes the EXEC's epoch, request, revision and context.
  EXECs run one at a time, FIFO (≤ 16 queued; more → ERROR `queue_full`).
- **CANCEL:** request 0 cancels everything and raises the epoch (older-epoch EXECs are then
  dropped); request ≠ 0 cancels that request only, epoch unchanged. **A cancelled request emits
  nothing** (no DONE, no ERROR).
- **Dropped silently:** EXEC with a stale epoch or another context (protocol "frames for another
  context are dropped"); counted in `node.dropped`.
- **Errors** (`ERROR {code, message}`): `sql_rejected` (guard), `sql_error` (DuckDB parse/bind/
  runtime; the message has our wrapper stripped from `LINE 1:` echoes), `timeout`,
  `result_limit`, `queue_full`, and from the host `dataset` (open failed).
- **Limits:** 250,000 rows and 32 MiB of Arrow IPC per result (the prototype's values), 15 s from
  EXEC receipt, `memory_limit = 512MB`.
- **Arrow out:** RESULT_SCHEMA carries an `apache-arrow` `Schema`, BATCH a `RecordBatch` whose
  column buffers are views into DuckDB's message (tested). Copies left: DuckDB-Wasm copies each
  message out of Wasm memory (needed, the next fetch reuses that memory) and the SQL text is
  decoded from the payload. No per-row objects, no concatenation. Types are DuckDB's defaults:
  `TIMESTAMP` → `Timestamp<MICROSECOND>` (BigInt64 storage), `BIGINT`/`count(*)` → `Int64`,
  `VARCHAR` → `Utf8`. Batches are 2048 rows (DuckDB's vector size).
- **Datasets:** `vessels` is generated inside DuckDB (prototype generator) as `telemetry(ts
  TIMESTAMP, vessel VARCHAR, speed, wind, wave_height, water_temp, lat, lon DOUBLE)`, 1,209,600 rows.
  `vessels-small` is `public/data/telemetry.parquet` as is (`t DOUBLE` epoch ms, `vessel INTEGER`).
  Files and URLs: bytes → `registerFileBuffer('/upload/<table>.<fmt>')` → `CREATE TABLE <table> AS
  SELECT * FROM read_parquet|read_csv(auto_detect)` → file dropped. Parquet is detected by the
  `PAR1` magic, else CSV. Table name = file stem, lowercase `[a-z0-9_]`, `t_` prefix if it starts
  with a digit. **Each open replaces all previous tables.**
- **Context statistics:** one pass per table: `count(*)`, `min/max` for numeric (as DOUBLE) and
  temporal columns (as DuckDB text, e.g. `2026-09-01 00:00:00`, which is also DuckDB literal
  syntax), `approx_count_distinct` + `approx_top_k(col, 33)` for text. ≤ 32 entries means the exact
  value set (`distinct`, sorted `values`); otherwise `distinct` is the HLL estimate. Plus 3 sample
  rows (numbers as numbers, everything else as text).

### Safety: why the guard is a tokenizer plus a wrapper

DuckDB-Wasm's pending-query API **runs every statement of a script** and streams the last
(verified: `SELECT 1; DROP TABLE x` executed the DROP). The guard:

1. DuckDB's own tokenizer (`bindings.tokenize`, the parser's scanner: strings, quoted identifiers,
   dollar quotes and comments handled exactly like the parser) finds `;` tokens; anything but `;`
   after the first `;` → `sql_rejected`.
2. Execute `SELECT * FROM (<sql>\n)`. Only query shapes parse there (SELECT, WITH…SELECT, VALUES,
   FROM-first, PIVOT, DESCRIBE, SUMMARIZE, set operations); DDL, DML, SET, PRAGMA, ATTACH, COPY,
   transactions, `query('DROP …')` all fail at parse/bind. Order and LIMIT inside are preserved.

Boot lockdown (`lockDown`): `LOAD parquet` (fetched from extensions.duckdb.org), then
autoinstall/autoload off, `allowed_directories = ['/upload/']`, `enable_external_access = false`,
`lock_configuration = true`. After that SQL cannot read URLs or other files, load extensions or
change settings (tests cover each). Note: `enable_external_access` cannot be re-enabled at
runtime, which is why uploads go through `/upload/`.

Rejected alternative: `json_serialize_sql` (only SELECT serializes) needs the json extension and is
a separate query: 1.0–3.3 ms per call in Node vs tokenizer 23–75 µs (same Wasm, Node 23,
scratch measurement). Even `SELECT 1` costs ~0.6 ms per `runQuery` in DuckDB-Wasm.

## Measurements

Method: `python3 tests/engine_smoke.py` (headless Chromium 145.0.7632.0, Vite dev server,
cross-origin isolated, 5 µs timer resolution, DuckDB-Wasm eh bundle). Two runs on this host, which
was shared with four other agents, so absolute numbers are noisy; p95 especially. Times are
`performance.now()` inside the worker. "Cold" = first execution after load, "warm" = 20 repeats.

| Stage | Run 1 | Run 2 |
|---|---|---|
| Engine instantiate (fetch + compile, dev, uncompressed) | 1590 ms | 1857 ms |
| `LOAD parquet` (network, cold cache) | 521 ms | 657 ms |
| Boot total (incl. lockdown) | 2375 ms | 2848 ms |
| `vessels` generation (1,209,600 rows) | 1604 ms | 2085 ms |
| Context (columns + statistics + sample) | 306 ms | 348 ms |
| …of which the statistics query | 255 ms | 288 ms |
| Worker start → vessels ready | 4304 ms | 5303 ms |
| `vessels-small` Parquet (120,960 rows) load + context | — | 305 ms |
| Dropped CSV (5,000 rows) load + context | — | 187 ms |

Statistics query vs alternatives (Node, same Wasm, 1.2M rows): hand-written one-pass 174–235 ms,
exact `count(DISTINCT)`/`list(DISTINCT)` variant 182 ms on this table (but unbounded on
high-cardinality text), `SUMMARIZE` 1781 ms.

Hot path, per EXEC:

| Measurement | p50 | p95 | Notes |
|---|---|---|---|
| Guard (tokenize + scan), 151-char query | 30 µs | 60–65 µs | min 20 µs; n = 1000 |
| MessageChannel yield (worker) | 15 µs | 25–30 µs | n = 1000 |
| `SELECT 42`: EXEC → first batch | 0.70–0.76 ms | 0.98–1.06 ms | per-query floor of DuckDB-Wasm |
| `SELECT 42`: EXEC → DONE | 0.76–0.82 ms | 1.0–1.1 ms | |

60,480-row aggregate (`date_trunc('minute', ts), vessel, avg(speed) … WHERE ts < '2026-09-08'
GROUP BY ALL ORDER BY 1, 2`; 30 batches, 1.61 MB Arrow):

| | EXEC → schema | EXEC → first batch | EXEC → DONE | polls / yields |
|---|---|---|---|---|
| Cold, run 1 / run 2 | 203 / 295 ms | 209 / 301 ms | 238 / 340 ms | 8 / 14 |
| Warm p50, run 1 / run 2 | 98 / 110 ms | 99 / 110 ms | 111 / 134 ms | 7 / 9–10 |
| Warm p95, run 1 / run 2 | 132 / 230 ms | 132 / 231 ms | 150 / 241 ms | 8 / 12–15 |

The frame stamps (`EXEC_RECEIVED` → `DB_FIRST_BATCH` / `DB_DONE`) agree with the worker-side
timers to 0.01 ms. Schema → first batch is ~0.5 ms; all 30 batches take ~12 ms after the first.
**Execution dominates**: the aggregate must finish before its first row exists.

Streaming scan (`SELECT ts, speed … WHERE vessel = 'Aurora' AND ts < '2026-09-12'`, 158,400 rows,
465 batches): first batch p50 12.5–13.3 ms, DONE p50 88–119 ms.

**Yield policy** (same scan, 10 warm runs): time-sliced (4 ms) yields 19–24 times (≈ one per 20–24
batches); yielding after every batch yields 467 times. DONE p50 119 ms vs 128 ms in the same run —
within noise, and the arithmetic (465 × 15 µs ≈ 7 ms) says per-batch yielding costs ~5%. Kept
time-sliced.

**CANCEL latency**: a CANCEL posted while a query runs waits until the database loop yields. Measured
as lateness of the task that delivers it: 10.8–20.0 ms during execution of a self-join, 6.9–11.3 ms
while streaming; then 0.07–0.4 ms (one outlier 3.5 ms) until the query reports stopped. The wait is
DuckDB's task granularity: `queryPollingInterval` is 4 ms, but a poll returns only between tasks,
which took ~14 ms each for these queries (7 polls ≈ 100 ms aggregate). The whole EXEC handling
inside `handle()` (first `startPendingQuery`) took 14.5 ms p50 for the aggregate.

**First-batch size**: DuckDB has no Arrow batch-size setting (`arrow_output_batch_size` does not
exist in 1.4.3); batches are always the 2048-row vector. For aggregates the first batch cannot
come earlier than the aggregate's completion anyway; for scans the first 2048-row batch arrived in
~12 ms. Smaller first chunks would need SQL-level splitting (e.g. the prototype's first-bucket
query), not an engine setting.

**In-process link** (Node 23, `tests/engine-links.test.ts`): send → listener entry p50 0.20 µs / p99
~2 µs synchronous vs 0.6–0.7 µs / 3–6 µs via microtask. Microtask batching has better bulk
throughput (0.17 vs 0.33 µs/frame) but delays delivery until the producer's synchronous section
ends, i.e. a first batch would wait for the database loop to yield. Chose synchronous delivery
through one shared pump per pair.

**Cross-origin isolation**: Vite dev/preview and Caddy send `COOP: same-origin` and `COEP:
credentialless`. In the smoke both the page and the worker are `crossOriginIsolated`,
`SharedArrayBuffer` exists, timer resolution is 5 µs. With COEP credentialless, CORS HEAD
requests to Hugging Face (`mlc-chat-config.json`), raw.githubusercontent.com (WebLLM model libs)
and extensions.duckdb.org all returned 200. `require-corp` was not needed, so not tested.

## Decisions where the spec left room

- In-process links deliver synchronously (measured above); the host calls nodes directly, which
  is the in-process link without the object.
- One DuckDB connection for model SQL, one for loading; EXECs FIFO, not interleaved.
- Cancelled requests emit nothing.
- Each dataset open replaces every previous table.
- `vessels-small` stays the prototype Parquet file unchanged (different schema from `vessels`).
- Temporal min/max use DuckDB text, not ISO `…T…Z` as in the protocol's example.
- Parquet support depends on extensions.duckdb.org at boot; offline, `boot` reports `parquet:
  false` and CSV still works.

## Requested contract changes

1. `RendererNode` has no export method, yet `UiToEngine` has `export` and `EngineToUi` an `export`
   reply. Proposal: `export(slot: number, format: 'csv'): void` on `RendererNode`. The host already
   calls it if present.
2. Document in protocol-v1: a cancelled request produces no DONE/ERROR from the database.
3. Document the database ERROR codes above, and that DatasetContext temporal min/max are DuckDB
   text literals.
4. Note for render: time columns arrive as `Timestamp<MICROSECOND>` (BigInt64) and counts as `Int64`.

## Gaps and next steps

- Cancellation granularity is one DuckDB task (~10–20 ms here); finer needs DuckDB-side changes.
- Parquet extension is fetched from a third-party host at boot (~0.5–0.7 s cold, blocking the worker
  thread via sync XHR). Self-hosting the version-matched extension would remove that dependency.
- No concurrent/interleaved EXECs; a speculative long query delays a committed one unless the
  coordinator cancels it.
- Engine instantiate (~1.6–1.9 s) and vessels generation (~1.6–2.1 s) dominate cold start; a
  prebuilt DuckDB database file or Parquet for `vessels` would cut generation time (not measured).
- Smoke ran against the dev server; production was only checked for boot (gzip engine, Parquet,
  context reaching the UI), not timed.
