# Rust and Wasm: optimize the data path, count the boundaries

Status: research and proposed experiments; no implementation or performance results.
Primary sources checked **2026-10-09**. Browser, compiler and package versions must be
pinned for actual measurements; a supported language is not a latency guarantee.

Rust is a strong candidate for a shared computational core and a later native service.
The hypothesis to test is that persistent, contiguous data processed in Rust beats the
same complete path in optimized JavaScript. Rewriting browser orchestration alone does
not establish that hypothesis: crossing into Wasm can add work to a short operation.

**Remove every avoidable copy.** Stream database batches through to chart updates without
whole-result materialization, per-row JSON, or gratuitous numeric repacking. DuckDB-Wasm
is the embedded prototype; ClickHouse is the primary production database target. Keep
already usable Arrow buffers on their direct route to the renderer instead of copying
them into Rust merely to process everything in one language.

## The proposed division

| Work | Initial candidate | What would justify changing it |
| --- | --- | --- |
| Input, IME, focus, DOM overlays, browser sessions | Thin TypeScript shell | A Rust UI materially simplifies ownership without harming latency |
| First marker and chart activation | Already-created Canvas 2D context | A warmed GPU path wins measured first-point timing |
| Decode, validate, reduce, project batches | Typed-array JS baseline versus fused Rust kernel | Whole-path improvement including ingress/egress |
| Embedded database | Existing DuckDB-Wasm worker | A custom integration eliminates a measured bottleneck |
| Dense chart geometry and hit testing | Retained arrays; optional Rust/Wasm | Repeated work over resident data amortizes the boundary |
| Later service | Native Rust coordinator streaming ClickHouse results | Measured topology and deployment constraints |

This keeps a serious Rust option without making every browser event pass through Wasm.
A Rust frontend can call browser APIs through `web-sys`; those are bindings to existing
web interfaces, not an escape from browser scheduling or presentation.
[web-sys documentation](https://wasm-bindgen.github.io/wasm-bindgen/web-sys/index.html)

## DuckDB-Wasm is already compiled native-language code

DuckDB is C++ compiled to Wasm with Emscripten. Its published design uses Arrow IPC for
results and JavaScript access to the Wasm heap. The normal asynchronous integration
instantiates a JavaScript worker and an `AsyncDuckDB` wrapper. A Rust wrapper does not
turn its database kernel into a faster Rust implementation.
[DuckDB-Wasm design paper](https://duckdb.org/pdf/VLDB2022-kohn-duckdb-wasm.pdf),
[current instantiation API](https://duckdb.org/docs/current/clients/wasm/instantiation)

Treat a separately built Rust module and the packaged DuckDB-Wasm runtime as distinct
memory/allocator domains. A numeric pointer from one is not a usable Rust slice in the
other. Running both in one worker removes a scheduling boundary, not automatically a
memory boundary. Emscripten's modularized instances are explicitly separate instances.
[Emscripten modularized output](https://emscripten.org/docs/compiling/Modularized-Output.html)

A deliberately linked build or compatible imported shared memory is a separate engineering
experiment. It needs a common ABI, coordinated memory layout, allocator ownership and
compatible threading/runtime assumptions. `SharedArrayBuffer` alone does not merge heaps.
The portable prototype should consume the supported Arrow/buffer interface and inspect
the selected package's generated bindings before claiming an eliminated copy.

## What actually crosses the Rust/JavaScript boundary

Small numeric parameters can map to JS numbers; 64-bit integers use BigInt through
`wasm-bindgen`. That does not require serializing a row object. Validate range/finite
constraints explicitly: binding conversions are not application validation.
[wasm-bindgen numeric types](https://wasm-bindgen.github.io/wasm-bindgen/reference/types/numbers.html)

The convenient boxed numeric-slice interface copies between typed arrays and Wasm
linear memory in both directions. Passing a whole batch once may still be worthwhile;
passing and returning every point separately multiplies conversions and calls.
[wasm-bindgen boxed numeric slices](https://wasm-bindgen.github.io/wasm-bindgen/reference/types/boxed-number-slices.html)

Rust strings are another conversion path: the binding transcodes/copies JS strings to
UTF-8, and unpaired UTF-16 surrogates can change during conversion. Define the protocol's
text normalization/encoding before hashing commits; do not hash different representations
on opposite sides. A JS string handle avoids copying but leaves the string in JS.
[wasm-bindgen strings](https://wasm-bindgen.github.io/wasm-bindgen/reference/types/str.html)

Passing `JsValue` can retain a JavaScript value rather than materializing a Rust data
structure. It does not make object fields a contiguous Rust column. Keep object handles
at the control boundary and compare real access/conversion costs for the chosen API.
[wasm-bindgen JsValue](https://wasm-bindgen.github.io/wasm-bindgen/reference/types/jsvalue.html)

A typed-array view into Rust linear memory can avoid a particular outgoing copy, but
the documented view API is unsafe: Rust allocation/memory growth can invalidate views,
and JavaScript lifetimes and mutation are not enforced by Rust's borrow checker.
Use an explicit lease, stable allocation and release protocol; recreate views after growth.
[js-sys Uint8Array views](https://docs.rs/js-sys/latest/js_sys/struct.Uint8Array.html#method.view)

## Copy ledger for the first prototype

Record actual bytes and ownership transitions; the table identifies places to inspect,
not a claim that each backend performs exactly one copy at every row.

| Boundary | Possible work | Proposed treatment |
| --- | --- | --- |
| DuckDB vectors → Arrow IPC | Serialization/materialization inside database runtime | Trace separately from query execution |
| DuckDB Wasm → worker-owned result buffer | Borrowed view or copy selected by binding/lifetime | Verify concrete package path; keep it alive correctly |
| Worker → chart owner | Structured clone or transferable ownership | Transfer standalone buffers when safe; no per-row messages |
| Arrow buffer → JS column views | Metadata decoding, possible alignment/conversion | Retain numeric buffers and validity bitmaps; avoid row objects |
| JS buffer → Rust memory | Copy for ordinary numeric-slice bindings | One batch ingress; fuse subsequent operations |
| Rust output → JS renderer | Copy or leased typed-array view | Reuse output storage; account for retained memory |
| CPU buffer → GPU | Upload/staging, validation and queue submission | Upload only changed ranges; avoid readback |

A transferable buffer changes ownership; it is not permission to detach a live Wasm
heap or a backing buffer still used by another view. The web's transfer and shared-memory
mechanisms have distinct semantics. [HTML structured data](https://html.spec.whatwg.org/multipage/structured-data.html)

Draw as soon as schema plus the first timestamp/value/series form a valid point; a timestamp
alone cannot locate a meaningful point. Complete early Arrow record batches incrementally,
then consume later batches without collecting the whole query. Account explicitly for
database encoding, unavoidable memory boundaries and GPU uploads that remain.

Benchmark two useful shapes: `Arrow → JS view → draw`, and
`Arrow → one Rust ingress → validate/filter/project/geometry → draw`.
If the kernel only transforms one scalar, the second path is a poor assumed default.
If many operations reuse a large resident column, its amortization hypothesis is stronger.

## SIMD, threads and warmup are explicit variants

Rust's Wasm feature defaults evolve with LLVM. Pin the target feature set and test the
actual emitted module, including dependencies; do not infer SIMD from the source language.
Use a scalar-compatible variant and a `simd128` variant for meaningful numeric kernels.
SIMD should preserve declared NaN/null/overflow and aggregation semantics.
[Rust Wasm target features](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html#enabled-webassembly-features)

Threads require compatible builds, worker startup and shared-memory synchronization.
For normal web deployment, plan cross-origin isolation and verify `crossOriginIsolated`;
COOP `same-origin` plus COEP `require-corp` is one documented configuration. Test all
worker/module/data origins under the policy, and retain a non-threaded fallback.
[Chrome isolation guide](https://web.dev/articles/cross-origin-isolation-guide)

Current DuckDB docs describe a threaded `coi` bundle, selected only with its required
browser features and isolation. The ordinary CDN bundle helper does not include it;
the docs add it explicitly and configure `maximumThreads`. A worker-backed database
is not automatically a parallel query engine.
[DuckDB threaded bundle](https://duckdb.org/docs/current/clients/wasm/instantiation#threading)

Precreate a bounded worker pool. Compare a single worker against parallel work at each
batch size: waking several workers for the first few points can lose to doing less work.
Reserve foreground capacity; a Rust thread pool competing with DuckDB and a local model
can improve aggregate throughput while making Enter latency worse.

Load immutable versioned assets before interaction and use the loader's streaming
compilation path with the correct Wasm MIME type. V8 documents separate resource and
compiled-code caches; cache behavior is engine-specific and can invalidate. A cached
download does not prove an instantiated, warmed module.
[V8 Wasm code caching](https://v8.dev/blog/wasm-code-caching)

Record four states: cold download/compile, cached assets but fresh instance, initialized
instance with cold data, and resident code/data/buffers. Warm representative kernels,
allocation pools and rendering resources outside the measured Enter path. Include their
cost in startup reporting. Compare release builds and inspect unexpected memory growth.

## Rust is not a shortcut around correctness or the GPU queue

Wasm bounds protection applies to linear memory, not each Rust/C++ allocation within it.
Unsafe code can still corrupt neighboring data; traps do not make that safe.
Prefer batch validation and safe loops the compiler can optimize. Inspect emitted code
before considering a narrowly justified unsafe kernel with independently tested invariants.
[WebAssembly memory safety](https://webassembly.org/docs/security/#memory-safety)

Return ordinary query/codec failures through typed results. Define what a panic, Wasm
trap or imported JavaScript exception does to the instance and outstanding generations;
do not repeatedly use exceptions as the normal cancellation or parsing path. Panic
recovery depends on the actual Wasm/toolchain configuration, not on writing `catch_unwind`.
[wasm-bindgen panic recovery](https://wasm-bindgen.github.io/wasm-bindgen/reference/catch-unwind.html)

`wgpu` supports native backends and WebGPU/WebGL on Wasm. This makes shared geometry and
rendering code plausible, but the browser path still uses web APIs. Share a conservative
feature subset; native extensions are not a promise of browser support.
[wgpu platform/backends](https://docs.rs/wgpu/latest/wgpu/)

An all-Rust chart is worth comparing once a workload needs substantial retained geometry.
It still pays device/pipeline setup, uploads and queueing. A local WebGPU model may contend
with chart work regardless of the language issuing it. Benchmark one-point presentation
and dense continuation separately, including model-active and model-paused cases.

## Reuse for the later Rust webservice

Keep query intent, validation, protocol state, timestamp arithmetic, codecs and numeric
kernels in browser-independent Rust crates where they earn their place. Use browser
adapters for promises/workers/DOM and native adapters for networking, clocks and database
execution. Share semantic fixtures and trace event definitions across both targets.

The production Rust service should stream ClickHouse output through the shared contract.
Optional native DuckDB is a different integration from the packaged browser Wasm worker.
Keep driver lifetimes and thread policy behind the database contract. Do not
put loopback HTTP between browser-local components merely to mimic the future service.

The decisive experiment compares identical results, batch sizes and resident data:
optimized typed-array JS; Rust with convenient copying bindings; Rust with persistent
buffers/fused kernels; and an optional GPU path. Record allocations, bytes copied,
boundary calls, worker queue delay and first-correct-point p50/p95/p99. Every microsecond
counts, including the ones introduced by moving an operation into Wasm.
