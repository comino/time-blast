# Persistent canvas review: persistence and recovery

Reviewed 2026-10-15 against `docs/persistent-canvas.md`, `AGENTS.md`, `docs/vision.md`
and the current UI, dataset loading, result cache and remote database code. This is
a review of a proposal, not a report of implemented persistence bugs. No tests or
provider requests were run.

The central model is sound: persist intent plus executable definitions, hydrate
without inference, retain immutable revisions, and distinguish completed execution
from first draw. Browser-local IndexedDB is sufficient for the requested reload
and rollback behavior. Server storage is not a prerequisite.

The following gaps need explicit decisions before the storage contract is implemented.

## 1. P1: Draft writes need their own monotonic fence and closed-session state

**References:** `docs/persistent-canvas.md:97`, `:142`, `:146`, `:154`, `:157`,
`:240`, `:257`; `src/ui/draft-encoder.ts:33`, `:69`.

The proposal fences canvas head commits and engine results, but the persisted draft
fields omit the edit-session identity used by runtime promotion. An edit sequence
alone is insufficient across two tabs, a resumed editor, or a second edit of the
same base. Async coalesced draft writes also need checks independent of the canvas
head: saving draft text normally does not change that head.

Failure example: draft update E/7 is queued; Enter commits E/7 and removes its draft;
the delayed autosave then writes E/7 back. Reload resurrects a finished edit. Escape
or deletion can suffer the same resurrection. Two tabs can overwrite the same
chart's unfinished request without either tab committing a new canvas head. Pairing
SQL and text with the same sequence prevents mismatched pairs, but does not prevent
an older complete record from replacing a newer one.

**Minimal remedy:** persist distinct edit-session IDs, require monotonic draft
versions, and close a session atomically with checkpoint/cancel. A closed-session
marker rejects all subsequent writes for that session; starting another edit
allocates a new ID. Preserve competing sessions as separate recoverable drafts.
Keep pending checkpoint intent bound to the exact sequence, not a boolean attached
to whichever text is current later.

Make a monotonically increasing canvas store version mandatory on every head
transition, including undo/redo. Comparing only the head ID admits an ABA race:
another writer changes A → B → A, and an operation prepared against the first A
incorrectly passes the comparison. The phrase “head/store version” at line 240
should not permit an implementation using only the head ID.

“Saved” must correspond to the current acknowledged head and draft version. An
older write acknowledgement must not mark newer pending text as saved.

## 2. P1: A creation draft needs its own source and provisional chart definition

**References:** `docs/persistent-canvas.md:76`, `:97`, `:140`, `:161`, `:182`,
`:201`; `src/engine/contracts.ts:66`; `src/ui/controller.ts:72`, `:147`.

The draft sketch permits a draft before the first successful query but only lists
chart ID, base revision ID, change text, sequence and a candidate. Such a draft has
no revision from which to recover source, presentation or layout. Its base must
also be nullable. For a refinement, those fields can come from the base revision;
for creation, they cannot.

Failure example: drop a CSV, begin a question, move its preview, then change the
default dataset before inference succeeds. Reload recovers text, but not which
source to use or where the unfinished card belongs. Resuming against the current
picker violates the source-identity contract even if the generated SQL is valid.

**Minimal remedy:** use explicit create/refine draft variants. Bind a creation
draft to its immutable source reference when it starts, plus its provisional
presentation and layout. Preserve this record when there is no successful SQL,
the source is missing, or execution failed. A missing file binding should produce
a recoverable shell with the question intact.

## 3. P1: Define recovery export to include work that never reached IndexedDB

**References:** `docs/persistent-canvas.md:157`, `:161`, `:240`, `:244`.

The storage-failure contract promises an export escape hatch, but the export
contract only explicitly names the document and reachable history. It does not
state whether drafts, pending checkpoint intent or a failed write's RAM-only
revision/commit are included.

Failure example: a completed refinement renders, then its checkpoint transaction
fails. Exporting only the stored head produces a valid file containing the old
chart, while omitting the very request/SQL the user needs to rescue. Closing the
page then loses it despite taking the offered recovery action. The same applies
to an unsaved layout change or a chart that has never completed a query.

**Minimal remedy:** recovery export takes a coherent snapshot of retained document
records **plus pending in-memory commands and draft sessions**. Mark uncommitted
work as recovered drafts/pending commands; do not manufacture successful committed
history or save acknowledgements. Include source descriptors, omit file contents,
file handles and credentials. It must work when storage is unavailable.

Define import identity at the same time: importing an old export into an existing
canvas must not silently put its head over newer work. The lean default is import
as a new canvas namespace, preserving original identity as provenance. Replacing
an existing canvas, if offered, is a separate explicit operation.

## 4. P2: History retention/export needs a canvas-owned graph, not head ancestry

**References:** `docs/persistent-canvas.md:54`, `:60`, `:76`, `:91`, `:221`, `:244`.

The semantic records contain a current head and parent pointers. They do not show
canvas ownership for commits/revisions or a collection of branch tips. “Reachable
history” is therefore underdefined. Given A → B → C, undo to B, then edit D, walking
parents from D reaches B and A but never C. Export/retention based on that walk
loses the abandoned future that the product contract explicitly promises to keep.

**Minimal remedy:** scope immutable records by canvas ID and retain/export every
commit owned by that canvas initially, plus its referenced chart revisions,
ancestry and source descriptors. A parent→children index can be derived; no new
branch-management subsystem is necessary. Draft base references are additional
roots if any garbage collection is later introduced. Persist the previously
visited redo child as a preference if redo must recover that choice after reload.

Do not implement compaction or pruning in the first version. Recording all
canvas-owned commits is a sufficient, testable retention rule.

## 5. P2: A source descriptor must preserve the SQL namespace on reattachment

**References:** `docs/persistent-canvas.md:81`, `:171`, `:189`, `:194`;
`src/engine/database-node.ts:738`, `:756`, `:764`; `src/engine/dataset.ts:46`, `:63`;
`src/engine/datasets.ts:19`, `:70`.

The source reference is described as a locator plus identity/schema, but replay
also needs the original table mapping. Today the loader derives the SQL table
name from the incoming file name and autodetects CSV parsing. Reattaching the
same bytes downloaded as `sales (1).csv` instead of `sales.csv` changes the table
name even though content identity can match. Reusing the existing loader as-is
would break the saved `FROM sales` query unnecessarily.

**Minimal remedy:** persist the logical table alias and source/load format with
the descriptor, and bind reattached bytes to that namespace. Capture any explicit
loading options once the UI supports them. Keep the observed schema fingerprint
separate from the locator and the live binding. A schema mismatch remains an
actionable error; do not rename tables or rewrite saved SQL implicitly.

Also distinguish `current` versus `pinned` source policies explicitly. Current
fixture records contain a name and mutable resource URLs, not an immutable
version token; the loader falls through from prebuilt files to manifest tables or
the built-in generator. Existing fixtures can be declared logical/current sources
for v1. A future pinned descriptor must validate the resolved version and may not
take those fallbacks to different data. No data-version archive is required here.

## Minimal draft record and write rules

This is one compact shape sufficient to resolve findings 1–3. `Presentation` and
`Layout` reuse the document's types; `SourceRef` is persisted separately.

```ts
type DraftSession = {
  canvasId: string;
  id: string;                    // durable edit-session ID, unique across tabs
  chartId: string;
  draftVersion: number;          // monotonic for every draft state update
  editSeq: number;               // changes only with inference input
  text: string;
  base:
    | { kind: 'refine'; revisionId: string }
    | { kind: 'create'; revisionId: null; sourceRefId: string;
        presentation: Presentation; layout: Layout };
  candidate?: {
    editSeq: number;
    sql: string;
    presentation: Presentation;
    sourceRefId: string;
    validatedAgainst: string;    // source/data-generation validation identity
  };
  checkpointIntent?: { editSeq: number };
  state: 'open' | 'closed';
  closedAs?: 'committed' | 'cancelled';
  committedRevisionId?: string;
};
```

This is an application record, not a change to the execution frame format. Closed
records can be reduced to tombstones. They need not store a candidate or text
forever; their job is to reject writes from a dead edit session. Closing a session
because its base was restored or changed must retain its unfinished request for
recovery; only explicit discard removes that work. On recovery or a second tab,
a new writer forks a new session rather than taking over a live one.

Required write invariants:

1. Draft mutations compare the expected draft version and require an open session
   in their transaction. A late candidate may not decrease `editSeq`, and it is
   promotable only when its sequence matches current text and checkpoint intent.
2. Checkpoint compares the expected monotonic canvas version, chart/base identity
   and current open draft version in one transaction. It writes the chart revision,
   canvas commit, head/version and closed session together. Referenced immutable
   source records must already exist or be written in that transaction.
3. Undo, restore, delete and Escape invalidate affected edit sessions durably as
   well as cancelling runtime work. An unrelated chart/layout action may preserve
   a draft; rebase the commit only after rechecking its unchanged chart base.
4. A save prepared before an undo cannot update the later head merely because the
   same base revision became selected again. Queue document commands in order and
   retain the monotonic store/version fence; engine cancellation alone is not a
   storage fence.
5. Recovery reads a self-consistent committed graph plus draft records. Pending
   checkpoint intent does not authorize a different edit sequence, and an
   interrupted execution is not a successful candidate.
6. Import validates unique record IDs, parent/revision/source references and
   canvas ownership before publishing a new head. Migration/import either installs
   a fully valid new graph or leaves the original available; a missing reference
   must not turn into a silently blank canvas.

## Acceptance cases worth adding

- Delay a draft write until after checkpoint or Escape; reload and verify the
  closed draft does not reappear. Repeat with two tabs editing one chart.
- Start a chart on a local file, fail before its first SQL success, change the
  picker, reload, and recover the original question/source/layout.
- Fail the checkpoint transaction, export from memory, close the page and import
  into a fresh store; verify the new request/SQL is recoverable alongside history.
- Export/import A → B → C, undo to B, branch D; verify both C and D survive.
- Exercise A → B → A with a delayed writer and verify the store-version conflict.
- Reattach identical file contents under a different filename and keep the saved
  table alias. Separately reject an incompatible schema without losing the chart.

## Deliberately deferred

Server ownership/synchronization, automatic multi-writer merging, cross-device
file access, historical data snapshots and history compaction do not block this
feature. The existing proposal already addresses missing sources, partial stream
failure, empty successful results, volatile/literal-date SQL, stale runtime events
and cache separation at the right conceptual level. The changes above make its
local persistence guarantees precise enough to implement and test.
