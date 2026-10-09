# Browser and transport design

Status: proposed; no performance measurements yet.
Primary sources checked: 2026-10-09. Implementation support must also be tested on the target browser builds.

The browser path should make Enter a small state transition over resources already prepared while typing.
Its output is the first correct, interpretable chart point for the committed request.
A timestamp alone is insufficient: the renderer also needs its value, series identity, units, scale, and validity.
Speculative pixels and corrected pixels have separate timing counters.

## Keep deployment separate from execution semantics

Define session, draft, commit, cancellation, result, and credit messages independently of their carrier.
A local adapter calls an in-process executor or worker; it does not serialize through loopback HTTP.
A remote adapter carries the same logical messages across a persistent browser connection.
Adapters declare cancellation, streaming, resumability, and isolation capabilities rather than pretending all backends behave alike.
An LLM worker, DuckDB worker, remote model server, and ClickHouse gateway can therefore occupy different combinations.

| Path | Initial proposal | Reason to investigate an alternative |
| --- | --- | --- |
| Browser to remote coordinator | Persistent binary WebSocket | Congested bulk results delay interactive traffic |
| Browser to capable remote coordinator | Optional WebTransport over HTTP/3 | Independent streams and expendable draft snapshots |
| Browser to embedded executor | Direct call or dedicated worker message | Main-thread work or large copying costs appear in traces |
| Restricted network fallback | Short uploads plus streaming fetch response | Persistent interactive transport is unavailable |

An ordinary browser page cannot speak arbitrary database TCP protocols.
A remote native-protocol database therefore needs a browser-compatible endpoint or gateway.
Direct Sockets exists for the separate Isolated Web App deployment model; it is not an ordinary website escape hatch. [Chrome Direct Sockets documentation](https://developer.chrome.com/docs/iwa/direct-sockets)

## Start with WebSocket, measure the upgrade

Use one already-open WebSocket for the initial implementation; set `binaryType = "arraybuffer"`.
Keep control messages short, result messages bounded, and bulk result production credit-limited.
The browser exposes queued outgoing application bytes through `bufferedAmount`, but this excludes OS/network buffering and does not acknowledge peer receipt.
The API provides no raw socket knobs or per-message delivery promise. [WHATWG WebSockets](https://websockets.spec.whatwg.org/)

Never feed an unbounded list of draft revisions into `send()`.
Keep one replaceable unsent snapshot and send the latest when the local queue allows it.
Once old bytes enter the connection, replacing a JavaScript queue cannot pull them back.
Application priorities must act before enqueueing; a priority field cannot overtake bytes already sent.
If large results measurably delay other results or control, test a separate prewarmed control connection.
That experiment pays extra connection and scheduling costs and still shares the physical network.

WebTransport provides ordered reliable byte streams and optional unreliable datagrams.
Its current specification also describes reliable-only HTTP/2 operation; API presence alone does not establish a QUIC path.
Detect available features, establish the actual session, and negotiate the usable capability subset.
Datagrams have a session-specific size bound; never assume an arbitrary prompt fits in one. [W3C WebTransport](https://www.w3.org/TR/webtransport/)

Proposed WebTransport mapping: one reliable control stream, one reliable stream per active result, optional datagrams for short replaceable drafts.
Avoid a stream per keystroke; an application revision is not a transport resource.
Separate streams should help isolate blocked result delivery on a QUIC path, but shared congestion and server queues remain.
Treat that latency improvement as a hypothesis, especially on clean low-latency links.
Maintain the WebSocket path until deployment and browser measurements justify the added server complexity.

Browser fetch request streaming exposes half-duplex semantics: the response is not processed before the request is fully sent.
Consequently one indefinitely open upload is unsuitable for receiving interactive preparation acknowledgments.
Use separate upload/download requests or a duplex transport; a completed small POST followed by a streaming response remains useful. [WHATWG Fetch](https://fetch.spec.whatwg.org/#dom-requestinit-duplex)

## Drafts can be expendable; commitment cannot

Every draft carries a session generation, monotonically increasing revision, context version, and complete prompt snapshot.
Discard older revisions; never apply a datagram as a text patch whose predecessor might be lost.
For prompts exceeding the datagram limit, use a reliable snapshot rather than inventing fragmentation and retransmission.
Text patches are an optional later optimization over an ordered reliable channel with base-revision checking.

On Enter, atomically capture the exact current input and allocate a unique request ID.
Send a reliable commit naming that revision and its exact content identity.
A commit may reference a previously acknowledged snapshot; otherwise include the complete final text.
Never assume that a typing update sent immediately before Enter has arrived.
The final keystroke and the Enter decision cannot be transmitted before they exist.
Pretransmission eliminates already-known work, not the causal need to communicate the commit.

The server atomically binds the request ID to one prompt/context identity and rejects conflicting reuse.
Retries of the identical request attach to its existing execution or return a known terminal state.
A lost acknowledgment must not silently execute a second expensive query.
Bound the deduplication retention period and surface expiry instead of promising permanent exactly-once execution.
All batches carry request identity and result generation; late cancelled batches cannot repaint a newer chart.

Pre-Enter transmission should be an explicit product mode because drafts leave the device before submission.
When disabled, keep prediction local and prewarm only prompt-independent resources.
Local mode must not route drafts through a remote observability service.
The event path must also handle IME composition, paste, undo, accessibility input, and mobile submission.
An Enter key used to confirm composition is not a query commit.

## Bound every queue

Prioritize commit/cancel/error handling, then the committed request's first valid point, then its continuation, then speculation.
Grant byte or batch credits between producer, transport, decoder, and renderer.
Reserve control capacity independently so a saturated data queue does not block cancellation.
An empty credit balance pauses production where supported; otherwise cancel or report an explicit resource limit.
Do not discard committed data to conceal a queue overflow.

Streams backpressure is useful only if the producer respects it.
Wrapping an ordinary WebSocket in a `WritableStream` does not create accurate transport write-completion or backpressure signals. [WHATWG Streams](https://streams.spec.whatwg.org/#example-ws-no-backpressure)

Limit bytes in flight, buffered decoded points, speculative tasks, and task age separately.
Measure queue age as well as queue size: one small message behind slow work can miss a frame.
Cancel obsolete generations promptly and ignore late completion even if physical cancellation is unavailable.
Coalesce paint requests while retaining the authoritative data necessary for later frames.
Progressive aggregation may replace many render points only when the representation and its accuracy are declared.

Flush the first useful record promptly; use larger batches after it to amortize overhead.
Do not await a throughput-oriented batch size or a compression window before delivering the first point.
Tune later batch size against queue age and remaining frame budget, with explicit bounds.
Test end-to-end arrival through the actual proxy and CDN configuration; server `write()` is not browser receipt.
Compression should be optional per payload class and benchmarked including encode/decode startup.

## Prepare the browser before commitment

Load the small input/render shell first; import optional analytics and heavy tooling outside the commit path.
Create the workers, decoder buffers, chart surface, and selected renderer while the application becomes ready.
On input focus, establish the real interactive session, authenticate, and check schema/context versions.
If local execution is selected, load the model and database independently, then prepare their executable state.
Track each readiness stage so a cache hit is not confused with a warm running engine.

Use `preconnect` for known HTTP origins when useful, but treat it as a hint: the browser can partially perform or skip the handshake.
It does not authenticate an application session or guarantee the desired live WebSocket. [HTML preconnect processing](https://html.spec.whatwg.org/multipage/links.html#link-type-preconnect)

Cache immutable code, model weights, and dataset files with content/version keys.
Keep result-cache keys sensitive to authorization, schema, parameters, and data freshness.
Store large local assets ahead of interaction; disk/cache retrieval and GPU upload belong in cold-start accounting.
Avoid speculative downloads competing with an already committed request.
Measure same-origin gateways versus direct browser endpoints rather than assuming fewer visible hosts means less latency.
Prevent token refresh, schema discovery, worker creation, font loading, and dynamic imports from surprising the Enter path.
Reconnect and revalidate after suspension; an old ready flag is not evidence of a live connection.

## Use workers where they remove contention

Start with TypeScript orchestration, binary decoding into typed arrays, and a small imperative rendering interface.
Keep per-point objects, string timestamps, repeated JSON parsing, and framework reconciliation out of the point loop.
Use a worker for CPU-heavy decoding or an embedded database so input remains responsive.
Co-locate compatible stages when that removes a worker hop without serializing expensive independent work.
Benchmark direct main-thread rendering against worker rendering; a message hop is not automatically a win.

An `ArrayBuffer` transfer moves ownership; the sender cannot continue using the transferred buffer.
Shared buffers use a different mechanism and require the relevant cross-origin isolated capability.
Neither mechanism promises that every browser, network, WASM, and GPU boundary is copy-free. [HTML structured data](https://html.spec.whatwg.org/multipage/structured-data.html)

The portable worker baseline is a small pool of transferable buffers with explicit ownership returned on reuse.
Batch control notifications, but deliver the first usable point without waiting for a large cross-thread batch.
Do not accidentally transfer a whole backing buffer still referenced by another active typed-array view.
Document ownership in the adapter contract and invalidate stale views after memory changes.

Evaluate a bounded `SharedArrayBuffer` ring only when transfer overhead is material.
The usual web deployment needs COOP `same-origin` plus a compatible COEP policy, appropriate resource headers, and `crossOriginIsolated` verification.
Cross-origin resources and popup integrations must be tested under those headers. [Chrome cross-origin isolation guide](https://web.dev/articles/cross-origin-isolation-guide)

Publish slots only after payload writes; use atomic indices, sequence checks, and a tested wraparound protocol.
Use worker notification rather than continuous spinning, and never block the main thread waiting for a slot.
When isolation is unavailable, use the transferable path with the same message semantics.
Shared memory removes particular copies; synchronization, ownership, and scheduling still cost time.

Rust/WASM is a candidate for measured codec, parser, aggregation, or geometry hotspots.
Keep contiguous numeric data in one memory domain across several operations to amortize crossings.
Include compilation, instantiation, copies, binding conversion, and memory growth in the comparison.
Do not rewrite orchestration in WASM merely to sound closer to the hardware.
Set allocation budgets and reuse buffers, while retaining bounds checks and explicit failure behavior.

## Reach the first correct pixel quickly

Preconstruct chart bounds, series styling, and any known time domain before results arrive.
On the first valid point, draw a visible marker; a single-vertex line may show nothing.
Use a declared provisional scale if the final value range is unknown and update axes consistently.
Never place a point using an invented final range or wait silently for all points just to autoscale.
Keep query errors, partial-result state, and units available without making their layout a first-point dependency.

Benchmark an already-created Canvas 2D context for the first marker and GPU geometry for dense continuation.
A tiny marker may not justify shader, pipeline, buffer, and submission setup.
Prewarm GPU resources when a GPU renderer is selected; select the crossover from measurements.
A Canvas overlay can serve the first point while the larger renderer catches up, but both must share the same transform and generation.

Canvas 2D's `desynchronized: true` is an optional latency hint, potentially trading ordinary presentation synchronization for tearing.
Inspect accepted context attributes and evaluate correctness and visual quality alongside latency.
Canvas can be GPU-backed; choosing 2D alone does not guarantee isolation from GPU work. [HTML canvas settings](https://html.spec.whatwg.org/multipage/canvas.html#concept-canvas-desynchronized)

OffscreenCanvas allows rendering in a worker after transferring canvas control.
Use it when main-thread contention outweighs worker coordination; prepare the transfer before interactive queries. [Chrome OffscreenCanvas guide](https://web.dev/articles/offscreen-canvas)

Request at most one pending animation frame for ordinary continuation.
Measure drawing the first marker immediately on receipt versus scheduling it into the next animation callback.
Do not add a timer, debounce, animation transition, or framework effect before that marker.
Avoid an always-running animation loop when no data changed.
Do not use synchronous layout reads to verify a canvas update.

WebGPU separates script-side operations from asynchronous device work; a returned API call is not completed rendering.
Avoid GPU readback and CPU/GPU synchronization in the display path. [WebGPU explainer](https://gpuweb.github.io/gpuweb/explainer/)
Collect expensive GPU diagnostics asynchronously and separately from benchmark samples used for latency claims.
Run local LLM decoding and chart rendering under contention tests: they may compete for the same GPU and memory bandwidth.
Pause obsolete model speculation at commit and use bounded inference submissions where the engine allows them.
Canvas 2D, a smaller model, or remote inference are experiments when local inference harms presentation latency.

## Measure presentation honestly

Instrument input-event handling, commit enqueue, server receipt, first complete record, decode completion, and draw submission separately.
Use monotonic local durations; do not subtract unrelated server and client clocks as if synchronized.
An animation-frame callback runs within rendering work, not as a guarantee that its pixels reached the display.
Browser rendering opportunities depend on visibility, performance, and hardware refresh constraints. [HTML rendering model](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering)

A nominal 60 Hz frame lasts about 16.67 ms; 120 Hz about 8.33 ms and 240 Hz about 4.17 ms.
These are arithmetic frame intervals, not promised minimum latency or measured Time Blast results.
A microsecond saved matters when it crosses a presentation deadline; averages can hide that effect.
Keep separate metrics for first draw submitted, first correct point presented by an instrumented proxy, and physical photons.
For literal Enter-to-photon measurement, use a shared hardware timebase for key actuation and a photodiode over the point's screen location.
Report display mode, refresh behavior, scan position, pixel response, and the input measurement origin.
A synthetic DOM event excludes the keyboard path; a screen recording does not directly measure light output.

## Experiments that decide the next layer of complexity

| Comparison | Required observation |
| --- | --- |
| Warm WebSocket vs HTTP/3 WebTransport | First-correct-point distribution under loss, congestion, and concurrent bulk traffic |
| Main-thread 2D vs OffscreenCanvas | Input delay, worker queue delay, and presentation proxy under CPU load |
| Transferable buffers vs shared ring | Crossing cost, allocation rate, tail latency, and fallback behavior |
| Typed-array JS vs WASM kernel | Whole-path latency including boundaries and cold initialization |
| Immediate first draw vs animation scheduling | Frame deadline misses and physical timing on fixed hardware |
| GPU chart with local LLM active vs paused | First-point latency and sustained chart responsiveness |
| Small first batch vs uniform batching | Time to first correct point, total completion, bandwidth, and CPU cost |

Record cold, warm, suspended/resumed, exact-speculation-hit, and speculation-miss cases independently.
Include slow devices, high-DPI displays, reduced battery modes, network loss, cancellation races, and tab visibility changes.
Promote an optimization only if its total measured effect improves the intended latency distribution and preserves result correctness.
