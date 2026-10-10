# Batch 1 · inference

Status: implemented and tested on branch `worktree-agent-a5a5be1c8f2409f19`; **not deployed**.
The model writes DuckDB/ClickHouse SQL directly. The JSON `QueryPlan` protocol and `plan.rs`
are gone from the server.

## What exists

| Piece | Where | State |
|---|---|---|
| Rust server speaking `tb1` | `crates/inference-server/` | implemented, 28 tests |
| Shared NL→SQL prompt (Rust + TS twins) | `src/prompt.rs`, `src/inference-node/prompt.ts` | byte-identical, golden-tested |
| SQL stream cleaner + obvious-invalid check (twins) | `src/sql.rs`, `src/inference-node/sql.ts` | shared case file |
| WebLLM worker speaking `tb1` | `src/inference-node/` | implemented, tested with a fake engine only (no GPU here) |
| tb1 SQL benchmark | `scripts/benchmark-sql.py` | self-test + live runs below |

Shared fixtures (read by both test suites): `crates/inference-server/tests/fixtures/`
`vessels-context.json` (the vessel `DatasetContext`), `vessels-prompt.txt`, `edge-context.json`
(quoting, Unicode, `1e21`, `-0`, `5e-324`, …), `edge-prompt.txt`, `sql-cases.json`.

## Server behaviour (`GET /session`, subprotocol `tb1`)

- Binary frames only, one tb1 frame per message, 1 MiB message limit; a text message, a bad
  frame or a non-HELLO first frame → `ERROR {code:"protocol"}` and close.
- `HELLO` → `READY {"node":"inference","name":"time-blast-inference","version":1,"model"}`.
- `CONTEXT` is stored by id (last 4 per session; re-sending replaces). Its system prompt is built
  once and reused verbatim for every request.
- `INFER` → stamps and frames, all echoing the INFER's `epoch/request/revision/context`:
  - first `SQL_DELTA`: `INFER_RECEIVED`, `PROVIDER_REQUEST` (node 3), `FIRST_TOKEN` (node 6 —
    first content byte from the provider, measured on the server clock), `SQL_FIRST_DELTA`;
  - later deltas: no stamps;
  - `SQL`: the full inference ledger plus `SQL_COMPLETE`;
  - `INFER_STATS {model, promptTokens, completionTokens, cachedTokens?, reasoningTokens?,
    costUsd?, attempts}` — `model` is the provider-reported model; optional fields only when the
    provider reported them. Nothing is estimated.
- Errors: `ERROR {code, message}` with codes `bad_request`, `unknown_context`, `bad_context`,
  `busy` (per-session limit, default 2 in flight), `budget`, `upstream`, `timeout`,
  `invalid_sql`. A failed request that reached the provider is still closed by `INFER_STATS`.
- `CANCEL` request 0: abort everything and adopt the new epoch. `CANCEL` request N: abort N,
  epoch unchanged. Aborting drops the job future → the reqwest body → upstream stream reset
  (tested: the fake upstream sees its body dropped). A cancelled request that already called the
  provider gets `INFER_STATS {…, cancelled: true}` with the usage of finished attempts only (an
  aborted stream reports none; its real upstream cost is unknown to the server).
- `INFER` with an epoch below the session epoch is dropped silently and never reaches the provider.
- Process-wide exact cache (system-prompt hash, trimmed question) → SQL, 4096 entries:
  a hit answers `SQL` with flag `CACHED` and zero-cost stats, no provider call.
- Kept from the prototype: pooled HTTP/2 reqwest client with TCP_NODELAY, HEAD warm-up at start,
  SSE decoder with byte limits, origin allow-list, session cap 64, heartbeat pings,
  `GET /health` (now with protocol, totals of tokens/cost/cancellations and today's budget).

### SQL handling

`SqlStream` strips a leading `<think>…</think>` block and Markdown fences and holds back trailing
whitespace/`;`/backticks, so **concatenated deltas are always a prefix of the final SQL**. It
streams nothing until the first word is `SELECT`/`WITH`/`FROM`/`(` (after comments): prose
never streams. `check()` rejects empty output, a non-SELECT start, a second statement and an
unterminated string/comment — then **one repair** turn (assistant reply + "That reply was
rejected: <reason>…"). Repair deltas stream only if attempt 1 streamed none; otherwise the `SQL`
frame alone is authoritative. No SQL parser dependency; the database node validates.

## Prompt design

System message (stable prefix, built only from the `DatasetContext`), then the trimmed question
as the only user message. Contents: role + dialect; output rules (only one SELECT, no prose or
fences or semicolon, compact SQL, aliases, partial questions get the most plausible answer);
result-shape convention (x first, optional series, value last, `lat`/`lon`, ORDER BY x);
≤ ~5000 rows via time buckets (dialect example) or LIMIT; `-- view: <name>` only on request;
"now" = the first TIMESTAMP/DATE column's max, spelled out as a literal; then the schema: one
line per column with range or low-cardinality values, ≤ 5 sample rows. Values are rendered as
SQL literals; numbers follow ECMAScript `Number#toString` in both languages so the two builders
agree byte for byte. Control characters in names/values become spaces.

Request: `temperature 0`, `max_tokens 512` (`TIME_BLAST_MAX_TOKENS`), `stream: true`,
`stream_options.include_usage`, no `response_format`; OpenRouter adds
`provider {sort: latency, require_parameters: true}` and `reasoning.effort` only if configured.

Token counts (vessel fixture, measured from provider usage): **~857 prompt tokens**, ~40
completion tokens per answer.

**Prompt caching:** none observed. 0 cached tokens in 120 live requests with an identical prefix
(Gemini 2.5 and 3.1 Flash Lite via OpenRouter). Gemini's documented implicit-cache minimum is
1,024–4,096 tokens depending on the model (Google lists 2,048 for 2.5 Flash), above our ~857.
OpenRouter reports hits as `usage.prompt_tokens_details.cached_tokens` at 0.25× input price; the
server passes that through as `cachedTokens`. Padding the prompt to reach the threshold would
raise cost per call; wide real schemas will cross it naturally. The prefix layout is ready.

## Measurements (2026-10-10, live, OpenRouter)

Method: `scripts/benchmark-sql.py`, release build, one warm tb1 session on this host (ARM64,
loopback client), 20 fixed questions × 2 rounds sequentially, server SQL cache off, provider
routing/caching uncontrolled. Client times from INFER send; server stage times from the SQL
frame's ledger relative to `INFER_RECEIVED` (client→server ≈ 0.1 ms). No eval of SQL correctness
was run (that is the cleanup+evals wave); reports contain every SQL text.

| Model / prompt | first SQL_DELTA p50 / p95 | SQL p50 / p95 | provider FIRST_TOKEN p50 | completion tok/req | cost/req |
|---|---:|---:|---:|---:|---:|
| Gemini 2.5 Flash Lite, prompt v1 | 425 / 601 ms | 501 / 760 ms | 300 ms | 67 | $0.000109 |
| **Gemini 2.5 Flash Lite, final** | **411 / 540 ms** | **451 / 592 ms** | 279 ms | 41 | **$0.000102** |
| Gemini 3.1 Flash Lite (reasoning minimal), final | 471 / 574 ms | 539 / 630 ms | 437 ms | 39 | $0.000274 |

Raw reports: `docs/batch-1/sql-bench-*.json` (n = 40 each; cold round 1 vs warm round 2 in each
file; one 1.5 s outlier on 3.1). "Compact SQL" cut completion tokens 38 % and SQL p95 by 170 ms.
Budget: at $0.0001 per translation, 3 $/day buys ~30,000 keystroke translations.

Observed quality issues (both models, not yet scored): every answer starts with a `-- view:`
hint even when none was asked for (2.5 once used `view: histogram`, not a valid name); some
answers return raw rows of the 1.2 M-row table (map tracks, scatter) despite the row rule;
2.5 Flash Lite once wrote SQLite `DATETIME(…)`. 3.1 Flash Lite used DuckDB idioms
(`time_bucket`, `corr`) consistently but is 2.7× the price and ~90 ms slower. Default stays
`google/gemini-2.5-flash-lite` until the eval wave scores executed results.

Self-test (fake provider, no tokens): 20 requests, deltas == SQL, full ledger, stats passthrough,
CANCEL aborts the upstream response; overhead first delta p50 4.9 ms incl. the fake's sleeps.

## WebLLM node

`src/inference-node/webllm.worker.ts` wires `createInferenceNode` (`node.ts`) to the worker's
`postMessage` (frames as transferred ArrayBuffers). HELLO `{"model": "qwen-0.5b"|"qwen-1.5b"|
"qwen3-4b"}` (or a concrete MLC id) → WebGPU adapter check → precision from `shader-f16` →
pinned assets → `STATUS {component:"inference", state:"loading", progress}` → a 1-token warm-up
generation + `resetChat` → `STATUS ready` → `READY {"node":"inference","name":"webllm","model"}`.
INFER before READY waits. One generation at a time; at most one INFER waits (a newer one
replaces it, the replaced one gets `ERROR busy`). CANCEL → `interruptGenerate`, the stream is
drained silently, then `INFER_STATS {…, cancelled:true}`. Same prompt, stream cleaner, check and
repair as the server; Qwen3 runs with `enable_thinking: false` and its empty think header is
stripped. No cost field (local). Tested only against a fake engine: real WebGPU latency is
unmeasured. WebLLM 0.2.85 re-prefills the full ~860-token prompt each request (the new message
list is not a continuation of the previous conversation); KV prefix reuse is a gap.

## Configuration (env)

New or changed: `TIME_BLAST_MAX_TOKENS` (512), `TIME_BLAST_SESSION_CONCURRENCY` (2),
`TIME_BLAST_CACHE_ENTRIES` (4096; 0 disables), `TIME_BLAST_DAILY_BUDGET_USD` (3; enforced from
provider-reported cost), `TIME_BLAST_MAX_CONCURRENT` (16, process-wide upstream slots),
`TIME_BLAST_REQUESTS_PER_MINUTE` (600), `TIME_BLAST_REQUESTS_PER_DAY` (30000). Unchanged:
provider URL/model/key, `TIME_BLAST_OPENROUTER`, `TIME_BLAST_REASONING_EFFORT`,
`TIME_BLAST_TEMPERATURE`, `TIME_BLAST_TIMEOUT_SECONDS`, bind, allowed origins.

## Deployment notes (not done)

- Build: `cargo build --release --locked --manifest-path crates/inference-server/Cargo.toml`
  (crate now has its own `[workspace]` table so it also builds from nested worktrees).
- Install with `sudo python3 scripts/deploy-inference.py <binary>`; health now must report
  `"protocol":"tb1"`. The existing `/etc/time-blast/inference.env` is preserved: on the demo host
  **raise `TIME_BLAST_REQUESTS_PER_MINUTE`/`_PER_DAY`** (the old 30/min would refuse
  per-keystroke traffic) and add `TIME_BLAST_DAILY_BUDGET_USD`.
- The endpoint path is unchanged (`/api/inference/session` via Caddy), but the protocol is not:
  the deployed browser build still speaks `time-blast.inference.v1`. Deploy server and the new
  browser engine together.
- `/infer` and `/draft` HTTP endpoints are removed.

## Requested contract changes

1. Allow an optional `cancelled: true` (and `reasoningTokens`) in `INFER_STATS` JSON — already
   emitted; please add to protocol-v1.
2. Repair restarts: `SQL_DELTA` has no way to say "discard previous deltas". Today the server
   streams repair deltas only when attempt 1 streamed none. Consider `SQL_DELTA` flag `0x01
   RESET` if the coordinator ever uses deltas for early execution.
3. Note in protocol-v1 that `FIRST_TOKEN` is stamped with node 6 (provider phase) on the
   inference node's clock.

## Known gaps

- No executed-SQL eval; quality findings above are by reading.
- Upstream cost of aborted streams is unknown (OpenRouter returns usage only at stream end).
- The view-hint rule is ignored by both Flash Lite models.
- Legacy callers of the removed JSON protocol remain outside this area: `src/inference/remote-socket.ts`,
  `scripts/benchmark-backend.py`, `tests/backend_meaning.py`, `tests/browser_backend_live.py`,
  `tests/browser_remote_backend.py`, `docs/backend-prototype.md`, `deploy/README.md`.
  `scripts/benchmark-models.py` (JSON-plan model matrix) is deleted; `benchmark-sql.py` replaces it.
