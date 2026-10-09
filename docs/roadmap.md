# Roadmap and optimization backlog

Status: proposed work. Nothing below is implemented or benchmarked yet.

## Build sequence

| Milestone | Deliverable | Exit criterion |
| --- | --- | --- |
| 0. Browser floor | Input, deterministic point source, prebuilt canvas, trace recorder | Reproducible input-to-draw distribution; physical timing method documented |
| 1. Correct protocol | Draft/commit/generation reducer, bounded queues, simulated adapters | Stale, duplicated, reordered, canceled, and truncated event tests pass |
| 2. Real data | DuckDB-Wasm and ClickHouse adapters with version probes | Compare first point and final result against reference queries; demonstrate actual early batches where plans permit |
| 3. Real inference | One remote adapter and one local WebGPU adapter; typed query intent | Semantic accuracy corpus passes the chosen threshold; cold/warm timings reported |
| 4. Prepared commit | Draft mirroring, one speculative candidate, valid promotion | Demonstrate a result staged before Enter; misses remain correct and do not starve |
| 5. Whole-path experiments | Typing replay and all four model/database placements | End-to-end distributions, hit rates, costs, and tail traces reproducible |
| 6. Deeper optimization | Winning codec, memory, transport, rendering, and scheduler changes | Each change improves its declared objective without breaking the correctness/resource gates |

Start milestone 0 without an LLM so inference variance cannot conceal browser mistakes. Keep it as a calibration fixture after real adapters arrive. The first prototype should support one narrow time-series query family end to end before expanding arbitrary SQL.

## Tricks worth testing early

| Idea | Intended saving | Tradeoff or condition |
| --- | --- | --- |
| Keep the real session open | DNS, TLS, authentication, connection setup after Enter | Idle resource use; reconnect after suspension |
| Prebuild chart and layout | Allocation, fonts, layout, shader/context setup | Initial page cost; viewport changes invalidate some work |
| Transmit latest draft snapshots | Prompt transport and context work | Remote drafts must be an explicit selected mode |
| Warm a stable prompt prefix | Repeated model prefill | Cache support, retention, token boundaries, and affinity matter |
| Compact typed query intent | Generated token count and SQL errors | Semantic catalog/compiler required; long tail needs fallback |
| Local vetted templates | Entire inference step for recognized requests | Must prove the grammar matches; never similarity-cache an answer |
| Start exact current-draft inference during pauses | Part of generation before Enter | Wasted work on continued edits; candidate must bind its revision |
| Predict one likely completion | Potentially whole query before Enter | Hit rate, correctness validation, and contention |
| Co-locate remote inference dispatch and DB | Avoid SQL returning through the browser | Data residency and deployment topology |
| Query progress and chart metadata separately | Keep slow annotations off the first-point path | Metadata must still establish correct point interpretation |
| Tiny first batch, larger continuation | Avoid throughput batch wait | More framing/encoding work; physical query must emit early |
| Draw a marker before a line | Make one point actually visible | Preserve consistent transforms when later points arrive |
| Known time domain and provisional y-domain | Avoid waiting for all data to autoscale | Axes may change; value quality remains explicit |
| Reuse arrays and decoder state | Allocation and garbage-collection pressure | Explicit ownership, bounds, and lifecycle discipline |
| Prioritize committed work at every queue | Tail latency during speculation | Requires engine support or admission reservations |

## Push further when the traces justify it

| Experiment | Why it could help | What can make it lose |
| --- | --- | --- |
| Forkable model KV state | Preserve shared prefill across predictions | Engine-specific APIs, memory pressure, eviction |
| Token-boundary incremental prefill | Consume typing time as context arrives | Retokenization, edits, chat delimiters, invalid suffix state |
| Pre-render hidden candidate buffer | Enter becomes binding plus buffer activation | GPU work and memory wasted; stale snapshot invalidation |
| Materialized time-series tiles and rollups | Avoid scanning raw history | Refresh lag, exact aggregate semantics, storage cost |
| Query an exact first bucket in parallel | Return a useful exact point before full range | Extra scans, snapshot mismatch, global/window dependencies |
| Cache a completed range and query the tail | Reuse unchanged historical work | Late updates and mutable data epochs |
| Viewport-aware buckets | Reduce query/transport/render volume | Must declare aggregation/resolution; extrema can disappear |
| Multiresolution overview then refinement | Early broad coverage | Count preview separately from requested exact resolution |
| Specialized first-point binary frame | Avoid large schema/decoder startup | Two formats and duplicate/replacement semantics |
| WebTransport independent result streams | Isolate blocked results from other traffic | Browser/server support, shared congestion, HTTP/2 fallback |
| Separate prewarmed control and bulk sockets | Keep large result queues away from control | Extra connections, no magic bypass of physical congestion |
| Transferable buffer pools | Avoid repeat allocation/copying across workers | Detachment and ownership complexity |
| Shared-memory ring | Reduce worker buffer handoff overhead | Isolation deployment, atomic coordination, wraparound bugs |
| Rust/Wasm parser or codec | Faster measured numeric/binary hotspot | Bindings, copies, compilation and memory growth |
| OffscreenCanvas | Escape main-thread contention | Worker scheduling and message overhead |
| WebGL/WebGPU geometry | Cheap large point-count continuation | Startup and contention with local inference |
| Desynchronized canvas hint | Reduce some presentation scheduling delay | Browser-dependent behavior and possible tearing |
| Delay bulk compression until after bootstrap | Ship first point without codec startup | More bytes; codec stream must support the chosen scheme |
| Warm TLS resumption on reconnect | Reduce setup after broken connection | Browser-controlled; no exactly-once guarantee from transport |
| Adaptive speculation using idle capacity | Spend resources when useful and available | Bad predictor creates load precisely when it hurts |

## Server-side experiments for the last stretch

An ordinary browser cannot expose every network or operating-system knob. A self-hosted coordinator or database adapter can still investigate them. These are optional deployment experiments, not requirements of the protocol.

- Reuse database sessions, prepared plans, encoder state, and memory pools.
- Benchmark proxy response buffering and compression with timestamps at each boundary.
- Compare server socket batching/flush policies, including `TCP_NODELAY` where meaningful and under actual control. Smaller writes can increase overhead.
- Investigate CPU affinity, NUMA placement, page faults, allocator behavior, and inference/DB queue policy after traces identify them.
- Test a separate pool for first-result work; avoid throughput batches that hold interactive queries behind large scans.
- Evaluate native protocol inside the backend when it reduces conversion or provides better cancellation. The browser-facing contract remains unchanged.
- Consider kernel-bypass or custom networking only after conventional network/queue costs dominate measured latency. It cannot remove browser scheduling, internet propagation, database dependencies, or display scanout.

## Tempting shortcuts to reject

- Announcing success on the first SQL token, timestamp, HTTP 200, or `requestAnimationFrame` callback.
- Showing any predicted answer as correct because it was available early.
- Assuming streaming transport makes an aggregate/sort execution incremental.
- Executing SQL prefixes before a complete allowed query is validated.
- Treating `SELECT`, a read-only transaction, or aborting a browser fetch as a complete isolation/cancellation policy.
- Claiming zero-copy across network, Arrow, worker, WASM, and GPU boundaries without measuring each handoff.
- Assuming a local model is fastest while excluding weight loading or its competition with rendering.
- Replacing the whole stack with a lower-level language before locating actual costs.

## Decisions still open

Choose the first dataset/query family, supported browser/device matrix, and acceptable preview/freshness semantics. Those choices determine whether immutable snapshots, exact tiles, or streaming raw scans are available.

Pick one hosted or self-hosted inference engine and one browser model only after measuring semantic accuracy on that family. Do not select a model purely by tokens per second. Similarly, select a chart backend on first-point and continuation measurements, not a large static-chart throughput demo.

The first deployment can be a local development setup with no hosting commitment. Define deployment, numeric SLOs, and operational costs from the baseline results. Preserve the broad placement-independent protocol while keeping the first runnable slice small.
