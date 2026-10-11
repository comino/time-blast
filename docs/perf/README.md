# Performance history

`pnpm perf` runs a fixed suite and appends one record to [history.jsonl](history.jsonl).
[index.html](index.html) plots it. [budgets.json](budgets.json) says how much each metric may
grow before `--check` fails. Results from the owner's machine come from
[/measure.html](../batch-3/measurement.md) and are ingested into the same file.

```sh
pnpm perf                        # build, run the default suite (~5–8 min here), append a record
pnpm perf --check                # same, then exit 1 on a regression beyond budget
pnpm perf --compare              # no run: check the latest record against its baseline
pnpm perf --suite quick          # 4 rounds, 1 boot: a smoke run (~3 min)
pnpm perf --only micro,db        # a subset (micro, db, e2e)
pnpm perf --no-build --dry-run   # reuse dist/, print but don't append
pnpm perf --with-eval            # also the live NL→SQL eval (costs money; off by default)
pnpm perf --ingest file.json     # add a /measure.html report as a hardware run
python3 -m http.server -d docs/perf 8000   # then open http://localhost:8000/
```

Needs Python Playwright with Chromium (as the other browser tests). The harness builds with
`vite build`, starts its own `vite preview` on a free port and the fake inference node
(`tests/fake_inference.py`, inside `scripts/perf/e2e.py`), and stops both by PID.

## The suite

| Metric | What | Source |
|---|---|---|
| `e2e.keystroke_to_draw` | last keystroke → first draw submitted, per typed question, fake inference in echo mode (every keystroke new SQL, 0 ms). Stage breakdown from the app's TIMING ledger | `scripts/perf/e2e.py` |
| `e2e.redraw_keystroke_to_draw` / `_presented` | every request drawn while typing that put a **new** image up (not a steady adoption): keystroke → submit, → WebGPU `onSubmittedWorkDone` | same |
| `e2e.chip_to_draw` | next-question chip click → first draw (prepared: PRIME + WARM) | same |
| `e2e.gesture_brush_to_draw`, `_legend_`, `_back_` | chart-as-query pointer/Escape → first draw | same |
| `e2e.first_query_after_boot` | the first question typed right after boot (cold caches, rollups building) | same |
| `boot.first_visit.*`, `boot.repeat_visit.*` | navigation → engine worker created, inference/renderer ready, **answerable** (CONTEXT and all nodes ready). First visit = fresh browser context; repeat = reload in it | same |
| `db.first_batch` | EXEC → first batch over the 112 corpus reference statements, optimized node (the app's defaults), result cache cleared; one sample = a statement's median of 3 | `scripts/perf/database.mjs` |
| `db.cache_hit`, `db.open`, `db.rollup_build` | result-cache replay; vessels generation + context; background rollups | same |
| `micro.coordinator_input_*` | Wasm coordinator `input()` + `drain()` per DRAFT (latest: stored; restart: CANCEL + INFER), µs | `scripts/perf/micro.mjs` |
| `micro.frame_encode_*`, `micro.frame_decode_timing` | tb1 codec on a 17-stamp TIMING and a SQL frame, µs | same |
| `eval.*` (optional) | first SQL delta and complete SQL per question against a live server; correctness is stored in `record.eval`, not budget-checked | `scripts/eval-sql.mjs` |

All browser numbers are software timestamps of a production bundle on this host's GPU path
(SwiftShader here, labelled in every record): draw **submission**, not photons.

## A record

One JSON object per line: `commit`, `dirty` (tracked files modified; `docs/perf/` and
untracked files ignored), `date`, `host` (name, CPU, cores, arch, memory, Node, **load average
before and after**), `browser`, `gpu` (`swiftshader` | `hardware`, API and adapter), `settings`,
and per metric `n`, `median`, `p95`, `min`, `max`, `ciLow`/`ciHigh` (95 % percentile-bootstrap
band of the median, 2000 resamples, fixed seed), plus `stages` (per-stage median/p95 deltas of
composite metrics), `notes` and `durationS`. Hardware records (`source: "hardware"`) carry the
browser's view of the machine instead of load averages.

## Noise control

This host is shared and often at load 10–20 on 4 cores. The harness does not pretend otherwise:

- **Load is recorded** before and after every run; the dashboard shows it per point.
- **Interleaving:** each e2e round types, clicks a chip and gestures in turn, so a load spike
  hits every metric alike; database statements are reshuffled every repeat; micro-bench batches
  rotate their order. `--repeat n` runs the whole suite n times and pools the samples.
- **Band, not a point:** every median comes with its bootstrap band.
- **Baseline = the median of the last `baselineRuns` (3) comparable runs** — same source, suite,
  host and GPU backend. Runs on other machines never mix.
- **A regression must clear three bars:** the median grew by more than the relative budget
  **and** more than the absolute budget, **and** the run's band lies entirely above the
  baseline's band. Optional p95 budgets catch tails on thresholds alone. A metric that the
  previous comparable run had but this run lacks also fails. Improvements are reported.

## Budgets and how they were chosen

See [budgets.json](budgets.json) and the measured spread in
[batch-3/measurement.md](../batch-3/measurement.md). Each budget sits above the largest
run-to-run change of that metric's median seen across the seed runs on this host, so ordinary
noise passes, and the absolute floor keeps sub-millisecond metrics from failing on percentages
of nothing. When the history grows, re-derive them from it rather than tightening by feel.
