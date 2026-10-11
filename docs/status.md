# Current status and handoff

Updated **2026-10-11** (batch 1 merged). Direction: [vision.md](vision.md). The source repository is
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
| **Last keystroke → first draw**, full app, fake inference | **372 ms median, 467 ms p95**; DuckDB's first batch is 332 ms of it, everything else ~10–40 ms | [e2e-main-2026-10-11.json](batch-1/e2e-main-2026-10-11.json) |
| Same, earlier run | 392 / 741 ms. With realistic SQL, 12/12 final keystrokes were dedups: the chart was already on screen before the last key | [render-calendar.md](batch-1/render-calendar.md) |
| Inference, Gemini 2.5 Flash Lite via Rust server | first SQL delta 348–411 ms p50, SQL 451 ms p50; ~$0.0001 per translation | [inference.md](batch-1/inference.md), [evals.md](batch-1/evals.md) |
| NL→SQL correctness, executed results, 45 questions | 2.5 Flash Lite **71 %** (prompt v3; was 49 %); 3.1 Flash Lite 87–89 % at 2.7× the cost and ~130 ms slower | [evals.md](batch-1/evals.md) |
| DuckDB-Wasm 60k-row aggregate, warm | first batch ~100 ms on a quiet host, 240–440 ms loaded | [engine.md](batch-1/engine.md) |
| ClickHouse remote, same query | first batch 128–219 ms loaded; Chromium's WebSocket receive (~25 MB/s) caps big results | [remote-database.md](batch-1/remote-database.md) |
| Coordinator per keystroke | 0.5 µs median in Wasm | [coordinator.md](batch-1/coordinator.md) |
| UI per keystroke | ~8 µs our code; ~115 µs median including `postMessage` | [ui.md](batch-1/ui.md) |
| Renderer, first batch → draw submitted | 1–6 ms per view; whole chart 4–9× faster than the old Canvas2D path | [render.md](batch-1/render.md) |

**Where the time goes:** inference (~450 ms) and the database (~100–400 ms). Everything we wrote
in between costs ~10 ms. With inference ~10× faster, the database is the bottleneck.

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

## Next: batch 2

See [plan-batch-2.md](plan-batch-2.md).

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
