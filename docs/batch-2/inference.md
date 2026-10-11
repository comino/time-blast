# Batch 2 · inference: fastest correct NL→SQL

Status: measured 2026-10-11 on branch `worktree-agent-a0ae6a1de8eca0c6b`; **not deployed**.

**Result:** the server default is now **`openai/gpt-oss-120b` on Groq with reasoning `low`**.
On the 45-question executed-result eval it is **91 % correct in all four runs** (Gemini 2.5 Flash Lite:
71 %). First SQL delta is **256–374 ms p50** (2.5 Flash Lite: 330 ms) and it costs **$0.00015–0.00017
per translation** (2.5 Flash Lite: $0.00012). It is more correct than Gemini 3.1 Flash Lite (87 %),
~200 ms faster and half the price. It also returns no raw rows and no unasked `-- view:` hints.

## Method

`scripts/eval-sql.mjs` (unchanged scorer, corpus v1, 45 questions) ran against the release Rust
server on this host. Each run used a fresh server on a private port, server SQL cache off, and
sequential requests over one tb1 session. Latency is client-side from INFER send (loopback). Tokens and cost are the
provider-reported `INFER_STATS`. Routing is set with the new `TIME_BLAST_REQUEST_EXTRA`
(OpenRouter `provider` object, `service_tier`). With n = 45, p95 is the third-highest value. The host is shared and loaded,
and provider-side time varies from run to run (the default ran at 256, 269, 278 and 374 ms p50
with identical answers and cache hits). Treat ±50 ms p50 as noise.

Raw reports: `docs/batch-2/eval-<model>-2026-10-11-b2-<label>.json` (every SQL, verdict, latency,
stats) and `prefixes-*.json`.

## Model / provider sweep (prompt v3, temperature 0)

Categories: exact / equivalent / shape / wrong / sql-error. Tokens per request: prompt /
completion / reasoning (part of completion) / cached. "rep" = requests that used the repair turn.

| Run | Model | **correct** | ex/eq/sh/wr/err | first delta p50 / p95 ms | SQL p50 / p95 ms | tokens p/c/r/cached | rep | cost/req |
|---|---|---:|---|---:|---:|---|---:|---:|
| **default** (Groq, low) | openai/gpt-oss-120b | **91 %** | 3/38/0/4/0 | 374 / 1025 | 463 / 1067 | 929 / 120 / 69 / 757 | 0 | $154µ |
| default, repeat | openai/gpt-oss-120b | **91 %** | 3/38/0/4/0 | 278 / 780 | 403 / 934 | 929 / 118 / 68 / 597 | 0 | $166µ |
| oss120-groq-low (`only: groq`) | openai/gpt-oss-120b | 91 % | 3/38/0/4/0 | 269 / 662 | 401 / 707 | 929 / 119 / 68 / 580 | 0 | $167µ |
| oss120-groq-low, repeat | openai/gpt-oss-120b | 91 % | 3/38/0/4/0 | 256 / 573 | 364 / 630 | 929 / 117 / 67 / 751 | 0 | $153µ |
| oss120-groq-medium | openai/gpt-oss-120b | 87 % | 4/35/0/3/3 | 651 / 1531 | 777 / 1564 | 1016 / 335 / 284 / 666 | 4 | $303µ |
| oss120-cerebras-low | openai/gpt-oss-120b | 76 % | 2/32/1/10/0 | 416 / 1844 | 432 / 1853 | 929 / 113 / 60 / 836 | 0 | $410µ |
| oss120-sambanova-low | openai/gpt-oss-120b | 82 % | 3/34/0/7/1 | 555 / 797 | 587 / 873 | 929 / 129 / 78 / 0 | 0 | $253µ |
| oss20-groq-low | openai/gpt-oss-20b | 76 % | 2/32/0/10/1 | 314 / 599 | 373 / 617 | 929 / 82 / 32 / 273 | 0 | $84µ |
| llama70-groq | meta-llama/llama-3.3-70b-instruct | 78 % | 6/29/0/5/5 | **216 / 345** | **320 / 426** | 888 / 46 / 0 / 0 | 0 | $561µ |
| llama8-groq | meta-llama/llama-3.1-8b-instruct | 31 % | 4/10/2/21/8 | 116 / 136 | 216 / 512 | 888 / 73 / 0 / 455 | 0 | $39µ |
| qwen38-27b-cerebras (reasoning none) | qwen/qwen3.8-27b | 78 % | 7/28/1/8/1 | 287 / 694 | 297 / 722 | 1009 / 45 / 0 / 0 | 0 | $1067µ |
| baseline (old default) | google/gemini-2.5-flash-lite | 71 % | 5/27/2/5/6 | 330 / 1055 | 478 / 1255 | 992 / 47 / 0 / 0 | 0 | $118µ |
| 31fl (reasoning minimal) | google/gemini-3.1-flash-lite | 87 % | 5/34/0/6/0 | 502 / 594 | 584 / 716 | 994 / 50 / 0 / 0 | 0 | $323µ |
| 31fl, `service_tier: priority` | google/gemini-3.1-flash-lite | 87 % | 5/34/0/6/0 | 456 / 616 | 557 / 742 | 994 / 50 / 0 / 0 | 0 | $582µ |
| 35fl (minimal) | google/gemini-3.5-flash-lite | 78 % | 2/33/1/9/0 | 465 / 574 | 580 / 683 | 994 / 55 / 0 / 0 | 0 | $436µ |
| haiku55 (provider default reasoning) | anthropic/claude-haiku-5.5 | **93 %** | 7/35/1/2/0 | 1485 / 2456 | 1633 / 4673 | 1384 / 310 / 214 / 0 | 4 | $293µ |
| haiku55, reasoning none | anthropic/claude-haiku-5.5 | 87 % | 5/34/1/5/0 | 509 / 1031 | 909 / 1372 | 1328 / 97 / 0 / 0 | 2 | $181µ |
| mercury25, reasoning none | inception/mercury-2.5 | 69 % | 3/28/2/8/4 | 612 / 1067 | 621 / 1080 | 995 / 44 / 0 / 0 | 0 | $46µ |
| nemotron35-lightning | nvidia/nemotron-3.5-lightning | 60 % | 3/24/1/9/8 | 283 / 331 | 434 / 826 | 1004 / 66 / 0 / 0 | 0 | $83µ |
| ministral-8b | mistralai/ministral-8b-2512 | 27 % | 3/9/4/22/7 | 313 / 510 | 882 / 1596 | 993 / 67 / 0 / 876 | 0 | $41µ |

Not measurable: `mistral-small-2603` (HTTP 429 on 42/45, rate-limited ZDR route) and
`gpt-5.4-nano` (HTTP 404 with reasoning `minimal` and `none`: no ZDR endpoint accepts our
parameters). `mercury-2.5` with its default reasoning used all 512 tokens on reasoning (0 %).
Candidate list: OpenRouter's ZDR endpoint list (`/api/v1/endpoints/zdr`, 2026-10-11).

Findings:

- **Provider matters as much as model.** The same gpt-oss-120b weights at `low` scored 91 % on Groq,
  82 % on SambaNova and 76 % on Cerebras. Cerebras wrote `SELECT vessel cnt …` (a dropped
  `count(*)`), aliased buckets as `ts`, and had a 1.8 s p95. The default pins Groq first with
  `provider.order`; `order` and `only` gave the same answers.
- **Reasoning effort:** `low` (~68 reasoning tokens) beats `medium` (~284) on both correctness and
  latency. More thinking added `LIMIT`/CTE variants and 2 cut-off replies.
- **Fastest first delta:** Llama 3.3 70B on Groq (216 ms p50) is fast, but it is 78 % correct
  at 3.6× the cost. gpt-oss-120b's ~68 reasoning tokens cost ~50–100 ms against it on Groq.
- **Claude Haiku 5.5** is the most correct (93 %) but takes 1.5 s with default reasoning. Without
  reasoning it is 87 % at 509 ms.
- **Gemini priority tier:** −46 ms first delta at 1.8× cost. Not worth it.

## Prompt and output shaping

- **Prefix caching exists now.** Groq caches our ~930-token prefix: **580–757 cached tokens per
  request** on gpt-oss-120b, billed at 0.5×, which is already in the cost column. Cerebras also caches
  (836). Gemini 2.5/3.x Flash Lite report **0 cached tokens** at ~992 prompt tokens: OpenRouter lists
  Gemini 2.5 Flash's implicit-cache minimum as 1024 tokens, so we sit just below it.
- **Output tokens:** gpt-oss emits no `-- view:` hint on unasked questions (0/45; Gemini: 27–29/45),
  so its SQL is shorter. Its completion count is higher only because of its ~68 reasoning tokens.
- **Prompt v4a** (row rule rewritten: "must aggregate … use LIMIT only for top/first/latest"):
  gpt-oss 91 → 87 %, 2.5 Flash Lite 78 → 73 % (with row check). **Rejected.**
- **v4b = v4a without sample rows** (prompt ~780 tokens instead of ~930–990): gpt-oss 80 %,
  2.5 Flash Lite 82 %. In this run gpt-oss reported ~1550 prompt tokens on 37/45 requests, as
  if two prompts were billed per request with `attempts: 1`. The cause is unknown and no other run
  showed it. It is worse for the default model and
  its cost rises, so the sample rows stay. Gemini moved ±4 questions between prompt variants
  that should not matter, so its prompt effects are within noise at n = 45.
- **Prompt unchanged (v3).** The Rust/TS builders and golden fixtures are untouched.

## Repair

### Implemented inside the server: raw-row pre-check (`TIME_BLAST_ROW_CHECK`, default on)

`sql::raw_rows` / `rawRows` (twins, shared cases in `tests/fixtures/sql-cases.json`) flags SQL
that reads a table with more than 5000 rows (from the `DatasetContext`) and has none of these:
GROUP BY, an aggregate call (not windowed), DISTINCT, QUALIFY, a sample, LIMIT ≤ 5000, or `=` on a
time column. Such a first reply gets the existing single repair turn. The repair message names
the table, its row count and the fix ("aggregate it, for example GROUP BY a time bucket, or add
LIMIT"). It never runs on attempt 2, and it is conservative: anything that might aggregate passes.

- Offline over every saved report: 0 false positives on the 45 reference queries and on every
  correct model answer except one equality-filter case, now covered by the time-column rule. It flags
  7 of the 13 failures of 2.5 Flash Lite v3.
- **Live, 2.5 Flash Lite: 71 → 78 %**, raw-row answers 7 → 0, sql-errors 6 → 1, 7 repairs. Cost
  +17 % ($138µ vs $118µ per request), SQL p50 +31 ms, because only the repaired answers are slower.
- **gpt-oss-120b: no effect.** No reply trips it (91 %, 0 repairs).
- Streaming: attempt 1's deltas have already gone out when the check runs; the `SQL` frame carries
  the repaired SQL. This is the same contract as the existing invalid-SQL repair, and the
  coordinator only acts on `SQL`. Requested contract change: `SQL_DELTA` flag `RESET` (see below).

### Proposed: repair on database `ERROR` (not implemented, contract change)

Flow: database → coordinator `ERROR {code: result_limit | sql_error | timeout}` for request N
whose SQL came from inference, not from a cache. The coordinator sends inference
**`REPAIR`** (new kind, or `INFER` with flag `REPAIR`) with the same session/request/epoch, a new
revision, and payload `{sql, code, message}`. The inference node keeps the last turn of each
request (≤ a few seconds, bounded) and appends the assistant SQL and "That query failed in the
database: <code>: <message>…" as the repair turn. It answers with `SQL` + `INFER_STATS
{attempts: 2}`. When both run remotely, the database node could send the `REPAIR` straight to
inference: remote components talk directly.

Estimated value, simulated with `--db-repair` (the failed SQL and error are appended to the question, then scored again):

| Model | DB errors | repaired by a DB-error turn | after the pre-check |
|---|---:|---:|---:|
| gpt-oss-120b (default) | 0 / 45 | — | 0 |
| Gemini 2.5 Flash Lite | 6 / 45 | 1 (most "fixes" became `LIMIT 5000`, i.e. wrong) | 1 left (`meridian_yesterday`, VARCHAR − INTERVAL) |

**Recommendation:** worth little now. On the default model it catches nothing, and on 2.5 Flash
Lite the in-server pre-check already captures most of the value, ~400 ms earlier, without a
database round trip. Revisit once the database guard rejects more classes of SQL or a weaker
model is the default. Every DB-error repair costs a database execution plus a full inference call
(~450 ms) on the critical path.

## Speculative translation: prefix replay

`node scripts/eval-sql.mjs --endpoint … --prefixes 0.5,0.75,0.9` translates each question's first
50/75/90 % of characters (cut mid-word, as typed) and compares the prefix's SQL and executed
result with the full question's.

| Model | final correct | same SQL text 50/75/90 % | same result 50/75/90 % | early *and* correct at 90 % | cost (180 req) |
|---|---:|---|---|---:|---:|
| gpt-oss-120b (default) | 41 | 0 / 5 / 8 | 5 / 11 / **28** | 25 | $0.026 |
| gpt-oss-20b (Groq) | 34 | 1 / 3 / 8 | 3 / 9 / 27 | 23 | $0.013 |
| Gemini 2.5 Flash Lite (+row check) | 35 | 1 / 0 / 9 | 3 / 10 / 17 | 13 | $0.025 |

- At 90 % typed, **28/45 prefixes already produce the final result** with the default model, and
  25 of those are correct answers. At 75 % it is 11, at 50 % 5.
- **SQL-text equality is rare (8/45 at 90 %), result equality is common (28/45).** The model
  re-words aliases and clauses between near-identical inputs. The coordinator dedups on SQL
  text, so it misses most of these wins. Proposal for the coordinator/database owners: dedup
  on a normalized SQL form, or compare the first batch's result hash and keep the drawn chart
  when it matches. Measuring how often the normalized form matches is next.
- **A cheap model for prefixes:** gpt-oss-20b matches the final result about as often (27 vs 28 at
  90 %) at half the cost, but its final answers are worse (76 %). A split of 20b for prefixes and
  120b for the stopped-typing request would dedup only when both agree, so it needs measuring
  as a pair; not done.

## Spend

All batch-2 runs: **$0.37** provider-reported, plus one aborted `mercury-2` run (cost not
recorded; ≤ $0.02 by its token rate). Cap was $1.50.

## Configuration changes

- Default when `TIME_BLAST_MODEL` is unset on OpenRouter: model `openai/gpt-oss-120b`, reasoning
  `low` (unless `TIME_BLAST_REASONING_EFFORT` is set), request extra
  `{"provider":{"order":["groq"],"require_parameters":true}}` (unless
  `TIME_BLAST_REQUEST_EXTRA` is set). An explicit `TIME_BLAST_MODEL` starts from plain settings.
- New `TIME_BLAST_REQUEST_EXTRA` (JSON object merged into every provider request; `model`,
  `messages`, `stream`, `stream_options` are refused).
- New `TIME_BLAST_ROW_CHECK` (`true` default / `false`).
- **Deploy note:** `/etc/time-blast/inference.env` on the demo host pins
  `TIME_BLAST_MODEL=google/gemini-2.5-flash-lite` (written by `scripts/deploy-inference.py`). Remove that
  line to get the new default; the deploy script's first-install template should drop it too.

## Requested contract changes

1. `SQL_DELTA` flag `RESET` (0x01): "discard earlier deltas of this request". Repairs after streamed
   deltas (invalid SQL, now also raw rows) make the delta prefix differ from the final `SQL`.
2. `REPAIR` (inference ← coordinator or database): `{sql, code, message}` for one database-error
   repair, as above. Low priority given the measured value.
3. Optional `provider` field in `INFER_STATS` (which upstream served it). OpenRouter reports it,
   and the sweep shows the same model varying 76–91 % by provider.

## Known gaps

- One fixture, 45 questions, sequential single-session load. No per-keystroke burst load against Groq
  rate limits.
- The gpt-oss-120b misses are `first_vs_second_week_speed` (text labels, a scorer gap from batch 1),
  `meridian_yesterday` (latest point instead of the day's track), and `tracks_map` and
  `scatter_wind_wave` (`LIMIT 5000` raw rows; the pre-check deliberately allows LIMIT ≤ 5000).
- The WebLLM node got the row pre-check (TS twin, tested with the fake engine) but has no real-GPU
  measurement.
- Groq's cache hit rate is uncontrolled (580–757 of 929 tokens). The effect of a cache hit on latency
  is not isolated.
