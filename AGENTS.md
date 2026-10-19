# Working on time-blast

**Read [docs/vision.md](docs/vision.md) before anything else.** It is the canonical
statement of purpose and wins over every other document, code comment or design
note in this repo.

## The project in five lines

- Research into one loop: **natural language → SQL → execute → see it**, made as fast as physically possible.
- The metric is **thought → correct result**. Typing, Enter and inference are steps to shrink or remove.
- Design for **~10× faster inference** than today. When it arrives, database, transport and drawing will dominate.
- Chase microseconds for their own sake. **Complexity is embraced** when it saves measured time, even off the bottleneck. **Measure every claim** and give **a concrete reason for every change**.
- Explore what speed enables: per-keystroke results, anticipating the next question, chart-as-query, voice.

## Hard rules

- **Model writes SQL.** The 7-field vessel `QueryPlan` is legacy. Don't extend it; replace it.
  Make execution safe (read-only, resource and time limits, cancellation), not model output.
- **Generic data.** Nothing on the hot path may assume the synthetic vessel schema.
- **One uniform protocol.** Coordinator, inference and database can each run in the browser
  or remotely. Same messages, same binary frame; only the transport differs (MessagePort locally,
  binary WebSocket remotely). Local paths use ownership transfer, never serialization for a
  network that isn't there. Remote components talk to each other directly.
- **Rust/Wasm for time-critical code; JS/TS only for boring glue and UI.** Rendering goes WebGPU (WebGL2 fallback) driven from Rust/Wasm; Canvas2D is legacy. Server hot paths are Rust. SIMD/assembly is welcome where measured.
- **Stream, don't collect.** Arrow batches flow into drawing without per-row objects,
  full-result collection or repeated concatenation. Draw at the first complete point.
- **Correctness of identity.** Preserve session/revision/request/epoch identities, cancellation
  and stale-result rejection. An early wrong chart is a failure, not a win.
- **Speculation budget:** a few $/day of inference. Report cost next to latency.

## Measurement honesty

- Distinguish proposals, implemented capabilities and measured results.
- Never invent latency numbers. Draw submission is not photons; say which you measured.
- Report cold/warm state, tails (p95/p99) and speculative resource cost with every result.
- Pin engine and browser versions; keep benchmark artifacts reproducible.

## Current state vs. vision

The first prototype (Oct 9–10, 2026) predated the vision; batch 1 replaced it (tb1 protocol,
model-written SQL, per-keystroke translation) and deleted its code. The public demo runs `main`
(batches 1–2, deployed 2026-10-11).
[docs/status.md](docs/status.md) records what is actually deployed;
[docs/README.md](docs/README.md) says which docs are current and which are historical.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm dev                     # browser app
npx tsc --noEmit && pnpm test && pnpm build       # required for implementation changes
cargo test --locked                               # workspace: tb-protocol, tb-coordinator, tb-render
cargo test --locked --manifest-path crates/inference-server/Cargo.toml
# After changing crates/tb-coordinator or crates/tb-render: rebuild and commit public/wasm/*.wasm
pnpm build:wasm
# NL→SQL eval by executed results (evals/): scorer self-test, or live against a running server
node scripts/eval-sql.mjs --self-test
node scripts/eval-sql.mjs --endpoint ws://127.0.0.1:8787/session
```

Browser smokes need Python Playwright. `tests/engine_smoke.py` needs a running dev
server; `tests/ui_smoke.py` runs the persistent-canvas application smoke against a
production preview (also requires `aiohttp`). `tests/canvas_card_smoke.py` tests
isolated controls against a dev server. Prompt changes go into both `crates/inference-server/src/prompt.rs` and
`src/inference-node/prompt.ts` (byte-identical, golden files in
`crates/inference-server/tests/fixtures/`; regenerate with `UPDATE_GOLDEN=1`) and get an eval run.
Deployment: [deploy/README.md](deploy/README.md). Provider keys live only in
`/etc/time-blast/inference.env` on the server; never commit credentials, private datasets
or model weights.

## Writing docs

Write short, decisive, current docs. State what is true, what was measured (and how), and
what is next. Don't hedge every sentence. When something becomes obsolete, update it or mark
it historical in `docs/README.md`; don't leave two truths side by side.

## Repo conventions

- Default branch `main`, remote `comino/time-blast` (public since 2026-10-19, MIT), as is the demo.
- This host is a small ARM64 box (2 cores, ~3.7 GB RAM): no heavy builds or model runs here.
