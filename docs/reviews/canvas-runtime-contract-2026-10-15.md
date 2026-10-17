# Canvas runtime contract review

2026-10-15. Static review of the proposed runtime extension against the current Rust
coordinator/renderer and TS host. No code edits, builds or provider calls.

The revised plan is implementable without a new database protocol or concurrent source
engines. The owner clarified during review that **generation identifies an operation/edit
incarnation**, not the chart lifetime: BeginEdit, resume, restore and refresh rotate it;
keystrokes within one edit keep it and the base fixed. Registration binds a source context;
releases carry the exact generation; tombstones reject older registration. This resolves the
initial ambiguity around reusing an immutable edit handle for successive bases.

The remaining requirements below are implementation blockers or concrete lifecycle traps,
not claims that the proposed feature already exists and is failing.

## P1: necessary contract decisions

### 1. Scope revision ordering as well as adoption by operation identity

Current `on_draft` compares against the one previous draft's revision before inspecting any
other identity (`crates/tb-coordinator/src/lib.rs:467`). `pump` also treats
`head.revision >= draft.revision` as coverage (`:823`); failed-request retry suppression uses
the same comparison (`:835`). Adding target checks only inside `adopt` will miss both paths.

**Failure trace:** edit A reaches sequence 40; BeginEdit B registers a new generation and sends
sequence 1. B is dropped as old, or A is treated as already covering B. The same problem occurs
when a saved draft is resumed with its own sequence counter.

**Required:** order revisions only within `(slot,generation,edit-context identity)`; validate
target generation and source before touching global draft/head state. On changing that identity,
reset the editor's comparison/retry state. A single shared inference scheduler can still finish
an earlier committed request, but its completion must use its recorded target, not the current
editor. Within one identity, same-sequence COMMIT must have identical text to its DRAFT;
otherwise reject it instead of accepting a mismatched checkpoint.

Also make short-text cancellation and `newer_than_shown` target-aware: today they respectively
unbind the global live slot (`:490`) and compare global `live_bound/pending_spec` (`:993`).
Targeted COMMIT must not call the legacy `keep()` that pops the live pool (`:1072`).

### 2. Generation must fence BIND itself; separating stream binding from retained image is necessary

The renderer accepts every BIND for an attached slot (`src/engine/render/index.ts:135`;
`crates/tb-render/src/renderer.rs:359`). BIND currently contains slot/view but no generation.
Database batches reach the renderer before coordinator admission (`src/engine/host.ts:325`).
Fencing only the UI's terminal/non-frame events cannot prevent a stale BIND from authorizing
old data to draw.

**Required:** REGISTER/RELEASE also update renderer target state, and targeted BIND carries
its generation. Reject stale BIND before touching `s.bound` or deleting JS request entries.
Include target generation in SQL/EXECUTION and other UI binding messages so a new execution
request can be mapped before any terminal output. Allocate coordinator request IDs globally
for the worker lifetime and never reuse them across target generations; stream frames can
then keep their existing request/epoch headers.

On new-generation registration, reject further old stream data immediately while retaining
the completed picture. Existing UNBIND clears both pending and shown state
(`crates/tb-render/src/renderer.rs:382`), so it does **not** implement “invalidate work but keep
the old chart.” Add a narrow renderer transition that drops the old pending result and stream
binding while keeping a completed shown result. RELEASE for deletion can clear it entirely.

Keep `displayedRequest` distinct from `activeRequest`. A retained old chart may still produce
resize/axes events while a new result loads. Events must inherit the producing request's
generation, not be stamped with whatever generation is current when their callback runs.
The delayed `presented()` callback is one concrete example (`src/engine/render/index.ts:285`).
If no completed image remains after a partial stream replaced it, restore the base by a new
query or show an explicitly failed preview; rebinding the old request cannot recover deleted
renderer data (`crates/tb-render/src/renderer.rs:612`).

### 3. Source activation needs an explicit suspend boundary, including failure

The database cancels its previous jobs at the beginning of `openDataset`
(`src/engine/database-node.ts:723`), but the host informs the coordinator only after a
successful open (`src/engine/host.ts:243`, `:255`). Database cancellation emits no terminal
frame. A failed open never sends a replacement CONTEXT. Thus previously running coordinator
requests can remain “running” indefinitely while the DB refuses their old context.

**Failure trace:** chart A is streaming; hydration switches to source B; A is silently
cancelled; B fails to open; A's pending checkpoint never receives an outcome and the
coordinator still thinks A's old source is active.

**Required:** before opening B, suspend the active source in the coordinator, terminalize
affected nonterminal requests locally, cancel them at their peers, and block new execution
until activation succeeds. Preserve completed target images. Then activate the new context
or report an unavailable source while remaining suspended. No global CANCEL/epoch reset is
needed for serial activation if all cancelled requests and bindings are invalidated explicitly.

Do not register an executable target against context 0 or merely the desired source name.
Attach shells immediately, then register/bind execution to the resolved current context when
available. A chart's old displayed result may belong to a previous source generation; it must
not prove that the newly opened generation already completed the same SQL.

### 4. Cancellation cannot leave cancelled requests eligible for adoption or later success

`Request::usable` excludes failed execution but **does not exclude `Exec::Cancelled`**
(`crates/tb-coordinator/src/lib.rs:164`). `supersede` sets only `Exec::Cancelled` when the old
query is running (`:1061`). Database admission rejects Cancelled/Idle, but not Failed/Done
(`:755`), so a malformed late sequence can still emit progress after terminal state. Error
handling can also mutate previously completed requests (`:678`).

**Required:** define legal transitions and make terminal states absorbing. For reuse, ask
specifically for a translated execution that is running or succeeded; never use the current
generic `usable()` predicate. Emit exactly one cancellation per execution attempt before
discarding it. Later SQL, ERROR, SCHEMA, BATCH and DONE must not resurrect it. Renderer admission
must be invalidated at the same time because it precedes coordinator admission.

Internal dedup retirement currently sets the new request's phase to Cancelled (`:1054`); do
not emit a user-visible cancellation merely because that bookkeeping flag changes. Its
candidate receives the adopted execution's real outcome.

### 5. SQL and terminal events must cover cache/adoption paths and distinguish retry attempts

Sending UI SQL only from `on_sql` misses coordinator cache hits: these go directly from
`start` to `release` (`crates/tb-coordinator/src/lib.rs:920`). It also misses explicit QUERY.
Text adoption changes the served revision without a new SQL frame (`:873`), while SQL dedup
can switch from a newly allocated request to a previously bound execution (`:1042`).

**Required:** emit a final candidate SQL event from the common accepted-SQL path, including
QUERY and cache hits. Adoption to a new edit sequence also re-emits candidate SQL followed
by either an immediate completed outcome or an explicit association with the still-running
execution. Key the document event by `(slot,generation,sequence)` and include the actual
execution request/attempt ID separately; physical request ID alone is not candidate identity.
Emit SQL before terminal status, and install all mappings before routing EXEC because the
local DB may complete synchronously (`:559`).

The request GC contract needs one of two small implementations: retain lightweight current
execution metadata in the target registry, or pin only each target's active/last-successful
request. “Emit before GC” alone is insufficient for a later Enter/adoption to consult a
completed execution.

Reconnect currently retires the in-flight translation and automatically retries it
(`:646`). That retry can retain generation/sequence but must have a new attempt identity.
The UI must reject an old attempt's terminal event after the replacement attempt starts.
Alternatively rotate operation generation when retrying, while keeping the durable draft
session and sequence. A transient internal retry is not the same as the user discarding an
edit; do not accidentally close its durable draft.

### 6. Reusing old opcodes is safe only behind explicit local-coordinator capability gating

The proposed interpretation uses `header.request` as slot for DRAFT/COMMIT and generation for
QUERY. This can work, but these are new wire semantics even though the kinds are old. The
current coordinator ignores DRAFT's request and treats its entire payload as text
(`crates/tb-coordinator/src/lib.rs:463`); it ignores QUERY's request (`:503`). An old
coordinator can therefore interpret the new payload or run QUERY without generation fencing.
Negotiating only with the inference server does not protect this boundary.

**Required if retaining the encoding:** reserve generation 0 for legacy messages; require the
target extension before sending targeted forms; reject legacy QUERY aimed at registered
targets; specify a typed encoder/decoder for each message and do not let a generic request
router treat slot/generation as an execution request. REGISTER must bind `header.context` to
the target; DRAFT/QUERY must match it exactly. Same-generation registration must be an
idempotent replay of identical immutable content, never a redefinition. A released generation
cannot become active on replay.

Admission failures occur before an execution request exists. Return an explicit target-scoped
rejection carrying slot/generation/sequence; do not emit ERROR with the overloaded input
`request` and let the UI interpret it as an execution request. Otherwise a rejected generation
can collide with an unrelated request or leave an operation pending forever.

**Smaller protocol adaptation:** use new targeted DRAFT/COMMIT/QUERY kinds with a consistent
`slot,generation` payload prefix while leaving `header.request=0` on input. This costs a few
enum variants and golden vectors but makes unknown old peers reject instead of executing
without fencing. It is not mandatory if capability gating is guaranteed at the coordinator
boundary. Keep ordinary inference and database EXEC payloads unchanged.

## P2: preserve the smaller implementation

### 7. Prefer fresh EXEC plus existing result-cache replay over cross-generation adoption initially

Requiring target and edit-context identity equality for adoption is safe. It means a newly
registered edit generation cannot automatically adopt the old generation's completed base.
That is an acceptable first-release boundary. A fresh EXEC reaches the existing bounded
database result cache, whose completion behavior is already explicit. Do not weaken the
identity check merely to recover this optimization.

Within one immutable edit generation, text/SQL adoption can still work after the completion
contract is implemented. Cross-generation result adoption needs a proven identical source
snapshot and volatility checks; forced refresh must always bypass it. Translation cache keys
can remain canonical base-content keys and need not include incidental slot numbers when the
operation, complete prompt/base and source context match.

### 8. Full presentation replacement must reset existing view-family state too

Clearing `Slot.params` alone does not clear values already applied inside a retained view
family. `ResultState::select` reapplies params only when a new family is created
(`crates/tb-render/src/renderer.rs:87`), while `set_param` updates existing families (`:339`).
A rollback from rotation=90 to omitted/default rotation can keep the old 90-degree geometry
if the same family is retained.

Replace the slot's presentation atomically and reset/rebuild affected view families (or apply
every supported parameter's default explicitly) before reporting its state. Apply it to the
intended pending/displayed result, not an unrelated old preview. A general public parameter
patch API is unnecessary for the first implementation; a small replace-presentation operation
is sufficient.

## Minimal acceptance traces before integrating storage

1. Target A sequence 40 → target B generation change sequence 1; B translates, A may finish
   only into A, and targeted COMMIT never consumes a legacy pool slot.
2. BeginEdit g1 → commit → BeginEdit g2 → delayed REGISTER/RELEASE/DRAFT/BIND g1. g2 and its
   immutable base survive; no old batch draws.
3. A streaming → activate B → B fails to open. A's operation gets one terminal cancellation;
   completed chart data remains visible; no execution is admitted against a phantom context.
4. Same-text adoption, identical-SQL adoption while running, completed adoption after GC,
   coordinator translation-cache hit and explicit QUERY each deliver SQL then one correct
   candidate outcome. Cancelled/failed executions cannot be adopted.
5. Reconnect retry of the same generation/sequence followed by an old attempt's terminal
   event. Only the replacement attempt can change the candidate outcome.
6. Replace presentation from explicit view/rotation to Auto/empty params using a retained
   renderer slot; family state and UI controls agree with the restored definition.
7. New UI plus old coordinator or old inference peer. Editing is rejected before execution;
   plain question inference and saved-SQL hydration remain available where supported.

The registry, explicit source-suspend transition and target-specific completion path are the
main changes. Reusing the existing guarded EXEC stream, one coordinator, one renderer and
serial source activation remains the smallest coherent implementation.
