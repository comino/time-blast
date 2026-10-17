# Persistent canvas: architecture review

2026-10-15. Static review of `docs/persistent-canvas.md` against the current source. Read
`AGENTS.md` and `docs/vision.md`. No source changes, tests, builds or provider calls.

The document/definition split is sound, as are SQL-first hydration, immutable edit bases and
preserved question history. The proposal correctly identifies most major seams. It is not
yet a sufficiently precise implementation contract: cancellation, terminal outcomes and
presentation replacement need decisions before storage is wired to today's events. Concurrent
source sessions are not required to deliver mixed-source persistence and should not be an
unmeasured first-release prerequisite.

“Demonstrated” below means a constraint visible in the current code; “risk” means a failure
inferred for the proposed implementation, not a claim that an unimplemented feature is broken.

## Blockers and correctness contracts

### 1. P1 — Target ownership must survive request completion and must fence both directions

**Demonstrated:** the coordinator has one `draft`, `head`, `in_flight`, `live_bound` and active
`context` (`crates/tb-coordinator/src/lib.rs:239`). UI CANCEL ignores its request field and
calls the global cancellation path (`:351`); that path bumps the epoch, cancels all inference
and database work, and clears every tracked request (`:603`). Completed kept requests are
garbage-collected once finished and drawn (`:1117`). Closing a kept card only detaches its
renderer (`src/ui/controller.ts:201`), without cancelling its query.

**Risk:** “release target” cannot be a UI alias for existing Cancel/detach, nor can a durable
chart be represented by a retained `Request`. An undo on chart A could cancel chart B, or a
deleted chart could continue doing expensive work. Having a runtime-to-document map only in
the UI will not make the coordinator direct an inference result into the right target.

The proposal already calls for fencing non-frame replies (`docs/persistent-canvas.md:263`),
but incoming `view`, `param`, `export` and `detach` commands are also slot-only
(`src/engine/contracts.ts:168`), and the host applies them directly (`src/engine/host.ts:217`).
A queued old control can mutate the replacement revision even if its later UI reply is ignored.

**Minimum fix:** specify a target registry independent of requests, with slot, lifetime
generation, active request and edit-base identity. Targeted cancellation invalidates that
generation and cancels only its work; global epoch cancellation remains a separate operation.
Validate the expected target generation/request for incoming data-dependent controls as well
as outgoing replies. One active natural-language editor is enough initially; multiple chart
targets do not require simultaneous inference sessions.

**Acceptance:** delete/restore while a query is running, then deliver old view/param/manipulate
commands as well as old frames; nothing may mutate the new target, and another target's work
must not be cancelled merely by the release.

### 2. P1 — Define exactly-once terminal/adoption events before using them to checkpoint

**Demonstrated:** `RESULT` is emitted at schema receipt (`crates/tb-coordinator/src/lib.rs:763`),
and `KEEP` can precede EXEC (`:1027`). DONE currently produces only TIMING (`:771`), after
which GC can remove the kept request (`:1117`). Database cancellation removes queued jobs or
marks a running job without a terminal frame (`src/engine/database-node.ts:291`, `:455`);
the remote adapter similarly deletes inflight bookkeeping (`src/engine/remote-database.ts:100`).

Adoption mutates an existing request's revision (`crates/tb-coordinator/src/lib.rs:873`). SQL
dedup also adopts running requests, marks the new request cancelled, and emits only BIND and
possibly KEEP (`:1013`, `:1042`). Thus one execution can serve several edit sequences, and a
request's revision at DONE need not equal the revision originally echoed by the database.
Renderer errors currently share the database failure branch (`:678`), contrary to the
proposal's desired separation of renderer failure and SQL validity.

**Risk:** simply forwarding DONE misses successful adoption after a previous DONE, leaves
cancellations pending forever, or assigns the wrong edit sequence to a stored SQL candidate.
Two places independently emitting terminal events can instead checkpoint twice. These are
requirements already recognized in the prose but not resolved by the proposed operation name.

**Minimum fix:** make the coordinator own an execution-outcome state machine. Record the
outcome before request GC, expose an immutable execution identity plus the explicitly served
target/edit sequence, and emit a distinct adoption result when an edit uses an already completed
execution. For a running adopted execution, retain the association until it completes. Generate
cancelled outcomes at the owner that knows cancellation was issued; do not wait for cancelled
peers to reply. Database success/failure and renderer status must be separate fields/events.
Document promotion remains an idempotent transaction keyed by the candidate identity.

**Acceptance:** a completed-result adoption, a running-result adoption that later fails, zero
rows, failure after one batch, queued cancellation, renderer failure after SQL DONE, and Enter
before/after each of those paths.

### 3. P1 — Restoring presentation must replace state, not replay saved settings

**Demonstrated:** a new inference BIND recomputes view from the question text and SQL comment
(`crates/tb-coordinator/src/lib.rs:418`). A hint is accepted only when that question contains a
matching presentation word (`crates/tb-coordinator/src/json.rs:302`). BIND's view then replaces
the slot hint (`src/engine/render/index.ts:137`). Conversely explicit QUERY uses a four-byte
BIND that leaves the old hint intact (`crates/tb-coordinator/src/lib.rs:499`, `:557`).

Renderer parameters only upsert keys (`crates/tb-render/src/renderer.rs:339`); BIND retains the
slot's parameter collection (`:359`). There is no operation to reset omitted parameters.
The UI's “chosen” view is a derived renderer choice, not a reliable record of whether the user
selected Auto (`src/ui/slot-card.ts:130`).

**Risk:** edit “make it weekly” on a manually selected bar chart can reset it to Auto. Rolling
back to a revision with `params: {}` can retain later rotation/playback values. Hydrating a
reused slot can inherit unrelated presentation. Saving the emitted chosen view also converts
Auto into a permanent explicit choice.

**Minimum fix:** one authoritative presentation record with explicit Auto/manual intent. A
target bind/restore replaces the complete presentation, including clearing removed parameters.
For inference edits, define precedence: current presentation survives unless the newest
change explicitly requests a different presentation; only then may an accepted SQL view hint
update it. Do not rediscover presentation by scanning historical questions. Capture user view
intent directly, and test both explicit-view and Auto restoration.

### 4. P1 if multiple sessions are retained — Renderer identities are global, not session-scoped

**Demonstrated:** every coordinator starts requests at 1 (`crates/tb-coordinator/src/lib.rs:278`).
The tb1 header contains epoch/request/revision/context, with no session field
(`src/protocol/frame.ts:42`). BIND even sets context to 0 (`crates/tb-coordinator/src/lib.rs:411`,
`:421`). The renderer's JS request map is keyed only by request (`src/engine/render/index.ts:55`),
and the Rust renderer finds a slot by request plus an epoch inequality
(`crates/tb-render/src/renderer.rs:403`). Database frames are delivered to the renderer before
coordinator admission (`src/engine/host.ts:325`).

**Risk:** “source-scoped runtime sessions with shared renderer” is not obtained by creating
several EngineHosts and forwarding their output. Two request=1 bindings collide; checking a
document ID after delivery cannot undo a wrong draw. Session identity in the document's tuple
is presently transport/runtime identity, not a field that downstream consumers check.

**Minimum fix if choosing that architecture:** allocate one global renderer-visible request
namespace or explicitly translate `(session generation, local request)` at every boundary,
including BIND, batches, cancellation, non-frame events, and sender-assigned WARM requests.
Keep IDs unique across source eviction/recreation. Alternatively retain one coordinator and
one source activation at a time for the first implementation; this avoids the namespace
bridge entirely. Do not change the binary header merely to carry durable chart UUIDs.

### 5. P1 — Editing is a semantic inference change, including repair and cache identity

**Demonstrated:** both backends currently accept a single question of at most 4096 characters
(`crates/inference-server/src/session.rs:184`, `src/inference-node/node.ts:148`) and build one
dataset system message plus one user question (`crates/inference-server/src/infer.rs:270`,
`src/inference-node/node.ts:174`). Repair asks for SQL for “my original question”
(`crates/inference-server/src/prompt.rs:219`, `src/inference-node/prompt.ts:152`). Dataset
contexts are limited to four in both implementations (`crates/inference-server/src/session.rs:32`,
`:122`; `src/inference-node/node.ts:47`, `:126`).

There are three different translation-reuse paths: coordinator `(context,text)`
(`crates/tb-coordinator/src/lib.rs:204`), process-wide server `(prompt hash,question)`
(`crates/inference-server/src/infer.rs:71`), and normalized PRIME
(`src/engine/prime.ts:39`, `:50`). The host consults PRIME before contacting inference
(`src/engine/host.ts:389`). Coordinator text adoption also bypasses translation (`:824`, `:843`),
so changing only cache storage is insufficient.

**Risk:** prepending history to INFER text exceeds today's question limit, obscures create vs
edit, and lets repair revert to an old root question. A cache key using a connection-local
handle can collide after reconnect or eviction. Presentation-word detection over a serialized
history is a separate correctness trap (finding 3). More than four resident sources cannot be
assumed to remain prepared at inference indefinitely.

**Minimum fix:** define a typed immutable EditBase with separate size limits for base SQL,
history and current change, a canonical content key, and a bounded preparation lifetime. Add
golden parity fixtures for both the edit prompt and its repair prompt. Key every translation,
text adoption and dedup decision by operation type and canonical base context; explicitly
bypass PRIME for edit operations initially. Define what happens to prepared edits when the
underlying dataset context is evicted, and reconstruct them before retrying after reconnect.
The current SQL remains the base through the repair turn. No second model call to rewrite the
question is necessary.

### 6. P1 — Negotiate extension support before sending unknown kinds

**Demonstrated:** READY currently advertises version/model but no capabilities
(`crates/inference-server/src/session.rs:87`, `src/inference-node/node.ts:85`). The host reads
only READY's model (`src/engine/host.ts:291`). Both codecs reject unknown message kinds
(`src/protocol/frame.ts:98`, `crates/tb-protocol/src/lib.rs:57`); the Rust session closes the
connection on decode error (`crates/inference-server/src/session.rs:398`).

**Risk:** an old peer cannot receive a new message and politely reject editing at the operation
handler: decoding already fails and the connection is closed. Sending a structured payload
using old INFER instead is worse because an old peer accepts it as a question.

**Minimum fix:** specify the capability string/version and default absent-capability behavior.
Keep create/EXEC compatibility; reject editing locally before sending new operations to an
old peer. Add prepared-context ordering and reconnect behavior to the protocol spec and Rust/TS
golden vectors. Deploy the accepting inference server before the UI that uses it; keep old
frontend/new-server and new-frontend/old-server cases in compatibility tests. New database
message kinds are unnecessary if only coordinator-to-UI terminal semantics change.

## Scope and architecture recommendations

### 7. P2 — Mixed-source restoration does not require concurrent source residency

The mandatory concurrent-session implication in `docs/persistent-canvas.md:201` and `:291`
adds a large subsystem before contextual editing. Source ownership is required; concurrent
engines are an implementation choice, not a requirement in the user's request.

**Demonstrated:** opening another local source cancels old jobs, waits for its query pump,
clears caches and replaces tables (`src/engine/database-node.ts:723`). It does not touch the
renderer. Coordinator context switching unbinds the live slot, not every kept target
(`crates/tb-coordinator/src/lib.rs:620`). The renderer owns copied data and keeps the shown
result until another result is drawn (`crates/tb-render/src/renderer.rs:357`;
`src/engine/render/index.ts:182`, `:188`). One renderer already shares one WebGPU device across
slots (`src/engine/render/backend.ts:94`, `:136`).

**Smaller implementation:** restore all shells, group queued saved queries by source, await
source activation, run that group's registered targets with bounded concurrency, then activate
the next source. Keep each chart's source and result-generation identity independently of
the dataset picker. An edit/gesture/refresh activates that chart's source and moves its work
ahead of background hydration. Preserve completed chart images in the renderer when their
source is inactive. Reopening a source gets a new generation and clears query reuse.

This does require an explicit scheduler. `openDataset()` calls made together are not a batch
API: later calls increment `contextSeq`, causing earlier pending opens to be skipped
(`src/engine/host.ts:234`). Wait for activation before scheduling its queries. The ordinary DB
queue has only 16 waiting slots and counts timeout from admission
(`src/engine/database-node.ts:281`, `:445`; `src/engine/limits.ts:19`), so do not enqueue 100
hydrates at once. All foreground controls must route via the chart's source; today gestures
use the global editor context (`src/ui/controller.ts:178`) and host global dialect/columns
(`src/engine/host.ts:196`).

**Tradeoff:** source changes can be expensive. Finishing or cancelling/requeueing background
hydration before a switch is necessary. “Other charts continue running” would need to mean
their definitions and completed results remain intact; immediate cross-source edits may
interrupt/restart background work. Measure activation and interactive latency before adding
concurrent source runtimes. If uninterrupted simultaneous cross-source execution is explicitly
required, keep the larger architecture and implement finding 4 first.

### 8. P2 — Reuse QUERY; the design's current-code description is too strong

`docs/persistent-canvas.md:41` describes QUERY as requiring an already usable slot. The actual
check rejects a *non-live slot still in the free pool*, but accepts an arbitrary slot absent
from that pool even without a previous request (`crates/tb-coordinator/src/lib.rs:513`). The
renderer requires the slot to have been attached (`src/engine/render/index.ts:135`).

This is not a recommendation to depend on the accidental lack of target validation. It means
a registered-target contract plus existing QUERY is a smaller change than a second saved-SQL
execution path. A renderer slot for a restored document chart can be attached outside the
general composer's live-slot pool. Register validates ownership; QUERY can execute it;
completion supplies the missing lifecycle. Preserve the guarded EXEC/Arrow path unchanged.

### 9. P2 — Specify what “data generation” and Refresh mean

**Demonstrated:** the result cache's correctness relies on immutable data between opens and
is keyed by SQL, with clear-on-open (`src/engine/result-cache.ts:7`, `:30`;
`src/engine/database-node.ts:730`). A source-reference ID and schema fingerprint cannot prove
that remote data is unchanged. No data-generation field exists in DatasetContext
(`src/engine/contracts.ts:83`). Coordinator identical-SQL adoption does not check volatility
(`crates/tb-coordinator/src/lib.rs:1013`), whereas the database result cache does
(`src/engine/result-cache.ts:23`, `:48`).

**Risk:** “same source/data generation” is not yet a usable predicate. A forced Refresh could
silently adopt old data, and SQL using `now()` could be treated as a completed-result equivalent.
Re-executing against an already materialized URL is also different from refetching that URL.

**Minimum fix:** define an execution generation for each resolved source snapshot. A materialized
local open is one generation; only an explicit source revision proves remote snapshot
equivalence. Distinguish evaluate-with-current-loaded-data from reload-source-and-evaluate,
and make forced refresh bypass coordinator adoption. Reuse the database volatility decision
for result adoption or conservatively do not adopt unknown/volatile SQL. Presentation-only
history can still reuse the current chart's known completed execution without claiming it is
a fresh data read.

### 10. P2 — Bound chart residency separately from source residency

The proposal bounds source residency but its 100-chart acceptance case also grows renderer
state. JS retains Arrow batches per bound request (`src/engine/render/index.ts:26`, `:188`),
in addition to copied Rust column stores and GPU geometry. The default export retention is
256 MiB per request (`:42`), and the database allows up to 32 MiB per result
(`src/engine/limits.ts:17`). The WebGL fallback uses a context per slot
(`src/engine/render/backend.ts:210`).

**Risk, not measured:** hydrating every restored chart can exhaust browser memory or graphics
contexts even with only one source resident. Pure database-session eviction does not release
chart buffers.

**Minimum fix:** keep all document shells but bound attached/hydrated chart residency; evict
runtime results independently of their persisted definitions and rehydrate when needed. A
small first release can impose a measured runtime chart limit and a clear deferred state;
it need not solve an infinite-canvas renderer before delivering persistence/edit/history.

## Recommended implementation cut

1. Specify registered targets, full presentation replacement, and terminal/adoption identity.
   Implement the smallest vertical path: one saved chart, reload via QUERY, refine against an
   immutable base, checkpoint, restore an old revision while late work is arriving.
2. Add the document transaction/history store and multi-chart shells using that path. Keep one
   coordinator, renderer and active data source; schedule mixed-source hydration serially.
3. Negotiate the edit protocol and implement both inference prompt/repair twins, with cache
   isolation and the refinement evals the proposal already requests.
4. Add source concurrency only if measurements justify it. The existing architecture already
   has a useful shared renderer and guarded streaming execution; preserve those boundaries.

The vertical slice should arrive before broad canvas controls or a second engine placement
architecture. Persistence, refinement and rollback are one correctness problem: proving that
the definition saved for a chart is exactly the definition whose execution and presentation
the user accepted.
