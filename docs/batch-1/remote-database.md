# Remote database (DuckDB or ClickHouse over tb1)

Status: implemented and tested (ClickHouse 2026-10-10, DuckDB 2026-10-17). The DuckDB backend is
deployed since 2026-10-17 (`nyc-taxi-big`, 120 M trips, behind `/api/database/`; deploy/README.md
"Remote database"); ClickHouse is not deployed.

The database node runs on a server and speaks `tb1` over WebSocket. The engine uses it through
the **same host routing** as in-browser DuckDB: it is just another `DatabaseNode`, backed by a
WebSocket `Link` instead of DuckDB-Wasm (`src/engine/remote-database.ts`, unchanged by the DuckDB
backend). Coordinator, renderer and UI are unchanged.

**DuckDB is the default backend.** A server-side DuckDB v1.4.3 (the browser's DuckDB-Wasm
version) serves one read-only database file, so model SQL has one dialect everywhere: the prompt
and the evals apply unchanged (`dialect: "duckdb"`). ClickHouse stays available by config.

| File | Role |
|---|---|
| `crates/database-server/` | Standalone Rust crate (own lockfile). Feature `duckdb` (default) links the official prebuilt `libduckdb.so` v1.4.3 via `libduckdb-sys` (C API only, no bundled C++ build) |
| `…/fetch-libduckdb.sh` | Downloads the release zip into `.cache/libduckdb-v1.4.3/`, SHA-256 pinned (arm64 + amd64) |
| `…/src/duck/mod.rs` | Open read-only + locked config, connection pool, guard (`Statement::prepare`), streaming, interrupt (`Control`) |
| `…/src/duck/exec.rs` | One EXEC: blocking worker → Arrow IPC → RESULT_SCHEMA / BATCH / DONE, limits, cancel |
| `…/src/duck/context.rs` | DatasetContext: prebuilt `__tb_rollup.__tb_meta`, else computed (port of `src/engine/dataset.ts`) |
| `…/src/{ipc,guard,clickhouse,exec}.rs` | ClickHouse backend (below) |
| `…/src/session.rs`, `service.rs` | Per-socket state, epochs, fencing; HTTP/WS surface (shared by both backends) |
| `…/tests/duckdb.rs` | Guard, lockdown, limits, timeout/CANCEL/close → interrupt, fencing, framing, equality, contexts, `latency` (ignored) |
| `tests/remote_duckdb.py` | Real app (production build, `vite preview`, headless Chromium) on the remote DuckDB, scripted inference |

```sh
crates/database-server/fetch-libduckdb.sh            # once
export DUCKDB_LIB_DIR=$PWD/.cache/libduckdb-v1.4.3 DUCKDB_INCLUDE_DIR=$PWD/.cache/libduckdb-v1.4.3
cargo test --locked -j 2 --manifest-path crates/database-server/Cargo.toml   # DuckDB + ClickHouse (skips if unreachable)
cargo build --release --locked --manifest-path crates/database-server/Cargo.toml
TIME_BLAST_DUCKDB_PATH=../time-blast-data/nyc-taxi.duckdb TIME_BLAST_DUCKDB_THREADS=3 \
  TIME_BLAST_ALLOWED_ORIGINS=http://127.0.0.1:4173 <target>/release/time-blast-database   # ws://127.0.0.1:8788/session
```

Engine side: `__timeBlastUi.controller.setDataset({kind: 'remote', name, endpoint: 'ws://…/session'})`
(or a `remote` source in the canvas). The page's origin must be in `TIME_BLAST_ALLOWED_ORIGINS`.

## DuckDB backend

Configuration (env): `TIME_BLAST_DB_BACKEND=duckdb|clickhouse` (default: `duckdb` when
`TIME_BLAST_DUCKDB_PATH` is set), `TIME_BLAST_DUCKDB_PATH`, `…_THREADS` (default: cores),
`…_MEMORY_LIMIT` (1GB), `…_TEMP_DIR` (`$TMPDIR/time-blast-duckdb`), `…_MAX_TEMP_SIZE` (4GB),
`…_MAX_QUERIES` (4, process-wide), `…_BATCH_ROWS` (8192), `…_CONTEXT_TIMEOUT_MS` (120000);
`TIME_BLAST_DB_NAME` (default: file stem), `TIME_BLAST_DB_DESCRIPTION`, and the shared limits
(`TIME_BLAST_DB_MAX_ROWS` 250,000, `…_MAX_BYTES` 32 MiB, `…_TIMEOUT_MS` 15,000, `…_MAX_QUEUED`
16, `…_SESSION_CONCURRENCY` 2).

**Safety is the execution environment.** The file is opened with `access_mode=READ_ONLY`,
`enable_external_access=false`, extension autoload/autoinstall off, community and unsigned
extensions off, `lock_configuration=true`, and the configured `threads`, `memory_limit`,
`temp_directory`, `max_temp_directory_size`. Each EXEC goes through DuckDB's own parser
(`duckdb_extract_statements`): 0 statements or more than 1 → `sql_rejected`; the one statement is
prepared and must have statement type SELECT (SELECT, WITH, VALUES, FROM-first, DESCRIBE,
SUMMARIZE, PIVOT with `IN`, set operations; parameters are refused). No wrapper is needed, so error
positions are the model's own. Verified in `tests/duckdb.rs`: DROP/CREATE/INSERT, SET (also
`SET enable_external_access = true`), PRAGMA, ATTACH, COPY, INSTALL/LOAD, EXPLAIN, CALL,
transactions, CHECKPOINT, `$1` → `sql_rejected`; `read_csv('/etc/passwd')`, `read_text(…)` →
`sql_rejected` (Permission Error); `FROM '/etc/passwd'` → `sql_error` (replacement scans off);
`PIVOT … ON x` without `IN` → `sql_rejected` (DuckDB expands it into CREATE TYPE + SELECT). duckdb-rs
is not used: its `prepare` *executes* every statement of a script but the last.

**Streaming.** The query runs on a blocking worker that owns a pooled connection
(`duckdb_execute_prepared_streaming`, `duckdb_fetch_chunk`). DuckDB converts each chunk to the
Arrow C data interface (`duckdb_data_chunk_to_arrow`, the same converter DuckDB-Wasm uses, so
types match the browser: `TIMESTAMP` → `Timestamp<µs>`, `count(*)` → Int64); arrow-rs imports it
without copying and writes an Arrow IPC encapsulated message (metadata V5, 8-byte alignment) behind
the tb1 header reserved in the same buffer. The first non-empty chunk (≤ 2,048 rows) is sent
alone; later chunks are coalesced to ≤ 8,192 rows / 2 MiB per BATCH. DuckDB `ENUM` (Arrow
dictionary) is cast to Utf8, since BATCH frames carry record batches only. Frames pass through a
2-slot channel and the session's 8 MiB send window, so a slow browser stops DuckDB's fetch loop.
DONE carries `{rows, bytes}` (bytes = BATCH payloads); stamps as for ClickHouse.

**Cancel, timeout, link close.** Each job has a `Control`: CANCEL (targeted or full), the
15 s deadline and a closed link mark it cancelled and call `duckdb_interrupt` every 5 ms until the
worker returns (DuckDB clears the interrupt flag when a query starts, so a single interrupt could
be lost between prepare and execute). The connection pointer is only interrupted while the worker
has it attached, never once it is back in the pool. A cancelled request gets no frame; a timeout
gets `ERROR timeout`. Measured (debug build, fixture, Rust client): CANCEL → worker returned
1.5 ms, link close → 1.7 ms, 400 ms timeout → stopped at 403 ms. The worker holds the
process-wide query permit until DuckDB has actually stopped. Waiting EXECs of a session start in
arrival order (each queues for its permit only after the one before it got one; before 2026-10-17
spawned jobs raced, which reordered a waiting EXEC behind a later one).

**DatasetContext.** A file with `__tb_rollup.__tb_meta` (`PrebuiltMeta` format 1, as written by
`scripts/build-datasets.mjs` and `scripts/fetch-datasets.mjs nyc-taxi-server`) is used as is
(nyc-taxi: 22 ms); `TIME_BLAST_DB_NAME`/`…_DESCRIPTION` override the stored ones. Otherwise the
server computes it once at startup like the browser's `describe`: tables of schema `main`
(alphabetical), types from `duckdb_columns()`, the same statistics SQL (count, min/max, approx
distinct + `approx_top_k(…, 33)` → exact `values` when ≤ 32), 3 sample rows, numbers written as
JavaScript would. Each statement is bounded by `…_CONTEXT_TIMEOUT_MS`; a table whose statistics time
out keeps types and DuckDB's row count. The file is read-only, so the context is cached for the life
of the process.

Errors: `sql_rejected`, `sql_error` (DuckDB's message, e.g. `Binder Error: …`, as DuckDB-Wasm
prints it), `timeout`, `result_limit` (rows, Arrow bytes, a single batch over the 16 MiB frame, or
DuckDB out of memory), `queue_full`, `dataset`, `unavailable`. WARM EXECs are answered
`unsupported` by the browser adapter and never reach the server (no result cache here yet).

### Measurements (DuckDB)

Host: the shared ARM64 box (4 cores, ~7.7 GB), **load average 6–10 from other agents**. Release
build, `threads=3`, `memory_limit=2GB`. Data: `nyc-taxi.duckdb` (2.95 GB, `trips` 120,017,885 rows,
`zones` 265), built minutes before, so the OS page cache was partly warm: "cold" = first run of
the SQL after the server opened the file, not a cold disk. Server = `EXEC_RECEIVED → DB_FIRST_BATCH
/ DB_DONE` stamps, Rust tb1 client on loopback, warm n = 10.

| Query | Rows | Cold first / done | Warm first p50 / max | Warm done p50 | DuckDB CLI (same settings) |
|---|---|---|---|---|---|
| `count(*)` | 1 | 18.3 / 18.4 | 0.75 / 1.5 | 0.84 | — |
| trips per day (`date_trunc`, full scan) | 1,096 | 2,583 / 2,583 | 1,409 / 1,949 | 1,409 | 0.78–1.30 s |
| avg fare by borough (JOIN zones, full scan) | 8 | 4,655 / 4,655 | 3,108 / 3,559 | 3,108 | 2.02–2.13 s |
| hourly by taxi type, January 2024 | 1,488 | 200 / 200 | 183 / 251 | 183 | 0.10–0.17 s |
| one hour of trips, ordered (scan) | 4,881 | 7.2 / 8.2 | 7.8 / 9.2 | 8.4 | — |

The server adds nothing measurable over the CLI beyond load noise; full scans of 120 M rows are
DuckDB's own 1–3 s on 3 shared cores. Selective queries (zone-map pruning on the sorted
`pickup_time`) are 7–200 ms.

**In the browser** (`tests/remote_duckdb.py`; production build, `vite preview`, Chromium
145.0.7632.0 headless with SwiftShader, scripted inference answering immediately; ms;
key = the one input event that inserts the whole question; warm n = 5; same load):

| Query (nyc-taxi) | Rows | Key → first draw cold / warm p50 / max | EXEC sent → server first batch (warm p50) | Server first (warm p50) |
|---|---|---|---|---|
| `count(*)` | 1 | 440* / 12.6 / 17.4 | 4.5 | 3.6 |
| trips per day | 1,096 | 2,138 / 893 / 1,364 | 889 | 888 |
| avg fare by borough | 8 | 1,789 / 2,272 / 2,522 | 2,256 | 2,255 |
| hourly, January 2024 | 1,488 | 127 / 125 / 143 | 117 | 116 |
| one hour of trips | 4,881 | 16.1 / 17.8 / 123 | 7.6 | 7.0 |

\* first chart of the page (card and renderer set-up). Opening the remote dataset (setDataset →
CONTEXT) took 646 ms (flights: 860 ms, computed context). Server first batch → renderer received
it: 1.5–5 ms; renderer → draw submitted: 0.1–3.7 ms. Every result equals the same SQL in the
DuckDB CLI (row count + 50-row table preview, all 5 taxi and 5 flights queries); the Rust test
compares every cell of the decoded IPC stream with a direct DuckDB query. On the 611k-row flights
file the same path draws in 25–100 ms warm (p50).

## ClickHouse backend

### Protocol behaviour

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

### Safety

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

### Result types

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

### Zero copy and alignment

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

### Measurements

Host: the shared ARM64 box (4 cores, ~8 GB), **load average 30–35 during the runs** (several
agents building). ClickHouse 26.8.21.10 on the same host (HTTP, loopback). Chromium
145.0.7632.0 headless, cross-origin isolated. Server: release build. Times are ms from the host
routing EXEC (worker `performance.now()`) to the recording renderer receiving the first BATCH /
DONE; "server" = `EXEC_RECEIVED → DB_FIRST_BATCH / DB_DONE` stamps (server clock). Cold = first
run after open, warm = 20 repeats. Both placements ran in the same page minutes apart, so the
comparison is fair even though absolute numbers are noisy.

#### 60,480-row aggregate (same SQL text on both)

`SELECT date_trunc('minute', ts) AS t, vessel, avg(speed) AS speed FROM telemetry WHERE ts <
TIMESTAMP '2026-09-08' GROUP BY ALL ORDER BY 1, 2`

| Placement | Cold first / done | Warm first p50 / p95 | Warm done p50 / p95 | Server first / done (warm p50) |
|---|---|---|---|---|
| DuckDB-Wasm in worker, run 1 | 756 / 893 | 241 / 516 | 298 / 553 | — |
| DuckDB-Wasm in worker, run 2 | 906 / 1020 | 437 / 675 | 519 / 774 | — |
| ClickHouse remote, run 1 | 444 / 508 | 128 / 194 | 200 / 379 | 113 / 137 |
| ClickHouse remote, run 2 | 269 / 315 | 144 / 239 | 249 / 361 | 131 / 151 |
| DuckDB-Wasm in worker, run 3 | 750 / 958 | 339 / 846 | 406 / 923 | — |
| ClickHouse remote, run 3 (with send window) | 442 / 564 | 219 / 461 | 381 / 763 | 205 / 234 |

For reference, `docs/batch-1/engine.md` measured DuckDB-Wasm warm at 99–110 ms first batch on a
quieter host. On this host ClickHouse remote reaches the first batch ~1.5–3× sooner than
in-browser DuckDB (warm p50), because aggregation runs multi-threaded in ClickHouse while DuckDB-Wasm is one thread
sharing the worker. Transfer adds: uplink (EXEC send → `EXEC_RECEIVED`, cross-process clocks on
one host) p50 2.6 ms, downlink of the first 200 KB batch p50 10.6 ms.

#### Other queries (warm p50, run 2; run 1 in the same range)

| Query | Rows | DuckDB first / done | ClickHouse first / done | ClickHouse server first / done |
|---|---|---|---|---|
| hourly aggregate, 5 columns | 2,016 | 468 / 468 | 192 / 200 | 190 / 190 |
| scan `ts, speed, lat, lon` of one vessel, ordered | 158,400 | 207 / 364 | 26 / 429 | 10 / 38 |
| per-vessel aggregate | 6 | 220 / 220 | 49 / 49 | 41 / 45 |
| `toStartOfInterval` / `time_bucket` 6 h | 336 | 401 / 401 | 153 / 155 | 152 / 152 |
| `SELECT 42` | 1 | 6.8 / 6.9 | 6.8 / 6.8 | 4.1 / 4.1 |

#### Where remote time goes

- **Chromium's WebSocket receive is the bottleneck for large results.** The 158,400-row scan is
  5.1 MB in 20 BATCH messages: the server finishes in 38 ms (a Rust tb1 client on loopback
  receives everything in 31 ms), but the browser needs 265–740 ms, ~10 ms per 250 KB message.
  A bare `WebSocket` on the page's main thread (no engine, no decode) shows the same ~25 MB/s
  (scratch probe, this host). So for large results, bytes on the browser link decide; the first
  batch still arrives early (26 ms).
- Floor: `SELECT 42` costs ~2–2.5 ms at a Rust client (two HTTP round trips on first sight of a
  statement: query + parallel DESCRIBE; one on repeats) and 6–7 ms in the browser (cross-process
  WebSocket hops on a loaded host). In-worker DuckDB's floor is 0.7–0.8 ms when the host is quiet.

#### `max_block_size` (Rust tb1 client on loopback, warm n = 20, p50 ms)

| `max_block_size` | aggregate60k batches / first / done | scan158k batches / first / done | `SELECT 42` |
|---|---|---|---|
| 2,048 | 30 / 143 / 189 | 20 / 20 / 31 | 2.1 |
| **8,192 (default)** | 8 / 119 / 138 | 20 / 15 / 31 | 2.5 |
| 65,409 (ClickHouse default) | 1 / 126 / 126 | 7 / 23 / 35 | 2.0 |

An aggregate's first block exists only when aggregation ends, so block size mostly sets message
size: 8,192 keeps the first message ~200 KB (≈ 10 ms in Chromium) instead of one 1.6 MB message
(≈ 65 ms), while costing nothing at the server. Scans read whole 8,192-row granules, so smaller
blocks do not make the first batch earlier.

#### First-byte settings (`scripts/clickhouse-first-byte.sh`, ClickHouse only, median of 9)

`wait_end_of_query=1` delays the scan's first byte 14 → 58 ms (it buffers the whole result);
the default 0 is what the server uses. `max_threads=1`, `output_format_arrow_record_batch_size`
and `max_block_size` changes moved first byte within noise (±5–40 ms at load 30).
`send_progress_in_http_headers=1` makes curl's "first byte" earlier only because headers leave
before data; it does not make data earlier, and the server keeps it off.

#### Compression (`scripts/clickhouse-compression.sh`, 60k aggregate, median of 9)

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

#### Cancellation

CANCEL → the ClickHouse query gone from `system.processes`: 20 ms, measured by polling
`system.processes` every 10 ms from the test (the poll itself is included). Closing the link stops
running queries the same way.

### Fixture equality

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

DuckDB backend:

- **Full scans are DuckDB's 1–3 s** on 3 shared cores for 120 M rows. Next: pre-aggregated
  rollups in the server file (the browser's `__tb_rollup` rewrite, run server-side), or a result
  cache + WARM support, which turns anticipation into instant answers.
- Each BATCH costs two copies after DuckDB's own Arrow conversion (arrow-rs IPC body, then the
  frame buffer). A direct IPC writer into the frame buffer would remove one; not measured yet.
- `TIME_BLAST_DUCKDB_BATCH_ROWS` (8,192) is set by analogy with ClickHouse's measured block size,
  not swept on DuckDB.

ClickHouse backend:

- **Isolation:** needs a dedicated ClickHouse user per deployment (see Safety).
- **Browser link throughput:** ~25 MB/s into Chromium on this host; try permessage-deflate or
  WebTransport, and smaller result types (Float32 positions) where the renderer allows.
- The full app with a fake inference node was not run; the browser check drives the real
  `EngineHost` and database factory with a scripted coordinator and a recording renderer.
- The UI has no control to pick `{kind: 'remote'}` yet (UI owner; needs contract change 1).
- No remote coordinator yet, so EXEC still travels browser → server; with a remote coordinator
  and remote inference, SQL would go server → server directly.
- Measured only on a loaded shared host; rerun on a quiet one for absolute numbers.
