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

Reproduce database/UI checks with Vite running:

```sh
python3 tests/browser_database.py
python3 tests/browser_ui.py
```

The scripts' module-isolation harnesses use Vite development module URLs. The separate production-build smoke exercised the built application's DOM and real adapters directly.

## Warm preparation comparison

[`benchmark-browser.json`](benchmark-browser.json) records 20 measured trials per mode and two discarded warmups per mode. The paired order alternated, the same database stayed loaded, all results contained 144 points, and the source was explicitly `LOCAL TEMPLATE`. This run used headless Chromium **151.0.7922.34**, `--disable-gpu`, on a shared Linux aarch64 host with four logical CPUs.

| Warm template path | Median draw-submission latency | p95 |
| --- | --- | --- |
| Speculation off | 26.1 ms | 46.9 ms |
| Prepared result | 7.3 ms | 18.1 ms |

The prepared case waits until all points are staged before submitting. It measures the benefit of a successful preparation hit, not hit rate, inference performance, overall GPU/CPU cost, or presentation time. The host was uncontrolled and the sample is small; these are observations, not latency guarantees. Raw samples and hashes of the measured source files are retained in the JSON.

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
