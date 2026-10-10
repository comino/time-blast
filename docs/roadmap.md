# Roadmap and optimization backlog

Status as of 2026-10-10: a deployed browser prototype and Rust inference service
exist. The public demo uses OpenRouter's Gemini 2.5 Flash Lite, browser-local
DuckDB-Wasm and Canvas2D. Local four-bit Qwen2.5-1.5B remains selectable. The
tables below separate implemented capabilities from remaining work; detailed
contracts are in [prototype.md](prototype.md), service operations in
[backend-prototype.md](backend-prototype.md), and dated evidence in
[verification.md](verification.md).

## Build sequence

| Milestone | Implemented | Remaining gate |
| --- | --- | --- |
| 0. Browser floor | Canvas, trace timings and deterministic template calibration; initial warm draw measurements | Reproducible end-to-end distributions and physical presentation measurement |
| 1. Correct protocol | Exact draft/commit identities, cancellation epochs, bounded queues, stale-result rejection and controlled adapter tests | Repeat the same gates against real remote database/scheduling services |
| 2. Embedded data prototype | DuckDB-Wasm worker, 1,209,600 synthetic readings, retained Arrow columns, first-complete-bucket execution and ten canvas views | Real datasets, broader query semantics, and measured memory/copy behavior across more devices |
| 3. Real inference | Local WebLLM and deployed Rust/OpenRouter inference; typed intent validation and one correction attempt | Hardware-WebGPU verification, independent held-out meaning evaluations and provider tail latency |
| 4. Prepared commit | Immediate draft transport, two-second idle execution, SQL/result promotion and bounded exact plan reuse | Typing replay, speculative hit rate, wasted work and contention measurements |
| 5. Usable service direction | Rust inference sessions, pooled provider HTTP/SSE, upstream cancellation and deployment tooling | Production access controls/quotas, a Rust ClickHouse bridge, and a separate scheduling service if needed |
| 6. Whole-path experiments | Public browser/real-provider smoke; seven-model comparison; adapter combinations under controlled doubles | Real remote database placements, sustained load and end-to-end p50/p95/p99 with costs and trace evidence |
| 7. Deeper optimization | Local exact first-bucket experiment, demand-loaded renderers and bounded drawing slices | Admit further codec/memory/transport/GPU changes only when their measured benefit passes correctness and resource gates |

Keep deterministic template mode as a calibration fixture; normal deployed and
WebGPU modes use models without silently falling back to templates. The first
slice supports four metrics, fixed aggregates/buckets, trailing windows and
vessel filtering/grouping. Arbitrary generated SQL remains outside the contract.

ClickHouse remains the intended deployment database. DuckDB supplies the
controlled embedded path; native DuckDB in a service is optional. The Rust
inference backend is implemented, but it is not a remote coordinator or database
relay. The browser still coordinates the deployed workflow.

## Next priorities

1. Measure real-user typing and independent unseen questions. Include false
   acceptance, valid-but-wrong plans, correction rates, cold/warm state and
   canceled/speculative cost. The [seven-model screening](experiments/hosted-models-2026-10-10.md)
   retains Gemini 2.5 Flash Lite for this configuration; it does not establish a
   general model ranking or future best default.
2. Build the Rust ClickHouse bridge against the existing Arrow contract. Verify
   snapshot/freshness semantics, ordered first useful output, explicit completion,
   cancellation and resource bounds before claiming placement equivalence.
3. Establish sustained-load latency distributions and service operating limits.
   Add authentication and durable/per-user budget policy before treating the
   public inference prototype as a production service.
4. Verify browser WebGPU on actual hardware and compare inference/rendering
   contention. Use whole-path measurements to decide whether GPU geometry,
   prefix reuse or memory handoff changes are worth their complexity.

## Early techniques: implementation and follow-up

The current implementation already keeps the inference socket open, mirrors
drafts, generates compact validated intent, prepares on a two-second pause,
promotes exact matches, draws the first marker and retains producer columns.
Templates are explicit options, and local grammar warmup precedes model readiness.
The table retains the rationale and tradeoffs; prefix warming at the provider,
completion prediction and remote database co-location remain proposals.

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

The exact-first-bucket idea has a measured local implementation: it executes the
first bucket and remainder **sequentially in one read-only DuckDB snapshot**,
rather than in parallel. See the [paired experiment](experiments/first-bucket-query-2026-10-09.md).
Parallel queries and a corresponding ClickHouse path still need separate testing.

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

The synthetic fleet and narrow query family are selected. Real datasets,
supported browser/device coverage, mutable-data freshness and acceptable
preview/refinement semantics remain open. Those choices determine whether exact
tiles, immutable snapshots or streaming raw scans are appropriate.

Current hosted and browser model defaults are explicit and replaceable. Broaden
semantic accuracy evaluation before changing them; model release date and
tokens/second alone are insufficient. Similarly, select another renderer using
first-point and continuation measurements, including contention with local
inference.

The HTTPS public demo is deployed. Numeric latency SLOs, durable operational
budgets and production capacity are not established. Preserve the placement
contracts while extending the measured runnable path; do not confuse client
adapters or deterministic service doubles with completed production integrations.
