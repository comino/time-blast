# Batch 1: the new loop

Status: planned 2026-10-10. Lands as step-by-step commits on `main`. Each step keeps
`pnpm test`, `pnpm build` and `cargo test` green. Direction: [vision.md](vision.md).

## Goal

Drop in any Parquet or CSV file and type a question. Every keystroke triggers a
translation, and newer ones cancel older ones. The model writes SQL, DuckDB runs it
in a worker, and Rust/Wasm WebGPU renderers draw from the first Arrow batch. **All ten
chart types** carry over. Per-hop timestamps measure keystroke → drawn point.
Inference runs in the browser or on the Rust server without changing other code.

## Steps

1. **Protocol spec and Rust codec** (`crates/tb-protocol`, `docs/protocol-v1.md`).
   - Fixed little-endian header: type, flags, session, epoch, request, revision, and
     per-hop timestamp slots.
   - Messages: `HELLO DRAFT INFER SQL_DELTA SQL EXEC SCHEMA BATCH DONE ERROR CANCEL`.
     `BATCH` carries Arrow IPC bytes.
   - One crate compiles natively and to Wasm, with golden test vectors.
   - Header parsing in Wasm versus `DataView` is decided by measurement.
2. **Transports.** MessagePort with ownership transfer in the browser and binary
   WebSocket remotely carry the same frames. Components become nodes with one handler
   each, and placement is configuration.
3. **Database node.** Synchronous DuckDB-Wasm (`duckdb-browser-blocking`) runs inside
   our own worker and speaks the protocol directly, removing the separate DuckDB RPC
   worker.
   - Execution: a single read-only `SELECT`, time/row/byte limits, cancel on `CANCEL`.
   - Data: drag-and-drop Parquet or CSV, with the schema sent via `SCHEMA`. The vessel
     data stays as a fixture.
4. **Rendering** (`crates/tb-render`). OffscreenCanvas runs in the same worker.
   - Arrow numeric columns go from DuckDB's result buffer straight to the GPU with
     `queue.writeBuffer`, and transforms run in shaders. Points never enter our Wasm
     memory.
   - Rust/Wasm owns scales, uniforms, scheduling and draw calls. A tiny hand-written JS
     shim makes the WebGPU calls (no wasm-bindgen or wgpu), with WebGL2 as fallback.
   - All ten views are rebuilt for generic data: line, bar, scatter, table (DOM),
     heatmap, surface, map, density, tracks and seasonal wheel.
   - Views are chosen from column roles: time, measure, category, lat/lon. Map, density
     and tracks appear when a lat/lon pair exists. The model may suggest a view but
     doesn't have to.
   - Old Canvas2D and new WebGPU are measured on identical queries.
5. **Inference node.**
   - The Rust server moves to protocol v1, takes the schema in a cacheable prompt
     prefix, and streams SQL as `SQL_DELTA`.
   - Latest-wins cancellation, at most one translation in flight per session.
   - WebLLM moves to the same protocol with SQL output.
   - Measure the cost per question against the few-$/day budget.
6. **Remove the 2-second pause; add measurement.**
   - Translate on every keystroke and check the revision before display.
   - Stage-by-stage trace of keystroke → drawn point.
   - A latency dial replays cached translations at simulated speeds.
7. **Delete the replaced legacy code.** The 7-field `QueryPlan`, `crates/query-core`,
   templates, the plan cache, the three JSON protocols and their tests go. The
   `QueryPlan` eval corpus is replaced by result-comparing NL → SQL checks.

The public demo stays on the old prototype until batch 1 reaches chart parity, then
it is redeployed.

## Deferred to batch 2

- A server-side DuckDB/ClickHouse node, built on a Hetzner worker rather than this box.
- Direct remote inference → database traffic.
- Next-question anticipation, chart-as-query, voice.
- Authentication and durable budgets for the public demo.
