# Batch 1: the new loop

Status: in progress (started 2026-10-10). Lands on `main`. Direction: [vision.md](vision.md).
Wire contract: [protocol-v1.md](protocol-v1.md). Code contracts: `src/engine/contracts.ts`.

## Goal

Drop in any Parquet or CSV file and type a question. Every keystroke triggers a
translation, and newer ones supersede older ones. The model writes SQL, DuckDB runs it
in the engine worker, and Rust/Wasm renderers (WebGPU, WebGL2 fallback) draw from the first
Arrow batch. **All ten chart types** carry over. Per-hop stamps measure keystroke → drawn point.
Inference runs in the browser (WebLLM) or on the Rust server with no other code changes.

## Architecture in one picture

```
main thread (JS: input, card chrome, DOM text)
   │ tb1 frames over MessagePort (transferred buffers) + UI control messages
engine worker
   ├─ coordinator  Rust/Wasm, sans-IO (crates/tb-coordinator)
   ├─ database     DuckDB-Wasm blocking API, in-process (src/engine/database.ts)
   ├─ renderer     Rust/Wasm (crates/tb-render) + WebGPU/WebGL2 shim, OffscreenCanvas per slot
   └─ inference link → MessagePort to WebLLM worker | WebSocket `tb1` to the Rust server
```

BATCH goes database → renderer in-process; the coordinator sees header-only copies.

## Waves and ownership

Each wave runs agents in parallel, each in its own git worktree. The coordinating agent merges
them into `main` between waves. **An agent edits only the paths it owns**, plus its own notes file
`docs/batch-1/<area>.md`. Shared contracts (`docs/protocol-v1.md`, `src/protocol/`,
`crates/tb-protocol/`, `src/engine/contracts.ts`) change only through the coordinating agent.
If one needs to change, report it rather than editing it.

### Wave 0: contracts (done by the coordinating agent)
Protocol spec, Rust + TS codecs with golden vectors, `src/engine/contracts.ts`, crate skeletons,
`scripts/build-wasm.mjs`, this plan.

### Wave 1: five parallel agents

| Area | Owns | Delivers |
|---|---|---|
| **coordinator** | `crates/tb-coordinator/`, `src/engine/coordinator.ts`, `public/wasm/tb-coordinator.wasm` | Sans-IO state machine: drafts, per-keystroke translation (`latest`/`restart`), one in-flight request, SQL dedup, BIND/UNBIND/KEEP, epochs and stale-result fencing, translation cache, latency dial, per-request stamp ledger → TIMING. Raw C-ABI Wasm exports; a JS loader implementing `CoordinatorCore`. Native unit tests for every rule. |
| **engine** | `src/engine/` (except files owned by others), `vite.config.ts`, `deploy/time-blast.Caddyfile` | Engine worker host and pump; in-process, MessagePort and WebSocket `Link`s; `DatabaseNode` on DuckDB-Wasm's blocking API: datasets (fixtures, drag-drop Parquet/CSV, URL), context statistics, single read-only `SELECT` guard, limits, cancellation, Arrow schema/batch emission with stamps. Cross-origin isolation headers. |
| **render** | `crates/tb-render/`, `src/engine/render/`, `public/wasm/tb-render.wasm`, `render-bench.html` | `RendererNode`: Rust/Wasm core + minimal JS WebGPU shim (WebGL2 fallback) on OffscreenCanvas; column-role inference and automatic view choice; line, scatter and bar; table rows, axis ticks, legend, CSV export events; first-draw stamping; keeps the previous image until the new binding draws. A benchmark page comparing against the old Canvas2D path. |
| **inference** | `crates/inference-server/`, `src/inference-node/`, `scripts/benchmark-models.py`, `deploy/time-blast-inference.service` | Rust server speaking `tb1` (via `tb-protocol` path dependency): schema context in a cacheable prefix, NL→SQL prompt with the result-shape convention, streamed `SQL_DELTA`, `SQL`, `INFER_STATS` with cost, cancellation, one repair attempt on invalid SQL. A WebLLM worker speaking `tb1` over MessagePort with SQL output. Delete `plan.rs` and the JSON-plan protocol from the server. |
| **ui** | `src/main.ts`, `src/ui/`, `index.html` | Main thread rewritten as thin glue: input → DRAFT/COMMIT frames with `KEY_INPUT`/`DRAFT_SENT` stamps; slots registered up front with canvases transferred to the engine; cards driven by RESULT/BIND/UNBIND/KEEP/TIMING; DOM axis labels, legend, view picker, table, export; stage-by-stage timing panel; settings for inference placement, latency dial and policy; dataset drag-and-drop. Tested against a fake engine worker. |

### Wave 2: after wave 1 merges

| Area | Delivers |
|---|---|
| **render-matrix** | heatmap and 3D surface on the render core |
| **render-geo** | map, density and voyage tracks (coastline included) |
| **render-seasons + integration** | seasonal wheel; end-to-end browser tests across placements (WebLLM fake, remote server, latency dial) |
| **cleanup + evals** | delete legacy (`QueryPlan`, `crates/query-core`, templates, plan cache, old adapters/coordinator/protocols, old tests); NL→SQL eval comparing query results; docs |

Then: measure keystroke → first draw per stage, update `status.md`, redeploy.

## Rules for every agent

- Read `CLAUDE.md`/`AGENTS.md`, `docs/vision.md`, `docs/protocol-v1.md` and
  `src/engine/contracts.ts` first.
- Rust or Rust/Wasm for hot paths; JS only for glue. No wasm-bindgen; raw C-ABI exports.
- No new npm dependencies. Rust dependencies only in `crates/inference-server`.
- This host has 4 cores and ~8 GB shared by several agents: build with `-j 2` and run at most
  one headless browser at a time. Chromium here has no GPU. Software WebGPU works with
  `--enable-unsafe-webgpu --use-angle=swiftshader --enable-features=Vulkan --use-vulkan=swiftshader`.
- Commit in your worktree with clear messages ending with the Co-Authored-By line. Keep
  `pnpm test`, `pnpm build` and `cargo test` for the crates you own green.
- Record what you measured, and how, in `docs/batch-1/<area>.md`. Label anything unmeasured.
