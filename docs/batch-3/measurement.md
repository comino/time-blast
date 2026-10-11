# Batch 3 · measurement discipline

Status: implemented and seeded (2026-10-11). Workstreams 4 and 5 of [plan-batch-3.md](../plan-batch-3.md).
Owner: measurement agent.

Two tools:

- **`pnpm perf`**: a regression harness. It appends one record per run to
  [perf/history.jsonl](../perf/history.jsonl), [perf/index.html](../perf/index.html) plots the history,
  and `--check` fails when a metric grows beyond [perf/budgets.json](../perf/budgets.json).
  Usage and record format are in [perf/README.md](../perf/README.md).
- **`/measure.html`**: a page the owner opens on their own machine. It measures the real pipeline
  on the real GPU and exports JSON, which `pnpm perf --ingest` adds to the same history.

## Harness: seed runs of `main`

Three default runs. The app code is identical to `main` b574034; the commits only add the harness.
The host is this shared 4-core Neoverse-N1 under heavy load from other agents, with SwiftShader and
Chromium 145 on a production build (`vite preview`). Numbers are medians, with the 95 % bootstrap
band in brackets.

| Metric | run 1 (load 22.6→26.6) | run 2 (26.6→27.8) | run 3 (27.8→30.8) |
|---|---:|---:|---:|
| `e2e.keystroke_to_draw` (n 10) | 88 [62–119] | 83 [65–139] | 100 [75–111] |
| `e2e.chip_to_draw` | 30 | 21 | 33 |
| `e2e.gesture_brush_to_draw` | 154 | 126 | 101 |
| `e2e.gesture_legend_to_draw` | 159 | 121 | 123 |
| `e2e.gesture_back_to_draw` (n 20) | 11.4 | 8.0 | 12.5 |
| `e2e.redraw_keystroke_to_draw` | 15 | 10 | 17 |
| `e2e.redraw_keystroke_to_presented` (SwiftShader GPU done) | 989 | 711 | 718 |
| `e2e.first_query_after_boot` (n 2) | 445 | 1328 | 796 |
| `boot.first_visit.answerable` (n 2) | 14 036 | 33 446 | 15 699 |
| `boot.repeat_visit.answerable` (n 2) | 16 169 | 23 738 | 17 476 |
| `db.first_batch` (112 statements) | 7.3 | 14.0 | 17.6 |
| `db.open` / `db.rollup_build` | 3573 / 4711 | 6392 / 13 371 | 7518 / 6988 |
| `micro.coordinator_input_latest` µs | 0.49 | 0.78 | 0.50 |
| `micro.coordinator_input_restart` µs | 4.7 | 11.1 | 5.9 |
| `micro.frame_decode_timing` µs | 0.67 | 1.61 | 0.58 |
| `micro.frame_encode_timing` µs | 0.92 | 2.25 | 1.33 |

All values are in ms unless marked µs. Each run takes 4–6 minutes.

What the seed runs show:

- **Load decides the numbers here.** At load 22–31 on 4 cores, the same code moves by up to 2.4×
  between runs (boot, database, micro benches). The e2e medians move least (±20 %), because each
  of their samples is short.
- These e2e numbers are about twice the batch-2 "quiet host" figures (39 ms keystroke → draw). Load
  explains the gap; the code is the same. Compare runs only at similar load. The dashboard and
  `--check` print the load of every run.
- **Boot takes 14–33 s here, and a repeat visit is no faster than a first visit.** DuckDB has to
  generate the dataset and build its rollups again on every load (`database ready` is 12–16 s of
  it). This is the cold-start workstream's target.
- On SwiftShader, `redraw_keystroke_to_presented` (WebGPU `onSubmittedWorkDone`) comes 0.7–1 s
  after submission, while submission itself takes 10–17 ms. Software rasterization of a queue of
  frames is the cost, not our pipeline. A real GPU is needed to know the true figure (below).

## Budgets: how they were chosen

A regression has to clear all three conditions:

1. the median grows by more than the **relative** budget;
2. it also grows by more than the **absolute** budget;
3. the run's 95 % band lies entirely above the band of the baseline, which is the median of the
   last three comparable runs.

Budgets sit above the largest run-to-run change of each median seen in the seeds. Rounded:

| Metric | relative | absolute |
|---|---:|---:|
| `e2e.keystroke_to_draw` | +60 % (p95: +200 %) | 25 ms (p95: 300 ms) |
| `e2e.gesture_brush/legend_to_draw` | +75 % | 40 ms |
| `e2e.chip_to_draw` | +100 % | 20 ms |
| `e2e.gesture_back_to_draw` | +100 % | 15 ms |
| `e2e.redraw_keystroke_to_draw` | +100 % | 20 ms |
| `e2e.redraw_keystroke_to_presented` | +150 % | 800 ms |
| `e2e.first_query_after_boot` | +150 % | 500 ms |
| `boot.*` (answerable 5000 ms) | +100 % | 1000 ms |
| `db.first_batch` | +100 % (p95: +200 %) | 5 ms (p95: 50 ms) |
| `db.open`, `db.rollup_build` | +150 % | 3000 / 5000 ms |
| `micro.*` (restart: 5 µs) | +150 % | 1 µs |

`pnpm perf --compare` checks run 3 against runs 1–2 and reports no regression. On this loaded host,
the budgets catch a doubling, not a 10 % slip. A quiet host, or `--repeat 3`, narrows the bands.
Tighten the budgets from a longer history, not by feel. The unit test (`tests/perf-lib.test.ts`)
checks each case: inside the noise passes, a regression separated from the baseline fails, other
hosts and GPUs are never compared, and a missing metric fails.

## The hardware page

`/measure.html` is part of the production build (`vite.config.ts` gains only
`build.rollupOptions.input.measure`), so it deploys with the app. It runs:

- the **real engine**: `src/measure/engine.worker.ts` builds the same `EngineHost` with the same
  coordinator, DuckDB and renderer factories as `src/engine/engine.worker.ts`. The renderer
  draws on this machine's GPU.
- the app's own **`UiController`**. Slots are plain 640×360 canvases. The app shell, board and
  next-question chips are not mounted.
- **inference**: an in-page fake tb1 node (`src/measure/fake-inference.worker.ts`) on its own
  worker over a MessagePort, the same placement as WebLLM. It uses the canned table of
  `tests/fake_inference.py` and waits a configurable delay (0 ms by default). The engine selects
  it with the endpoint `fake:?latency=<ms>&mode=<plain|echo|vary>`. The optional **live** pass
  uses the real server over WebSocket.

No login and no backend change. URL parameters: `auto=1`, `reps=4`, `cadence=70`, `latency=0`,
`passes=echo,vary[,live]`, `endpoint=wss://…` (default: the build's `VITE_INFERENCE_ENDPOINT`), `rtt=5`.

### Sequence

1. Boot. Right after it, the first question is typed cold.
2. Press Start (or use `auto=1`). The page reads the hardware and samples the refresh rate for 1.2 s.
3. RTT: a fresh WebSocket per sample.
4. One typing pass per mode: 3 questions × reps, typed with synthetic `InputEvent`s every 70 ms.
5. A summary is shown on screen, and **Download JSON** saves the report.

There are two fake-inference modes:

- **echo** appends the question as an SQL comment. Every keystroke runs the pipeline, but the data
  equals the image on screen, so the renderer keeps that image (a *steady* adoption) and no new
  frame exists. This mode is comparable with the harness.
- **vary** moves the time window 7 min per character (the per-vessel bar uses avg). Every
  keystroke, including the last, changes the data. **The presented-frame numbers come from vary.**

### What each timestamp means

| Name | Meaning | Limits |
|---|---|---|
| keystroke (`KEY_INPUT`) | `timeStamp` of the synthetic input event | Excludes keyboard, OS and browser input latency |
| draw submitted (`FIRST_DRAW_SUBMITTED`) | The renderer returned from `queue.submit` (WebGPU) or the last GL call of the result's first frame, in the engine worker | CPU side only; the GPU may not have started |
| GPU work done (`FIRST_PRESENTED`) | `queue.onSubmittedWorkDone()` resolved in the worker (WebGL2: the worker's next animation frame) | Observed one worker task late. "Presented" in the protocol name is aspirational |
| next animation frame | First main-thread `requestAnimationFrame` timestamp (vsync-aligned frame begin) at or after GPU done, from a continuous rAF loop | Lower bound for the compositor frame that shows the image, accurate to about one refresh interval |
| on glass | Not measured | At least one more refresh interval after that frame: scan-out and panel latency need a camera or photodiode. `requestVideoFrameCallback` covers `<video>`, not canvases |
| steady | Same data as the image on screen: submitted = presented, stamped when identity is proven | No frame time exists |
| boot stages | `performance.now()` from navigation start when the main thread sees each STATUS ready frame and CONTEXT. *Answerable* = coordinator, renderer and inference ready plus CONTEXT | The page's own bundle, not the app shell. One sample per load; reload for more |
| RTT | connect = `new WebSocket` → `open` (DNS, TCP, TLS, upgrade); HELLO→READY = one tb1 round trip | A fresh socket each time |
| hardware | WebGPU `adapter.info` (vendor, architecture, device, description, fallback), WebGL `UNMASKED_RENDERER`, the engine's renderer STATUS, UA client hints, `hardwareConcurrency`, `deviceMemory` (capped by the browser), DPR, refresh rate = median rAF interval | A browser may round or hide some of these values |

### Headless check (SwiftShader, labelled software)

`python3 tests/measure_page.py --url <server>`: 16 checks pass on the production build. The run
uses 2 reps and points the RTT probe and the live pass at `tests/fake_inference.py`. The report
is in the history as a `hardware`-source record with GPU `swiftshader` (a software GPU, not a
hardware result):

| Metric | median (n) |
|---|---:|
| boot answerable | 14 481 ms (1) |
| first question after boot | 596 ms (1) |
| echo: last keystroke → draw submitted | 38.7 ms (6) |
| vary: last keystroke → draw submitted | 23.5 ms (6) |
| vary: last keystroke → GPU done / next frame | 506 / 507 ms (5) |
| vary: any keystroke that changed the image → next frame | 46.8 ms (31) |
| WebSocket connect / HELLO→READY (localhost) | 10.8 / 4.8 ms (3) |

The pass that redraws on every keystroke queues frames faster than SwiftShader can rasterize them,
so the final keystroke's GPU-done time grows to 0.5–2.8 s. Isolated redraws take about 47 ms.
These are not GPU numbers.

## Hooks and contracts

- **No engine, UI or renderer code changed.** The harness reads TIMING breakdowns by wrapping
  `controller.rail.timing` on the page, so they come from the app's own `breakdown()`. Boot stages
  come from wrapping `Worker` in an init script. Both work on the production bundle.
- `src/measure/engine.worker.ts` duplicates the six lines that build `EngineHost` in
  `src/engine/engine.worker.ts`. That module builds its host at import, so it cannot be imported.
  **Keep the two in sync.** If the cold-start work changes engine construction, the measure
  worker must follow. A tiny shared `createEngineHost(connectInference)` export in
  `src/engine/` would remove the duplicate (a contract change; not made here).
- `src/measure/canned.ts` duplicates the canned SQL of `tests/fake_inference.py`.

## Known gaps

- **One real-GPU run so far** (owner, Apple M5, 2026-10-11; results in [status.md](../status.md),
  files in [perf/hardware/](../perf/hardware/)). Its vary-pass frame metrics were throttled by a
  hidden tab (1 s staircase up to 30.7 s) and were removed at ingest; the page now discards and
  retries samples that overlap a hidden tab, and notes it in the report.
- The report has no commit. Ingest assumes the checkout HEAD and adds a note.
- The measure page boots its own bundle, not the app shell, so it does not capture the app's boot
  exactly. The harness's `boot.*` metrics measure the real app.
- Typing uses synthetic events; real input latency is not included. The frame time is a lower
  bound (±1 frame); photons are not measured.
- On this host, the bands are wide; budgets detect about a 2× regression. The suite still needs
  a dataset other than vessels (generality workstream) and the cold-start boot bench numbers
  once that work lands; both slot into `scripts/perf/e2e.py`.
- The live pass and `--with-eval` cost money and were not run against the real server here.
  `--with-eval` is wired to the eval runner but has not been run end to end.
- The 3 seed records have `db.cache_hit` n = 1 (an LRU-eviction bug in the first version of the
  step, since fixed); later runs have n ≈ 112.
