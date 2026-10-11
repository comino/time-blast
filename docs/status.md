# Current status and handoff

Updated **2026-10-10** (batch-1 cleanup). The source repository is private; the
[live synthetic-data demo](https://time-blast.46-224-133-201.sslip.io) is public.

## Source on `main`: batch 1

`main` holds the batch-1 architecture ([plan](plan-batch-1.md), [tb1 protocol](protocol-v1.md),
notes per area in [batch-1/](batch-1/)): Rust/Wasm coordinator, engine worker with the DuckDB-Wasm
database node, tb1 inference server writing SQL, WebLLM node, new main-thread UI. The prototype's
code (7-field `QueryPlan`, `query-core`, adapters, old UI, its evals and smokes) is deleted; only
the Canvas2D chart remains as the renderer benchmark's baseline.

- **Not yet end to end in a browser:** the Rust/Wasm renderer is not merged (`main` has a stub).
- **Not deployed:** neither the tb1 inference server nor the batch-1 browser build.
- **Measured:** NL→SQL quality by executed results, [batch-1/evals.md](batch-1/evals.md); per-area
  latencies in the batch-1 notes.

## Deployed: the prototype

Everything below this heading describes the **prototype build that is still live**. Its source
was last present at `1afe91c`.

### What runs today

```text
Browser chat → browser coordinator → persistent WebSocket → Rust inference service
                                                           ↓
                                                  OpenRouter / Gemini 2.5 Flash Lite
                                                           ↓
Browser chart ← streamed Arrow columns ← DuckDB-Wasm ← Rust/Wasm SQL compiler ← validated plan
```

The hosted model generates a constrained query plan, not executable SQL. Rust
validates it at the service, the browser checks the returned plan, and the
Rust/Wasm compiler produces allowlisted SQL. The database and renderer stay in
the browser. Local WebGPU inference remains selectable through the same logical
contract; a development build without `VITE_INFERENCE_ENDPOINT` defaults to
Qwen2.5-1.5B with four-bit weights.

| Component | Implemented placement | Remaining work |
| --- | --- | --- |
| Chat, canvas and coordinator | Browser | Remote coordinator service; realistic typing/load replay |
| Inference | Browser WebGPU or Rust → OpenRouter/OpenAI-compatible provider | Broader semantic evaluation and measured provider/prompt tuning |
| Query compiler | Rust/Wasm in browser | Additional validated query operations/dialects |
| Database | DuckDB-Wasm worker | ClickHouse service; remote database contract currently has no shipped service |
| Drawing | Canvas2D, ten views, streamed column views | Comparative GPU/OffscreenCanvas measurements; image dataset/adapter |

Live query is on by default. At 20 trimmed characters, **two seconds without an
edit** starts inference and displays a chart automatically. Enter bypasses the
pause or promotes the matching preview. Draft transport starts earlier; remote
draft snapshots are coalesced over 25 ms. Sending a draft does not itself buy a
provider generation or establish a resumable model/KV session.

Model modes do not silently fall back to templates. Auto and template-only modes
are explicit options. A 64-entry exact plan cache is configurable; disable
**Reuse exact model plans** in Runtime when testing fresh inference. Invalid
output, truncation or refusal gets one correction attempt. A valid plan can
still misunderstand the question, and that does not trigger repair.

The dense dataset contains **1,209,600 synthetic readings** for six vessels over
14 days. Questions aggregate those rows into chart points. Try:

- “Compare vessel wave height by minute over the last 7 days” → **60,480 points**.
- “Compare vessel speeds by minute over the last 24 hours” → **8,640 points**.
- “Compare vessel wave height by hour over the last 1days as a 3D surface” → **144 points**.
- “Show a heatmap of vessel wind by hour over the last 7 days.”

Time series, bars, scatter, heatmaps, surfaces, maps, density maps, voyage
playback, seasonal wheels and tables are implemented. Cards support dragging,
resizing, duplication, compatible view changes, SQL inspection and CSV export.
Compatible changes reuse result buffers. The workspace is in memory, bounded to
eight cards and 64 MiB of unique result buffers; it is not saved across reloads.

DuckDB emits the first complete time bucket before the remainder, using two
read-only queries in one snapshot; single-bucket requests use one query. Arrow numeric views are borrowed into
drawing, with no per-row objects or whole-result wait on that path. Engine,
worker/IPC and graphics boundaries still have copy/scheduling costs. This is not
literal end-to-end zero-copy.

### Source and deployed versions

The last implementation commit is **`661a1d9`**: provider reasoning/sampling
controls and the hosted model comparison. Those controls were tested in isolated
services; the running backend remains the build recorded in **`197b445`**.
The documentation wrap-up does not deploy a new binary or change the model.

The live frontend release is **`20261010T173044Z-a1890942`**. Caddy serves it from
`/srv/time-blast/current` and proxies `/api/inference/` to the active
`time-blast-inference.service` on `127.0.0.1:8787`. Both local and public health
checks reported `ready` with `google/gemini-2.5-flash-lite` during this wrap-up.
A health response verifies service availability, not provider/model warmth.

Provider credentials remain server-side in `/etc/time-blast/inference.env`,
owned by root with mode `0600`. Backend installation preserves that file on
updates; a source default change alone does not override its configured model.
See the [deployment runbook](../deploy/README.md) for builds, checks and updates.

### Evidence and limits (prototype)

| Evidence | Observation | What it does not establish |
| --- | --- | --- |
| [Hosted model comparison](experiments/hosted-models-2026-10-10.md) | Seven models screened; 2.5 Lite matched 8 supported plans and 4 required refusals in both runs; supported-response medians **551 ms / 454 ms** | General model accuracy, provider rankings, p95/p99, browser drawing |
| [Public browser with real inference](benchmarks/rust-backend-public-live-2026-10-10.json) | Three correct model/SQL/chart results; dispatch-to-first-draw **816 / 520 / 686 ms** | Physical photons, sustained load, all user devices; the automatic two-second pause precedes dispatch |
| [First-bucket experiment](experiments/first-bucket-query-2026-10-09.md) | Week/minute chart drew about **42 ms earlier**, adding about **6 ms** to database completion | A universal DuckDB/ClickHouse speedup |
| Automated checks | **717 application tests**, **34 Rust backend tests**, benchmark scorer self-tests, TypeScript/Vite and release Rust builds passed at `661a1d9` | Hosted availability or correctness outside tested cases |

Gemini 2.5 Lite remains the default based on this integration's observed
tradeoffs. Gemini 3.1 Lite matched the tested meanings but took 750 ms median;
other available candidates refused supported requests or changed their meaning.
Qwen Flash's route was excluded by the account's zero-data-retention setting,
so it has no measured quality result. The comparison preserves settings, failures
and dated catalog prices. Cases were reused, routing/cache state uncontrolled,
and the existing schema had previously been debugged against 2.5 Lite.

Card timings separate inference, database-to-first-batch, database total and
data-to-draw. Database total includes its first-batch span. Provider first-token
time includes transport/queue work. Drawing measures software submission, not
screen presentation; overlapping spans must not be added together.

The host has no normal hardware-WebGPU adapter. Real hosted inference was
browser-tested, but local hardware-WebGPU accuracy and latency remain unverified
on this host. Native GGUF results and deterministic browser fixtures do not
substitute for a hardware-WebGPU run.

## Pick up here next

The direction is set by [vision.md](vision.md). Batch 1 delivered the uniform protocol, model-written
SQL over generic data, and per-keystroke translation without the idle pause (in source). Next:

1. **Merge the renderer and wire the loop end to end** (wave 2): all ten chart types on the Rust/Wasm
   core, browser tests across placements.
2. **Measure thought → result stage by stage** with the TIMING ledger and the latency dial; then
   deploy the tb1 server and the new browser build together ([deploy/README.md](../deploy/README.md)).
3. **Raise NL→SQL quality** with the executed-result eval ([batch-1/evals.md](batch-1/evals.md)):
   the default model is cheap but the weakest on it.
4. **Move components.** A server-side DuckDB node on tb1; ClickHouse; remote inference handing SQL
   straight to a remote database.
5. **Explore interactions:** per-keystroke results, next-question anticipation, chart-as-query, voice.

Operational debt: the public demo has no authentication, and its OpenRouter budget counters are
process-local and reset on restart.

## Documentation map

Full map with current/historical classification: [README.md](README.md).
