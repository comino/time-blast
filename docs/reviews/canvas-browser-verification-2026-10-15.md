# Persistent canvas browser verification

Initial verification on 2026-10-15 in Chromium **145.0.7632.0**, headless, WebGL2/SwiftShader,
against the production bundle on `http://127.0.0.1:5395`. The coordinator and
renderer used their real Wasm; data execution used real DuckDB-Wasm. Only
inference was scripted, over a real local `tb1` WebSocket connection. No provider
calls were made; cost was **$0**.

The tested working tree is based on `c4341b1b9f94b58180f061a82a85f0d493b522d5`.
It was not committed at measurement time. Exact entry, CSS, dependency and Wasm
SHA256 hashes are in [the raw hydration ledger](canvas-hydration-2026-10-15.json).
The application entry was `assets/main-BGpvl4gU.js`, SHA256
`d752e80bf450483cef4a22b3fdbe5311febc2a7281e1889ad46d7b082affabe7`.

## Initial functional results

[`tests/canvas_smoke.py`](../../tests/canvas_smoke.py) passed all eight application
flows, plus a real drag and layout reload assertion:

1. Type a question, press Enter, and save the original question, exact SQL and
   Auto presentation after successful execution.
2. Reload the same canvas and revision, execute its saved SQL, and issue no new
   inference request. A dragged card keeps its saved position without creating
   a new chart revision.
3. Refine a saved chart. `EDIT_CONTEXT` contains the original question, current
   SQL, presentation and lineage; `EDIT_INFER` carries the new change. The
   resulting SQL checkpoints into the same chart.
4. Select Surface, change rotation, select Auto, undo, redo and restore the first
   chart revision. Restoring Auto with an empty parameter map resets rotation
   to the renderer default of −30; it does not retain the later rotation.
5. Export and import the canvas, preserving every revision and canvas commit,
   including branches. Result rows are absent from revision records.
6. Reload with an unfinished refinement, recover it without inference on load,
   resume it, and checkpoint the next successful change.
7. Edit exact SQL without inference, then refine it with that edited SQL as the
   base. An explicit inferred Surface hint updates and persists manual intent.
8. Keep a fixture chart and a local CSV chart in one canvas. After reload, the
   fixture hydrates while the file chart retains its definition and requests
   reattachment. Reattaching identical bytes under a different filename restores
   the original logical table name and result, without inference or changing
   the fixture chart's revision.

The run made **7 scripted inference calls**, with **0 page errors and 0 console
errors**. The screenshot at `/tmp/timeblast-persistent-canvas.png` was visually
inspected: the retained Surface chart and reattached CSV bars both render.
Screenshot capture waits for the resize/worker redraw after Fit.

The browser smoke found a genuine first-refinement sequence mismatch: beginning
an empty editor did not seed the encoder to the document's next wire revision.
It was fixed, then the full flows above passed repeatedly. No further blockers
were found in these tested flows.

## Initial bounded hydration

[`tests/canvas_hydration_measure.py`](../../tests/canvas_hydration_measure.py)
seeds real model/session/IndexedDB records, then reloads the application. Each
chart has five revisions. Every reload creates fresh engine workers and loads
the 1,209,600-row vessel fixture; browser HTTP/module caches are warm. The
machine is shared, and rendering uses a software GPU. These are **individual
observations**, not p95/p99 measurements or performance guarantees.

Initial recorded observation, in milliseconds:

| Charts | JSON bytes | Metadata visible | First execution terminal | All initial terminals | Register → all terminals | Resident / hydrated |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 9,867 | 133.3 | 2,226.7 | 2,226.7 | 121.2 | 1 / 1 |
| 10 | 123,755 | 181.7 | 2,225.9 | 4,052.8 | 1,930.5 | 8 / 8 |
| 100 | 4,626,184 | 873.1 | 2,665.2 | 4,717.1 | 2,154.2 | 8 / 8 |

Metadata, first-terminal and all-terminal times start at navigation. The
register-to-terminal span starts after source activation; it separates query
hydration from initial engine/fixture startup. All 1/10/100 card definitions
exist, while only 1/8/8 requests are resident and have table rows. Inference
calls remain **0**. Both recorded runs, including an earlier slower observation,
are retained in the [raw ledger](canvas-hydration-2026-10-15.json).

The real-Wasm regression in
[`tests/render-node.test.ts`](../../tests/render-node.test.ts) also verifies 100
dormant canvas shells allocate no GPU buffers/surfaces, eight registrations
activate eight surfaces, release frees the target's resources, stale generation
work cannot reactivate it, and a fresh generation can hydrate the same shell.
The renderer suite passed **12/12**. The isolated card/board browser smoke passed
**13 checks**, including slider/playback transaction boundaries, unavailable
manual intent, presentation-only updates, and stale drag/brush/playback fencing.

## Reproduction

```sh
pnpm build
pnpm exec vite preview --host 127.0.0.1 --port 5395 --strictPort
python3 tests/canvas_smoke.py http://127.0.0.1:5395
python3 tests/canvas_hydration_measure.py http://127.0.0.1:5395
pnpm exec vitest run tests/render-node.test.ts
pnpm exec tsc --noEmit
```

The Python scripts need `aiohttp`, Playwright and its Chromium installation.
For the isolated DOM component test, start Vite on 5394 and run
`python3 tests/canvas_card_smoke.py http://127.0.0.1:5394`.

Repeated reloads of the unbundled Vite development application encountered
Chromium `net::ERR_INSUFFICIENT_RESOURCES` while fetching a worker module. This
was not a lost-document failure. Production-preview reloads completed without
that failure. Provider SQL quality and real-GPU/WebGPU performance are outside
this scripted browser check; they require their separate evaluation paths.


## Final production verification, including every definition

The final bundle, including the source lifecycle fix below, passed the complete
`tests/ui_smoke.py` wrapper and the 1/10/100 definition cycle on 2026-10-15.
The entry is `assets/main-Dx2oGuz0.js`, SHA256
`f32f8c38eec21158739a003e8a56b7b32dd7df79bc8891661b8d3a47ce2f3fc0`.
All six entry/dependency/CSS/Wasm hashes were checked against `dist`; the exact
hashes, successful runs, original failure and diagnostic control are retained in
[the final browser ledger](canvas-final-browser-2026-10-15.json). The earlier
measurement ledger above is unchanged.

All eight flows and the layout assertion above passed again. A ninth flow now
clicks a real suggested-question chip while the default new-chart source differs
from the chip's source. It verifies that the new persistent chart has the exact
chip SQL, question and source, the previous two chart revisions remain unchanged,
and the click makes no inference request. After reload and local-file
reattachment, the saved definition and numeric result are unchanged. Global
PRIME mappings remain disabled for the durable controller. This final smoke made
**7 scripted inference calls**, with **0 page errors and 0 console errors**.

The extended hydration check keeps the initial automatic hydration measurement
separate, then uses actual card Refresh buttons to execute each remaining saved
SQL sequentially. Refresh includes the application's current source-reopen
cost. The fixture has 1,209,600 rows; every document has five revisions per
chart. Suggestions retain application-default WARM behavior. Every chart's
selected SQL is distinct, and the harness verifies both its execution and a
successful terminal outcome. It does not imply 100 simultaneous resident results.

Times below are milliseconds from navigation, except the remaining-definition
cycle, which starts after the initial batch has completed:

| Definitions | Metadata visible | First draw submitted | First execution terminal | All initial terminals | Remaining-definition cycle | All definitions terminal | Maximum resident |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 136.1 | 2,350.5 | 2,357.6 | 2,357.6 | 0.0 | 2,357.6 | 1 |
| 10 | 126.0 | 2,293.6 | 2,564.9 | 4,524.6 | 731.9 | 5,329.3 | 8 |
| 100 | 995.2 | 2,853.8 | 2,861.7 | 5,126.4 | 31,538.9 | 36,693.6 | 8 |

The cycle executed **1/10/100 distinct selected SQL statements**, respectively,
with **0 inference calls**. Initial table results were 1/8/8; final residency was
1/8/8 and never exceeded eight during cycling. Serialized document sizes remain
9,867 / 123,755 / 4,626,184 bytes. First draw is the real
`FIRST_DRAW_SUBMITTED` protocol stamp adjusted by the page's time origin, not a
hardware display timestamp. These are single observations on shared hardware
and a software GPU, not latency percentiles or guarantees.

The all-definition extension exposed a real source-reopen failure that the
initial-eight check could not detect: the first subsequent Refresh could fail
with `query was canceled`. Disabling suggestion WARM avoided the failure and
provided a diagnostic control. The database lifecycle review then reproduced
two related races deterministically: an old, unjoined internal warm-up could
cancel a newer source load on the shared load connection, and delayed lockdown
could start a warm-up against the old source while a new open was underway.
The fix joins both roll-up and warm-up tasks before reopening and clears the old
current-source context. Both regressions failed before the fix and passed after
it in `tests/database-lifecycle.test.ts`. The rebuilt default-WARM 10-chart check,
full 1/10/100 cycle and complete wrapper smoke all passed. No unresolved blocker
remains in the browser flows tested here.

Final production reproduction:

```sh
pnpm build
pnpm exec vite preview --host 127.0.0.1 --port 5395 --strictPort
python3 tests/ui_smoke.py http://127.0.0.1:5395
python3 tests/canvas_hydration_measure.py http://127.0.0.1:5395
```

For the focused lifecycle check, set `CANVAS_MEASURE_COUNTS=10` on the hydration
command. The preserved diagnostic control additionally set
`CANVAS_SUGGEST_OPTIONS='{"warm":false}'`; the final acceptance runs use neither
this override nor fake database/renderer implementations.
