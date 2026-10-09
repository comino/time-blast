# Rust service and browser channels

Status: approach collection, not an implementation decision or benchmark result.
Primary documentation checked on 2026-10-09; pin crate versions, features, OS, and browser builds before testing.

A native Rust service acting as a bounded streaming relay for ClickHouse is the primary service candidate.
The intended path is ClickHouse → Rust relay → browser columnar decoder → chart, beginning with the first complete drawable point.
Browser DuckDB-Wasm is the initial prototype backend; native DuckDB embedded in Rust is an optional comparison, not the production destination.
The relay should preserve usable upstream column buffers and bytes instead of rematerializing results into rows and encoding them again.
The useful question is which complete path gets a correct point onto the screen earliest under load.
There is currently no Time Blast evidence naming a fastest language, socket library, or channel.

## Production path and prototype placements

| Placement | Execution path | Work removed or introduced |
| --- | --- | --- |
| Primary: ClickHouse and Rust | ClickHouse → bounded Rust relay → browser → chart | Preserves streaming while coordinating requests, identity, and cancellation |
| DuckDB embedded in Rust | Browser → persistent connection → Rust → in-process DuckDB | Removes a separate DB network hop; retains browser/service transport |
| DuckDB-Wasm in browser | Input → worker → embedded DuckDB → renderer | Removes result networking; adds browser startup, memory, and worker constraints |

For the native prototype, embedding removes the need for a TCP connection between Rust and DuckDB.
For production, compare direct browser-to-ClickHouse response streaming with the Rust relay to quantify the relay's actual cost.
Use identical data, query semantics, warmup accounting, and chart behavior to compare the placements.
Rust is the proposed service language, not a requirement that every browser component become WASM.

## Pure TCP has a specific boundary

An ordinary browser page cannot open arbitrary TCP or UDP sockets.
Compiling Rust to browser WASM does not change this: WASM obtains environmental capabilities from its host.
The browser host still exposes browser networking APIs. [WebAssembly introduction](https://webassembly.github.io/spec/core/intro/introduction.html)

Chrome's Direct Sockets provides TCP/UDP for the distinct Isolated Web App model, with its deployment and permission requirements.
It is an optional product-distribution experiment, not an API available to this ordinary website. [Chrome Direct Sockets](https://developer.chrome.com/docs/iwa/direct-sockets)

Native Rust can use TCP internally, and a native benchmark client can establish a useful diagnostic comparison.
That comparison does not turn the browser into a TCP client or measure the browser's input-to-chart path.
With the DuckDB prototype there is no DB socket to optimize away; with ClickHouse, native TCP is a server-side adapter option.

## Choose layers independently

| Layer | Responsibility | Candidate starting point |
| --- | --- | --- |
| HTTP/session entry | Serve UI, authenticate, negotiate, upgrade | axum |
| Async runtime | Socket readiness, task scheduling, timers | Tokio |
| WebSocket implementation | Frames, masking, message assembly, close/ping behavior | tungstenite through tokio-tungstenite; fastwebsockets alternative |
| QUIC transport | Encrypted connections, streams, flow/congestion control | Quinn |
| Browser WebTransport endpoint | HTTP/3/WebTransport session semantics above QUIC | wtransport |
| Upstream database | Query dispatch, cancellation, incremental payload/status | ClickHouse streaming HTTP or a measured native adapter |
| Prototype database | In-process execution and result extraction | duckdb-rs/native DuckDB |
| Application scheduler | Draft replacement, commit priority, candidate/result credits | Time Blast state machine |

These names are not interchangeable socket libraries.
For example, axum's current WebSocket module uses tokio-tungstenite internally. [axum WebSocket source](https://docs.rs/axum/latest/src/axum/extract/ws.rs.html)
The tokio-tungstenite crate adapts tungstenite to Tokio's asynchronous streams. [tokio-tungstenite upstream](https://github.com/snapview/tokio-tungstenite)
Compare one layer at a time while preserving the surrounding connection and scheduling architecture.

## Channel shortlist

| Channel | Proposed role | Main question for the latency rig |
| --- | --- | --- |
| Persistent binary WebSocket | Initial remote control/results channel | Can bounded messages and explicit flushing meet the tail target? |
| WebTransport over HTTP/3 | Parallel result streams and replaceable drafts | Does independent stream delivery improve latency under loss or competing data? |
| Streaming fetch plus separate control uploads | Restricted-network fallback and baseline | How much request/proxy overhead remains after prewarming? |
| WebRTC data channels | Optional peer-oriented experiment | Does its connectivity model solve a deployment need worth the extra session machinery? |
| Direct TCP | Native-to-native diagnostic or internal adapter | How much of the measured path is actually browser channel overhead? |

WebSocket gives the application a persistent bidirectional message channel, not raw socket access.
Its browser API exposes `bufferedAmount`, but no `TCP_NODELAY`, socket descriptor, or general receive-side pause primitive. [WHATWG WebSockets](https://websockets.spec.whatwg.org/)
Use compact control messages and small initial result messages on the warm connection.
Maintain independent application queues before the writer so stale drafts and bulk data do not bury a commit.
Already-enqueued bytes cannot be reprioritized by adding a priority field afterward.

WebTransport offers reliable ordered streams and optional datagrams.
The current specification also includes reliable-only HTTP/2 operation; do not equate the API name with a working QUIC/datagram path.
Detect and negotiate the capabilities actually implemented by the browser and server. [W3C WebTransport](https://www.w3.org/TR/webtransport/)
Our proposed HTTP/3 mapping is one reliable control stream and one reliable stream per live result.
Short, self-contained draft snapshots can use datagrams; commit, schema, exact data, and terminal status stay reliable.

Treat WebTransport deployment as an experiment that includes UDP reachability, certificates, session establishment, and proxy/load-balancer support.
Test the real route and record whether the session uses the intended transport; retain a functioning fallback.
Independent QUIC streams still share congestion and server resources, so a stream is not a dedicated latency lane.

Browser fetch request streaming remains half-duplex for response processing.
An open upload cannot be the only channel when the client must receive preparation acknowledgments while continuing to type. [WHATWG Fetch](https://fetch.spec.whatwg.org/#dom-requestinit-duplex)

WebRTC data channels provide ordered/unordered and reliable/partially reliable delivery using SCTP over DTLS and ICE. [RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html)
Its connection machinery can use STUN and TURN servers. [W3C WebRTC configuration](https://www.w3.org/TR/webrtc/#rtciceserver-dictionary)
For one browser talking to one known Rust service, our initial hypothesis favors fewer session-management components.
Keep WebRTC on the list if peer connectivity, an existing media session, or a measured network advantage changes that tradeoff.
Record direct versus relayed paths separately; a TURN relay is a different topology, not free UDP.

## Rust candidates worth comparing

| Candidate | Verified API/role | What Time Blast must evaluate |
| --- | --- | --- |
| axum WebSocket | Upgrade API, concurrent read/write integration, buffer and message-size configuration | Route/session convenience versus a leaner handshake path |
| tokio-tungstenite | Async adapter around tungstenite; TLS features are opt-in | Message assembly, flushing, allocations, and loaded tails |
| fastwebsockets | Frame-oriented API, message collector, Hyper upgrade and axum integration | Equivalent compliance and buffering settings, with less or different copying |
| wtransport | Async browser WebTransport endpoint | Browser interoperability, sessions, streams, datagrams, and operational complexity |
| Quinn | Native QUIC library beneath a WebTransport implementation | Transport tuning only where the higher layer permits it |

axum exposes write-buffer targets, maximum sizes, and explicit flush behavior; inspect actual settings rather than assuming defaults fit tiny responses. [axum upgrade configuration](https://docs.rs/axum/latest/axum/extract/ws/struct.WebSocketUpgrade.html)
fastwebsockets provides `FragmentCollector` when an application needs complete messages and reports Autobahn/fuzz testing upstream. [fastwebsockets upstream](https://github.com/denoland/fastwebsockets)
Its vectored-write option is a preference, not a guarantee that every write uses that path. [fastwebsockets WebSocket API](https://docs.rs/fastwebsockets/latest/fastwebsockets/struct.WebSocket.html)
Compare complete, bounded browser-message handling against complete handling; bypassing validation or fragmentation logic is not an equivalent implementation.

Quinn implements QUIC; it is not by itself the HTTP/3/WebTransport server that `new WebTransport(...)` expects. [Quinn upstream](https://github.com/quinn-rs/quinn)
wtransport supplies the browser-facing layer, but its maintainers explicitly describe production readiness and protocol evolution as remaining concerns. [wtransport upstream](https://github.com/BiagioFesta/wtransport)

Before committing to a dependency, record the exact release/tag, minimum Rust version, enabled features, supported transport version, and unresolved issues affecting our path.
Use crate releases, changelogs, and source history rather than treating GitHub stars or the word “fast” as maintenance evidence.
The shortlist remains provisional; neither upstream echo benchmarks nor README comparisons establish our winner.

## Proposed Rust execution path

```text
browser draft/commit
  → session reader and bounded coordinator
  → validated query + admission permit
  → ClickHouse execution → upstream ArrowStream bytes
  → bounded Rust relay → priority writer → warm browser channel
  → incremental columnar decoder → first valid timestamp + value → chart
```

ClickHouse's `ArrowStream` returns incremental record batches. [ClickHouse ArrowStream](https://clickhouse.com/docs/reference/formats/Arrow/ArrowStream)
The proposed relay forwards those bytes using shared ownership/slices where available; it parses only metadata needed for identity, framing, limits, and completion.
No `collect()` of the complete result, per-row Rust structs, JSON intermediate, or decode-and-reencode step belongs on this path by default.
The official Rust client documents row decoding over RowBinary; that is a different candidate from an opaque ArrowStream HTTP relay. [ClickHouse Rust client](https://clickhouse.com/docs/integrations/language-clients/rust/index)
HTTP chunks, WebSocket messages, and Arrow batches have different boundaries; preserve byte order and incrementally reconstruct the format.
Arrow's stream contains schema, dictionary dependencies where needed, and record batches; the decoder must satisfy those dependencies before drawing. [Arrow IPC format](https://arrow.apache.org/docs/format/Columnar.html#ipc-streaming-format)
A timestamp alone cannot produce a correct point, and a tiny downstream frame cannot obtain a record before ClickHouse emits the required batch data.

ClickHouse can report execution failures after HTTP 200 and after partial output. [ClickHouse HTTP caveats](https://clickhouse.com/docs/concepts/features/interfaces/http#http-response-codes-caveats)
Require a tested terminal-status/truncation strategy; do not infer success from an Arrow iterator ending or from the first bytes arriving.
Current HTTP framing formats offer terminal success/exception packets, but their binary-safe payload wrappers use base64. [ClickHouse framing formats](https://clickhouse.com/docs/concepts/features/interfaces/framing-formats)
Compare their explicit status handling against plain ArrowStream and native-protocol adapters, including conversion costs; do not assume framing is free.

Keep the session reader responsive while the database executes and while the writer is backpressured.
A single loop that awaits the full query before reading again will delay cancellation and newer commits.
Evaluate one connection-owning task with bounded work versus split read/write tasks under identical load.
Avoid a task and channel hop per row; pass owned column batches with explicit memory accounting.
Reserve foreground capacity before admitting speculation and cancel obsolete candidates promptly.

## Embedded DuckDB prototype worker

Tokio warns that blocking or long CPU work inside a future can stop other futures from progressing.
`spawn_blocking` runs such work on blocking threads, but requires explicit concurrency limits for CPU-heavy workloads.
A running blocking task is not stopped by aborting its join handle; persistent worker loops are better suited to dedicated threads. [Tokio blocking-work documentation](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html)

Proposed baseline: a bounded set of long-lived database workers, each owning its connection and prepared state.
Budget DuckDB's own parallelism together with worker count so each query does not independently consume the machine.
Preserve a control path capable of cancellation even when the data channel is full.

duckdb-rs exposes `prepare_cached`, connections that are `Send` but not `Sync`, and an interrupt handle for long-running queries. [duckdb-rs Connection API](https://docs.rs/duckdb/latest/duckdb/struct.Connection.html)
Use connection ownership rather than concurrent unsynchronized access; do not put every query behind one global connection lock.
Tie interrupt handles to the active execution generation so a delayed cancellation cannot interrupt a newer query on a reused connection.
Return “engine stopped” only after actual execution termination is observed.

The current `query_arrow` API materializes its result; `stream_arrow` lazily fetches chunks but still permits internal materialization for some statements.
Its documentation also reports iterator panics for fetch/conversion errors after execution starts. [duckdb-rs Statement API](https://docs.rs/duckdb/latest/duckdb/struct.Statement.html)
Probe execution-to-first-batch for each selected query plan; an iterator type is not proof of early database output.
Translate worker termination and late extraction errors into an incomplete/error result, never an implicit successful end.
The data-plane investigation should decide whether the safe binding suffices or a narrower native API adapter is justified.

## A ledger for zero avoidable copying

| Boundary | Proposed policy |
| --- | --- |
| ClickHouse output → Rust | Stream bounded chunks; preserve existing columnar encoding |
| Rust input → writer | Reuse owned buffers/slices where the APIs permit; avoid concatenating the whole response |
| Network/TLS → browser | Measure actual buffering and copies; no promise of a shared buffer across processes or machines |
| Decoder → renderer | Typed-array views where compatible; explicit copies only for alignment, decompression, conversion, or ownership |
| CPU → GPU | Account for upload/conversion; avoid readback in the first-point path |

The target is zero avoidable application copies, with unavoidable or API-imposed movement recorded honestly.
Bound retained memory and propagate credits upstream; keeping every received buffer forever is not a zero-copy win.

## TCP knobs and write policy

On sockets it owns, Rust can set `TCP_NODELAY`; Tokio documents that this disables Nagle's algorithm. [Tokio TcpStream](https://docs.rs/tokio/latest/tokio/net/struct.TcpStream.html#method.set_nodelay)
Test it for small first-point/control writes, and record whether the server framework already set it.
It does not flush an application buffer, clear a TLS buffer, bypass congestion, or configure the browser's socket.
If a proxy terminates the browser connection, our socket setting applies to the hop we own.

Nagle buffering and delayed acknowledgments are different mechanisms; TCP explicitly permits delayed ACK behavior. [RFC 9293](https://www.rfc-editor.org/rfc/rfc9293.html#name-delayed-acknowledgments-when-)
Avoid designing a tiny-message exchange that requires an application acknowledgment after every fragment.
Measure packet timing before attributing a delay to one TCP algorithm.

`TCP_CORK` can hold partial output until uncorked and is platform-specific in socket2. [socket2 TCP_CORK](https://docs.rs/socket2/latest/socket2/struct.Socket.html#method.set_tcp_cork)
It is a batching experiment for continuation, with prompt uncorking and cancellation handling, not a default first-point setting.
Compare gathering an already-ready header and payload into one write against adding a timer to wait for more data.
The former can reduce write overhead without deliberately delaying the first useful record.

tungstenite distinguishes `write` from `send`: `send` writes and flushes, while ordinary writes need subsequent flushing. [tungstenite WebSocket API](https://docs.rs/tungstenite/latest/tungstenite/protocol/struct.WebSocket.html)
Inspect equivalent async sink behavior in the pinned integration; count actual writes and flushes.
Flush the first schema/point dependency set promptly, then adapt continuation batching within an age limit.
A completed library flush still does not establish browser receipt or physical presentation.

## Compression has to earn its delay

The current tungstenite and fastwebsockets upstream documentation says `permessage-deflate` is unsupported. [tungstenite upstream](https://github.com/snapview/tungstenite-rs), [fastwebsockets upstream](https://github.com/denoland/fastwebsockets)
Do not add a fictional compression toggle to the comparison; use explicit payload compression or another verified implementation when testing it.
Start the codec comparison with an uncompressed first-point payload and independently encoded continuation batches.
Measure schema bytes, encoder setup, compression ratio, flush behavior, browser decode time, and allocations together.
Keep compression state, output length limits, and dependency boundaries explicit in the protocol.
Compression may win on constrained links and lose on loopback; both are relevant deployment cases.

## Side-by-side experiments before selecting a stack

| Experiment | Hold fixed | Measure |
| --- | --- | --- |
| axum/tungstenite vs axum/fastwebsockets | TLS route, payloads, flush policy, correctness checks | First useful response and browser draw p50/p95/p99, allocations, CPU |
| axum upgrade vs lean custom upgrade | Same WebSocket engine and warm connection | Steady-state difference separately from connection establishment |
| One socket vs separate control/data sockets | Same work, credits, and transport | Commit/cancel and first-result delay during a large stream |
| WebSocket vs HTTP/3 WebTransport | Same result semantics and session warmth | Loss/congestion tails, failures, CPU, bytes, fallback frequency |
| `TCP_NODELAY` and flush variants | Same endpoint, TLS, record sizes | Actual small-record departure and arrival; no echo-only ranking |
| Dedicated DB workers vs bounded blocking tasks | DB settings, connection reuse, concurrency | Admission delay, first batch, completion, cancellation lag |
| Native embedded DuckDB vs browser DuckDB | Dataset, queries, warm/cold classification | Entire Enter-to-correct-draw path plus startup and memory |
| ClickHouse pass-through relay vs direct response vs native adapter | Identical SQL, result types, terminal correctness | First batch/point, copies, memory, relay overhead, and completion |
| Compression and continuation batching | Exact same logical result | First point, final completion, CPU and bandwidth |

Use a warm single interactive client, realistic concurrent users, and foreground work competing with speculation.
Inject a slow reader, connection loss, invalid frames, oversized payloads, late DB errors, and cancellation races.
Include direct TLS and the intended production proxy path; plaintext loopback is a diagnostic, not the deployment result.
Report first correct point, useful coverage, and final completion with the same correctness oracle.
Keep socket echo tests as component diagnostics; they omit database scheduling, schema decoding, worker crossings, and drawing.
Use the [measurement plan](experiments.md) to separate draw-submission timing from actual photons.

The proposed comparison order is ordinary warm WebSocket, an equivalent fastwebsockets variant, then WebTransport and deeper runtime tuning.
That order keeps each new mechanism attributable while leaving room to push every demonstrated bottleneck further.
