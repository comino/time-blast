# Hosted inference model comparison — 2026-10-10

Gemini 2.5 Flash Lite is older than the current Gemini Lite models. It remains
the deployed default because the alternatives tested here did not improve this
integration's combination of correct interpretation, latency and price.
This is a configuration comparison, not a general model ranking.

## Results

Seven distinct models were screened through the actual release-built Rust
backend. The [initial five-model matrix](../benchmarks/rust-openrouter-model-matrix-2026-10-10.json)
was followed by [two additional candidates and a repeated baseline](../benchmarks/rust-openrouter-model-followup-2026-10-10.json).
Each configuration received the same eight supported questions and four requests
that must be refused, with strict full-plan comparison. One correction attempt
remained enabled. No application plan cache was used.

| Run / model | Exact supported plans | Correct refusals | Median of all supported responses | Median of correct supported plans |
| --- | ---: | ---: | ---: | ---: |
| Initial / Gemini 2.5 Flash Lite | 8/8 | 4/4 | 551 ms | 551 ms |
| Initial / Gemini 3.5 Flash Lite | 6/8 | 4/4 | 752 ms | 713 ms |
| Initial / Gemma 4 26B A4B | 4/8 | 4/4 | 826 ms | 653 ms |
| Initial / Ministral 3 3B | 5/8 | 0/4 | 611 ms | 659 ms |
| Initial / Qwen3.5 Flash | Unavailable | Unavailable | — | — |
| Follow-up / Gemini 2.5 Flash Lite | 8/8 | 4/4 | 454 ms | 454 ms |
| Follow-up / Gemini 3.1 Flash Lite | 8/8 | 4/4 | 750 ms | 750 ms |
| Follow-up / Qwen3.5 9B | 0/8 | 4/4 | 1,099 ms | — |

Latency measures HTTP dispatch on this host to the Rust response, including
validation and any correction. The first median includes failed supported
requests; the second excludes them and can therefore select easier questions.
Neither includes the four unsupported questions. Do not compare success-only
medians as if every model completed the same set of questions. Qwen Flash's HTTP
errors are deliberately excluded from this table's latency columns.

Both baseline runs returned all supported plans on their first attempt. Gemini
3.1 Lite also matched every case, but was slower and more expensive. Gemini 3.5
Lite refused the `1days` surface and named-vessel maximum-wind requests. Gemma
refused four supported requests. Qwen 9B refused all eight supported requests.
These were complete refusals, not exhaustion of the output-token budget.

Ministral silently added an Aurora filter to two fleet comparisons and dropped
requirements from all four unsupported questions. Its other supported mismatch
set `splitByVessel=true` with an already-selected vessel; that is not an exact
plan match, but produces equivalent SQL in the current compiler. The raw strict
score is retained rather than changing expectations after seeing outputs.

Qwen Flash returned HTTP 404 before generation. A separate minimal structured
output probe exposed OpenRouter's reason: `zdr-violation-by-account`, with its
single endpoint excluded by the account's zero-data-retention requirement.
Account privacy settings were not changed. This is an availability limitation,
not a measurement of Qwen Flash's speed or quality.

## Prices and configurations

Indicative input/output prices per million tokens from the public OpenRouter
catalog snapshot saved with each report:

| Model | Input / output | Reasoning request | Temperature |
| --- | ---: | --- | --- |
| [Gemini 2.5 Flash Lite](https://openrouter.ai/google/gemini-2.5-flash-lite) | $0.10 / $0.40 | Omitted, existing provider behavior | 0 |
| [Gemini 3.1 Flash Lite](https://openrouter.ai/google/gemini-3.1-flash-lite) | $0.25 / $1.50 | Minimal | 0 |
| [Gemini 3.5 Flash Lite](https://openrouter.ai/google/gemini-3.5-flash-lite) | $0.30 / $2.50 | Minimal | Omitted |
| [Gemma 4 26B A4B](https://openrouter.ai/google/gemma-4-26b-a4b-it) | $0.0675 / $0.225 | None | 0 |
| [Ministral 3 3B](https://openrouter.ai/mistralai/ministral-3b-2512) | $0.10 / $0.10 | Omitted | 0 |
| [Qwen3.5 Flash](https://openrouter.ai/qwen/qwen3.5-flash-02-23) | $0.065 / $0.26 | None | 0 |
| [Qwen3.5 9B](https://openrouter.ai/qwen/qwen3.5-9b) | $0.10 / $0.15 | None | 0 |

These are catalog snapshot prices, not measured charges or a guarantee that
latency-based routing picks the cheapest endpoint. Model pages and endpoint
prices can differ: for example, Gemma's fast Makora endpoint listed $0.08/$0.32,
and Qwen 9B's page listed a slower $0.08/$0.13 endpoint. Tokenization, corrections,
provider caches and billed reasoning also affect actual cost.

The backend now offers explicit `TIME_BLAST_REASONING_EFFORT` and
`TIME_BLAST_TEMPERATURE` controls without changing existing defaults.
[OpenRouter's reasoning documentation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
distinguishes disabling reasoning from hiding its text. Gemini 3.5 Lite's
catalog marks reasoning mandatory, so it uses `minimal`, not `none`. Sampling
parameters are omitted for that model following
[Google's migration documentation](https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.6).
All profiles keep the same 256-token completion budget; reasoning can consume
part of that budget. Request parameters are required by OpenRouter routing.

## Reproduce and interpret

```sh
python3 scripts/benchmark-models.py --self-test
python3 scripts/benchmark-models.py \
  --binary /path/to/release/time-blast-inference \
  --catalog /path/to/openrouter-models.json \
  --output /path/to/matrix.json
# Follow-up: append these to the same command with a different output path:
# --model google/gemini-2.5-flash-lite:omitted:0
# --model google/gemini-3.1-flash-lite:minimal:0
# --model qwen/qwen3.5-9b:none:0
```

`OPENROUTER_API_KEY` stays in the environment. The runner starts isolated Rust
processes on loopback ports and leaves the deployed service unchanged. It writes
the case/profile manifest before requests, rotates model order between cases,
runs requests sequentially, saves each response atomically, and cleans up its
processes. Each model has a separate pooled provider client. Startup warms only
transport, and HTTP connections to the Rust service are new per request.

The twelve questions are reused development/acceptance cases, not held-out
questions. The existing prompt/schema was previously debugged against Gemini
2.5 Lite; alternative models may benefit from their own integration work. There
was one request per case per profile per run, uncontrolled provider routing,
cache, queue and model warm state, and no sustained load. The two baseline
medians themselves show variability. No p95/p99, browser drawing, database time,
or screen presentation was measured. These results justify retaining the current
default for now, not declaring the older model universally better.

Validation: 34 Rust backend tests, 717 application tests across 25 files, both
benchmark scorer self-tests, release Rust build, and TypeScript/Vite build pass.
