# Current status and handoff

Updated **2026-10-11** (batches 1–3 merged; see Deployed for what runs live). Direction: [vision.md](vision.md). The source repository is
private; the [live synthetic-data demo](https://time-blast.46-224-133-201.sslip.io) is public and,
since 2026-10-11, **runs batch 1 + batch 2** ([deploy/README.md](../deploy/README.md)): public
check, real inference, last keystroke → first draw 547 ms.

## On `main`: batch 1, complete in source

```
main thread (JS glue: input, cards, DOM text)
   │ tb1 frames over MessagePort (transferred buffers)
engine worker
   ├─ coordinator  Rust/Wasm, sans-IO: per-keystroke translation, dedup, fencing, cache, latency dial
   ├─ database     DuckDB-Wasm blocking API in-process  |  or tb1 WebSocket → Rust → ClickHouse
   ├─ renderer     Rust/Wasm + WebGPU/WebGL2 shim, OffscreenCanvas per card, ten views
   └─ inference    tb1 WebSocket → Rust server → OpenRouter (SQL out)  |  or WebLLM worker
```

Everything speaks one protocol, [tb1](protocol-v1.md). Moving a node changes only its link. This
is shown for the database: browser DuckDB and remote ClickHouse return identical results through
the unchanged coordinator, renderer and UI. It is also shown for inference: a WebLLM worker or the
remote server. Per-area notes and measurements are in [batch-1/](batch-1/); plan and ownership in
[plan-batch-1.md](plan-batch-1.md).

### Measured

All numbers come from a shared, heavily loaded 4-core ARM host with a SwiftShader software GPU,
and measure draw *submission*, not photons.

| What | Result | Source |
|---|---|---|
| **Last keystroke → first draw**, full app, fake inference | **331 ms median, 490 ms p95** on final `main` (all 15 e2e checks pass); DuckDB's first batch is 321 ms of it, everything else ~10 ms. Earlier merge run: 372 / 467 ms | [e2e-main-final-2026-10-11.json](batch-1/e2e-main-final-2026-10-11.json), [e2e-main-2026-10-11.json](batch-1/e2e-main-2026-10-11.json) |
| Same, earlier run | 392 / 741 ms. With realistic SQL, 12/12 final keystrokes were dedups: the chart was already on screen before the last key | [render-calendar.md](batch-1/render-calendar.md) |
| Inference, Gemini 2.5 Flash Lite via Rust server | first SQL delta 348–411 ms p50, SQL 451 ms p50; ~$0.0001 per translation | [inference.md](batch-1/inference.md), [evals.md](batch-1/evals.md) |
| NL→SQL correctness, executed results, 45 questions | 2.5 Flash Lite **71 %** (prompt v3; was 49 %); 3.1 Flash Lite 87–89 % at 2.7× the cost and ~130 ms slower | [evals.md](batch-1/evals.md) |
| DuckDB-Wasm 60k-row aggregate, warm | first batch ~100 ms on a quiet host, 240–440 ms loaded | [engine.md](batch-1/engine.md) |
| ClickHouse remote, same query | first batch 128–219 ms loaded; Chromium's WebSocket receive (~25 MB/s) caps big results | [remote-database.md](batch-1/remote-database.md) |
| Coordinator per keystroke | 0.5 µs median in Wasm | [coordinator.md](batch-1/coordinator.md) |
| UI per keystroke | ~8 µs our code; ~115 µs median including `postMessage` | [ui.md](batch-1/ui.md) |
| Renderer, first batch → draw submitted | 1–6 ms per view; whole chart 4–9× faster than the old Canvas2D path | [render.md](batch-1/render.md) |

**Where the time went after batch 1:** inference (~450 ms) and the database (~100–400 ms);
everything else ~10 ms. Batch 2 cut the database to a few ms for most queries (below).

### Known gaps

- Hardware GPU numbers come from one owner run (below); every other render and end-to-end number is software-GPU.
- **NL→SQL:** the default model still returns raw rows on ~7/45 questions. Repair on the database's
  `result_limit` error is not wired: it needs that error to reach inference.
- **Renderer:**
  - one WebGL2 context per card (Chromium keeps ~16);
  - no device-loss recovery;
  - no line thinning for multi-million-point series;
  - no lat/lon tick labels.

## Batch 2 so far (merged on `main`)

Details: [batch-2/database.md](batch-2/database.md), [batch-2/inference.md](batch-2/inference.md),
plan: [plan-batch-2.md](plan-batch-2.md).

- **Database first batch: 24.5 → 4.7 ms median (p95 158.9 → 24.1 ms)** over 281 statements, Node,
  same DuckDB-Wasm build. The wins: compressed in-memory storage; background minute/hour/day rollups
  with an exact rewrite via DuckDB's own parser (narrow, provably exact shapes; anything else runs
  raw); a bounded result cache. Exactness: 308 statements give identical results on both paths.
  Threads lost: the blocking API has no threaded build.
- **Last keystroke → first draw, full app, fake inference: 106.7 → 39.2 ms median
  (p95 163.6 → 64.5 ms)** on a quiet host, same run. Not comparable with the loaded-host batch-1 runs.
- **Inference: new server default `openai/gpt-oss-120b` on Groq, reasoning low: 91 % correct**
  (4 runs; Gemini 2.5 Flash Lite 71 %), first SQL delta 256–374 ms p50, ~$0.00016/request; Groq
  caches ~600–750 prompt tokens. The provider matters as much as the model (same model 76–91 %).
  A raw-row pre-check in the server lifts Gemini 2.5 Flash Lite to 78 %.
- **Prefix replay:** at 90 % of a question typed, 28/45 translations already give the final result,
  but only 8 are byte-identical SQL. The coordinator dedups on exact SQL; a result-level "keep the
  chart steady" check in the renderer would turn more of these into zero-latency answers.
- DONE now says whether a result came from a rollup or the result cache (flags in protocol-v1).
- **The chart is a query** ([batch-2/manipulation.md](batch-2/manipulation.md)). Brushing an x range,
  clicking a series, bar or map point, and going back all rewrite the SQL deterministically with
  DuckDB's own parser, with no model call. Brushing refines buckets; a new `QUERY` frame sends the
  rewritten SQL through the coordinator. Pointer → first draw: brush 38 ms, series click 28 ms,
  back 2.3 ms p50 (software GPU). Exactness: 101 statements × 246 filters, identical to filtering
  the original result.
- **Steady charts while typing:** when a new result's data equals what is on screen, the renderer
  keeps the image (277 of 293 per-keystroke results with alias/case/layout variants of the SQL);
  about 1.3 GPU redraws per typed question instead of about 25.
- **Next-question chips** ([batch-2/voice-anticipation.md](batch-2/voice-anticipation.md)): after
  a result settles, up to 4 follow-ups are derived from its SQL without a model (split by a column,
  bucket, window, aggregate, view) and pre-run in the background (`PRIME` + `EXEC` `WARM`). A chip
  click draws in **9.8 ms p50** from the result cache. 2177/2177 generated follow-ups execute, at
  $0 extra.
- **Voice:** push-to-talk; interim transcripts drive DRAFT frames like typing, the final transcript
  commits. It is not measured with a real microphone (headless Chromium has no speech service).


## Batch 3 (merged)

Plan: [plan-batch-3.md](plan-batch-3.md). **Direction (owner, 2026-10-11): bring the project to a
finished, polished state soon. Hosted API inference is fine; no work on local inference or on
hosted-inference latency.**

- **Cold start** ([batch-3/cold-start.md](batch-3/cold-start.md)). Medians on the loaded dev host,
  8 alternating boots each:

  | ms, median / p95 | before | after |
  |---|---|---|
  | First visit → first question answerable | 11 906 / 16 593 | 7 517 / 9 734 |
  | Repeat visit → answerable | 12 577 / 18 527 | 4 464 / 6 822 |
  | First question after boot, keystroke → first draw | 497 / 748 | 91 / 211 |
  | Rollups ready (first visit) | ~28 000 | ready with the dataset |

  How: a prebuilt `vessels.duckdb` (tables, statistics, rollups) attached read-only and read on
  demand, cached across visits with the Cache API; the worker and DuckDB compile start before the
  UI is built; Parquet loads only when needed; warm-up queries after the deferred lockdown.
  Correctness: 308/308 identical results prebuilt and from Parquet. **The floor is DuckDB-Wasm
  itself:** compiling and instantiating its 34 MB engine costs 3–4 s here on every visit, because
  Chrome's code cache doesn't keep it. Not an order of magnitude yet; real hardware still unmeasured.
- **Generality** ([batch-3/generality.md](batch-3/generality.md)): three real public datasets with
  no dataset-specific code: `weather` (Open-Meteo, hourly, 12 cities), `flights` (US DOT, June 2024,
  3 tables, JOINs), `cities` (GeoNames, no time column). Executed-result scores, default model,
  mean of 4 runs: **vessels 89–91 %, weather 88 %, flights 85 %, cities 77 %** (prompt v6: the
  dataset's own time column, qualified shared columns). Eval spend $0.37.
- **Perf regression harness:** `pnpm perf` runs e2e, gesture, chip, boot, database and micro
  benches, appends p50/p95 per stage to [perf/history.jsonl](perf/history.jsonl) keyed by commit,
  checks [budgets](perf/budgets.json) (`--check` fails loudly) and feeds a dashboard
  ([perf/index.html](perf/index.html)). Notes: [batch-3/measurement.md](batch-3/measurement.md).
- **Real-hardware page:** `/measure.html` runs the real pipeline with an in-page fake inference
  node and reports keystroke → GPU-presented frame, boot stages, GPU adapter and network RTT. Its
  JSON goes into the history with `pnpm perf --ingest`. Samples taken while the tab was hidden
  are now discarded and retried (a hidden tab throttles timers to 1/s and stops frames).
- **First real-hardware run** (owner, Apple M5, macOS 26.6, Chrome 154, WebGPU on Metal, 60 Hz,
  public deploy, fake in-page inference; [raw](perf/hardware/m5-chrome154-2026-10-11-raw.json)):

  | What | median | max |
  |---|---|---|
  | Boot → answerable (repeat visit, cached) | 428 ms | — |
  | Keystroke → draw submitted, new data each question (n=12) | 12.4 ms | 31.7 ms |
  | Keystroke → GPU done, same | 14.3 ms | 34.0 ms |
  | Keystroke → next frame, same data kept on screen (n=16) | 16.9 ms | 28.5 ms |
  | First question after boot | 9.5 ms | — |
  | WebSocket connect / HELLO→READY to the server | 66 / 18 ms | 75 / 19 ms |

  Software GPU on the dev host: 63 ms keystroke → draw, 4.5–6.7 s boot. So on real hardware our
  whole pipeline is about one frame, and the DuckDB-Wasm boot floor seen here is a slow-host
  artifact. Inference (~300–600 ms) is now essentially the entire loop. Keystroke → frame for new
  data was invalidated in this run (tab hidden) and needs a rerun; one run, n=12, no p95 claims.
- **Cleanup and fixes:** the legacy Canvas2D chart is deleted; a disposed database node could
  cancel another connection's query through a reused connection id (flaky test, fixed).

## Next

Owner: open `/measure.html` on real hardware and ingest its JSON (`pnpm perf --ingest`). Then
polish: self-host the DuckDB extensions (one unexplained failed dataset load after deploy), repair
on database errors (the error goes back to the model for one retry), and renderer robustness (one
GPU device for all cards, device-loss recovery, line thinning).

## Deployed

Since 2026-10-11 (afternoon) the demo runs `main` with batches 1–3: tb1 server with
`openai/gpt-oss-120b` on Groq (prompt v6), $3/day cap, per-keystroke rate limits, cross-origin
isolated page, prebuilt `vessels` database, all five datasets selectable in settings, and
`/measure.html`. Public check: last keystroke → first draw 533–1013 ms with real inference across
four datasets; boot to ready 5–8 s first visit, 4.5 s repeat. Details, hashes and rollback copies:
[deploy/README.md](../deploy/README.md). The old prototype's documentation is historical:
[prototype.md](prototype.md), [backend-prototype.md](backend-prototype.md).

Operational debt: no user authentication; the budget counters are process-local and reset on
restart; no ClickHouse node is public (it would need a dedicated read-only user).

## Documentation map

Full map with current/historical classification: [README.md](README.md).
