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

The first prototype (Oct 9–10, 2026) predates the vision and conflicts with it in places: the
7-field plan, a 2-second idle pause, per-component JSON protocols and vessel-shaped column
batches. See the "What to unlearn" table in [docs/vision.md](docs/vision.md).
[docs/status.md](docs/status.md) records what is actually deployed;
[docs/README.md](docs/README.md) says which docs are current and which are historical.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm dev                     # browser app
pnpm test && pnpm build      # required for implementation changes
cargo test --locked --manifest-path crates/inference-server/Cargo.toml
# After changing crates/query-core: rebuild and commit public/wasm/query-core.wasm
pnpm build:wasm && cargo test --manifest-path crates/query-core/Cargo.toml
```

Browser smoke scripts in `tests/*.py` need a running dev server and Python Playwright.
Deployment: [deploy/README.md](deploy/README.md). Provider keys live only in
`/etc/time-blast/inference.env` on the server; never commit credentials, private datasets
or model weights.

## Writing docs

Write short, decisive, current docs. State what is true, what was measured (and how), and
what is next. Don't hedge every sentence. When something becomes obsolete, update it or mark
it historical in `docs/README.md`; don't leave two truths side by side.

## Repo conventions

- Default branch `main`, remote `comino/time-blast` (private). The demo is public.
- This host is a small ARM64 box (2 cores, ~3.7 GB RAM): no heavy builds or model runs here.
