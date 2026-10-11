# Batch 1 · render-geo: map, density, tracks

Status: implemented on the Rust/Wasm render core (`crates/tb-render/src/view/geo.rs`,
`view/geo/`), verified natively and in headless Chromium on software WebGPU and WebGL2.

## What it does

One view family for every result with a latitude and a longitude column. One instance draws
all three views from the same geometry, so switching map ⇄ density ⇄ tracks never re-ingests.

| View | Needs | Draws |
|---|---|---|
| `map` | lat + lon | Discs. Series (or a text x such as `vessel` / `port`) → palette colour; with a value too, disc size ∝ √value. Value without series → colour on a ramp, ramp legend. |
| `density` | lat + lon | Counts per ≈3 CSS px cell of the visible window, log colour ramp, legend `1 / cell … max / cell`. |
| `tracks` | lat + lon + time x | Per-series polylines ordered by time; `playback` 0..1 reveals each track up to that fraction of the time extent (the crossing segment is clipped exactly at the cut) and puts a marker at each series' interpolated position. |

All three draw the Natural Earth 1:110m coastline and a graticule; the legend ends with the
graticule step (`grid 5°`). There are no axis tick labels (see gaps).

**Applicability and ranks.** Lat/lon columns are found by name (`lat`/`latitude`,
`lon`/`lng`/`long`/`longitude`, and since this change also `*_lat`, `*_latitude`, `*_lon`,
`*_lng`, `*_long`, `*_longitude`), numeric only. Positions are the point of a query that
selects them, so geo views rank 5–7, before line/bar/scatter (10–12): with a time x the
automatic view is `tracks`, otherwise `map`. When the result also carries several measures
(`roles.measures` non-empty), the numbers are the focus and geo ranks 20–22, after xy.
`density` is offered, never automatic (the rank is fixed at schema time, before row counts
are known). Rows with a null/non-finite position, |lat| > 90, or (for tracks) a null time are
skipped; longitudes outside ±180 are normalised.

## How

- **Projection: Web Mercator, per vertex on the GPU.** Vertices are `[lon, lat, t, v]` f32
  exactly as ingested; WGSL and GLSL ES 3.00 shaders project (`log(tan(π/4 + φ/2))`). Chosen
  over equirectangular because it is conformal: regional data (the common case) keeps its
  shape, while equirectangular squashes east–west by cos φ (≈ 0.6 at 54° N). Its cost (one
  `log`+`tan` per vertex) is GPU-side; it keeps the CPU out of the per-point path. The CPU only
  fits the window: padded data extent (6 %/side, ≥ 0.05°), widened to the plot aspect for equal
  scale. Data spanning the antimeridian is fitted and drawn in 0..360° longitude when that is
  tighter; segments spanning > 180° are dropped instead of drawn across the map.
- **Density: CPU binning in Rust**, incremental per batch into a grid aligned with the fitted
  window; rows are uniform in Mercator northing, so each point's row comes from a latitude
  lookup table (no per-point projection). The grid is rebuilt only when the window changes
  (extent growth or resize). Only non-empty cells are uploaded (`[col, row, count]`). The GPU
  alternative (additive point sprites into an offscreen texture + colormap pass) needs
  render-target and texture-sampling ops the command stream does not have (one render pass
  per slot onto the canvas); not built, not measured. At the measured CPU cost below it would
  need to beat ~0.1 ms per 2k-row batch.
- **First point ASAP.** The coastline (8,344-byte i16 binary compiled into the Wasm, decoded
  once) is uploaded and drawn from the second frame on; the first data frame contains only
  data and the graticule (no buffers: lines come from instance ids). `Family::wants_frame`
  requests that second frame. Uploaded once per result (16.7 KB), not per frame.

## Changes outside `view/geo*` (all backward compatible)

| File | Change |
|---|---|
| `crates/tb-render/src/view/mod.rs` | `pub mod geo;`, `geo::DEF` in `FAMILIES`; new trait method `Family::wants_frame(&self) -> bool` with default `false`. |
| `crates/tb-render/src/renderer.rs` | `Renderer::frame`: after `f.draw(..)`, `if f.wants_frame() { s.dirty = true; }`. |
| `crates/tb-render/src/axes.rs` | `pub const LEGEND_RGB: usize = 1 << 30`; `palette_hex` returns `#rrggbb` for `LEGEND_RGB \| 0xRRGGBB` (explicit legend colours for ramps). |
| `crates/tb-render/src/schema.rs` | `is_lat`/`is_lon` accept the `*_lat…`/`*_lon…` suffixes; test `lat_lon_by_suffix`. |
| `src/engine/render/index.ts` | `Renderer.frame`: `if (x.tb_needs_frame()) this.schedule();` after `tb_frame_done` — the synchronous first-draw frame previously never scheduled a follow-up. |

Wasm size: 175 → 242 KB (data +28 KB: shaders 19 KB + coastline 8 KB; code +39 KB).

## Verified

- `cargo test -p tb-render`: projection round trip and clamp, lon normalisation, antimeridian
  wrap, fit (aspect, containment, centring, single point, empty), graticule steps, ramp,
  applicability and ranks, ingest filtering, per-series time sort (+ GPU rewrite and segment
  binding), playback cut and interpolated markers (incl. the cut reaching the shader uniform),
  coastline decode and deferral (no basemap bytes in frame 1, once in frame 2, never again),
  value/series legends, density incremental binning and rebuild on window change, Mercator row
  edges.
- `tests/render-geo.test.ts` (vitest, real Wasm, null GPU): automatic `tracks`, synchronous
  first draw with DRAWN points, coastline bytes only in the second frame, legend, view switches
  and playback redraw, `map` for positions + value with a ramp legend.
- `tests/render_geo.py --software` (headless Chromium 145, SwiftShader): WebGPU and WebGL2 each
  render map (port calls), density (100k), tracks and tracks at playback 0.4 with ink on every
  canvas, ≥ 3 colour buckets, less ink at 0.4 than at 1.0, chosen views, DRAWN points, zero
  frames while idle (no runaway `wants_frame`), no console errors.

## Measured

Software GPU (SwiftShader) in headless Chromium 145 on this shared ARM64 host under heavy load
(load average ≈ 36 on 4 cores during the runs), 5 reps per row: **not hardware timings; tails
are host contention**. `first draw` = RENDER_FIRST_BATCH → FIRST_DRAW_SUBMITTED (draw
submission, not photons). Build = Rust frame build, replay = JS shim GPU calls. Batches of
2,048 rows. Raw: [render-geo-bench-swiftshader.json](render-geo-bench-swiftshader.json)
(`python3 tests/render_geo.py --software --reps 5 --timings-only --json …`).

Medians (p95) in ms:

| Case | Backend | First draw | 1st build | Coast frame | Batch build | Batch frame |
|---|---|---|---|---|---|---|
| tracks, 6 × 2,000 | WebGPU | 1.14 (73) | 0.065 | 0.21 | 0.035 | 0.25 (40) |
| tracks, 6 × 2,000 | WebGL2 | 6.1 (50) | 0.065 | 0.22 | 0.050 | 0.40 (19) |
| density, 100k raw | WebGPU | 6.7 (18) | 0.135 | 0.45 | 0.080 | 0.34 (9.8) |
| density, 100k raw | WebGL2 | 5.9 (15) | 0.30 | 0.19 | 0.080 | 0.22 (12) |
| map, 12k with series | WebGPU | 4.2 (39) | 0.050 | 0.15 | 0.035 | 0.24 (6.4) |
| map, 12k with series | WebGL2 | 4.8 (22) | 0.050 | 0.13 | 0.030 | 0.47 (16) |

- The Rust frame build stays ≤ 0.3 ms median in every case; first-draw medians above that are
  ingest + shim replay on a contended software GPU.
- Coastline frame (16.7 KB upload + 2,085-segment draw): 0.13–0.45 ms median, kept off the
  first frame.
- Playback change → frame submitted: 11.6 ms WebGPU, 3.3 ms WebGL2 (single samples, includes
  marker recompute and the software GPU's frame acquire).
- Density, native release (aarch64, min of 30, `cargo test --release -p tb-render -- --ignored
  --nocapture density_cost`): ingest 100k 1.02 ms; full rebin + cell list 1.92 ms with a binary
  search per point → **0.75 ms** with the latitude lookup table (kept).

## Known gaps

- No lat/lon tick labels: `AxisScale` has no explicit-ticks variant and the Mercator y axis is
  not linear in latitude. Proposal: `AxisScale::Ticks(Domain, Vec<(f64, String)>)`. The legend
  states the graticule step instead.
- `playback` is not carried over to a new result: each new tracks result starts at 1.0 (all);
  the UI must re-send `playback` after VIEWS if it wants to keep a position. Slot params are
  not applied when the core creates a family.
- The coastline is re-uploaded per result (16.7 KB, after the first frame) rather than shared
  per slot; sharing needs a slot-level static-buffer cache in the core.
- `density` rank is static (never automatic, even for 1M points); choosing by row count needs
  a re-rank after the first batches.
- Density bins in the fitted window at screen resolution; a streaming result whose extent keeps
  growing rebins every batch (O(n) each, 0.75 ms per 100k native).
- Mercator y is computed in f32 on the GPU: fine to ~10 m features; sub-metre extents would
  need projection relative to an origin.
- No hardware-GPU numbers; the GPU additive-blend density alternative is unmeasured.
