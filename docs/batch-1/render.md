# Batch 1 · render

Status: wave 1 done. Owner files: `crates/tb-render/`, `src/engine/render/`,
`public/wasm/tb-render.wasm`, `render-bench.html`, `src/render-bench.ts`,
`vite.render-bench.config.ts`, `tests/render-*`, `tests/render_*.py`.

## Architecture

```
engine worker
  RendererNode (src/engine/render/index.ts, JS glue)
    ├─ ingest.ts   Arrow Schema/RecordBatch → Wasm staging: one Uint8Array.set per needed buffer
    ├─ core.ts     raw C-ABI exports of tb-render.wasm (no wasm-bindgen), memory-growth-safe views
    ├─ backend.ts  WebGPU | WebGL2 | null shim: replays the Rust command stream
    └─ table.ts    table preview rows + CSV export (cold path)
  tb-render.wasm (crates/tb-render, Rust)
    schema.rs   column types → roles (protocol-v1 result shape convention)
    store.rs    canonical columns: time i64 µs, numbers f64 (NaN = NULL), text → interned ids
    view/       view families (xy = line/bar/scatter) build per-series f32 geometry
    scale.rs    nice domains, numeric and UTC calendar ticks, labels
    axes.rs     plot layout, AxisTicks JSON, grid instances
    gpu.rs      command stream, GpuVec (tail-only uploads), per-slot buffer pool, pipelines
    renderer.rs slots, BIND/UNBIND, request+epoch fencing, keep-old-image, frame building
```

Rust owns every decision; JS makes GPU calls and DOM-bound posts. Per frame Rust writes a flat
`u32` command list (`gpu.rs` `op`: CTX, BUF_CREATE/DESTROY/WRITE, PASS, PIPE, VB, UNI, SCISSOR,
DRAW, END). The shim walks it once: `queue.writeBuffer(buffer, offset, memory.buffer, src, len)`
straight from Wasm memory, pipelines pre-built at startup from Rust-provided WGSL/GLSL, one
render pass per dirty slot, one command encoder and one `submit` per frame for all slots.
Redundant pipeline/vertex-buffer/uniform binds are elided in Rust (`PassRecorder`).

- **WebGPU:** one device, one `GPUCanvasContext` per slot (`alphaMode: premultiplied`, transparent
  clear so the card background shows through in light or dark themes). Uniforms are one 256-byte
  block per draw in a per-slot uniform buffer with a dynamic offset.
- **WebGL2 fallback:** the same stream; one context per slot (WebGL contexts can't share
  buffers), UBO + `bindBufferRange`, instanced attributes with byte offsets (no base-instance
  needed). Chromium caps live WebGL contexts at ~16 per process: fine for 10+ slots, not for 50.
- **null:** validates the stream without a GPU (unit tests; keeps views/table/export working).

### Data path (decided by measurement, see below)

Arrow buffers are copied once per needed column per batch into Wasm staging, then Rust converts
them column-wise into canonical columns and f32 geometry relative to per-result origins
(time: ms since the first timestamp, so f32 keeps sub-second precision for epoch µs; labels use
the exact i64). Only role columns are copied. Dictionaries are sent once per dictionary object.
Nulls stay nulls: NaN/`NULL_TIME` in canonical columns, `f32::MAX` in vertex data (shaders treat
|v| ≥ 1e37 as missing), so a null breaks a line instead of drawing zero.

Wasm memory growth detaches views: `RenderCore` re-derives `u8/u32` views whenever
`memory.buffer` changed, after every export call (tested with a 200k-row batch mid-stream).

### First draw, scheduling, keep-old-image

- The first BATCH of a bound request ingests, builds a frame for that slot only and submits
  synchronously inside `handle()`. Stamps: `RENDER_FIRST_BATCH` on arrival,
  `FIRST_DRAW_SUBMITTED` after `queue.submit`, then a second `DRAWN` with `FIRST_PRESENTED` when
  `onSubmittedWorkDone()` resolves (WebGL2: next animation frame). DRAWN echoes the BIND's
  request, revision, epoch and context; payload `u32 slot, u32 points`.
- Later batches mark the slot dirty; one `requestAnimationFrame` frame draws all dirty slots.
  `requestAnimationFrame` exists in Chromium dedicated workers (verified by render-bench:
  `workerRequestAnimationFrame: "requestAnimationFrame"`); elsewhere a 16 ms timer.
- Domains grow through uniforms only; appends upload only the new tail of each series buffer.
  Lines need x-sorted series: an out-of-order point marks the series, and the next line frame
  sorts it in Rust and re-uploads it once.
- A newly bound request stays `pending` until it has a drawable point (or DONE for an empty
  result); the old result keeps drawing (also on resize) and is replaced in the same frame.
  UNBIND clears the canvas. Fencing: data is accepted only for the request bound to a slot and
  only with an epoch ≥ the binding's.
- GPU buffers come from a per-slot pool pre-warmed at attach (8 × 64 KiB vertex + 1 uniform), so
  a first draw normally creates no GPU objects (tested in `renderer.rs`).

## Views, roles and axes

Roles (Rust `schema::infer_roles`): lat/lon by name; first remaining column is x (temporal →
time, text/bool → category, numeric → numeric x when ≥2 numeric columns); last numeric after x
is the value; the first middle text column (or id-like integer: `id`, `*_id`, `*Id`, `key`,
`series`, `group`) is the series; other middle numerics are measures. A lone numeric column is a
value with no x (table only). COUNT/SUM integers are never series.

Automatic view: time → line, category/integer x → bar, float x → scatter, no value → table.
`setView` hints win when applicable. Wide results (no series column, extra measures) draw one
series per measure for line/bar; scatter with a measure plots measure (x) vs value (y).

Axes: Rust computes nice ticks (d3-style 1-2-5 steps) and calendar-aligned UTC time ticks
(ms…weeks, months, years; midnight ticks show the date), lays out the plot rect and posts
`{type:'axes'}` when the JSON changes. `at` = CSS px from the canvas's top-left (same frame as
`plot`). Legend = series labels + palette colours. The GPU draws hairline grid rows, the zero/base
line and x tick marks. `views` is posted on RESULT_SCHEMA and on view changes; `table` (first 50
rows as strings, exact UTC µs) after the first draw and on DONE; `export` (CSV Blob) on request.

Visuals: capsule-SDF antialiased lines (1.7 css px, round joins/caps), SDF disc markers (every
point when sparse, the newest point per series otherwise), AA bars grouped per series, legacy
`SERIES_COLORS` palette.

## View-family API (for wave 2)

`crates/tb-render/src/view/mod.rs`:

```rust
pub trait Family {
    fn handles(&self, view: View) -> bool;                // can this geometry draw `view`?
    fn ingest(&mut self, store: &Store, from: usize, to: usize); // rows arrive in order
    fn points(&self) -> u32;                              // drawable points (first-draw trigger)
    fn upload(&mut self, view: View, gpu: &mut Gpu);      // GpuVec::sync per buffer
    fn axes(&self, view: View, store: &Store) -> AxisModel; // AxisScale::{None,Linear,Time,Category}
    fn draw(&mut self, view: View, frame: &mut DrawFrame);  // pass.pipeline/vertex_buffer/uniform/draw
    fn set_param(&mut self, name: &str, value: f64) -> bool { false } // `rotation`, `playback`
    fn release(&mut self, gpu: &mut Gpu);
}
pub struct FamilyDef { name, applicable: fn(&Roles, &mut Vec<(View, u8)>), create, pipelines }
pub static FAMILIES: &[&FamilyDef] = &[&xy::DEF];
```

To add a family: write `view/<name>.rs` with a `Family` impl and `pub static DEF: FamilyDef`,
declare its pipelines as `PipelineDesc` (WGSL with `vs`/`fs` entry points + GLSL ES 3.00
`vert`/`frag`; preludes provide the shared `Uniform` block `u`, `to_px`, `to_clip`, `missing`,
`CORNERS`), add `pub mod <name>;` and the `DEF` to `FAMILIES`. Rank views in `applicable`
(lower wins the automatic choice; xy uses 10–12). Nothing in JS changes: the shim builds
pipelines from the JSON Rust exports. Use `store.lat/lon`, `store.x` (`XValues::Time` exact µs),
`store.series`, `store.value`, `store.measures`; keep geometry relative to an origin in f32.

## Measurements

All numbers: headless Chromium 145.0.7632.0, **SwiftShader** WebGPU/WebGL2 (CPU emulation;
not hardware timings), 4-core aarch64 host shared with other agents (1-min load average 19–24
during the runs: medians are usable, p95s are mostly contention). Pages served cross-origin
isolated (5 µs timers). Medians (p95) in ms. Raw JSON: `render-bench-2026-10-11.json`,
`render-engine-2026-10-11.json`. Reproduce: `pnpm exec vite --config vite.render-bench.config.ts
--port 5199` then `python3 tests/render_bench.py --software --reps 5`; `python3
tests/render_engine.py --software` (starts its own server).

### render-bench: synthetic Arrow batches, 6 series, 2048-row batches, main thread

| | 8,640 pts WebGPU | 8,640 WebGL2 | 60,480 WebGPU | 60,480 WebGL2 | legacy Canvas2D 8,640 / 60,480 |
|---|---|---|---|---|---|
| first batch → first draw submitted¹ | 1.86 (30.5) | 3.90 (9.5) | 0.93 (5.8) | 5.73 (26.7) | 0.015 / 0.010 (one dot) |
| – ingest (copy + Rust) | 0.18 | 0.20 | 0.13 | 0.12 | — |
| – frame build (Rust) | 0.07 | 0.07 | 0.07 | 0.08 | — |
| – replay + submit (shim) | 0.98 | 2.63 | 0.61 | 2.11 | — |
| per later batch: ingest / frame | 0.19 / 1.32 | 0.19 / 0.63 | 0.15 / 0.39 | 0.14 / 0.35 | 0.000 append, work deferred |
| all batches drawn | 11.8 | 12.7 | 84.7 | 143.9 | 101 / 516 (4 ms slices per frame) |
| full redraw, CPU side | 0.59 | 1.56 | 1.65 | 1.23 | 102 / 522 (to settled) |
| full rebuild (view switch, re-ingest + upload) | 0.47 | 1.05 | 1.37 | 3.72 | — |

¹ RENDER_FIRST_BATCH → FIRST_DRAW_SUBMITTED stamps. The first draw is the whole first batch
(2048 rows, all series, grid), not one dot. Legacy Canvas2D draws a single marker
synchronously and finishes the chart over many animation frames; it is faster to its first
pixel on this CPU-only box but 10–60× slower to the complete chart. GPU completion
(`onSubmittedWorkDone`) under SwiftShader takes 1 s (8,640) to >10 s (60,480, capped): CPU
rasterisation, meaningless for hardware. A pre-pool run on a quieter host measured 0.75 ms
first draw for 60,480 on WebGPU (replay 0.48).

Wasm: 175,094 bytes (66,441 gzip -9), no imports. Wasm memory: 1.9 MiB after 8,640 points,
3.8 MiB after 60,480 (canonical f64 columns + f32 geometry).

### Data-path alternatives (60,480-row f64 column, per call)

| step | ms |
|---|---|
| `Uint8Array.set` of the Arrow column into Wasm memory (484 KB) | 0.015 |
| Rust f64 → relative f32 conversion | 0.14 |
| Rust min/max scalar / SIMD128 | 0.099 / 0.074 |
| JS `Float32Array.set(Float64Array)` | 0.100 |
| WebGPU `writeBuffer` of the raw Arrow f64 buffer | 0.48 |
| upload until `onSubmittedWorkDone` | 0.94 |
| GPU → CPU readback round trip (copy 16 B + `mapAsync`) | 1.77 |

**Decision: one memcpy per column into Wasm, conversion and stats in Rust.** The copy is
the cheapest step measured (15 µs for 484 KB). Uploading raw Arrow buffers straight to the GPU
costs more than the copy (0.48 ms: f64 is twice the f32 bytes and WGSL has no f64, so shaders
would decode bit patterns) and statistics computed on the GPU need a readback (1.8 ms) before
the axes can be labelled — an order of magnitude more than Rust's 0.1 ms min/max. SIMD128
min/max is 25% faster than scalar here; the ingest loop is fused with conversion and null
handling, so it stays scalar until profiles show min/max matters (the kernel stays in
`bench.rs` for that comparison).

### Through the real engine data path (DuckDB-Wasm database node → renderer in one worker)

`tests/render_engine.py`, vessels fixture (1.2 M rows), WebGPU SwiftShader, warm runs
(10 each). `render` = RENDER_FIRST_BATCH → FIRST_DRAW_SUBMITTED.

| query | view chosen | DB first batch | DB → render | render | EXEC → first draw submitted |
|---|---|---|---|---|---|
| minute avg per vessel (60,480 rows) | line | 519 | 0.01 | 2.22 | 533 |
| `vessel, count(*)` (Int64 value) | bar | 185 | 0.01 | 1.31 | 186 |
| hourly `avg(wind), avg(speed)` (wide) | line, 2 series | 245 | 0.01 | 1.51 | 246 |
| `vessel, CAST(ts AS VARCHAR)` | table | 34 | 0.01 | 0.40 | 37 |

The renderer is ~0.3–1% of EXEC → first draw on this box; the database dominates.

## Decisions where the spec left room

- **Two DRAWN per request:** the first right after submit (RENDER_FIRST_BATCH +
  FIRST_DRAW_SUBMITTED), a second with FIRST_PRESENTED (coordinator confirmed).
- **Table view counts as drawn** when the first row arrives (DRAWN points = rows); the canvas
  is cleared and the UI shows the DOM table.
- **Empty results replace the old image on DONE** (DRAWN points = 0): an empty answer is a
  correct answer; keeping the previous chart would show a wrong one.
- **Strict fencing:** RESULT_SCHEMA/BATCH before BIND are dropped (coordinator sends BIND
  first). A BATCH without a prior schema uses `batch.schema`.
- **Integer middle columns are measures** unless id-like by name (COUNT/SUM are integers).
- **Wide results** (no series, several measures) draw one series per measure for line/bar.
- **Nanosecond timestamps** are floored to µs (DuckDB emits µs).
- **Transparent canvas clear:** theme comes from the card; series colours are the legacy
  palette, grid is neutral grey with alpha.
- **Benchmark on the main thread:** the legacy chart needs DOM; the renderer runs on
  transferred OffscreenCanvases exactly as in the worker, and `render_engine.py` measures it
  inside a real worker.

## Requests to the contract owner

- `RESULT.columns[].role`: the coordinator only sees header-only schemas. The renderer
  computes roles in Rust; it could post them in the `views` UI message (`columns:
  [{name, role}]` is already in the Rust JSON) or the coordinator could link
  `tb_render::schema::infer_roles`. Decide which.

## Known gaps

- WebGL2 uses one context per slot (Chromium keeps ~16 live); a shared context + bitmaprenderer
  would lift that.
- No device-loss / context-loss recovery yet (Rust keeps all data, so a re-upload is possible).
- Series beyond the 6-colour palette reuse colours; very many series mean one draw each.
- Canonical columns are retained for the whole result (needed for view switches and exact
  labels); no row cap yet beyond the export retention cap (256 MB).
- Lines draw every point; no LOD/min-max decimation for multi-million-point series yet.
- Hardware GPU timings are unmeasured (no GPU on this host).
