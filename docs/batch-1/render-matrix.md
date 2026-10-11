# Batch 1 · render-matrix: heatmap and 3D surface

`crates/tb-render/src/view/matrix.rs` is a new view family on the Rust/Wasm render core. It
draws `heatmap` and `surface` for any result shaped **x (time, category or number) × series ×
value**, following the protocol-v1 result shape convention. Nothing in it is vessel-specific.

## What it draws

**One geometry, two views.** Per series, one f32 buffer of `[x, value]` points relative to
per-result origins (the same layout as `xy`). Heatmap ↔ surface switches never rebuild or
re-upload. A streamed batch uploads only each series' new tail. The x window, the colour/height
domain, row order and the camera are uniforms, so a growing domain never touches geometry.

- **heatmap**: one instanced draw per series row. Each point is a cell spanning one bucket (the
  smallest x gap seen). Time buckets start at their timestamp; numbers and categories are centred.
  Cell edges snap to device pixels, so adjacent buckets meet with no seams and no double blending.
  Colour comes from a viridis 6th-degree polynomial in the fragment shader (no texture), with the
  same polynomial in Rust for the legend. NULL values leave the cell blank, never zero. Rows run
  top to bottom in first-seen order, with series labels on the y axis (one per row while rows are
  taller than a text line). The legend is a colour scale: nice ticks over the value extent, each
  with its viridis colour. Category × category (e.g. weekday × site) works the same way.
- **surface**: one flat ribbon per series lane, at height = value, as instanced segments (the
  buffer bound twice at offsets 0 and 8, as in `xy.line`). A perspective camera (30° elevation)
  rotates about the vertical axis by the `rotation` param, in degrees and clamped to −180..180,
  via `set_param` → redraw. Lighting is one directional light, flat per segment, with series
  palette colours. Floor footprints show each lane's extent and gaps; floor edges and a value-axis
  line are screen-space 3D lines. Lanes never interpolate across series. A NULL, or an x gap wider
  than 1.5 buckets, breaks the ribbon. The camera is fitted to the circumscribed footprint, so
  rotating never zooms.
  - **No depth buffer.** The core has none, and adding one would change every pipeline and the
    shims. Instead the surface uses painter's order: lanes draw back to front for the current
    rotation. When the rotation puts high x farther away (sin θ > 0), each lane draws from a lazily
    built reversed copy of its buffer. The copy is built once on the first such rotation (6
    lanes × 240 points: 28 KB with headroom). The copy fills from the end of its buffer, so
    streaming appends prepend and upload only new points. After that, rotating uploads only
    uniform blocks (measured: 3,840 B for 15 draws).
  - **Axes for 3D.** The 2D path computes x ticks (time/number/category) and value ticks. The new
    `Family::place_axes` hook then projects them: x labels go to the projected position on the
    near floor edge, de-overlapped at 56 px. Value labels go to the projected height of the value
    axis, which stands at the leftmost floor corner. Labels stay in the bottom and left gutters
    because the UI draws them there. The 2D grid is suppressed. The legend lists series in palette
    colours (lane order = legend order, series 0 at the back).

## Choice ranks

| Result | Available (preference order) | Automatic |
|---|---|---|
| time × series × value, ≤ 12 series | line, bar, scatter, heatmap, surface, table | line |
| time/category × series × value, > 12 series in the first drawable batch | heatmap, line, bar, scatter, surface, table | heatmap |
| category × category × value | bar, line, scatter, heatmap, surface, table | bar (heatmap above 12 series) |
| no series column | (no matrix views) | — |

The heatmap's rank is 20 (xy's are 10–12) and the surface's is 40, so the surface is never
automatic. The series count is unknown at RESULT_SCHEMA, so `view::REFINE` runs while the
pending result's first drawable batch arrives (no hint set). It can promote the heatmap **before
the first draw**, so a line chart never flashes and then gets replaced. The new choice goes out as
VIEWS with that frame. Limitation: a result ordered by series first (`ORDER BY series, ts`) can
show only a few series in its first batch and stays a line chart.

## Changes outside `view/matrix.rs`

All of these are backwards compatible; no existing family or literal needs changing.

| File | Change |
|---|---|
| `crates/tb-render/src/view/mod.rs` | `pub mod matrix;`, `&matrix::DEF` in `FAMILIES`; new `Family::place_axes(&self, View, &mut AxesOut) -> bool` (default: keep the layout and draw the grid); new `pub static REFINE: &[fn(&Store, &mut Vec<View>)]` (= `[matrix::refine]`). |
| `crates/tb-render/src/renderer.rs` | `ResultState::select` takes `params` and replays the slot's params (e.g. rotation) into a newly created family, at its two call sites `set_view` and `schema`. `Renderer::batch` runs `REFINE` while a pending result has no drawable point and no hint, reselects, and sets the new private `Slot::views_dirty`. `Renderer::frame` posts VIEWS for `views_dirty` slots (the JS shim drains events only after frames, and `tb_frame` clears events). `frame` also calls `place_axes` after `layout`, clears the grid when it returns false, and guards the axes-repost condition (`grid.id == 0 && grid`). |
| `crates/tb-render/src/axes.rs` | `RGB_FLAG`/`rgb_index`: legend "palette indices" at or above `1 << 24` carry a literal RGB colour (`palette_hex`/`palette_rgba` honour it). `ticks()` gets a `vertical` flag: y-axis category labels thin by line height (16 px) instead of label width (before, every other heatmap row lost its label). |
| `tests/render-node.test.ts` | Expected views for time × series × value now include heatmap and surface. |
| `public/wasm/tb-render.wasm` | Rebuilt (binary conflict expected; the integrator rebuilds). |

## Verification

- `cargo test -p tb-render`: 51 tests, 10 of them new in `matrix.rs`. They cover applicability and
  ranks, refine at 12 versus 13 series, cell geometry and bucket width, category centring, a
  streaming append that uploads only the tail while the colour domain moves in uniforms, the
  camera fitting the plot at every 15° rotation with a constant scale, back-to-front lane order,
  reversed buffers, rotation clamping, projected axes and grid suppression, viridis endpoints and
  monotonic luminance, and a renderer-level automatic heatmap switch with VIEWS + FIRST_DRAW plus
  rotation replay into the next result's family.
- `tests/render-matrix.test.ts` (vitest, real Wasm core, null GPU) covers views and choice, the
  heatmap switch before the single DRAWN, colour-legend posting, and surface rotation redrawing
  11 draws with ≤ 4 KB uploaded.
- `tests/render_matrix.py --software` runs headless Chromium on `tests/render-matrix.html` and
  checks six cases on **WebGPU (SwiftShader) and WebGL2**: hinted heatmap, hinted surface, surface
  rotated 120°, auto with 20 series → heatmap, auto with 6 series → line, and weekday × site
  heatmap. Every case draws (DRAWN) with ≥ 2,000 ink pixels and ≥ 4 colour buckets. The rotated
  surface differs from the default one, and rotation uploads only uniforms. Both backends pass.
- `pnpm test` and `pnpm build` are green.

## Measurements

**Method:** `python3 tests/render_matrix.py --software --bench --reps 3 [--backend …] [--sizes …]`,
run on 2026-10-11 under headless Chromium 145.0.7632.0 with **SwiftShader** (software GPU,
**not hardware timings**). The host has 4 cores shared with other agents, and the page is
cross-origin isolated (5 µs timers). Data is ORDER BY ts, series, with 2,048-row Arrow batches
and one NULL per 97 rows, on a 420×260 CSS px canvas at dpr 1. Line on the same data is the
reference. Cells give median / p95 in ms over 3 reps (append rows: over every batch of every
rep).

- *first draw*: RENDER_FIRST_BATCH → FIRST_DRAW_SUBMITTED from the DRAWN stamps. It includes the
  JS Arrow → Wasm copy, ingest, frame build and command replay. It is submission, not photons.
- *presented*: first batch → `presented()` (WebGL2: next rAF; WebGPU: `onSubmittedWorkDone`).
- *append*: `handle(batch)` (copy and ingest) plus a `frame(false)` build and replay, per batch.

**WebGL2 (SwiftShader)**

| | 6×1,440 line | 6×1,440 heatmap | 6×1,440 surface | 50×2,000 line | 50×2,000 heatmap | 50×2,000 surface |
|---|---|---|---|---|---|---|
| batches | 5 | 5 | 5 | 49 | 49 | 49 |
| first draw submitted | 2.16 / 59.4 | 4.26 / 9.74 | 0.79 / 4.83 | 10.4 / 106 | 0.66 / 3.78 | 4.71 / 5.99 |
| first batch → presented | 39.5 / 111 | 28.6 / 30.6 | 18.2 / 20.0 | 43.1 / 391 | 15.0 / 18.9 | 25.4 / 31.6 |
| append ingest | 0.31 / 4.32 | 0.16 / 0.20 | 0.17 / 6.52 | 0.21 / 8.06 | 0.13 / 2.04 | 0.14 / 4.53 |
| append frame (build + replay) | 0.60 / 10.7 | 1.16 / 8.91 | 0.49 / 6.61 | 2.65 / 14.8 | 1.07 / 8.40 | 2.96 / 11.6 |
| append upload, bytes | 19,872 | 18,396 | 20,256 / 36,640 | 42,520 | 29,780 | 59,168 / 200,720 |
| all batches → presented | 80.8 / 208 | 64.5 / 67.2 | 54.8 / 54.9 | 482 / 727 | 151 / 186 | 294 / 429 |
| full redraw, GPU done | 20.5 / 34.7 | 27.1 / 28.6 | 33.2 / 35.1 | 58.7 / 67.4 | 10.6 / 36.6 | 24.3 / 39.2 |
| rotate (set_param + frame), CPU / GPU done | | | 1.92 / 23.9 | | | 5.41 / 28.3 |
| GPU calls in the full frame | 97 | 48 | 124 | 669 | 268 | 828 |

**WebGPU (SwiftShader), 6×1,440 only**

The 50×2,000 run did not finish within 29 min on this host: SwiftShader's WebGPU rasterizer is
the bottleneck.

| | line | heatmap | surface |
|---|---|---|---|
| first draw submitted | 1.05 / 37.6 | 0.73 / 1.39 | 2.83 / 8.30 |
| first batch → presented | 183 / 1,204 | 107 / 599 | 346 / 1,752 |
| append frame (build + replay) | 2.23 / 4.90 | 0.38 / 0.62 | 0.56 / 5.97 |
| rotate CPU / GPU done | | | 9.53 / 903 |

Reading:

- Heatmap and surface first draws cost about what a line does, roughly 1–5 ms submitted. Their CPU
  work scales with the number of series (one draw per series row or lane), not with points. A
  50-series append frame costs about 1–3 ms of CPU (build + replay) on this loaded host.
- Rotation is uniforms only: 15 uniform blocks (3,840 B) for 6 lanes. Before the reversed-copy
  fix, rotated streaming rewrote whole copies per batch (50×2,000: 288 KB median, 812 KB p95 per
  append). Now it uploads only the new points, plus a rebuild when a copy outgrows its doubling
  headroom (the p95 of 200 KB).
- Presented and GPU-done times are SwiftShader rasterization. They say nothing about hardware.
- The p95 spikes on the first rep are cold pipelines/JIT plus host contention; with 3 reps, p95
  is effectively the maximum.

## Known gaps

- Painter's order is approximate: tall ribbons seen end-on can interleave wrongly across lanes. A
  depth attachment in the core (pipelines + shims) would make it exact.
- Heatmap cells narrower than a pixel overlap (last drawn wins); there is no per-pixel
  aggregation. At 2,000 buckets in ~400 px, each pixel column shows one of about 5 buckets.
- 3D axis labels live in the 2D gutters: x labels sit under their projected positions, and value
  labels sit at the projected height of the axis corner. There are no lane labels in the plot (the
  legend names the lanes), and no labels along the depth axis.
- Integer measure columns (e.g. `hour, dow, avg(v)` with `dow` as an integer) are not used as heatmap rows;
  only text or id-like series columns are.
- The surface uses flat per-segment shading, so noisy data shows as hatching. No elevation
  param yet.
