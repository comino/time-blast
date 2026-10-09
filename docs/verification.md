# Prototype verification — 2026-10-09

The prototype is functionally exercised. These checks are not evidence of physical input-to-light latency, model semantic accuracy across arbitrary language, or production service performance.

## Automated checks

- TypeScript compilation and Vite production build pass.
- Rust compiler tests pass; the built Wasm artifact is also instantiated and exercised by the JavaScript tests.
- The test suite covers strict intent grammar/validation, actual model-worker message/cancellation behavior through controlled doubles, remote inference request/cancellation isolation, speculative promotion, stale query rejection, primitive Arrow backing-buffer identity/slices, stream truncation/EOS/error handling, bounded query admission, and ordered chart indices.
- Transport tests cover canceled messages still queued in MessageChannel, stale remote epochs, repeated identical commits, and all four inference/database placement combinations under a remote scheduling double. No live remote service is implied.

## Browser checks

Python Playwright with Chromium **145.0.7632.0** on this Linux host:

- DuckDB-Wasm **1.32.0**, Arrow **17.0.0**, bundled synthetic Parquet: **120,960 input rows**.
- An hourly average over the final 24 hours split by vessel produced **144 points in one Arrow batch**. The first point had `x = 1789344000000`, `y = 14.08533333333333`, `series = 0`.
- A raw scan returned its first **2,048-row** batch. Cancellation caused the next iterator request to reject with `AbortError`. A subsequent committed query returned all 144 expected points.
- The integrated UI rendered actual results, exported CSV, displayed 12 visible table rows, generated SQL, and recorded first-draw trace events. Desktop 1440×1000 and mobile 390×844 layouts were inspected. IME Enter suppression, stale/canceled events, settings validation, and pre-start errors were exercised.
- A **production-build** smoke staged 144 points before Enter, promoted them on submission, and completed without page errors. Single-run latency values are deliberately not treated as a benchmark.
- After gzip engine packaging, the production app was checked with both HTTP-transparent decoding and an actual gzip response without `Content-Encoding`. Both initialized the real DuckDB engine and staged/promoted 144 points without browser errors; no raw DuckDB Wasm URL was requested. Gzip-loader tests cover bounded bodies, truncation and cancellation.

Reproduce database/UI checks with Vite running:

```sh
python3 tests/browser_database.py
python3 tests/browser_ui.py
```

The scripts' module-isolation harnesses use Vite development module URLs. The separate production-build smoke exercised the built application's DOM and real adapters directly.

## Spatial canvas restoration

The canvas and extended visualization update passes **291 unit tests**, TypeScript checking, and the production build. The UI, live-translation, drawing-completion, renderer, and workspace browser regressions pass on Chromium **145.0.7632.0**. The workspace regression uses controlled batches and animation frames; its assertions establish event ordering and ownership, not wall-clock speed.

The new checks verify that a loading card exists before commit dispatch, the first mark precedes bulk indexing, consecutive questions retain independent views, all ten representations and duplication avoid a new query, duplicate views receive the exact original batches, and hidden views submit no premature first-draw timing. Camera, drag, resize, deletion, eight-card eviction, duplication at capacity, stale events, cancellation, and disposal are exercised through the UI. A 60,480-point rendering fixture still draws every segment of all six series in lines and geographic tracks; no sampling was introduced by the spatial layout.

`browser_views.py` executes ten direct visualization requests through real DuckDB and verifies the inferred mode, exact expected point counts, first-draw traces, and column identity after switching. It exercises all three lazy renderer families, surface rotation, UTC voyage seeking/playback, offscreen pause, empty results, unsupported photo/spatial choices, and restoration of the previous chart from the Data tab. A deliberately held renderer import proves database completion does not falsely report display completion or first drawing; releasing it resumes the correct card. Matrix/geo/calendar unit tests cover missing buckets, reordered indices, valid first marks, geographic frame expansion, antimeridian breaks, density counts, leap-year calendar positions, bounded slices, and disposal.

The public production smoke initializes **1,209,600 rows** in real DuckDB, promotes a prepared request with trailing whitespace, prepares SQL on edits without executing a query, renders **60,480 points**, and keeps four independent cards. It then requests heatmap, surface, tracks, and density directly, and switches to the seasonal wheel and back without querying. Presentation changes issue no new query and runtime changes do not reload DuckDB. HTTP-decoded engine loading and browser errors remain checked. The screenshot in the README comes from this deployed-build smoke.

```sh
python3 tests/browser_workspace.py
python3 tests/browser_views.py
python3 tests/ui_rendering.py
python3 tests/ui_completion.py
python3 tests/browser_production.py --url https://time-blast.46-224-133-201.sslip.io
```

These checks preserve the first-point path and bound background work. The historical latency measurements below predate this UI update; a fresh controlled performance comparison is still required before claiming a latency improvement.

## Default live query and stage timing

The live-query update passes **295 unit tests**, TypeScript checking, and the production build. `tests/browser_live_query.py` exercises actual DuckDB with the default settings: typing produces a result without Enter, edits reuse the same preview DOM and primary canvas, Enter keeps it without another query, and later drafts preserve kept cards. Controlled browser fixtures cover startup replay, runtime changes, IME composition, repeated input notifications, Stop, short drafts, same-turn coalescing, stale events, and switching back to manual submission.

Controlled-clock coordinator tests isolate inference, SQL compilation, database first-batch/stream completion, and first publication. Prepared queries retain their original work costs; publishing staged data starts a separate drawing interval. Browser checks verify displayed stage values and distinguish template translation from model inference. A chart reset test proves old batch/index references and callbacks are discarded while canvas allocations survive. These checks do not require a hardware WebGPU model or a live remote service.

All seven local UI/browser suites and the public HTTPS production smoke pass. The deployed smoke verifies the default live result and pinning, visible timing values, manual SQL-only preparation, exact prepared-result promotion, 60,480-point streaming, persistent advanced views, and blank new-execution timings on duplicates. No browser errors or failed assets were observed; the README screenshot reflects this release.

```sh
python3 tests/browser_live_query.py
```

The preview reuses its card and primary canvases instead of reconstructing them on every edit. An isolated 120-revision headless check, discarding 20 warmups, observed median empty-preview replacement time fall from 4.9 ms to 0.1 ms (p95 5.7 ms to 0.2 ms). This measures synchronous empty-card maintenance only, with no inference, query, populated renderer, or screen presentation; it is not an end-to-end benchmark.

## Warm preparation comparison

[`benchmark-browser.json`](benchmark-browser.json) records 20 measured trials per mode and two discarded warmups per mode. The paired order alternated, the same database stayed loaded, all results contained 144 points, and the source was explicitly `LOCAL TEMPLATE`. This run used headless Chromium **151.0.7922.34**, `--disable-gpu`, on a shared Linux aarch64 host with four logical CPUs.

| Warm template path | Median draw-submission latency | p95 |
| --- | --- | --- |
| Speculation off | 19.6 ms | 35.7 ms |
| Prepared result | 5.65 ms | 20.8 ms |

The prepared case waits until all points are staged before submitting. It measures the benefit of a successful preparation hit, not hit rate, inference performance, overall GPU/CPU cost, or presentation time. The host was uncontrolled and the sample is small; these are observations, not latency guarantees. Raw samples and hashes of the measured source files are retained in the JSON.

The measured source was committed in `c0527b645da6a0b2cd2cb0cea9508f9aa0b62275`. Subsequent gzip engine packaging changes cold startup; these measurements concern the already-warmed development runtime.

```sh
python3 scripts/benchmark-browser.py --output /tmp/time-blast-benchmark.json
```

## Local model: explicit verification limit

WebLLM **0.2.85** is integrated through its real WebGPU engine. Default headless Chromium exposed `navigator.gpu`, but `requestAdapter()` returned `null`. Auto mode reported that limitation and kept exact templates usable.

With explicit software-WebGPU flags, SwiftShader exposed an adapter without `shader-f16`; the worker selected **Qwen2.5-0.5B-Instruct-q4f32_1-MLC**. It downloaded roughly 267 MB of model artifacts and reported model initialization ready. The non-template generation did **not** produce a completed validated intent before the probe's **420-second timeout**. The browser was then closed. No completed LLM inference is claimed from this host.

The real inference probe is:

```sh
python3 tests/browser_inference.py --timeout 600
```

It forces `webgpu` mode, checks the actual source/model and exact expected plan, prints GPU/browser details, and exits 2 if no adapter is available. `--software` is an explicit CPU-emulation experiment, not a hardware performance substitute. Model weights stay in the browser profile, never in the repository.

Next acceptance check: run this on a GPU-equipped browser, evaluate a representative natural-language corpus for semantic fidelity, then measure warm and cold inference alongside typed-draft speculation. The local-model path must remain visibly distinct from the deterministic template path.
