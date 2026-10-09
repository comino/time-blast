# Latency experiments and measurement

Status: experiment plan, October 9, 2026. No results have been collected. All comparisons below are proposed tests, not performance claims.

Optimize the latency of a correct answer under a declared resource budget. A favorable trace of a wrong query, a stale cache hit, or a draw that never reaches the screen is not a win.

## Define the finish lines

| Metric | Start | Finish | Interpretation |
| --- | --- | --- | --- |
| Enter to preview | Committing input event | First provisional preview draw submitted | Responsiveness proxy; may be wrong or approximate |
| Enter to valid point | Committing input event | First complete, valid committed point available in browser memory | Data-path metric |
| Enter to correct draw | Committing input event | First correct point's draw submitted | Main software optimization metric; not presentation |
| Enter to useful coverage | Committing input event | A declared fraction of requested series/time buckets drawn | Guards against gaming the benchmark with one unhelpful point |
| Enter to completion | Committing input event | Successful full result and final chart update | Guards against sacrificing the rest of the result |
| Physical Enter to light | Instrumented physical key trigger | Sensor detects the correct point's display transition | Literal end-to-end metric, including input and display |

Define useful coverage before a run, for example a specified fraction of expected populated buckets across all requested series. State the dataset and criterion; do not invent a denominator from whichever records arrived first. Empty results have their own Enter-to-confirmed-empty metric. Failed, canceled, and timed-out requests remain in outcome statistics instead of disappearing from latency reports.

“Correct” has two layers: the query must match the intended metric/filter/window, and the point must match that query's agreed data epoch. Protocol validity alone does not prove the LLM understood the user. Use a curated natural-language corpus with accepted interpretations and reference queries, then compare returned values against the reference result. Test ambiguity separately; a fast request for clarification is preferable to declaring a guessed metric correct.

## Trace boundaries

Capture compact events with `{trace_id, commit_id, candidate_id?, component, clock_id, event, timestamp, attributes}`. Each component uses its own monotonic clock. Export traces after the critical path from bounded buffers; do not write a network log for every point.

```text
draft.input
draft.enqueued / draft.received
context.ready / model.ready / database.ready / renderer.ready
speculation.admitted / speculation.discarded / speculation.promoted
input.event_timestamp / input.handler_start
commit.enqueued / commit.received
inference.queued / prefill.start / prefill.end / decode.first_token
intent.complete / query.validated
database.queued / database.start / database.first_batch / database.complete
encode.first_frame / transport.enqueued
browser.first_byte / browser.first_complete_point
decode.complete / render.update_start / render.draw_submitted
result.complete / result.error / result.canceled
cancel.requested / cancel.engine_stopped
```

Mark a span unknown when the engine does not expose it. A client-reported request duration cannot manufacture server queue or prefill timings. Record both input event timestamp and handler start where supported so main-thread input delay is not accidentally excluded.

Use `performance.now()` for browser durations. Related browser contexts can translate time origins, but a remote server's monotonic clock is not directly comparable. Use component-local spans and browser-observed round trips; if estimating clock offsets, report uncertainty. Timer precision can be reduced or jittered, so microsecond-scale experiments need repeated samples and a reported effective resolution. [High Resolution Time](https://www.w3.org/TR/hr-time-3/).

`PerformanceEventTiming` can help diagnose input processing and presentation associated with an event; it is not an identity-aware timestamp for an asynchronously arriving chart point. Treat it as supporting diagnostics. [Event Timing API](https://w3c.github.io/event-timing/).

Record the browser callback and draw submission as their actual events. Neither `requestAnimationFrame`, a second animation frame, nor a GPU fence directly measures emitted light. The rendering loop includes browser scheduling decisions. [HTML rendering model](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering).

## The physical experiment

Use a microcontroller or instrumented input device that timestamps a physical trigger and injects the corresponding keyboard event, and a photodiode on the same acquisition timebase. Place the detector over the expected first point in a controlled chart fixture. Measure multiple screen positions because scanout position can matter.

For an easier calibration fixture, switch a high-contrast patch in the same canvas submission as the point; label it a presentation proxy. Validate that the patch does not update when a point is rejected or absent. A camera can verify that the correct plotted point appeared, with timing uncertainty set by its capture method and frame rate. Report sensor threshold, sample rate, input path, monitor mode, refresh/VRR behavior, and pixel response conditions.

Do not describe synthetic DOM events as physical keyboard measurements. Do not equate a video frame or screen capture API with photons. Calibrate instrumentation overhead with a trivial input-to-marker application before measuring inference or database work.

## Baseline workload

Begin with a reproducible generated time-series dataset: event timestamp, series ID, numeric value, nulls, out-of-order arrival, and late corrections. Fix the generator seed and dataset version. Keep a small fixture whose complete result can be independently checked, plus larger datasets that exceed caches and browser memory budgets.

Use query classes with different execution behavior:

1. Ordered raw range scan, with and without a selective filter.
2. Per-minute aggregates over a finite range.
3. Global aggregate and full sort, where early exact output may be impossible.
4. Grouped series with sparse/missing buckets and timezone boundaries.
5. Join/window-function query, including dependencies outside the displayed window.
6. Empty result, large value, query error after partial data, and bounded resource failure.

Prepare natural-language variants with explicit expected interpretations: negation, changing average to maximum, adding a tenant filter, timezones, and “last hour.” Record actual input traces containing timestamps, revisions, pauses, paste, middle edits, composition, undo, and Enter. Replay them causally: no component may see the final text before the recorded user has produced it.

Measure app/model/data cold starts separately from warm runs. Also measure a warm app after suspension, cache eviction, GPU contention, and token/session expiry. Report cached artifacts and pre-Enter preparation duration; never amortize an unreported minute of warmup into a claimed instant experience.

## Controlled comparisons

| Experiment | Baseline and change | Question it answers |
| --- | --- | --- |
| E01 | Synthetic in-memory point to Canvas, immediate vs scheduled draw | What is the browser/display floor on this machine? |
| E02 | No draft transmission vs versioned drafts over a warm session | How much post-Enter setup/transmission work is actually removed? |
| E03 | Cold model vs warm context vs observed prefix cache hit | Is preparation reused by this exact engine? |
| E04 | Full SQL vs compact intent vs vetted template | Does shorter generation preserve semantic accuracy and save latency? |
| E05 | No speculation vs one candidate vs limited branching | Do hit-rate gains outweigh queue contention and wasted work? |
| E06 | Materialized result vs execution-time batch streaming | Does the physical plan emit useful data early? |
| E07 | Uniform batch size vs tiny first batch then bulk | Is first-point latency improved without unacceptable completion cost? |
| E08 | Arrow-only vs first-point extension vs specialized codec | Are schema/codec costs large enough to justify custom framing? |
| E09 | Warm WebSocket vs actual WebTransport session | What happens under loss, congestion, and concurrent bulk delivery? |
| E10 | Main-thread drawing vs OffscreenCanvas; transfer vs shared ring | Are scheduling savings larger than coordination costs? |
| E11 | Typed-array JavaScript vs a Rust/Wasm hotspot | Does the full pipeline improve after crossings and initialization? |
| E12 | Raw scan vs rollup/tile vs exact first-window query | Does earlier output preserve the query's semantics? |
| E13 | Local model and renderer together vs paused speculation/remote model | Does GPU contention move the bottleneck into presentation? |
| E14 | Compression off/on; proxy buffering off/on | Where is the first byte being held? |
| E15 | Duplicate commits, revision races, cancel, disconnect | Can stale or incomplete results ever look current and complete? |
| E16 | Direct column views vs copying Wasm bindings vs retained Rust buffers | Which copies/calls are introduced or removed, including first-point cost? |
| E17 | Per-card incremental visibility vs complete workspace result/reveal | Which persistence, multi-card, and animation barriers delay a correct mark? |
| E18 | Rust socket backends under identical TLS, payloads, queues, and flush policy | Does a crate change improve end-to-end p95/p99 rather than echo throughput alone? |
| E19 | ClickHouse byte relay vs decode/re-encode adapter | Can original columnar payloads reach the decoder sooner with fewer copied bytes while preserving completion/errors? |

Vary one mechanism at a time before testing combinations. Pin builds and record negotiated capabilities. Compare under equal resource budgets; a second GPU or preloaded full dataset is a different configuration, not a free software speedup.

The placement matrix must cover local/local, local/remote, remote/local, and remote/remote. Start with a local network and then controlled additional RTT, jitter, loss, and bandwidth constraints. Document the impairment method and actual observed network conditions. Run both isolated and concurrent-user loads; speculative work can look excellent in an otherwise empty system and worsen p99 at realistic utilization.

## How to analyze a run

Report p50/p95/p99, sample counts, confidence intervals where supportable, errors, timeouts, and semantic accuracy. Do not claim a stable p99 from a few dozen requests. Randomize or alternate compared configurations and keep warmup rules fixed. Repeat on different devices only after establishing a repeatable baseline on one machine.

Separate exact speculation hits, partial reuse, misses, and invalidated hits. Then report the complete workload distribution using their observed frequencies. Do not average component p99s into an end-to-end p99. Keep per-request traces for tail analysis.

Report at least these costs per submitted query:

- Generated and discarded tokens, cached tokens when observable, retained model memory.
- Executed/canceled speculative queries, scanned/result bytes, CPU/GPU time where observable.
- Queue age, allocation rate, decoder memory, frame misses, and cancellation lag.
- Model/data download bytes and warmup duration; energy or power with measurement method if available.

Evaluate expected benefit under load, not just hit rate:

```text
net latency benefit ≈
  probability of valid hit × foreground time saved
  − validation overhead
  − contention added to hits and misses
```

This is an admission heuristic, not a performance law. Total resource cost is an additional constraint rather than something measured in milliseconds. Stop increasing speculative breadth when committed p95/p99 or the resource budget regresses.

## Required invariants before calling a result faster

- A late old generation never updates the current chart.
- Exact data never silently changes inside one declared query/data epoch.
- Wrong prompt/context/authorization/time bindings cannot promote.
- Nulls, decimal values, and int64 timestamps survive the codec path correctly.
- Loss, duplicates, truncation, and late database errors cannot become success.
- No credit deadlock prevents schema plus the first point from arriving.
- Cancellation stops rendering immediately and its actual engine cost is recorded.
- Empty/failed/ambiguous cases remain visible in outcome statistics.

Test these with an eventual protocol simulator and adversarial event schedules before relying on microbenchmarks. The initial repository contains the plan only. When experiments exist, store their configuration, reproduction command, raw observations, and environment manifest alongside any chart of results.
