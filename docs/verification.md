# Prototype verification — 2026-10-09

The prototype is functionally exercised. These checks are not evidence of physical input-to-light latency, model semantic accuracy across arbitrary language, or production service performance.

## Inference reliability iteration

The default local profile is now **Qwen3-4B**, with a literal extraction contract selected together with its prompt, JSON grammar and decoder. The previous Qwen2.5-0.5B compact path scored **1/8 exact** on the reported regression set in native screening; the selected 4B contract scored **8/8**, all on its first attempt. On a separate, previously inspected 12-case development gate, its six supported requests were exact or had the proven single-vessel grouping equivalence, and all six unsupported requests remained non-executable. These are specific test results, not a general accuracy percentage.

The first independently authored 24-case audit found **13/16 supported exact-or-equivalent plans** and **6/8 unsupported requests kept non-executable**. Its remaining failures include a wrong bucket, false unsupported claims, and dropped absolute-date/forecast requirements. A well-formed wrong interpretation does not trigger validation repair. A later contract with explicit temporal scope passed the public eight but regressed the mixed supported gate, so it remains an unselected experiment. The [evaluation reports](../evals/results/README.md) retain failed candidates, raw outputs, frozen artifacts, corpus hashes, runtime details and scoring limitations.

A final independently authored 20-case audit of the unchanged selected candidate scored **10/12 supported exact** and **6/8 unsupported non-executable**, with no runtime failures. One strict supported mismatch comes from an omitted bare-request grouping default in the audit author's contract; its original expectation and score remain unchanged, with an independent-review note. The other supported failure changes 24-hour buckets to one hour. Absolute dates and forecasting again produced false accepts. These residual failures remain documented; no prompt was tuned against the final audit.

All model-quality measurements above use **llama.cpp b11538 and native GGUF weights on CPU**. The browser uses WebLLM 0.2.85 and MLC assets; neither browser accuracy nor GPU inference speed can be inferred from the native scores. The hardware preflight on this host returned no GPU adapter and loaded no weights. The hardware-only evaluator is ready for another machine and refuses software adapters.

Worker regressions exercise the selected contract, both precision variants, canonical forced-header handling, correction feedback, context overflow, cancellation and cumulative diagnostics. Asset tests verify immutable model/library revisions while preserving registry memory, context and feature settings. Profile/cache lifecycle tests prove that switching models retains DuckDB, old worker messages are fenced, disabling exact-plan reuse keeps the warm engine, and in-flight requests cannot repopulate a cleared cache after its policy changes.

The actual browser XGrammar Wasm accepts supported literal extractions and rejects malformed shapes. Unsupported requirements that the grammar intentionally allows are rejected by the real decoder. Captured native completions for the user's three questions pass through the actual decoder, rebuilt Rust compiler, DuckDB and canvas: **60,480**, **144** and **2,016** points with all six vessels and correct available time bounds. Nineteen invalid completions stop before compilation or database execution. This replay checks execution of captured responses, not live model generation.

```sh
python3 tests/browser_model_grammar.py
python3 tests/browser_model_query.py
python3 tests/ui_model_profiles.py
python3 tests/browser_model_accuracy.py --self-test
# On a machine with a hardware WebGPU adapter:
python3 tests/browser_model_accuracy.py --profile qwen3-4b --headed
```

## First complete bucket in local DuckDB

The local database now emits the first complete timestamp group before executing the remaining window, within one read-only transaction. The checked-in Rust/Wasm compiler preserves the original time-window anchor and rejects splits through a group. One connection and admission owner retain both statement streams, one abort signal, and shared row/unique-buffer budgets. Remote database behavior is unchanged.

The [warm comparison](experiments/first-bucket-query-2026-10-09.md) contains six pairs for each of six query shapes. All **36 pairs** match every ordered timestamp, series, metric and coordinate value exactly. For the week/minute six-vessel chart, median first draw changed **55.65 → 13.85 ms**; the median paired improvement was **42.40 ms**, with **6.30 ms** additional database completion time. Both strategies used the same initialized dataset, and native inference was paused. These measurements concern software drawing submission on this host, not inference or screen presentation.

The production path's captured-model replay draws from the first **six-point** batch while retaining all **60,480** eventual points and the original Arrow buffers. All ten chart routes, view switching and the two-second live-query flow pass with the enabled strategy. Separate real-engine probes verify read-only mutation rejection in either phase, cancellation/early return, unchanged recovery results and no remainder after a canceled prefix. Controlled tests also cover empty prefixes, shared budgets, query ownership, partial failures and commit errors.

```sh
python3 tests/browser_first_bucket_safety.py
python3 tests/browser_model_query.py --first-bucket
python3 tests/browser_views.py
python3 tests/browser_live_query.py
```

## Automated checks

- Final iteration: **675 application tests across 23 files**, **8 Rust tests**, and **8 controlled evaluator/provenance tests** pass, along with TypeScript checking and the Vite production build. The rebuilt Wasm artifact is committed with its Rust source. Independent reviews found no material blocker in the selected inference/profile/cache path or the complete-bucket execution path.
- TypeScript compilation and Vite production build pass.
- Rust compiler tests pass; the built Wasm artifact is also instantiated and exercised by the JavaScript tests.
- The test suite covers strict intent grammar/validation, actual model-worker message/cancellation behavior through controlled doubles, remote inference request/cancellation isolation, speculative promotion, stale query rejection, primitive Arrow backing-buffer identity/slices, stream truncation/EOS/error handling, bounded query admission, and ordered chart indices.
- Transport tests cover canceled messages still queued in MessageChannel, stale remote epochs, repeated identical commits, and all four inference/database placement combinations under a remote scheduling double. No live remote service is implied.

The **2026-10-10 public HTTPS smoke passed** on code revision `64d3802`, release `20261010T000722Z-bebaed19`. It verifies the Qwen3-4B selection and enabled exact-plan cache, no template fallback when WebGPU is deliberately unavailable, then explicitly selects templates for real DuckDB checks. The enabled first-bucket strategy is visible in SQL details and trace events. The 1,209,600-row dataset produces 60,480 points; live typing waits two seconds, Enter bypasses the pause, prepared data promotes without another query, runtime changes retain DuckDB, and four independent cards preserve advanced views. Both reported surface/window questions pass. There are no page errors or failed app assets. This deployment check does not claim live browser model inference.

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

## Inference work reduction and 2-second pause

The next update passes **363 unit tests**, TypeScript checking and the production build. Controlled clocks verify no automatic inference/query before 2,000 ms, timer reset on edits, immediate Enter, remaining-deadline behavior after startup/remote PREPARE, and no duplicate execution at the deadline. Browser fixtures also prove Clear on an empty canvas and closing a finished/stopped preview cancel a pending replacement. Real DuckDB live queries wait at least two seconds after the recorded input event. All eight local browser suites, including the 1,209,600-row database smoke, pass. The public HTTPS smoke also verifies the measured pause and early Enter bypass, prepared promotion, 60,480-point results, advanced views and asset loading with no browser errors; its screenshot is included in the README.

The actual worker is exercised with a controlled engine: compact schema requests, full validated plans, separated queue/warmup/generation telemetry, usage conversion, and rejection of interrupted/truncated output. Compact decoder tests cover all ten views and reject unsafe grouping, extra/missing fields, invalid values and malformed output. Cache tests cover exact identity, capacity, immutable returned plans, context changes, caller mutation and canceled/failed generations. The UI verifies phase labels and removes old generation statistics on a cache hit.

[Recorded Qwen tokenizer measurements](benchmarks/inference-token-counts-2026-10-09.json) show the system prompt shrinking from **951 to 527 tokens**; a representative complete ChatML input shrinks from **979 to 555**. Three canonical output examples shrink **37→31**, **38→32**, and **41→35** tokens. The artifact records the exact texts, tokenizer URL/hash, context and method. These are offline token counts, not model output, semantic-accuracy results, or measured GPU speedups. No hardware inference was available on this host; the existing `browser_inference.py` probe remains available for a hardware-equipped browser.

True KV prefix reuse remains unimplemented: the pinned browser runtime resets independent system/user requests and has no supported prefix checkpoint/restore API. The new exact plan cache is explicitly labeled and skips only repeated local model generation. Remote latency comparisons and a trained semantic parser remain separate experiments requiring an actual service or training/evaluation workload.

## Requested windows and failed inference

This update passes **411 unit tests**, including actual rebuilt Rust/Wasm compilation, plus **5 Rust tests**. Requests retain their original trailing window instead of inheriting the bundled dataset's 14-day duration. Tests cover 710 days, longer dataset contexts, adjacent number/unit wording such as `1days`, and the positive unsigned 32-bit ABI boundary.

`tests/browser_query_failures.py` executes the user's two surface requests through deterministic templates and real DuckDB: 710 days returns **2,016 hourly points** from the available 14 days; `1days` returns **144 hourly points**. It checks all six vessel series, exact time bounds, the visible requested-versus-available coverage note, and live preview reuse. Controlled UI fixtures verify inference, compilation and partial database failure durations, retained model diagnostics, stopped loading, recovery and stale-event rejection. A failure cannot fabricate database activity or a draw. Workspace, all ten real query/view routes, and live-translation browser regressions also pass.

The public HTTPS production smoke passes both exact prompts, the existing 60,480-point query, prepared promotion, the 2-second typing pause and independent chart views, with no browser errors. Desktop cards now leave room for the surface and coverage note; live edits preserve a manually resized card. The existing compact mobile card height remains unchanged and can still squeeze a surface when coverage and timing rows are present.

The original one-day refusal message corresponds to the model's explicit `unsupported_request` output. A template miss in Auto mode continues to the model; the valid one-day surface plan passes validation. These tests establish query support and failure reporting, **not** that the revised prompt prevents false refusals on a hardware WebGPU model. Prompt instructions now explain missing number/unit spaces and windows exceeding available coverage; actual model semantic accuracy remains unverified on this host. The earlier token-count artifact records the prompt before these additions.

```sh
python3 tests/browser_query_failures.py
```

## Bounded model correction

The correction update passes **427 unit tests**, TypeScript checking and the production build. Controlled-engine tests exercise the actual worker's refusal, malformed JSON, invalid plan and length-limit correction branches; enforce the two-attempt ceiling; check cancellation before/during correction and queue ownership; and verify combined timings/token counts without invented rates. Runtime failures never retry. Browser failure fixtures verify visible correction costs, raw output rendered as literal text, truncation/finish labels and metadata clearing on the next draft. The public HTTPS smoke passes the unavailable-model/no-template-fallback check and explicit-template DuckDB/rendering regressions without page errors. These are execution-contract tests, not model-accuracy tests.

[Native real-model diagnostics](benchmarks/native-inference-evaluation-2026-10-09.json) record 18 exploratory cases with pinned llama.cpp ARM64 binaries, official Qwen GGUF weights, prompt/schema texts, hashes, raw responses and expected plans. The 0.5B model produced structurally valid but wrong plans for the reported minute/seven-day question under several prompts. A correction following a **synthetically supplied refusal** still returned the wrong bucket/window. The 1.5B model handled the two supported examples but silently dropped a metric from an unsupported combination. No prompt rewrite or model upgrade was shipped on the strength of these trials. GGUF quantization and native grammar differ from WebLLM/MLC: these observations neither reproduce the browser refusal nor establish browser performance or accuracy.

## Mobile matrix geometry and interpreted query scope

The later reliability pass fixes the compact mobile surface limitation described above. Matrix cards now retain a 520-pixel minimum height; a populated mobile canvas gains enough vertical room to fit the first card. Its existing resize observer fits the camera after that expansion, without adding per-batch layout reads. Query details cover only the chart body, leaving statistics, stage timings and controls accessible. Chart headings also identify the interpreted vessel filter or fleet grouping, rather than calling every grouped result a fleet comparison.

`tests/browser_mobile_matrix.py` exercises actual surface cards with controlled column buffers at 390×844, including the 710-day requested window and its coverage note. The projection height increased from approximately one pixel to 98 pixels in the ordinary case and 64 pixels with the coverage note. Screenshots were visually inspected. The workspace regression and five additional viewport geometry checks from 320×568 through 651×800 pass without page errors or horizontal page overflow. These are layout checks, not database or latency measurements.

The ten-view browser test also had an independent test-harness race: Playwright's request event can arrive before the Python interception callback records its held import. The test now waits for that explicit interception signal, verifies there is still no drawing, then releases the renderer and checks completion. Eighty isolated repetitions and the full real-DuckDB view suite pass; application rendering behavior was not changed to accommodate the test.

```sh
python3 tests/browser_mobile_matrix.py
python3 tests/browser_workspace.py
python3 tests/browser_views.py
```

## Warm preparation comparison

Current default is local WebGPU inference, with templates bypassed. The browser live-query and public deployment scripts deliberately remove WebGPU availability, submit known template wording, and require a model error with no data or database timings. They then explicitly select templates for the existing real DuckDB checks. This verifies absence of silent fallback, not successful model generation. The historical template benchmark below requires an explicit template/Auto selection.

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

## Earlier software-WebGPU probe

WebLLM **0.2.85** is integrated through its real WebGPU engine. Default headless Chromium exposed `navigator.gpu`, but `requestAdapter()` returned `null`. Auto mode reported that limitation and kept exact templates usable.

With explicit software-WebGPU flags, SwiftShader exposed an adapter without `shader-f16`; the worker selected the then-default **Qwen2.5-0.5B-Instruct-q4f32_1-MLC**. It downloaded roughly 267 MB of model artifacts and reported model initialization ready. The non-template generation did **not** produce a completed validated intent before the probe's **420-second timeout**. The browser was then closed. No completed browser LLM inference is claimed from this probe.

The real inference probe is:

```sh
python3 tests/browser_inference.py --timeout 600
```

It forces `webgpu` mode, checks the actual source/model and exact expected plan, prints GPU/browser details, and exits 2 if no adapter is available. `--software` is an explicit CPU-emulation experiment, not a hardware performance substitute. Model weights stay in the browser profile, never in the repository.

Next acceptance check: run this on a GPU-equipped browser, evaluate a representative natural-language corpus for semantic fidelity, then measure warm and cold inference alongside typed-draft speculation. The local-model path must remain visibly distinct from the deterministic template path.
