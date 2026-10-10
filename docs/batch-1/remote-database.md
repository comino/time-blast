# Batch 1: remote database (ClickHouse over tb1)

Status: implemented and tested (2026-10-10). Owner: remote-database agent. Not deployed.

The database node runs on a server in front of ClickHouse and speaks `tb1` over WebSocket. The
engine uses it through the **same host routing** as in-browser DuckDB: it is just another
`DatabaseNode`, backed by a WebSocket `Link` instead of DuckDB-Wasm. Coordinator, renderer, UI
and `src/engine/host.ts` are unchanged. The browser check runs identical queries through both
placements in one engine worker and gets **identical results, cell for cell**.

## What exists

| File | Role |
|---|---|
| `crates/database-server/` | Standalone Rust crate (own lockfile; axum + fastwebsockets + reqwest, no Arrow library) |
| `…/src/ipc.rs` | Arrow IPC stream → encapsulated messages, parsing only the flatbuffer fields it needs |
| `…/src/guard.rs` | Single-statement guard + `SELECT * FROM (<sql>\n)` wrapper (ClickHouse lexer) |
| `…/src/clickhouse.rs` | HTTP client, query settings, error mapping, DatasetContext, DESCRIBE, KILL |
| `…/src/exec.rs` | One EXEC: stream, split, frame, limits, type casts, send window |
| `…/src/session.rs` | Per-socket state: HELLO/READY/CONTEXT, EXEC/CANCEL, epochs, fencing |
| `src/engine/remote-database.ts` | `RemoteDatabaseNode` (link adapter, Arrow decode) and `createPlacedDatabase` |
| `src/engine/engine.worker.ts` | One line: `createDatabase: createPlacedDatabase(createDatabase)` |
| `scripts/clickhouse-vessels.{sh,sql}` | Loads the vessels fixture into ClickHouse |
| `scripts/clickhouse-{first-byte,compression}.sh` | ClickHouse-side measurements |
| `deploy/time-blast-database.service` | systemd draft (not deployed) |
| `tests/remote-database.test.ts` | vitest: adapter, zero copy, fencing, reconnect, placement |
| `tests/remote_database.py` + `remote-database.{html,worker.ts}`, `remote-database-page.ts` | Browser equivalence + latency |

```sh
scripts/clickhouse-vessels.sh                        # once; CLICKHOUSE_URL, CLICKHOUSE_DATABASE
cargo test --locked -j 2 --manifest-path crates/database-server/Cargo.toml   # unit + live ClickHouse (skips if unreachable)
python3 tests/remote_database.py [--warm 20]         # builds release, starts server + Vite, headless Chromium
TIME_BLAST_CLICKHOUSE_URL=http://127.0.0.1:18123 TIME_BLAST_CLICKHOUSE_DATABASE=time_blast_dev \
  crates/database-server/target/release/time-blast-database   # ws://127.0.0.1:8788/session
```

Engine side: open a dataset with `{kind: 'remote', name, endpoint: 'ws://…/session'}` (boot or
`dataset` message). Any other source opens DuckDB-Wasm, which now boots on the first local open.

## Protocol behaviour

- **HELLO → READY, then CONTEXT.** HELLO may carry `"context": <id>`; the server answers CONTEXT
  with that id (default 1). The engine passes the host's context id, so ids never collide with
  DuckDB contexts and no frame is rewritten. A reconnect sends the same HELLO, then
  `CANCEL(request 0, last epoch)` to restore the epoch fence.
- **CONTEXT** = protocol-v1 `DatasetContext`, `dialect: "clickhouse"`, every table of the
  configured database: columns from `system.columns`, one statistics query per table (`count()`,
  Float64 min/max, temporal min/max as ClickHouse text, `uniq` + `groupUniqArray(33)` for text:
  ≤ 32 → exact sorted `values`), 3 sample rows. Types are ClickHouse names
  (`DateTime64(6, 'UTC')`, `LowCardinality(String)`), which the prompt shows the model. Cached
  5 min. Measured: browser open → CONTEXT 160–220 ms (1.2 M rows; DuckDB-Wasm load + context:
  17–23 s on the same loaded host).
- **EXEC** → guard → ClickHouse HTTP `FORMAT ArrowStream` → each encapsulated IPC message is one
  RESULT_SCHEMA or BATCH payload → DONE `{rows, bytes}` (bytes = sum of BATCH payloads, as the
  browser node). Stamps: `EXEC_RECEIVED` (RESULT_SCHEMA, ERROR), `DB_FIRST_BATCH`, `DB_DONE`.
  Every reply echoes epoch, request, revision and context. Zero-row batches are skipped.
- **Dropped silently:** EXEC with an epoch below the session's or another context.
- **CANCEL:** request 0 adopts the new epoch and aborts everything; request ≠ 0 aborts that one.
  Abort = drop the job (its HTTP response closes, `cancel_http_readonly_queries_on_client_close=1`)
  **and** `KILL QUERY WHERE query_id = … ASYNC` with the per-request id
  `tb-<pid>-<session>-<request>-<attempt>`. **A cancelled request gets no frame**: the session
  discards frames still queued, the adapter drops frames already on the wire. Closing the link
  cancels everything it started (tested: the ClickHouse query leaves `system.processes`).
- **Concurrency:** 2 EXECs run per session (FIFO beyond, ≤ 16 waiting, then `queue_full`). The
  browser node runs one at a time; ClickHouse can overlap a speculative and a committed query.
- **Errors:** `sql_rejected` (guard; ClickHouse READONLY/ACCESS_DENIED), `sql_error`, `timeout`
  (15 s from EXEC receipt, relay clock; ClickHouse `max_execution_time` as backstop),
  `result_limit` (250,000 rows / 32 MiB Arrow, counted by the relay; ClickHouse
  `max_result_rows/bytes` with `result_overflow_mode=throw` as backstop), `queue_full`,
  `dataset` (CONTEXT failed), and **`unavailable`** (ClickHouse unreachable; link down). Messages
  have the wrapper offsets removed (`position N`, `col N`) and the version suffix stripped.
  ClickHouse appends exceptions to a stream that already sent data (`__exception__` block, then
  closes the chunked body); the splitter detects the non-IPC bytes and maps that text.
- **Backpressure:** each session has an 8 MiB send window of queued frames; a job waits for
  credit, so a slow browser stops the ClickHouse read instead of buffering whole results.

## Safety

`guard.rs` mirrors the browser guard: a lexer that knows ClickHouse strings (`\` escapes, `''`),
quoted identifiers, heredocs and comments (`--`, `#!`, `# `, nested `/* */`) finds `;`; anything
after the first `;` → `sql_rejected`. The statement runs as `SELECT * FROM (<sql>\n)`, so DDL,
DML, `SYSTEM`, `KILL`, `SET`, and `FORMAT`/`INTO OUTFILE` clauses fail to parse. Every query
carries `readonly=1`. Checked against ClickHouse 26.8.21.10:

| Attempt | Result |
|---|---|
| `SELECT 1; DROP TABLE telemetry` | `sql_rejected` (guard); HTTP would refuse multi-statements anyway |
| `DROP TABLE telemetry`, `SELECT 1 FORMAT JSON` | `sql_error` (parse error inside the wrapper) |
| `url(…)`, `file(…)` table functions | `sql_rejected` (READONLY) |
| Top-level `SETTINGS max_result_rows = 0` | refused (READONLY) |
| `SETTINGS …` inside the wrapper (`… SETTINGS max_result_rows = 0, result_overflow_mode = 'break'`) | accepted but **not applied**: limits still throw `result_limit` |
| `SELECT … FROM system.tables` / other databases | **readable** with the dev `default` user |

The last row is the gap: database isolation needs a dedicated ClickHouse user (readonly profile,
`GRANT SELECT ON time_blast.*` only). The server takes `TIME_BLAST_CLICKHOUSE_USER/PASSWORD`; the
dev runs used the shared server's `default` user, so no user was created there.

## Result types

ClickHouse's Arrow output differs from DuckDB's, and the renderer must not assume either:

| SQL | DuckDB-Wasm | ClickHouse |
|---|---|---|
| `ts` column | `Timestamp<MICROSECOND>` | `Timestamp<MICROSECOND, UTC>` |
| `date_trunc('minute', ts)` | `Timestamp<MICROSECOND>` | `Timestamp<SECOND, UTC>` |
| `count(*)` | `Int64` | `Uint64` |
| `SELECT 42` | `Int32` | `Uint8` |
| `toStartOfInterval(ts, …)`, `toStartOfHour`, any `DateTime` | — | **UInt32** without help |
| `Enum8/16`, `UUID`, `IPv4/6`, `Int128` | — | Int8/16, FixedSizeBinary, UInt32 |

A `DateTime` as UInt32 would draw a time axis as numbers, and `toStartOfInterval` is the bucket
the prompt suggests for ClickHouse. ClickHouse has no Arrow setting for it. Fix, at zero cost for
the common case: a `DESCRIBE TABLE (<sql>)` runs **in parallel** with the query. If the result
schema has no UInt32 / Int8 / Int16 / FixedSizeBinary column it is forwarded at once and the
DESCRIBE is dropped. Otherwise the DESCRIBE decides; if a cast is needed the first query is
killed and the statement re-runs as `SELECT toDateTime64(t, 0[, tz]) AS t, … FROM (<sql>)`
(Enum/UUID/IP → `toString`, 128/256-bit → `toFloat64`). The decision is cached per SQL text, so a
repeat runs the cast query directly. Measured cold cost on `toStartOfInterval` (6 h buckets):
cold 227–242 ms vs warm 143–153 ms (includes the first-run analysis on ClickHouse, not only the
restart).

## Zero copy and alignment

- Server: one copy per byte, HTTP chunk → frame buffer. The tb1 header is written into space
  reserved in front of the message (`seal`), with exactly one allocation per frame. No Arrow
  decode, no re-encode. The splitter pads metadata to keep the body 8-aligned if a producer did
  not (ClickHouse does; tested both).
- Browser: the payload starts at 24 + 16·n in the WebSocket message's own ArrayBuffer, the body at
  +8 + metadata, Arrow buffers 8-aligned inside it; `IpcMessageDecoder` (unchanged) builds the
  `RecordBatch` with **every column buffer a view into that ArrayBuffer** (vitest asserts
  `values.buffer === message buffer`). Decode cost per message: p50 0.10–0.14 ms, p95 1.2–2.1 ms.
- Concatenating RESULT_SCHEMA + BATCH payloads + end marker reproduces ClickHouse's stream
  byte for byte (Rust test).

## Measurements

Host: the shared ARM64 box (4 cores, ~8 GB), **load average 30–35 during the runs** (several
agents building). ClickHouse 26.8.21.10 on the same host (HTTP, loopback). Chromium
145.0.7632.0 headless, cross-origin isolated. Server: release build. Times are ms from the host
routing EXEC (worker `performance.now()`) to the recording renderer receiving the first BATCH /
DONE; "server" = `EXEC_RECEIVED → DB_FIRST_BATCH / DB_DONE` stamps (server clock). Cold = first
run after open, warm = 20 repeats. Both placements ran in the same page minutes apart, so the
comparison is fair even though absolute numbers are noisy.

### 60,480-row aggregate (same SQL text on both)

`SELECT date_trunc('minute', ts) AS t, vessel, avg(speed) AS speed FROM telemetry WHERE ts <
TIMESTAMP '2026-09-08' GROUP BY ALL ORDER BY 1, 2`

| Placement | Cold first / done | Warm first p50 / p95 | Warm done p50 / p95 | Server first / done (warm p50) |
|---|---|---|---|---|
| DuckDB-Wasm in worker, run 1 | 756 / 893 | 241 / 516 | 298 / 553 | — |
| DuckDB-Wasm in worker, run 2 | 906 / 1020 | 437 / 675 | 519 / 774 | — |
| ClickHouse remote, run 1 | 444 / 508 | 128 / 194 | 200 / 379 | 113 / 137 |
| ClickHouse remote, run 2 | 269 / 315 | 144 / 239 | 249 / 361 | 131 / 151 |

For reference, `docs/batch-1/engine.md` measured DuckDB-Wasm warm at 99–110 ms first batch on a
quieter host. On this host ClickHouse remote is ~2–3× faster to the first batch than in-browser
DuckDB, because aggregation runs multi-threaded in ClickHouse while DuckDB-Wasm is one thread
sharing the worker. Transfer adds: uplink (EXEC send → `EXEC_RECEIVED`, cross-process clocks on
one host) p50 2.6 ms, downlink of the first 200 KB batch p50 10.6 ms.

### Other queries (warm p50, run 2; run 1 in the same range)

| Query | Rows | DuckDB first / done | ClickHouse first / done | ClickHouse server first / done |
|---|---|---|---|---|
| hourly aggregate, 5 columns | 2,016 | 468 / 468 | 192 / 200 | 190 / 190 |
| scan `ts, speed, lat, lon` of one vessel, ordered | 158,400 | 207 / 364 | 26 / 429 | 10 / 38 |
| per-vessel aggregate | 6 | 220 / 220 | 49 / 49 | 41 / 45 |
| `toStartOfInterval` / `time_bucket` 6 h | 336 | 401 / 401 | 153 / 155 | 152 / 152 |
| `SELECT 42` | 1 | 6.8 / 6.9 | 6.8 / 6.8 | 4.1 / 4.1 |

### Where remote time goes

- **Chromium's WebSocket receive is the bottleneck for large results.** The 158,400-row scan is
  5.1 MB in 20 BATCH messages: the server finishes in 38 ms (a Rust tb1 client on loopback
  receives everything in 31 ms), but the browser needs 265–740 ms, ~10 ms per 250 KB message.
  A bare `WebSocket` on the page's main thread (no engine, no decode) shows the same ~25 MB/s
  (scratch probe, this host). So for large results, bytes on the browser link decide; the first
  batch still arrives early (26 ms).
- Floor: `SELECT 42` costs ~2–2.5 ms at a Rust client (two HTTP round trips on first sight of a
  statement: query + parallel DESCRIBE; one on repeats) and 6–7 ms in the browser (cross-process
  WebSocket hops on a loaded host). In-worker DuckDB's floor is 0.7–0.8 ms when the host is quiet.

### `max_block_size` (Rust tb1 client on loopback, warm n = 20, p50 ms)

| `max_block_size` | aggregate60k batches / first / done | scan158k batches / first / done | `SELECT 42` |
|---|---|---|---|
| 2,048 | 30 / 143 / 189 | 20 / 20 / 31 | 2.1 |
| **8,192 (default)** | 8 / 119 / 138 | 20 / 15 / 31 | 2.5 |
| 65,409 (ClickHouse default) | 1 / 126 / 126 | 7 / 23 / 35 | 2.0 |

An aggregate's first block exists only when aggregation ends, so block size mostly sets message
size: 8,192 keeps the first message ~200 KB (≈ 10 ms in Chromium) instead of one 1.6 MB message
(≈ 65 ms), while costing nothing at the server. Scans read whole 8,192-row granules, so smaller
blocks do not make the first batch earlier.

### First-byte settings (`scripts/clickhouse-first-byte.sh`, ClickHouse only, median of 9)

`wait_end_of_query=1` delays the scan's first byte 14 → 58 ms (it buffers the whole result);
the default 0 is what the server uses. `max_threads=1`, `output_format_arrow_record_batch_size`
and `max_block_size` changes moved first byte within noise (±5–40 ms at load 30).
`send_progress_in_http_headers=1` makes curl's "first byte" earlier only because headers leave
before data; it does not make data earlier, and the server keeps it off.

### Compression (`scripts/clickhouse-compression.sh`, 60k aggregate, median of 9)

| Option | Bytes | Total |
|---|---|---|
| none | 1,605,064 | 148 ms |
| HTTP `lz4` | 481,210 | 133 ms |
| HTTP `zstd` | 178,163 | 169 ms |
| HTTP gzip level 1 | 321,397 | 180 ms |
| Arrow IPC body `lz4_frame` | 543,192 | 139 ms |
| Arrow IPC body `zstd` | 330,176 | 134 ms |

On loopback all within noise of each other; compression only pays across a real network. The
server keeps HTTP compression off and **must** keep Arrow body compression off
(`output_format_arrow_compression_method=none`; ClickHouse's default is `lz4_frame`), because a
compressed body cannot be viewed in place and apache-arrow 17 cannot decode it. The bytes that
matter are on the browser link (above); permessage-deflate is the candidate there (not supported
by fastwebsockets; not measured).

### Cancellation

CANCEL → the ClickHouse query gone from `system.processes`: 20 ms, measured by polling
`system.processes` every 10 ms from the test (the poll itself is included). Closing the link stops
running queries the same way.

## Fixture equality

`scripts/clickhouse-vessels.sql` reproduces `VESSELS_SQL` in ClickHouse. DuckDB evaluates
`12.8 + vessel * 0.7` in exact DECIMAL; the ClickHouse version writes those terms as
`(128 + 7 * v) / 10` so the correctly rounded quotient matches DuckDB's DECIMAL → DOUBLE. Result:
all 1,209,600 rows × 8 columns **bit-identical** (scratch comparison via DuckDB-Wasm in Node:
0 mismatches, max |Δ| 0). The browser check then finds 0 mismatching cells on all six queries
(one 6-hour-bucket average differs in the last bit, relative 1.8e-14, from summation order).

## Requested contract changes

1. `DatasetSource` gets `| { kind: 'remote'; name: string; endpoint: string }` (database placement
   by dataset source). Today `remote-database.ts` defines `RemoteDatasetSource` and callers cast.
2. protocol-v1 HELLO payload: optional `"context": <u32>`: the context id the database node must
   use for its CONTEXT and expect on EXEC. Without it the server uses 1.
3. protocol-v1 database ERROR codes: add `unavailable` (database or link unreachable; in-flight
   requests fail with it when a remote link drops).
4. protocol-v1: note that `DONE.bytes` counts BATCH payload bytes, and that ClickHouse contexts
   carry ClickHouse type names and text min/max like `2026-09-01 00:00:00.000000`.
5. Render/UI note (no contract change): time can arrive as `Timestamp<SECOND|MICROSECOND, UTC>`,
   counts as `Uint64`, small literals as `Uint8`.

## Gaps and next steps

- **Isolation:** needs a dedicated ClickHouse user per deployment (see Safety).
- **Browser link throughput:** ~25 MB/s into Chromium on this host; try permessage-deflate or
  WebTransport, and smaller result types (Float32 positions) where the renderer allows.
- The full app with a fake inference node was not run; the browser check drives the real
  `EngineHost` and database factory with a scripted coordinator and a recording renderer.
- The UI has no control to pick `{kind: 'remote'}` yet (UI owner; needs contract change 1).
- No remote coordinator yet, so EXEC still travels browser → server; with a remote coordinator
  and remote inference, SQL would go server → server directly.
- Measured only on a loaded shared host; rerun on a quiet one for absolute numbers. Not deployed.
