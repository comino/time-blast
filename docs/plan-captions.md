# Chart captions: an AI title and explanation per revision

Status: **implemented and measured (2026-10-18)**. The plan was reviewed by Codex at code level
before the build. That review found that "a separate request" alone shares the coordinator's
cancel path, the socket FIFO, server admission, provider slots and limits, and the IndexedDB
journal with its cross-tab conflict channel. So captions now share **none** of these.

## Problem

A chart is a conversation. Refine, regenerate, Edit SQL and chart-as-query gestures each make a
new `ChartRevision`. The header used to be `originalQuestion`, which never changes, so after a few
refinements it described a chart that no longer existed. Each saved revision now gets:

- a **title**, shown in the header and in chart-history rows;
- a short **explanation** of what its SQL computes, in the SQL panel, marked "Generated
  description".

The SQL stays authoritative. The question moves to the header tooltip ("Asked: …").

## Design: isolate, don't arbitrate

| Translation uses | Captions use instead |
|---|---|
| Engine worker → Rust coordinator → inference WebSocket | A **caption link**: a second tb1 WebSocket from the canvas controller (main thread), opened on the first caption and closed after 30 s idle. Frames `DESCRIBE` 0x40 / `DESCRIPTION` 0x41 ([protocol-v1.md](protocol-v1.md#captions-separate-link)); the coordinator never sees them |
| Provider client, 16 slots | Own `Provider` instance: own connection pool, 2 slots |
| `openai/gpt-oss-120b` on Groq | `anthropic/claude-haiku-5.5`, reasoning off: another upstream, so separate provider limits |
| Budget 600/min, 30 000/day, $3/day | Own budget: 60/min, 2 000/day, $0.30/day |
| SQL cache | Own cache, keyed by the exact payload (512 entries ≤ 16 KiB) |
| Session map, epochs, concurrency 2 | Own per-session set, max 1 in flight. Typing never cancels a caption; `CANCEL` for its id, or cancel-all, does |
| IndexedDB `timeblast-canvases` journal | Own database `timeblast-captions`: no schema migration, no shared transaction, no canvas broadcast |

- **Request.** Self-contained: SQL, question, the referenced tables' columns (from the saved
  `SourceRef`), the parent's caption title and the change text. No CONTEXT is involved, so
  captions for old revisions need no database. Payloads over 16 KiB get no caption.
- **When.** A revision becomes the chart's head (Enter, refine, regenerate, Edit SQL, gesture).
  After boot or a canvas switch, once hydration jobs have drained, each chart's last 10
  revisions are queued, oldest first, one request at a time, so `previousTitle` exists. A
  presentation-only revision (same SQL) inherits its parent's caption without a request.
- **Identity.** Revisions are immutable. A caption stored for `(canvas, revision)` is valid while
  its SQL equals that revision's SQL and the prompt version matches. A card shows it only while no
  edit is open on the chart. A late reply for a revision the chart no longer shows is kept for
  history and never shown in the header.
- **Failures.** On `budget`, captions pause for 60 s. An endpoint without `describe-v1` is not
  asked again. A dropped link retries the request once the link is back. The browser WebLLM
  node does not advertise `describe-v1`: one engine, one job slot.
- **Files.** Export writes the canvas's valid captions as an optional `captions` field next to
  the strict document, which is otherwise unchanged. Import and Save a copy remap them onto the
  forked revision ids and store them before the canvas opens, so nothing is asked again.
  Malformed entries are dropped and never fail an import.
- **Setting.** Settings → Captions → Chart captions, on by default. Off cancels and restores the
  questions.
- **Prompt.** `src/inference-node/caption.ts` and `crates/inference-server/src/caption.rs`,
  byte-identical, with goldens `caption-*` in `crates/inference-server/tests/fixtures/`.

## Measured

### Quality, cost and model choice

Source: `scripts/caption-eval.mjs`, [caption-eval-2026-10-18.json](captions/caption-eval-2026-10-18.json).

Cases, 58 per model:

- 36 created charts: 6 per dataset, with corpus reference SQL;
- 11 refinements: the canvas edit cases, captioned with the parent's title and the change;
- 11 SQL edits: the same SQL with a stale question, where the title must follow the SQL.

Each caption was graded blind by `claude-sonnet-5.5` against the SQL: 2 = right and complete,
1 = right but vague, 0 = wrong. Latency is request → whole reply, non-streamed, from this host.
The whole experiment cost $0.57.

| Model | Titles = 2 | Explanations = 2 | Any 0 | Change reflected | SQL edit follows SQL | p50 / p95 | $/caption |
|---|---|---|---|---|---|---|---|
| **haiku-5.5, reasoning none** (chosen) | 56/56 graded¹ | 54/56 | 0 | 22/22 | 11/11 | 946 / 1125 ms | 0.00010 |
| haiku-5.5, default reasoning | 53/58 | 50/58 | 0 | 22/22 | 11/11 | 1649 / 2708 ms | 0.00017 |
| gpt-oss-20b (Groq) | 50/58 | 54/58 | 0 | 22/22 | 11/11 | 348 / 722 ms | 0.00005 |
| gpt-oss-120b (Groq) | 48/58 | 57/58 | 0 | 21/22 | 11/11 | 305 / 495 ms | 0.00010 |
| llama-3.1-8b (Groq) | 13/58 | — | 45/58 | 1/22 | 0/11 | — | 0.00002 |

¹ The judge's reply was unparseable for 2 of 58. The 2 explanations scored 1 assume units
(minutes, miles) that the SQL doesn't state.

**Option B**, the title after the SQL in the translation stream (36 create cases): titles
scored 2 on 26/36. Executed SQL was correct on 24/36 without the title instruction and 22/36 with
it, at +10 output tokens p50. It is not adopted: worse titles, a risk to SQL accuracy, and a cost
on every speculative keystroke.

### Interference with the data path (A/B)

**Server level.** Source: `scripts/captions-ab.mjs`,
[captions-ab-server-2026-10-18.json](captions/captions-ab-server-2026-10-18.json).

- Setup: a local server with SQL and caption caches off, so every request reaches the provider.
  The workload is 157 corpus questions × 2 = 314 pairs, in random order. In arm "on", a
  `DESCRIBE` goes out on the caption link at the same instant as each `INFER`. That is the worst
  case: the app sends at most one caption per saved revision, never per keystroke.
- Timing: client-side, INFER sent → frame received, over loopback.

| Translation | Captions off p50 / p95 / p99 | Captions on p50 / p95 / p99 | Δp50 [95 % CI] | Δp95 [95 % CI] |
|---|---|---|---|---|
| → first SQL delta | 274 / 919 / 1476 ms | 264 / 874 / 1238 ms | −10 [−32, +5] ms | −45 [−219, +79] ms |
| → final SQL | 406 / 1050 / 1674 ms | 385 / 1003 / 1380 ms | −21 [−43, +7] ms | −47 [−197, +73] ms |

- No translation was refused or failed in either arm. 314/314 captions succeeded: p50 815 ms,
  p95 1225 ms, $0.029 in total ($0.00009 each).
- Reading: the p50 interval bounds any slowdown at +7 ms, about 2 %, and the point estimate is
  faster. Provider tail noise (±200 ms) is too large to resolve a ±3 % p95 tolerance with 314
  pairs. p99 is reported, not claimed.

**Browser level.** Source: `scripts/perf/captions-ab-browser.py`,
[captions-ab-browser-2026-10-18.json](captions/captions-ab-browser-2026-10-18.json).

- Setup: the production build in headless Chromium with SwiftShader, against the same server and
  the real provider, with the in-browser translation cache off. Each sample types a vessel corpus
  question into a new chart at 70 ms/key and presses Enter.
- Metric: the app's own ledger, last keystroke → first draw *submitted*.
- Arms: switched per pair with the caption setting, in random order. With captions on, the
  previous chart's caption is in flight while the next question is typed.
- Samples: 93 pairs. 4 samples failed to draw in both arms; those were hard questions, not
  captions.

| Key → first draw | Captions off | Captions on | Δ [95 % CI] |
|---|---|---|---|
| p50 | 428 ms | 425 ms | −3 [−50, +43] ms |
| p95 | 1089 ms | 1326 ms | +237 [−432, +589] ms |
| p99 | 2133 ms | 1829 ms | — |

- "On" was slower in 51 of 93 pairs (sign test p ≈ 0.4), with a median paired difference of
  +8 ms.
- The p95 point estimate comes from single provider outliers in both arms (the worst off sample
  was 2567 ms, the worst on 1987 ms). The interval cannot resolve p95 at this N: no evidence of a
  slowdown, and no proof that there is none.
- 164 captions arrived during the run. The rest were cancelled when a pair switched captions off.

**Main thread, measured directly:** handling one caption reply (parse, store dispatch, DOM text,
panel refresh) took **1.5 ms p50, 2.0 ms max** over 12 replies under SwiftShader. It happens once
per saved revision, and that is the only work captions add to the page.

## Next

- WebLLM `describe-v1`, after measuring its effect on the next translation on real GPUs.
- A user-edited chart title as authoring state (a `Change` on the revision).
