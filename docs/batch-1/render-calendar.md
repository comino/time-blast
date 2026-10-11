# Batch 1 · render-calendar: the seasons view and the first end-to-end number

Status: implemented and measured 2026-10-10. Code: `crates/tb-render/src/view/calendar.rs`.

## Seasons (seasonal wheel)

A view family on the Rust/Wasm render core. It applies when x is a time column and there is a
value. Its rank is 90 (line/bar/scatter are 10–12), so it is listed whenever it applies and
is never the automatic choice. A `-- view: seasons` hint or the view picker selects it.

- **Angle** is the position in a calendar cycle, starting at 12 o'clock and running clockwise.
  **Radius** is the cycle index: one concentric ring per day, ISO week or year, oldest
  innermost. **Colour** is the value on a sequential colormap (blue → teal → green → yellow
  → orange, lightness increasing). The colour domain and ring range are uniforms, so
  streaming rows that widen them change no geometry.
- **Cycle choice** depends on span and bucket (min positive gap within a series):
  - 24 h clock: span < 2 d and buckets < 6 h.
  - Weekly wheel: span < 60 d and buckets ≤ 1 d. Weeks start Monday 00:00 UTC.
  - Yearly wheel: everything else.

  The cycle only widens as batches stream. A change re-places every stored row, which
  happens at most twice per result. Consequence: 14 days of minute data first shows a 24 h
  clock from batch 1 (2,048 rows ≈ 34 h), then switches to the weekly wheel on batch 2.
- **Calendar math** is exact integer UTC on i64 µs: `Cycle::locate`, plus Hinnant's civil
  conversion for years and leap years. A per-cycle cache means a row costs one subtraction
  and one division. Only the in-cycle fraction becomes f32. Ring indices are relative to the
  first cycle seen. Values are relative to the first value.
- **Honest emptiness.** Nothing is aggregated or interpolated. Each returned (time, value)
  row is one annular cell, its width the bucket size. Null values and null times draw
  nothing. Each ring has a faint full track, so dates missing from the result read as
  empty. The caption names the cycle and the span actually covered ("… · 14 d of data,
  empty = not in result"), so short data doesn't look like an annual pattern.
- **Series → small multiples.** Each series gets its own wheel, laid out in whichever grid
  gives the largest radius, with a shared colour domain and ring range. The cap is 12
  wheels; the caption names how many series were left out. Ring offsets were rejected
  because they would give the radius two meanings at once.
- **GPU:** `calendar.cell` draws each instance (`[fraction, ring, value]`, 12 B) as one
  triangle-strip annular sector. Segments are chosen so the arc error stays under ~1 px,
  with a minimum width (1 px, or 3 px while the bucket is unknown) so a single row is
  visible. One instanced draw per wheel covers all cells, another covers tracks, another
  the spokes (months / weekdays / 3 h). `calendar.ramp` draws the colour legend with no
  vertex buffer. WGSL and GLSL ES 3.00 share the colormap stops.
- **First point on the first batch:** `points()` is non-zero after the first valid row
  (unit test plus the "one row" browser case).

### Changes outside `view/calendar.rs` (all backward compatible)

| File | Change |
|---|---|
| `view/mod.rs` | `pub mod calendar;`, the `FAMILIES` entry, and a default no-op `Family::decorate(&self, view, store, &mut AxesOut)` for free-positioned labels; the test's expected view list now includes `seasons` |
| `axes.rs` | `AxesOut.labels: Vec<(x, y, text, anchor)>`; `to_json` emits `"labels"` only when non-empty |
| `renderer.rs` | calls `decorate` after `layout`; a table view now posts an empty AXES (`NO_AXES`) so the previous chart's DOM labels disappear (bug found by the e2e test); test expectations include `seasons` |
| `src/engine/contracts.ts` | optional `AxisTicks.labels?: {x, y, label, anchor}[]` (shared contract: **coordinator to ratify**) |
| `src/ui/slot-card.ts` | draws `labels` as `.axis-free` spans (8 lines) |
| `tests/render-node.test.ts` | expected view lists include `seasons` |

Families that build `AxesOut` with a struct literal must add `labels: Vec::new()`. `layout()`
already does.

### Verified

- `cargo test -p tb-render`: 53 tests. Calendar tests cover leap years (1600, 2000, 2024 vs
  2023, 2100), Feb 29 and Mar 1 fractions, pre-1970 flooring, year 9999 at µs resolution,
  Monday-based weeks, month sections in leap years, cycle choice, applicability and rank,
  null handling, streaming re-placement, small multiples and the series cap, the draw
  stream (20,160 instances in one draw) and labels.
- `tests/render_calendar.py` with `tests/render-calendar.html` drives the real RendererNode on
  WebGPU and WebGL2 (SwiftShader). Four cases (weekly 20,160 rows, yearly with 2 series,
  24 h clock, one row) must have non-empty pixels, the right caption and FIRST_DRAW_SUBMITTED.
  Both backends pass.

### First-draw cost, 14 d × 1 min (20,160 rows, 2,048-row batches)

Chromium 145.0.7632.0 headless, **SwiftShader software GPU**, shared ARM64 host at load average
~33 on 4 cores. Warm, 9 reps; values are median / p95 in ms. Draw submission, not photons.

| | WebGPU | WebGL2 |
|---|---|---|
| first BATCH → FIRST_DRAW_SUBMITTED | 5.5 / 8.9 | 6.1 / 14.2 |
| of which ingest (copy + Rust) | 0.15 / 3.8 | 0.14 / 0.45 |
| of which frame build (Rust) | 0.07 / 0.35 | 0.10 / 6.3 |
| of which replay + submit (JS shim) | 4.0 / 8.4 | 2.1 / 13.9 |
| all 10 batches + final frame (CPU) | 25 / 57 | 21 / 35 |
| until GPU done (`onSubmittedWorkDone` / finish) | 8,842 / 24,429 | 44 / 73 |

On a quieter run (load ~25, 5 reps), first BATCH → FIRST_DRAW_SUBMITTED was 0.6–1.9 ms median.
The Rust parts stay ~0.2 ms; the spread is host contention. Software WebGPU takes seconds to
finish a frame, and so does the **line** view with the same data (8.2 s, same page,
`?view=line`), so that cost belongs to SwiftShader-Vulkan on this host, not to the seasons
view. It says nothing about hardware GPUs.

## End to end with a fake inference node

`tests/fake_inference.py` is a `tb1` WebSocket server in the Python standard library
(RFC 6455 handshake and framing). It sends READY for HELLO and stores CONTEXT. For INFER it
returns keyword-picked canned SQL as 2× SQL_DELTA → SQL → INFER_STATS (cost 0), echoing
epoch/request/revision/context and stamping INFER_RECEIVED, SQL_FIRST_DELTA and SQL_COMPLETE.
`tests/e2e_fake_inference.py` loads the real app (`index.html` → `app.ts` → engine worker with
coordinator, DuckDB-Wasm and renderer). It sets the inference placement to the fake through
localStorage, types with Playwright at 70 ms per key, and asserts the following. All pass:

- a chart draws without Enter (non-empty canvas pixels)
- TIMING carries KEY_INPUT through FIRST_DRAW_SUBMITTED (stages 1–16, plus 17 when presented)
- a changed question rebinds the live card (new request; the SQL shown changes)
- Enter keeps the card
- the view picker offers line/bar/scatter/seasons/table, each chart view draws a different
  image, table clears the canvas, and seasons puts its labels in the DOM
- no ERROR frames

### Last keystroke → first draw (our pipeline only)

Same environment: SwiftShader WebGPU, load ~25–34. Dataset: the 1.2 M-row `vessels` fixture
in DuckDB-Wasm. 12 samples rotating over three questions: hourly avg speed by vessel (line,
6 series), 10-minute wind (line), and max speed per vessel (bar). In **echo mode** every
keystroke produces new SQL, so the final keystroke runs the whole pipeline:

| Stage delta (ms) | median | p95 |
|---|---|---|
| key → draft sent (UI) | 0.23 | 2.1 |
| → coordinator | 1.5 | 12.2 |
| → inference received (WebSocket, localhost) | 2.4 | 7.6 |
| → SQL complete (fake, no model) | 0.1 | 0.2 |
| → SQL received (coordinator) | 3.6 | 8.7 |
| → exec received (database) | 0.09 | 0.13 |
| → **DB first batch (DuckDB query)** | **383** | **698** |
| DB first batch → first draw submitted | ≈1.7 | ≈8 |
| **key → first draw submitted** | **392** | **741** |

DuckDB execution over 1.2 M rows dominates: ~98% of the median. Everything else takes
~10 ms, including the renderer's ~1.7 ms. FIRST_PRESENTED did not arrive in the echo
samples' TIMING; it is best effort.

With realistic canned SQL (the answer is fixed once a keyword is typed), **12 of 12** final
keystrokes were SQL dedups. The correct chart was already on screen before the last key, so
thought → result for the final keystroke was ≤ 0. This is the per-keystroke loop working as
the vision intends.

Reproduce: `pnpm exec vite --port 5199 --strictPort`, then
`python3 tests/e2e_fake_inference.py --url http://localhost:5199 --software --samples 12`.

## Integration findings

1. **Fixed:** table view left the previous chart's DOM axis labels on the card.
   `renderer.rs` now posts an empty AXES for views without a chart.
2. **Not fixed (engine):** the rail shows *Inference: Starting* and *Coordinator: Starting*
   indefinitely with remote inference. `src/engine/host.ts` only sends `statusToUi` for
   errors (lines 121, 230); nothing reports `ready`. Suggested fix: in `connect()`'s listener
   (`host.ts:217`), call `this.statusToUi('inference', 'ready', 'Remote inference')` on
   `Kind.READY`, and do the same for the coordinator once it is booted.
3. **Harness:** on a cold Vite cache, the dev server reloads the page once while optimizing
   dependencies. The e2e test installs its hook after the dataset context arrives.

## Known gaps

- The cycle choice can switch once mid-stream (24 h clock → weekly) for minute data, because
  the first batch can't know the final span. A span hint from the database (min/max of x)
  would remove it.
- Cell width uses the latest cycle's length, so yearly cells are 1/365 or 1/366 wide. That
  is a 0.3% width difference; positions are exact.
- Ring labels on dense rings are thinned to about 11 px apart and can overlap cells. There
  are no tooltips yet.
- The WebLLM placement and latency-dial end-to-end runs are not covered here. The fake runs
  only over the remote WebSocket placement.
