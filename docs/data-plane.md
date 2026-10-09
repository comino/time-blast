# Data plane: make useful data available early

Status: design proposal; no adapters or performance results are implemented here.
Primary documentation checked on **2026-10-09**. Pin engine/client versions and probe
capabilities at startup; the links below describe current capabilities, not a guarantee
about every deployed engine or browser.

The database objective is the first **correct, drawable point for the committed
request**, followed by a useful overview and then complete coverage. Raw rows, exact
aggregated buckets, and provisional estimates need different query plans. A stream
of bytes cannot make a blocking query emit a result it has not computed.

## Adapter boundary

An adapter receives a validated query plan, bound parameters, snapshot policy,
viewport/resolution, deadline, resource budget, and cancellation token. It returns
schema, batches, coverage/finality information, progress, and one terminal outcome.
Keep this logical contract identical for an in-browser worker, local companion,
remote DuckDB service, and ClickHouse. In-process execution should bypass network
serialization while preserving the same identities and state transitions.

Advertise capabilities individually: `incremental_batches`,
`execution_time_streaming`, `ordered_output`, `cancel_query`, `prepared_plans`,
`snapshot_reuse`, `approximate_query`, and `typed_terminal_status`. A batch iterator
is evidence only for the first capability. Store the tested client/engine versions
and test-query results beside the capability record.

| Candidate | First implementation path | Critical qualification |
| --- | --- | --- |
| DuckDB-Wasm | Warm worker + persistent connection + Arrow batch reader | Explicitly request streaming and measure the selected physical plan |
| Remote DuckDB | Service adapter using an incremental engine API, then Time-Blast frames | Do not build an endpoint around full-result materialization |
| ClickHouse | Streaming HTTP response with `ArrowStream`; controlled adapter translates errors | Format, query execution, and HTTP flushing are separate layers |
| ClickHouse newer framing | Version-gated experiment with typed HTTP packets | Extra text/base64 framing has a cost; not a baseline requirement |

## DuckDB-Wasm: streaming must be explicit

`query()` materializes a whole result. `send()` exposes Arrow batches; the async
connection API documents `allowStreamResult = false` as its default. The candidate
path is therefore `await conn.send(validatedSql, true)` and incremental iteration,
with an integration check against the pinned package. The parameter permits
streaming where the engine supports it; it does not remove blocking operators.
[Query API](https://duckdb.org/docs/current/clients/wasm/query),
[async connection reference](https://shell.duckdb.org/docs/classes/index.AsyncDuckDBConnection.html#send).

Proposed worker flow, deliberately leaving validation and framing outside the sketch:

```ts
// Pseudocode: connection and schema context are already warm.
const reader = await conn.send(validatedSql, true);
for await (const batch of reader) {
  if (requestIsObsolete()) break; // Adapter must also cancel/drain the engine.
  emitBatchWithoutConvertingEveryRowToAnObject(batch);
}
// A successful reader end is necessary before reporting complete coverage.
```

Keep the worker, engine, connection, necessary extensions, and known schema warm.
Prepare recurring parameterized shapes when useful, but verify whether the chosen
prepared-statement execution API exposes the required streaming behavior. Parsing
and planning can be reused by DuckDB prepared statements; they do not eliminate
execution work. [DuckDB workload tuning](https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads#prepared-statements).

Give committed work priority over speculation. Multiple connections do not prove
independent worker execution or preemption. Benchmark scheduling and cancellation;
start with one speculative query at a time. A separate speculative worker may avoid
queue interference but duplicates runtime state and can contend for CPU and memory.

Current deployment documentation distinguishes `mvp`, `eh`, and threaded `coi`
bundles; `coi` requires cross-origin isolation. Probe the actual selected bundle
instead of assuming every browser runs a single thread or supports parallelism.
[DuckDB-Wasm deployment](https://duckdb.org/docs/current/clients/wasm/deploying_duckdb_wasm).

## ClickHouse: remove every buffering boundary

Start with a bounded query, reused HTTP connection, and a reader that consumes
`response.body` incrementally. Do not call `arrayBuffer()`, `text()`, or `json()` on
the entire response before decoding. Keep query authorization and cancellation in
the adapter; direct browser access is optional when the deployment permits it.

ClickHouse HTTP can buffer responses using `buffer_size` /
`http_response_buffer_size`; `wait_end_of_query=1` requests whole-response buffering.
For the latency experiment, disable whole-query waiting and explicitly test a small
or disabled response buffer. HTTP 200 alone is not success: execution errors can
arrive after response headers and corrupt an otherwise valid result stream.
The adapter must validate completion and recognize the pinned server's error
encoding before emitting a successful terminal event.
[ClickHouse HTTP buffering and errors](https://clickhouse.com/docs/concepts/features/interfaces/http#response-buffering).

Measure separately: engine block ready, format batch ready, server write, proxy
forward, browser chunk arrival, and decoder batch ready. Disable proxy/CDN response
buffering on this route and compare compression settings. These are deployment
requirements to verify with traces, not consequences of choosing HTTP streaming.
Compression can save transfer time while delaying a small first payload; compare
uncompressed first output with compressed bulk output where the transport permits.

ClickHouse processes blocks. `max_block_size` is a recommended loading size, not a
promise of one row per packet or a network flush control. Very small blocks add
processing overhead. Sweep block sizes rather than setting one row everywhere.
[ClickHouse block-size setting](https://clickhouse.com/docs/reference/settings/session-settings/max#max_block_size).

`ArrowStream` supports incremental record batches. Current documentation also lists
`output_format_arrow_record_batch_size` and
`output_format_arrow_record_batch_size_bytes`: positive accumulation targets can
delay the first batch; zero disables each target. Probe settings on the deployed
version. Compare uncompressed Arrow with its supported codecs using the actual JS
decoder; do not assume all codec combinations are available.
[ArrowStream format and settings](https://clickhouse.com/docs/reference/formats/Arrow/ArrowStream).

Experiment with a negotiated fixed-layout frame for one complete timestamp/value
tuple, then Arrow batches for bulk data. Reuse schema IDs and deduplicate by point
identity. This saves framing/decoding only after a real result exists; an adapter
cannot extract a row before its upstream engine/batch makes that row available.

An optional newer path uses ClickHouse HTTP framing, introduced in 26.8. Typed
packets separate data from exceptions and progress. The documented success
terminator is a final progress packet with final counters; an exception or truncated
stream is failure. `EventStream` base64-encodes data, and binary output requires a
byte-safe framing choice such as `JSONEachPacketBase64`. Benchmark its overhead
against raw Arrow plus an adapter. Do not require this feature on older servers.
[26.8 introduction](https://clickhouse.com/blog/clickhouse-streaming-http-api),
[framing contract](https://clickhouse.com/docs/concepts/features/interfaces/framing-formats).

## Produce the first exact point, not merely the first timestamp

DuckDB documents grouping, sorting, joins, and windowing among blocking operations.
Actual latency depends on the selected algorithms: a hash join may need its build
side first; a global sort may need all candidates. Inspect physical plans and first
batch timing for each supported query shape.
[Blocking operators](https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads#blocking-operators).

| Query shape | What can become drawable early? | Proposed optimization |
| --- | --- | --- |
| Filtered raw readings | A complete timestamp/value tuple, even with unordered coverage | Narrow time/series predicates and a suitable physical layout |
| Earliest readings | Earliest tuple only after the plan establishes ordering | Ordered read path plus limit; test that no global sort remains |
| Count/sum per time bucket | Exact bucket only when all contributing rows are accounted for | Query a small independent bucket first; then widen coverage |
| Global average, percentile, top-K | Early partial state is generally provisional | Precomputed compatible aggregate or explicitly approximate preview |
| Join + time aggregation | Depends on join inputs and aggregate completion | Prejoin stable dimensions or use an appropriate maintained result |

ClickHouse can read in sorting-key order when the `ORDER BY` prefix matches and
`optimize_read_in_order` applies; this can avoid reading everything for a small
`LIMIT`. The documented optimization does not apply with `GROUP BY`. Never infer
the optimization from SQL text alone: inspect the selected plan.
[Ordered reads](https://clickhouse.com/docs/reference/statements/select/order-by#optimization-of-data-reading).

For “hourly revenue over seven days,” a candidate is one exact first-hour query
followed by the remaining hours, all tied to an agreed snapshot. The first hour is
still an aggregate over all relevant rows in that hour. Empty early windows need
explicit empty coverage or an exact zero according to query semantics; a fabricated
zero is not a point. Keep this partitioning out of global-rank, cross-window, or
non-decomposable queries unless equivalence is proven. Extra queries can increase
total work and contention, so compare against a single preaggregated range query.

## Progressive fidelity and coverage are independent

Use separate fields for request binding (`speculative`/`committed`), value quality
(`provisional`/`exact`), resolution (`raw`/`bucketed`/`sampled`), and coverage
(`partial`/`complete`). An exact hourly bucket may belong to a partially covered
chart. A sampled overview does not become an exact full-data aggregate merely
because its scan ended. Show estimates as estimates; report their method and, when
valid, uncertainty. “Rows scanned / estimated total” is progress, not confidence.

Batches carry query identity, snapshot identity, series identity, timestamp unit,
timezone/bucket convention, resolution, and validity information. Upsert identity
is `(series_id, time, bucket_width, resolution, observation_id)` with monotonic point revision;
bucketed points omit the observation ID, while raw duplicates need this stable
disambiguator. Never append an updated
aggregate as a new observation. Null, zero, missing, and non-finite values differ.

Out-of-order exact points can render as points immediately. Draw line segments only
where ordering and coverage permit them; do not draw through unknown gaps. A
maximum observed timestamp is not a completeness watermark. An adapter may emit a
completed interval only after proving that no additional result for that interval
can arrive under the agreed snapshot. Every shard contributing to a bucket matters.

First-point optimization also needs a coordinate system. Precompute the committed
time domain from the request and use a known or explicitly provisional y-domain.
An exact point with provisional scaling can be displayed, then rescaled; waiting
for global min/max solely to create axes can erase the benefit of streaming.

## Pay before the request: layouts, aggregates, and tiles

Sort/partition storage around common series filters and time windows. DuckDB's
zonemaps benefit from ordered columns because irrelevant row groups can be skipped.
This is different from promising a general secondary index makes every time-range
query cheap. [DuckDB indexing](https://duckdb.org/docs/current/guides/performance/indexing).

ClickHouse projections can provide alternate ordering and precomputed aggregates.
Incremental materialized views shift compatible computation to insert time; their
source is the inserted block, and changes to a joined right-side table do not
automatically refresh previous results. Choose and validate the maintenance model
before treating a rollup as authoritative.
[Projections](https://clickhouse.com/docs/concepts/features/projections/projections),
[incremental materialized views](https://clickhouse.com/docs/concepts/features/materialized-views/incremental-materialized-view).

Proposed tile pyramid: retain time-aligned resolutions with count, sum, min/max,
and first/last timestamp-value pairs. Query enough samples to represent the visible
pixels, then refine zoomed areas. Preserve extrema so downsampling does not hide
spikes. Combine means using sum/count, not a mean of means; exact quantiles cannot
generally be reconstructed from per-tile quantiles. A sketch stays approximate.

Cache tiles, prepared shapes, schema, small dimension tables, decoded columns, and
render buffers separately. A useful result-cache key includes canonical plan and
parameters, principal/tenant and row policy version, schema version, source
snapshot/version, timezone and calendar rules, bucket alignment, resolution, and
algorithm version. SQL string equality alone is insufficient.

At COMMIT, freeze the interpretation of relative time and the snapshot policy.
A precomputed “last hour” anchored while typing differs from one anchored at commitment.
The protocol defaults to the coordinator's first acceptance time; an explicit
client-clock anchor is an optional policy when the window must end at Enter.
Promote speculative data to exact committed data only when the complete bindings
match. Otherwise retain a labelled preview or recompute. A TTL is a freshness
policy, not proof that underlying data is unchanged.

For local immutable files, use a versioned manifest/content identity. For a single
engine transaction, use the adapter's supported snapshot guarantee. For multiple
queries/shards, require an application-level immutable version or ingestion fence
whose semantics cover late arrivals, corrections, and dimension tables. Do not
invent a universal reusable ClickHouse/DuckDB snapshot token. Without a proved
shared snapshot, independently queried tiles remain separate views of source state.

## Local compute does not guarantee local data

DuckDB-Wasm can register already-fetched buffers or lazily read registered remote
HTTP files. An embedded engine scanning cold remote Parquet can still pay for
metadata and data requests. Warm relevant metadata and bounded ranges while typing,
using immutable object versions; measure transferred bytes and request count.
[DuckDB-Wasm file registration](https://duckdb.org/docs/current/clients/wasm/data_ingestion).

Compare three placements: warm browser data, browser engine with remote files, and
compute beside remote storage. Move predicates and aggregates to the placement
that avoids the most critical-path data movement. Budget local cache capacity and
eviction, and report cold download/compile separately from warm execution. Avoid
duplicating a large scan solely to claim a faster post-Enter number.

## Bounded speculation and failure handling

Only the adapter may execute validated, authorized read plans. A `SELECT` prefix
check is insufficient: table functions can access files/networks, extensions and
UDFs can do more, and views/macros can hide these operations. DuckDB documents file
access controls, external-access restrictions, extension controls, and configuration
locking. Apply an allowlist of relations/functions and restrict host capabilities;
parameter binding protects values, not model-generated query structure.
[DuckDB security model](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview).

Enforce server-side permissions plus per-query scan, memory, runtime, result-byte,
and concurrency limits. ClickHouse restrictions can overshoot between checks, and
`overflow_mode=break` may return partial results as though input ended. Use throwing
limits for the exact path and explicitly label any intentional partial path.
[ClickHouse query limits](https://clickhouse.com/docs/concepts/features/configuration/settings/query-complexity).

Cancellation must stop source work, not just discard browser output. Test abort
acknowledgement and lingering CPU/IO; reserve capacity for the committed request.
An error, timeout, cancelled query, truncated transport, or decoder failure must
never upgrade partial coverage to complete. Previously received values may remain
visible with the request failure/coverage state; an explicit invalidation must
remove any values whose correctness can no longer be supported.

First adapter experiments: compare materialized vs execution-streamed DuckDB; raw
scan vs aggregate/sort/join; ClickHouse flush and Arrow batch settings; one exact
bucket vs one range query; raw data vs rollups/tiles; local warm vs cold remote
Parquet; then cancellation under competing speculation. Record first exact point,
first overview, completion, correctness, CPU/bytes, and p95/p99—not just throughput.
