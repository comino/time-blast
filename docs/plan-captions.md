# Plan: chart captions (AI title + explanation per revision)

Status: **proposal**, not implemented, nothing measured. Revised after a code-level review by
Codex (2026-10-18), which found that "a separate request" alone does not isolate captions: they
would share the coordinator's cancel path, the WebSocket FIFO, server admission counters,
provider slots and limits, the IndexedDB journal and its cross-tab conflict channel. This
revision removes the sharing instead of arbitrating it.

## Problem

A chart is a conversation: refine, regenerate, Edit SQL and chart-as-query gestures each make a
new `ChartRevision`. The card title is `originalQuestion`, which never changes, so after a few
refinements it describes a chart that no longer exists; after Edit SQL nothing describes the SQL.
Chart history lists change texts, not what each revision *is*.

Per revision we want a **title** (header, history rows) and a 1–2 sentence **explanation** of
what the SQL computes (SQL panel). The SQL stays authoritative; the caption is labelled as a
generated description.

## Hard constraint

**No measurable effect on the data path**: key → SQL → execute → first draw is unchanged
(paired A/B, declared tolerance, see Measurement), and no translation is refused, delayed or
cancelled because of a caption.

## Options

| Option | Data-path cost | Verdict |
|---|---|---|
| A. Title before the SQL in the translation output | +20–40 output tokens before the first SQL byte, every keystroke | Rejected |
| B. Title after the SQL in the same stream | None only after a real SQL-boundary parser and splitting the job lifecycle (today `SQL` is sent after stream end + validation, `infer.rs:335`); +15–25 % output tokens on every speculative keystroke; changes the translation prompt | Experiment in phase 3, not the base |
| C. Deterministic title from the SQL | None | Fallback only (unreadable as a main title) |
| **D. Separate DESCRIBE request per saved revision, on separate resources** | None by construction; verified by A/B | **Chosen** |

D is needed anyway: Edit SQL and old revisions have no translation to piggyback on.

## Design: isolate, don't arbitrate

### 1. A caption link, not the coordinator

Captions do not go through the Rust coordinator or the engine's inference link.

- The canvas controller (main thread) owns a **second tb1 link** to the inference server,
  opened lazily on the first caption and closed after 30 s idle. Same frame codec, same
  `createWebSocketLink`; only its traffic differs. This is a placement of a new node role
  ("describe"), which the uniform-protocol rule allows; it does not require one shared socket.
- Why: the coordinator's UI `CANCEL` ignores the request id and cancels everything
  (`tb-coordinator/src/lib.rs:376`, `:685`), its error path is translation-specific (`:753`), and
  inference capabilities reach the UI through host-specific messages. A separate link needs no
  coordinator change, no Wasm rebuild, and puts no caption bytes in front of an INFER on the
  shared FIFO socket (`links.ts:253`, `session.rs:341`).
- The link's sender allocates request ids itself (it is the only sender) and keeps
  `id → captured identity`. CANCEL by id. Reconnect drops all pending captions; they are retried
  on the next trigger.
- Cost: one extra session per active tab against `MAX_SESSIONS = 64` while captions are in
  flight. Acceptable for the demo; recorded.

### 2. Self-contained request, no CONTEXT

`DESCRIBE` payload (JSON, ≤ 16 KiB, checked **before** sending; larger SQL gets the
deterministic fallback):

```json
{ "v": 1, "sql": "…", "question": "…", "dialect": "duckdb",
  "columns": { "flights": [["dep_delay","DOUBLE"], …] },
  "previousTitle": "…", "change": "…" }
```

`columns` lists only the tables the SQL references, from the saved `SourceRef` (names and
types). No server CONTEXT, so backfill of old revisions needs no database activation and is
immune to the server's 4-context limit and reconnect context loss.

`DESCRIPTION` reply: `{ title, explanation, model, cached, usage }` with timing stamps;
failures use `ERROR`. Two new kinds appended as wire constants (Rust + TS codec, cross tests).

### 3. Server: separate everything translations use

| Translation resource | Caption resource |
|---|---|
| `Provider` (16 slots, its HTTP client) | Own `Provider` instance: own client/connection pool, own semaphore (2 slots, `try_acquire`, fail fast → `ERROR busy`) |
| Model `gpt-oss-120b` | `TIME_BLAST_DESCRIBE_MODEL`, default a different model (candidate `gpt-oss-20b` on Groq). Groq rate limits are per model per organization, so a different model has its own RPM/TPM bucket. If the same model is configured, the isolation claim no longer holds and the docs say so. |
| `Budget` (600/min, 30 000/day, $3/day) | Own `Budget` (60/min, 2 000/day, $0.30/day). Translation counters never see captions; total spend cap becomes $3.30/day. |
| SQL cache | Own bounded cache keyed by `sha256(promptVersion, model, payload bytes)`: the payload *is* every semantic input. Identical in-flight requests coalesce. |
| `session.active`, epoch, per-session concurrency | Own per-session map, max 1 in flight; a UI-level `CANCEL request=0` on that link cancels captions (keeps the cancel-all contract) |

With separate slots, budget and provider bucket there is nothing to preempt, so the review's
cross-session preemption problem does not arise. What remains shared: server CPU (one small
JSON prompt per save) and the host's network. Both are measured, not assumed.

Prompt: small and separate (not the translation system prompt). Output `TITLE: …` /
`EXPLAIN: …`; the server trims, enforces ≤ 80 / ≤ 320 chars, strips control characters, rejects
empty output. The UI renders with `textContent` only. TS and Rust prompts byte-identical with
goldens, as for translation.

**Browser WebLLM node:** does not advertise `describe-v1`. It has one engine and one job slot
(`node.ts:59`, `:195`), so a caption would delay the next translation. Enable only after a
separate measurement on real GPUs.

### 4. Client storage: a separate database

Captions are derived data. They go into their **own IndexedDB database** `timeblast-captions`
(store `captions`, key `[canvasId, revisionId]`), not the canvas database:

- the canvas DB stays at version 1 (its upgrade handler is not migration-safe, `store.ts:38`);
- no caption write joins a journal transaction (`store.ts:75` opens all stores);
- no caption write fires the canvas BroadcastChannel, which today turns *any* same-canvas
  notification into a cross-tab conflict that stops journal writes (`session.ts:26`, `:81`).

```ts
interface Caption {
  canvasId: Id; revisionId: Id;
  fingerprint: string;   // the request fingerprint; recomputed on display, mismatch = regenerate
  kind: 'generated' | 'fallback';  // a fallback never suppresses generation
  title: string; explanation: string; model: string; at: number;
}
```

Writes are best-effort; failure only means regenerating (a server cache hit). Two tabs may
generate the same caption; the second write is identical and harmless. **Export/import omit
captions** in this phase (validation rejects unknown root fields, `validation.ts:80`); imported
canvases regenerate them.

### 5. Client: when to ask, what to show

- **Capture identity first:** `{canvasId, chartId, revisionId, sql, payload}` is captured
  synchronously when the request is queued. A reply is stored against that identity, whatever
  happened meanwhile.
- **Display is a separate decision:** the header shows a caption only when the card displays
  that revision's saved SQL with no open draft. During refinement the header keeps the typed
  text, as today; the selected durable head is not trusted as "what is shown" (`controller.ts:27`
  tracks draft, request and shown attempt separately).
- **Trigger:** a new head revision whose first result has drawn, plus no translation in flight
  for that canvas (one check of controller state, no timer). Gesture revisions are captioned
  only when the user leaves the chart alone (no new gesture revision for 1 s); a brushing run
  makes many.
- **Presentation-only revisions** (same SQL) reuse the parent's caption; late parent captions
  propagate.
- **Backfill** after real hydration completion (not the current `hydrated` flag, which is set
  before hydration jobs run, `controller.ts:160`): per chart, root → head, at most the last 10
  revisions, one request at a time, so `previousTitle` exists and titles stay stable along the
  chain.
- **UI updates** through a narrow `card.caption(text)`; never `document()` or `title()`, which
  have side effects (`slot-card.ts:134`, `:195`). History rows invalidate per revision.

### 6. UI

Header: caption title, original question in the tooltip. SQL panel: explanation ("Generated
description"), then `SAVED SQL`. Chart history: title, then change text. No caption: today's
behaviour.

## Phases

1. **Prompt and model experiment (no product code).** Caption 30 recorded refinement chains plus
   the eval set's gold SQL with: the compact caption prompt on gpt-oss-20b and on gpt-oss-120b,
   and option B on the translation model. Score faithfulness (does the title describe the SQL,
   not the question; a refined title names what changed), cost and latency. Decide the model.
2. **Server + client, flag off.** Frame kinds, server caption path (own provider, budget, cache,
   map), caption link, caption DB, identity/display rules, UI. Tests: typing and keystroke
   cancels never touch a caption; UI cancel-all does; reconnect; identical-SQL regeneration;
   undo/redo/restore during a pending caption; canvas switch; draft open when a reply lands;
   two tabs; oversized SQL falls back; caption budget exhaustion leaves translation admission
   untouched.
3. **A/B, then ship.** Paired, interleaved runs, captions on vs off, real provider, warm and cold:
   ≥ 300 committed queries per arm for p50/p95 with bootstrap intervals (p99 reported, not
   claimed). Plus a stress arm that captions every keystroke, as an upper bound on interference.
   Assert captions actually ran. Report key → first draw (submission, not photons), translation
   refusals, provider 429s, caption success/latency/cost. Ship when every translation-path
   delta's interval contains zero within ±3 % of p95, and the phase-1 quality gate holds.
4. **Later:** export/import captions (portable format bump), WebLLM `describe-v1`, option B for
   live-preview titles if phase 1 favoured it.

## Cost (estimate, replaced by phase 1)

~400 input + ~60 output tokens (+ reasoning) per caption. On gpt-oss-120b on Groq that is on the order of $0.0002 per saved revision; a smaller model costs less.
Only saves pay; keystroke speculation is unchanged.
