# Persistent canvas and chart revisions

**Design proposal, 2026-10-15.** Implementation and verification now live in
[canvas-implementation.md](canvas-implementation.md). The owner's new priority is a canvas that owns
questions, SQL, chart definitions and history; restores them after reload; and supports
agent-assisted changes to an existing chart. This takes precedence over the previous polish
backlog. The [vision](vision.md) still governs execution and measurement.

The implementation uses browser-local IndexedDB with export/import. Cross-device
server storage remains future work. The sketches below describe the design;
the implementation record and protocol specification govern shipped code.

## The product contract

The canvas is a saved, executable document. A chart is the result of evaluating a versioned
definition against a referenced data source. Its identity survives engine restarts, reloads,
changes of SQL, moves and resizes.

- Save the user's original question, subsequent change requests, exact SQL, source reference,
  chart presentation, layout and history. Save unfinished editing separately.
- Restore the document immediately, then hydrate charts by executing their saved SQL. Normal
  reload does not translate the questions again and does not create revisions.
- Send an edit's original question, relevant revision history, current SQL, presentation and
  new change request to inference together with the current dataset schema.
- Keep previous versions. Undo, restore and branching must never destroy the alternative path.
- Store no result batches, input files, rendered images, axis labels or sampled dataset values
  in the canvas. SQL literals and user-written filters remain part of the saved definition.

Restoring an old revision restores its **definition**, not its old data values. The same SQL
may produce different results if the source changed. Exact historical data requires a source
that independently retains versions; the canvas can reference such a version without copying it.

## What the code does today

| Current mechanism | Why it cannot be the durable model |
|---|---|
| `src/ui/board.ts`: card coordinates and camera in memory | No document, restore or layout-change events |
| `src/ui/controller.ts`: `SlotEntry`, `KEEP`, `RESULT` | A card is identified by an engine slot; SQL is transient; keeping can precede successful execution |
| `src/ui/draft-encoder.ts`: 64-entry text ring | Draft revision numbers and question text do not survive reload |
| `SlotEntry.history`: up to 64 previous SQL drill-downs | Clears on a new question; no redo, provenance, canvas history or persistence |
| Coordinator `DRAFT`/`COMMIT`: one global live question | Cannot direct a natural-language edit to an arbitrary durable chart |
| `QUERY`: SQL for an already usable slot | Rejects idle pool slots; hydration needs explicit target registration |
| Coordinator caches `(context, text)`; inference caches `(prompt, text)` | The request "make it weekly" needs a different key for each base query |
| `EngineHost`: one open dataset; coordinator: one active context | Reopening a mixed-source canvas must not run every chart against the currently selected source |

The existing renderer, Arrow stream, SQL guards and transport framing remain useful. The new
document layer controls them through explicit commands; it never serializes their live objects.

## Durable records

Use stable document IDs. Runtime slot, request, epoch and context numbers are allocated afresh
and mapped to these IDs; they are never used as persisted chart or history identities.

```ts
type Canvas = {
  id: string;
  formatVersion: number;
  headCommitId: string;
};

type CanvasCommit = {
  id: string;
  parentId: string | null;
  at: string;
  action: string;                 // "Edit Wind", "Move chart", "Delete chart", ...
  restoredFrom?: string;
  state: {
    title: string;
    charts: Array<{
      id: string;                // stable across every chart revision
      revisionId: string;
      layout: { x: number; y: number; width: number; height: number; z: number };
    }>;
  };
};

type ChartRevision = {
  id: string;
  chartId: string;
  parentId: string | null;
  at: string;
  sourceRefId: string;            // immutable dataset/connection descriptor
  originalQuestion: string;      // verbatim root question; never overwritten
  change: { kind: 'create' | 'refine' | 'gesture' | 'sql' | 'view' | 'regenerate';
            text: string; details?: object };
  sql: string;                   // exact executable SQL, not a diff
  presentation: { view: 'auto' | string; params: Record<string, number> };
  provenance?: { model?: string; promptVersion?: string };
};
```

This is a semantic sketch, not a final wire schema. Full SQL and presentation per revision
make an old chart independently executable. Canvas commits hold small snapshots of membership,
revision pointers and layout; SQL is stored once in its revision record. Start with these
snapshots rather than making recovery depend on replaying a long command log. Measure storage
growth before introducing patch chains or compaction. Retain all reachable branches.

Persist camera and current selection as canvas preferences; panning does not create an undo
step. Persist each edit draft separately with `chartId`, `baseRevisionId`, the exact change text,
an edit sequence, and its latest matching completed SQL candidate. A draft can exist before a
chart has its first successful query. A copied chart gets a new chart ID and an explicit origin
reference; it does not share mutable history with its source.

## Original question, changes and the agent

Keep the original question and append the user's revisions. Do not replace the original with
an agent's paraphrase: that would erase intent and make rollback depend on a lossy summary.
A later concise description of the current chart is display metadata with provenance.

Example:

1. Original: "Average wind speed per vessel by hour." Store SQL A.
2. Change: "Only vessel 7, and use daily buckets." Store SQL B, parent A.
3. Change: "Show the maximum instead." Store SQL C, parent B.

The third inference receives the original question, the relevant changes through B, **SQL B**,
B's presentation, the new request and the current schema. The prompt states that B is the
current implementation: preserve its filters, grouping and presentation unless the new request
changes them. Historical instructions explain provenance; they do not override the current SQL
or the newest explicit change. A direct SQL edit or chart gesture is part of that history too.

Keep the full lineage in the document. On the inference path, current SQL is the complete base;
send a bounded recent history for context rather than replaying every historical conversation.
Older instructions can be inspected in history. Do not persist the dataset's system prompt:
it currently contains sample rows and statistics. Rebuild it from the source when needed.

An edit session has an **immutable base revision**. Every keystroke revises that same base with
the whole change request typed so far. Never feed the last partial preview back as the next
base. Start a new base only when that edit ends and a new edit begins. This also handles voice
transcripts without repeatedly applying incomplete instructions.

Inference still returns complete SQL through the existing streaming path. A second model call
to rewrite the question is not required. View controls and supported chart gestures continue
to produce deterministic revisions without inference.

## Live preview, saving and checkpoints

Live execution remains per-keystroke. Document saving and history grouping must not debounce
inference, block first drawing, or add an approval step before seeing a result.

- Selecting "Edit" on a chart targets that chart. The editor shows its question, current SQL
  and revision; typing a change previews it in place. The general composer still creates charts.
- One editing session is one history step, rather than a step for every character. Enter ends
  the edit; leaving the editor also checkpoints a matching completed candidate. Escape cancels
  the draft and rehydrates the base if the preview changed the picture. Starting another edit
  must preserve any unresolved draft, not quietly discard or reinterpret it.
- Save the changing draft asynchronously in coalesced writes. Persist each completed candidate
  with the exact edit sequence that produced it. Never pair new question text with older SQL.
- Checkpoint only a candidate for the latest edit sequence, following final SQL and successful
  terminal database completion, including an empty result. `KEEP`, `RESULT_SCHEMA` or the first
  drawn batch alone does not establish success: a stream can fail later.
- SQL/result dedup may adopt an already completed execution for that sequence; report this
  explicitly with its source/data-generation identity. Do not force another query just to get
  a completion event, or mistake adoption of an incomplete/failed request for completion.
- If Enter arrives before completion, save a pending checkpoint intent. Complete it only when
  that exact edit succeeds. A failed/cancelled attempt stays an actionable draft; it cannot
  replace the saved chart definition. A renderer failure is reported separately from SQL validity.
- A save transaction writes the revision, canvas commit, head pointer and draft disposition
  atomically. Show "Saved" only after that transaction completes. Persistence failure leaves
  work in memory with "Not saved" and a retry/export path.

After reload, restore the committed canvas and unfinished draft text. A completed draft
candidate can be rehydrated as a labelled preview if it still matches its saved edit sequence
and base. An interrupted inference stays interrupted until resumed; never show a previous
candidate as the answer to more recent text. Save throughout the session; do not rely on unload
events to make the document durable. An abrupt close can lose writes not yet acknowledged.

## Hydration and data sources

1. Load document metadata, restore chart shells and positions, and display question, SQL and
   revision immediately. Charts show their individual loading/missing-source state.
2. Resolve each revision's immutable source reference and inspect its schema/dialect. A source
   reference identifies a fixture version, URL/resource, connection, or local file binding.
   Store table/column names and types or their fingerprint, not sampled values.
3. Allocate runtime targets and execute saved SQL through the normal guarded execution path.
   Prioritize visible/selected charts, bound concurrency, and yield to interactive edits.
   Deduplicate identical execution within the same source/data generation where safe.
4. Stream results into the existing renderer. Hydration produces runtime status and timing, not
   new chart revisions. One failed chart does not prevent the others from loading.

**Saved SQL is the default authority for reload.** "Refresh" executes it again. "Regenerate from
intent" sends the saved question, lineage and current SQL to inference and creates a new
revision after execution succeeds. If a document contains only a question, it remains an
unresolved draft; resolving it generates SQL once and saves the result. Do not silently fall
back to inference when saved SQL fails. An optional explicit regeneration-on-open policy can
be added later; it must record its revisions and inference cost.

Important cases:

- **Local dropped files:** the current `File` cannot be reconstructed from its name. Persist
  a locator and identity metadata, plus a file handle when supported; otherwise ask the user to
  reattach the source. Do not serialize a `File`/`Blob` into the canvas. Reattachment must verify
  identity/schema and must not silently substitute another same-named file. File handles are
  browser-local bindings, omitted from portable exports. [File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)
- **Changed source:** restore the definition, report schema incompatibility on that chart, and
  offer repair as a new revision. A schema fingerprint detects structure changes, not changes
  to values. A logical source reference may intentionally track current data; a pinned source
  version must never silently resolve to a different version.
- **Time windows:** today's prompt often generates literal dates from the current data maximum.
  Replaying that SQL preserves those dates. A rolling window needs explicit SQL-relative
  expressions or versioned parameter bindings; do not silently regenerate it on reload.
- **Mixed-source canvases:** changing the default dataset applies to new charts. Existing charts
  retain their sources. Introduce source-scoped runtime sessions behind a canvas runtime, with
  shared renderer/compiled modules, bounded source residency and collision-free runtime IDs.
  Do not start a complete DuckDB/GPU stack per chart or repeatedly reinterpret cards under one
  global context. An evicted source can reopen when a chart needs refresh or editing.

The existing prebuilt-dataset Cache API is disposable engine acceleration, separate from the
canvas document. Canvas restore must work with that cache cleared and sources available. No
new data persistence is part of this feature.

## History and rollback

Two levels serve different actions:

- **Chart history:** immutable question/change/SQL/presentation revisions. Restore a version
  of one chart without changing other charts or their positions. Show request text and SQL diff.
- **Canvas history:** commits of chart membership, selected chart revisions, titles and layout.
  Undo/redo reverses an edit, add/delete, move/resize or Arrange. One completed drag is one step.
  Camera motion, hydration, inference progress and animation frames are not history steps.

Undo moves the canvas head to a parent; redo selects the previously visited child. Editing
after undo creates a new child while retaining the old future. If a node has multiple children,
history exposes the alternatives. Restoring an older chart adds a canvas commit selecting that
revision; editing it creates a child of that chart revision. Restoring an entire historic canvas
adds a commit with that earlier state and a `restoredFrom` reference. This keeps restoration
itself undoable and preserves the record of how the user got there.

Deleting a chart removes it from the current canvas state, not from retained history. History
preview cannot accept an in-flight edit. Restore/undo invalidates affected runtime targets and
cancels their work before rehydration; late SQL, data or completion events cannot restore the
abandoned future. Other charts continue running.

## Storage and runtime boundaries

For the browser-local default, use IndexedDB transactions behind a `CanvasStore`, with stores
for canvas headers, commits, chart revisions, source references/bindings and drafts/preferences.
IndexedDB provides asynchronous structured storage and transactions; the storage adapter stays
outside the keystroke → draw path. [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)

Commit against an expected head/store version inside the same transaction. A second tab or a
late task cannot overwrite a newer head. Broadcast changes to other tabs; on a conflict preserve
the draft and require an explicit reload/branch decision, rather than last-writer-wins loss.
Unrelated layout updates can be rebased only after checking the target chart's base revision.
Do not assume browser-local storage is a cross-device backup. Provide a versioned `.timeblast.json`
export/import containing the document and reachable history, never source data or credentials.
Validate imports and refuse unknown future formats without rewriting them.

If server storage is selected, persist the same records with authenticated canvas ownership,
conditional head updates and explicit save acknowledgement. Retain the browser draft journal
for interruptions. The public inference endpoint is not an ownership model for private canvases.
Storage API choice does not change the execution frame format or where data is queried.

Add a document/controller layer above the current engine. Document commands are ordinary UI
work; scheduling, cancellation and drawing remain Rust/Wasm. The engine receives an immutable
execution target, not a mutable canvas document. A runtime binding maps:

`(canvas ID, chart ID, base revision ID, edit session, edit sequence)`

to the engine's `(session, epoch, request, context, slot)` identities. Promotion checks both
bindings and the current document base. The wire's existing `revision` is a keystroke counter;
it must not be confused with a durable `ChartRevision.id`.

Fence the non-frame UI messages too. Today `views`, `axes`, `table` and `manipulated` primarily
identify a slot; add the runtime target/request identity so an old event cannot relabel a
restored card or record a gesture against the wrong revision. Slot IDs alone are insufficient.

Extend the shared protocol explicitly (proposed operation names; specify bytes and goldens
before implementation):

| Operation | Purpose |
|---|---|
| Register target / release target | Associate a durable chart/edit base with a runtime slot; release cancels only that target |
| Run saved query | Execute SQL in a registered target, including a restored card with no previous request |
| Begin edit + targeted draft/commit | Prepare immutable base question/SQL/view once; subsequent drafts carry only a handle and change text |
| Prepared edit context + edit inference | Send the same immutable base to either inference placement; current text stays last |
| Execution completed/failed/cancelled | Give the document layer a reliable terminal outcome, distinct from progress, schema and first draw |

Keep the binary frame header and Arrow result path. Advertise the extension in HELLO/READY;
older peers must reject unsupported editing explicitly, never interpret structured edit input
as a plain question. Normal new-question inference remains compatible. Replay prepared edit
contexts after reconnect. A handle is connection-scoped; its immutable content is the cache key.

Every translation cache and dedup/adoption path must distinguish create from edit and include
dataset context, base SQL, relevant intent/presentation, change text and prompt/model identity
where applicable. Primed suggestions must have the same scope or bypass edit requests. Identical
words against different charts must never share a translation merely because the text matches.
Document history must retain different user actions even when their generated SQL is identical.

## Implementation sequence and acceptance

1. **Document and hydration:** stable IDs, records/store, named canvas identity, source
   descriptors, board serialization, registered query targets, terminal outcomes, save state,
   reload and export/import. Include mixed-source restore; do not bind all cards to the picker.
2. **History:** chart revisions and canvas commits, semantic checkpoints, draft recovery,
   undo/redo, non-destructive restoration, deletion recovery and stale-result fencing.
3. **Contextual editing:** target selector/editor, prepared edit protocol in both inference
   implementations, cache isolation, in-place preview and meaningful refinement evals.

These are delivery slices of one feature. Persistence alone does not satisfy the owner's request.

Required acceptance cases:

- Create, move, resize and change the view of several charts; reload; recover exact definitions
  and layout with zero inference calls. Verify first draw does not wait for a storage write.
- Restore mixed datasets with overlapping column names; each executes against its own source.
  Clear the engine's dataset cache and repeat; reattach a missing local file without losing work.
- Send the same change text to different base SQL; verify distinct agent context and cache keys.
  Refinement evals cover multi-step filters, changed grouping, gestures, JOINs and view changes
  across vessels/weather/flights/cities; score executed results and cost, not plausible SQL.
- Undo/restore while inference and streaming are running; deliver late frames deliberately;
  prove they cannot draw into or checkpoint the restored revision.
- Reload during typing, SQL generation, execution and a checkpoint transaction. Recover either
  the complete committed state or its predecessor plus saved draft, never a torn revision.
- Fail after the first result batch; preserve the prior committed definition. A zero-row success
  can checkpoint. A storage error never shows "Saved" or removes history.
- Go back, edit a different branch, then return to the old branch after reload. Delete/undo a
  chart and restore a whole canvas without removing the abandoned future.
- Simultaneous tabs, old/future-format imports and failed migrations preserve recoverable work.
- Compare hot-path latency with persistence off/on; measure document-open time, first visible
  hydrated chart, all-chart hydration, save latency and metadata size at 1/10/100 charts. Report
  inference cost separately; no performance claim precedes measurements.
