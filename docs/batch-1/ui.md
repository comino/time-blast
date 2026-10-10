# Batch 1 · UI (main thread)

Status: wave 1 done, tested against a fake engine. The real engine worker is a stub on this branch.

## What runs where

| File | Role |
|---|---|
| `src/ui/app.ts` | Page entry (`index.html` loads it). DOM glue, worker spawn, the input listener, and the resize observer. |
| `src/ui/draft-encoder.ts` | Hot path. Writes DRAFT, COMMIT, CANCEL and CONFIG straight into a fresh `ArrayBuffer` (header, `KEY_INPUT` and `DRAFT_SENT` stamps, UTF-8 via `encodeInto`). Output is byte-identical to `encode()` (tested). |
| `src/ui/controller.ts` | DOM-free logic: slot pool, BIND/UNBIND/KEEP, routing of engine messages, TIMING history. `ResizeBatcher` sends one resize per slot per frame. |
| `src/ui/timing.ts` | TIMING ledger → per-stage rows, the headline **last keystroke → first draw submitted**, cache-hit flag, and rolling median/p95 over the last 50 requests. |
| `src/ui/slot-card.ts`, `board.ts`, `rail.ts`, `settings-panel.ts`, `app-shell.ts`, `app.css` | DOM chrome. Same look as the prototype; `styles.css` is reused. |
| `src/ui/dataset-drop.ts`, `defaults.ts` | Drag-and-drop or URL → `DatasetSource`; boot defaults and persisted settings. |

### Boot sequence
1. `boot {inference, dataset}`. Inference is `{remote, VITE_INFERENCE_ENDPOINT}` if that is set, otherwise `{webgpu, 'qwen-1.5b'}`. The dataset is fixture `vessels`.
2. `attach` slots 1 and 2. Each canvas goes over as a transfer via `transferControlToOffscreen()`.
3. One CONFIG frame: protocol defaults, any persisted overrides, and `freeSlots: [1, 2]`.

### Slots and cards
- On KEEP, the card is pinned, a new slot is attached, and `CONFIG {freeSlots:[n]}` is sent. The pool always holds two slots.
- Pool cards are created up front, hidden with `visibility:hidden` so the ResizeObserver still reports their size. Their canvases are already in the engine.
- BIND shows the bound pool slot as the live card. Its title is the text of the bound revision (the encoder keeps the last 64 revision texts).
- UNBIND hides the live card and clears its chrome. Kept cards ignore UNBIND.
- Closing a kept card sends `detach`. Closing the live card sends CANCEL and hides it.

## Measured: main-thread cost per keystroke

Method: `tests/ui_smoke.py` runs headless Chromium 145 (Playwright, `--disable-gpu`) against the Vite dev server. COOP/COEP are added by request interception, so `crossOriginIsolated` is true (timer resolution 5 µs). Live query is off during measurement, so the fake engine sends no replies. **The host was heavily loaded** (load average 5–8 on 4 cores, shared with four other agents). Treat the tails as an upper bound and repeat on an idle machine.

| What | Median | p95 | Notes |
|---|---:|---:|---|
| Handler, real typing (input handler entry → `postMessage` returns), 40 keys at 15 ms apart | 115 µs | 0.9–1.2 ms (max 9 ms under load) | 3 runs |
| Same handler, back-to-back synthetic input events (5000) | 15–20 µs | 50–100 µs | worker already awake |
| Whole `dispatchEvent` per synthetic event | 53–79 µs | — | includes Chromium event dispatch |
| Encoder alone (post replaced by a no-op), 100k drafts of ~55 chars | 8 µs | — | our code |
| `worker.postMessage` alone after an idle gap | 60–145 µs | 0.2–2.7 ms | interleaved micro-probe |

Conclusion: our share is about 8 µs per keystroke. The rest is Chromium's cross-thread post, which costs most when the worker is asleep. Transfer and structured clone of a 120-byte buffer were within noise of each other (transfer +15 µs median, inconclusive). A SharedArrayBuffer ring plus `Atomics.notify` measured 105 µs median against 165 µs for transfer in the same interleaved run. That is a candidate for a future UI→engine link, not adopted (see requests).

Other hot-path discipline:
- Nothing on the input path reads layout.
- The revision label and the UI-cost readout update in one `requestAnimationFrame`.
- Per keystroke the path allocates the frame buffer, one message object and one transfer array. No `Frame` objects or `DataView`s.

## Decisions where the spec left room
- **Revisions.** A text change bumps the revision. A composition-flag change alone resends the same revision. Identical events send nothing. COMMIT reuses the drafted revision when the text is unchanged, so the coordinator can KEEP without new work.
- **Enter keeps the text and selects it.** Clearing the box would send a short DRAFT, which per protocol would cancel the committed work. Typing replaces the selection.
- **Epoch.** CANCEL increments it, and every later frame from the UI carries the new value.
- **TIMING origin.** The latest `KEY_INPUT` at or before `FIRST_DRAW_SUBMITTED`. Other stages use their earliest stamp after the origin, otherwise their latest stamp before it (shown as a negative offset, e.g. reused SQL). Headline = first draw − origin.
- **Errors.** An ERROR with a request id that is still bound goes to that card and the rail. All others go to the rail.
- **Settings.** Inference placement, plus coordinator config (`live`, `speculate`, `translationCache`, `inferencePolicy`, `minChars`, `latencyDialMs`), persist in `localStorage['time-blast.ui.v1']`. Datasets do not persist. The latency-dial slider sends at most one CONFIG per frame.
- **Legacy.** The legacy entry (`src/main.ts`) and its UI modules are left untouched: `tests/lifecycle.test.ts` imports `src/main`.

## Requested contract changes (for the coordinating agent)
1. Export `CoordinatorConfig` from `src/engine/contracts.ts`. The UI keeps a local copy in `controller.ts`.
2. Specify the units of `AxisTicks.x[].at` and `y[].at`. **The UI assumes CSS pixels from the canvas's top-left, the same frame as `plot`.**
3. Name the `param` vocabulary. The UI sends `rotation` (degrees, −180..180, surface) and `playback` (0..1, tracks).
4. Fix the STATUS `component` names. The UI shows `database | inference | renderer | coordinator` and maps the aliases `model`, `webllm`, `duckdb` and `render`. Unknown components get their own pill.
5. Define the vocabulary of `{kind:'webgpu', model}`. The UI sends profile ids `qwen-0.5b | qwen-1.5b | qwen3-4b`. The inference node must accept these, or the contract should list the accepted ids.
6. Optional, for measurement: a shared-memory UI→engine link (SAB ring + `Atomics.notify`). It would keep frame semantics and drop `postMessage` from the keystroke path. Adopt only if an idle-machine measurement confirms the gain.

## What the integrator must wire
- `engine.worker.ts` must handle these messages: `boot`, `attach` (it can arrive right after boot, so queue it until the renderer exists), `resize`, `detach`, `view`, `param`, `export`, `dataset`, `inference`, and `frame`.
- It must reply with tb1 frames (STATUS, ERROR, BIND, UNBIND, RESULT, TIMING, KEEP, INFER_STATS) and with the UI messages `context`, `views`, `table`, `axes` and `export`. The UI also accepts a CONTEXT frame in place of `{type:'context'}`.
- Serve the page cross-origin isolated (COOP/COEP in `vite.config.ts` and Caddy). Then the TIMING stamps and the UI cost have 5 µs resolution, not 100 µs.
- Cleanup wave: delete the legacy `src/main.ts`, `tests/lifecycle.test.ts` and the old modules in `src/ui/`: `index.ts`, `shell.ts`, `workspace.ts`, `result-card.ts`, `chart.ts`, the `*-renderer.ts` files, `renderer-*.ts`, `order.ts`, `bar-layout.ts`, `frame-work.ts` and `geo-coastline*`. **Keep `styles.css`** (the new UI imports it). Optionally rename `src/ui/app.ts` → `src/main.ts`.

## Tests
- `tests/ui-draft-encoder.test.ts`: revisions, stamps, COMPOSING, byte-identity with `encode()`, COMMIT, CANCEL epoch, CONFIG, revision-text ring.
- `tests/ui-controller.test.ts` (fake engine in `tests/ui-fake-engine.ts`): boot, attach, CONFIG; keystroke → transferred DRAFT; Enter → COMMIT; BIND/UNBIND visibility; KEEP replenishes the pool; detach; routing of RESULT, views, axes, table and export; TIMING and INFER_STATS; STATUS and ERROR; resize coalescing.
- `tests/ui-timing.test.ts`, `tests/ui-dataset-drop.test.ts`, `tests/ui-defaults.test.ts`.
- `tests/ui_smoke.py`: start `pnpm exec vite --port 5391 --strictPort --host 127.0.0.1`, then run `python3 tests/ui_smoke.py http://127.0.0.1:5391/`. A scripted fake engine (replaces the worker via request interception, draws on the transferred OffscreenCanvas with 2D) covers boot and attach, typed DRAFTs, live card, axes, view picker and surface controls, Enter → KEEP with a replenished pool, the latency-dial CONFIG, CANCEL, and zero console errors. It prints the cost measurements above.

## Known gaps
- No DOM unit tests (there is no jsdom in the repo). The DOM is covered only by the Playwright smoke.
- The mobile layout was not checked this wave.
- Board zoom does not change render resolution. The size sent is CSS px × DPR regardless of zoom.
- Kept cards do not survive a reload.
- A BIND for a revision more than 64 revisions old keeps the previous title.
