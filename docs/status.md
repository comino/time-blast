# Current status and handoff

Updated **2026-10-11** (batch 1 merged; batch-2 database and inference work merged). Direction: [vision.md](vision.md). The source repository is
private; the [live synthetic-data demo](https://time-blast.46-224-133-201.sslip.io) is public and
still runs the **old prototype** (see the end of this page).

## On `main`: batch 1, complete in source

```
main thread (JS glue: input, cards, DOM text)
   │ tb1 frames over MessagePort (transferred buffers)
engine worker
   ├─ coordinator  Rust/Wasm, sans-IO: per-keystroke translation, dedup, fencing, cache, latency dial
   ├─ database     DuckDB-Wasm blocking API in-process  |  or tb1 WebSocket → Rust → ClickHouse
   ├─ renderer     Rust/Wasm + WebGPU/WebGL2 shim, OffscreenCanvas per card, ten views
   └─ inference    tb1 WebSocket → Rust server → OpenRouter (SQL out)  |  or WebLLM worker
```

Everything speaks one protocol, [tb1](protocol-v1.md). Moving a node changes only its link. This
is shown for the database: browser DuckDB and remote ClickHouse return identical results through
the unchanged coordinator, renderer and UI. It is also shown for inference: a WebLLM worker or the
remote server. Per-area notes and measurements are in [batch-1/](batch-1/); plan and ownership in
[plan-batch-1.md](plan-batch-1.md).

### Measured

All numbers come from a shared, heavily loaded 4-core ARM host with a SwiftShader software GPU,
and measure draw *submission*, not photons.

| What | Result | Source |
|---|---|---|
| **Last keystroke → first draw**, full app, fake inference | **331 ms median, 490 ms p95** on final `main` (all 15 e2e checks pass); DuckDB's first batch is 321 ms of it, everything else ~10 ms. Earlier merge run: 372 / 467 ms | [e2e-main-final-2026-10-11.json](batch-1/e2e-main-final-2026-10-11.json), [e2e-main-2026-10-11.json](batch-1/e2e-main-2026-10-11.json) |
| Same, earlier run | 392 / 741 ms. With realistic SQL, 12/12 final keystrokes were dedups: the chart was already on screen before the last key | [render-calendar.md](batch-1/render-calendar.md) |
| Inference, Gemini 2.5 Flash Lite via Rust server | first SQL delta 348–411 ms p50, SQL 451 ms p50; ~$0.0001 per translation | [inference.md](batch-1/inference.md), [evals.md](batch-1/evals.md) |
| NL→SQL correctness, executed results, 45 questions | 2.5 Flash Lite **71 %** (prompt v3; was 49 %); 3.1 Flash Lite 87–89 % at 2.7× the cost and ~130 ms slower | [evals.md](batch-1/evals.md) |
| DuckDB-Wasm 60k-row aggregate, warm | first batch ~100 ms on a quiet host, 240–440 ms loaded | [engine.md](batch-1/engine.md) |
| ClickHouse remote, same query | first batch 128–219 ms loaded; Chromium's WebSocket receive (~25 MB/s) caps big results | [remote-database.md](batch-1/remote-database.md) |
| Coordinator per keystroke | 0.5 µs median in Wasm | [coordinator.md](batch-1/coordinator.md) |
| UI per keystroke | ~8 µs our code; ~115 µs median including `postMessage` | [ui.md](batch-1/ui.md) |
| Renderer, first batch → draw submitted | 1–6 ms per view; whole chart 4–9× faster than the old Canvas2D path | [render.md](batch-1/render.md) |

**Where the time went after batch 1:** inference (~450 ms) and the database (~100–400 ms);
everything else ~10 ms. Batch 2 cut the database to a few ms for most queries (below).

### Known gaps

- **Not deployed.**
  - The tb1 server and the new browser build must ship together.
  - The rate limits in `/etc/time-blast/inference.env` must allow per-keystroke traffic.
  - The ClickHouse node needs a dedicated read-only user before any public use.
  - Deploying needs the owner's go-ahead.
- **No hardware GPU measurements.** All render and end-to-end numbers are software-GPU.
- **NL→SQL:** the default model still returns raw rows on ~7/45 questions. Repair on the database's
  `result_limit` error is not wired: it needs that error to reach inference.
- **Renderer:**
  - one WebGL2 context per card (Chromium keeps ~16);
  - no device-loss recovery;
  - no line thinning for multi-million-point series;
  - no lat/lon tick labels.
- `render-bench` still compares against the legacy Canvas2D chart. `src/ui/chart.ts` and its
  imports remain only for that.

## Batch 2 so far (merged on `main`)

Details: [batch-2/database.md](batch-2/database.md), [batch-2/inference.md](batch-2/inference.md),
plan: [plan-batch-2.md](plan-batch-2.md).

- **Database first batch: 24.5 → 4.7 ms median (p95 158.9 → 24.1 ms)** over 281 statements, Node,
  same DuckDB-Wasm build. The wins: compressed in-memory storage; background minute/hour/day rollups
  with an exact rewrite via DuckDB's own parser (narrow, provably exact shapes; anything else runs
  raw); a bounded result cache. Exactness: 308 statements give identical results on both paths.
  Threads lost: the blocking API has no threaded build.
- **Last keystroke → first draw, full app, fake inference: 106.7 → 39.2 ms median
  (p95 163.6 → 64.5 ms)** on a quiet host, same run. Not comparable with the loaded-host batch-1 runs.
- **Inference: new server default `openai/gpt-oss-120b` on Groq, reasoning low: 91 % correct**
  (4 runs; Gemini 2.5 Flash Lite 71 %), first SQL delta 256–374 ms p50, ~$0.00016/request; Groq
  caches ~600–750 prompt tokens. The provider matters as much as the model (same model 76–91 %).
  A raw-row pre-check in the server lifts Gemini 2.5 Flash Lite to 78 %.
- **Prefix replay:** at 90 % of a question typed, 28/45 translations already give the final result,
  but only 8 are byte-identical SQL. The coordinator dedups on exact SQL; a result-level "keep the
  chart steady" check in the renderer would turn more of these into zero-latency answers.
- DONE now says whether a result came from a rollup or the result cache (flags in protocol-v1).
- **The chart is a query** ([batch-2/manipulation.md](batch-2/manipulation.md)). Brushing an x range,
  clicking a series, bar or map point, and going back all rewrite the SQL deterministically with
  DuckDB's own parser, with no model call. Brushing refines buckets; a new `QUERY` frame sends the
  rewritten SQL through the coordinator. Pointer → first draw: brush 38 ms, series click 28 ms,
  back 2.3 ms p50 (software GPU). Exactness: 101 statements × 246 filters, identical to filtering
  the original result.
- **Steady charts while typing:** when a new result's data equals what is on screen, the renderer
  keeps the image (277 of 293 per-keystroke results with alias/case/layout variants of the SQL);
  about 1.3 GPU redraws per typed question instead of about 25.

The deployed demo is untouched. Its `/etc/time-blast/inference.env` pins
`TIME_BLAST_MODEL=google/gemini-2.5-flash-lite`; remove that line when deploying to get the new
default (`scripts/deploy-inference.py` no longer writes it for new installs).

## Next

See [plan-batch-2.md](plan-batch-2.md): shipping (needs the owner), real-GPU measurements (needs the
owner), result-level stability while typing, and the interaction experiments.

## Deployed: the old prototype

The live demo runs the prototype's build: frontend `20261010T173044Z-a1890942`, backend from
`197b445`. It uses a 7-field query plan instead of SQL, a 2-second idle pause and Canvas2D charts.

- **Serving:** Caddy serves it from `/srv/time-blast/current` and proxies `/api/inference/` to
  `time-blast-inference.service` on `127.0.0.1:8787`.
- **Credentials:** provider credentials are in `/etc/time-blast/inference.env` (root, `0600`).
- **Documentation (historical):** [prototype.md](prototype.md), [backend-prototype.md](backend-prototype.md),
  and the dated records in [benchmarks/](benchmarks/) and [experiments/](experiments/).
- **Operations:** [deploy/README.md](../deploy/README.md).

Operational debt: the public demo has no authentication, and its OpenRouter budget counters are
process-local and reset on restart.

## Documentation map

Full map with current/historical classification: [README.md](README.md).
