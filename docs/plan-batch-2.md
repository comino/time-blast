# Batch 2: attack the two big costs, ship, then explore

Status: proposed 2026-10-11 by the coordinating agent after batch 1 merged. Direction:
[vision.md](vision.md). Evidence: [status.md](status.md) and [batch-1/](batch-1/).

## Where the time goes now

Last keystroke → first draw (fake inference): ~370 ms median on a loaded host. Our own pipeline
(UI, protocol, coordinator, renderer) costs ~10–40 ms of it. The two big costs:

1. **Database first batch:** ~100 ms quiet, 250–440 ms loaded (DuckDB-Wasm, 1.2M rows).
2. **Inference:** ~450 ms to complete SQL (Gemini 2.5 Flash Lite), and it is only 71 % correct.

The vision assumes inference gets ~10× faster, which leaves the database as the limit. So the
database comes first, inference second.

## Workstreams

| # | Workstream | Concrete experiments | Done when |
|---|---|---|---|
| 1 | **Database first batch** | DuckDB-Wasm threaded (COI/pthreads) build, now possible since the page is cross-origin isolated; keystroke-to-keystroke result reuse (same FROM/WHERE, different bucket or aggregate); pre-aggregated rollups built after load (per series × minute/hour) with exact-semantics rewrite; a first-bucket split; ClickHouse remote as the comparison | Measured first-batch p50/p95 for the eval corpus's queries, before/after, with correctness checked against unoptimized results |
| 2 | **Inference latency and quality** | Fast providers and small models via OpenRouter (Cerebras/Groq-class routes), Gemini 3.1 Flash Lite vs 2.5, prompt-prefix caching thresholds, repair on `result_limit`, speculative translation of likely completions of the current draft | Eval-corpus table of correctness × first-SQL latency × cost; a default chosen by the numbers |
| 3 | **Ship batch 1** | Deploy the tb1 server + new browser build together; per-keystroke rate limits; ClickHouse read-only user if it goes public | **Needs the owner's go-ahead** (outward-facing) |
| 4 | **Real hardware** | Hardware WebGPU on the owner's machine; physical keystroke → photon measurement | Needs the owner |
| 5 | **Interactions** | Next-question anticipation, chart-as-query (brush/click → SQL edit), voice | Prototype + measured latency for each |

## Constraints right now

- The development host's disk is ~98 % full (shared with other projects): at most two parallel
  agent worktrees until space is freed.
- Spend caps: inference experiments ≤ $1 per workstream run without the owner's say-so.
