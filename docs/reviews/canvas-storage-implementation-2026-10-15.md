# Canvas storage implementation review

Reviewed 2026-10-15: `src/canvas/model.ts`, `validation.ts`, `store.ts` and
`tests/canvas-model.test.ts`. The findings below concern implemented behavior.
The unfinished app/session integration and recovery exporter are outside this
review. No source or test files were edited.

**Re-review status:** the implementer fixed findings 1–4 during this review. The
original reproductions are retained below, with their original line references.
All four fixes were independently verified again with real Chromium IndexedDB:
oversized title/question commands reject before changing the model; reload still
works; restored creation drafts are closed and ignore late completion; closing
the store no longer strands an acknowledgement; duplicate draft writes reject
without changing the saved draft. No browser errors occurred in that re-run.
No remaining P1 issue was confirmed in the reviewed model-produced write paths.
The prototype-named import ID edge case below remains nonblocking.

Validation: the original 16 tests passed; the expanded 18 canvas-model tests also
pass after the fixes. Additional checks imported
the three modules through Vite into an otherwise empty Chromium page and used
real IndexedDB in temporary browser storage. No inference or database providers
were called. The reproductions below were observed in that browser harness.

## 1. P1, fixed: Acknowledged writes can make the entire canvas unloadable

**Locations:** `src/canvas/model.ts:126`, `:141`, `:222`;
`src/canvas/store.ts:98`, `:106`, `:115`, `:58`;
`src/canvas/validation.ts:130`, `:144`.

Model commands accept values that the loader later rejects. Storage checks
versions and ownership but not record validity before acknowledging the write.
The loader validates the complete graph, including every draft and historical
commit. Consequently one invalid historical record prevents loading the entire
canvas, even if the current head is otherwise valid.

Two observed reproductions:

```ts
const model = CanvasModel.create();
await store.write(model.initialPatch());
await store.write(model.rename('x'.repeat(1025))!); // resolves successfully
await store.load(model.header.id);                // Invalid canvas title
```

For a model containing a valid source, `startDraft({ sourceRefId,
text: 'x'.repeat(16385) })` also returns a write that succeeds, after which load
rejects with `Invalid original question`. Draft text itself allows up to 1 MiB,
but creation copies it into `originalQuestion`, whose limit is only 16,384
characters. No malformed patch or modified export is needed for either failure.

**Fix:** share record constraints between the model/write boundary and import
validation. Reject an invalid command before mutating the model, or adjust the
read contract to admit the supported input; never acknowledge records that
`load()` cannot read. Keep this as bounded record validation, not a full-history
walk for each keystroke. Cover creation/update of long questions, title changes
and a round trip through actual storage. Merely validating export/import does
not fix already acknowledged local records.

## 2. P1, fixed: Restoring a canvas leaves pending creation drafts able to commit later

**Locations:** `src/canvas/model.ts:240`, `:275`, `:306`, `:311`, `:319`.

`affected()` compares only committed chart membership/revision pointers.
Creation drafts have no committed membership yet, so they are absent from both
sides of that comparison and never invalidated by whole-canvas restoration.
Their `baseRevisionId` is null, so `promote()` accepts them on the restored canvas
as long as their chart ID is still absent.

Observed sequence:

1. Save the initial empty commit; create one committed chart.
2. Start a second creation draft, record SQL, and call `finishDraft()` while its
   execution is pending.
3. `restoreCanvas(initialEmptyCommit)` correctly produces zero committed charts,
   but the second draft remains open.
4. Deliver `outcome(secondDraft, sequence, sql, 'succeeded')`.

The last call returns a head-changing patch and the restored empty canvas now
contains a chart. A response from the abandoned working state therefore changes
the selected history after rollback. The same blind spot exists in `moveHead()`.

**Fix:** explicitly invalidate pending creation sessions during history
navigation that abandons their working state. They can remain recoverable as
superseded drafts, but must lose automatic promotion authority. Either record
their creation/base canvas state, or close the applicable creation drafts as
part of whole-canvas restore/undo/redo. Add a pending-new-chart restore case;
the existing undo test only covers a draft on an already committed chart.

## 3. P2, fixed: Closing the store during a write prevents its promise from settling

**Locations:** `src/canvas/store.ts:80`, `:128`.

`close()` closes the BroadcastChannel immediately. An already running IndexedDB
transaction can still complete, and its `oncomplete` handler calls
`channel.postMessage()` before resolving the write promise. Posting on the
closed channel throws and skips `resolve()`.

Observed reproduction:

```ts
const saving = store.write(model.initialPatch());
store.close();
await saving; // never settles, although the transaction completes
```

Chromium reports `Failed to execute 'postMessage' on 'BroadcastChannel': Channel
is closed`. A 150 ms race confirmed that the write stayed pending after this
exception. A journal waiting for that acknowledgement can hang during shutdown
or connection replacement.

**Fix:** treat broadcast notification as best-effort work after durable
completion. Catch notification errors or skip a closed channel and always
settle the write promise. A notification failure cannot turn an already
committed transaction into an unacknowledged save.

## 4. P2, fixed: Duplicate keys in one patch bypass closed-draft fencing

**Locations:** `src/canvas/store.ts:87`, `:107`, `:115`.

All compare-and-swap reads are performed before any writes. Two entries for one
draft key therefore both inspect the same old record. A patch containing a
close followed by a reopen, both expecting version 0 and writing version 1,
passes every check and finishes with the draft open:

```ts
await store.write({ canvasId, drafts: [
  { expectedVersion: 0, value: { ...draft, version: 1,
      state: 'closed', closedAs: 'discarded' } },
  { expectedVersion: 0, value: { ...draft, version: 1, state: 'open' } },
] });
```

The real storage check accepted the transaction and `load()` returned an open
draft. Duplicate immutable record keys similarly inspect the pre-transaction
state and can overwrite each other within one patch.

**Fix:** reject repeated `(store, canvasId, id)` keys before issuing writes, or
explicitly compose and validate a single transition for each key. Current
`CanvasModel` commands do not emit this patch, so this is an internal API
boundary defect, not a demonstrated UI path. It matters before journal
coalescing or other patch producers are added.

## Nonblocking import edge case

`validation.ts:17` accepts an ID such as `toString`. A valid imported canvas with
that root commit ID and an empty `redoChoices` object passes validation, but
`model.ts:252` reads the inherited `Object.prototype.toString` value as its redo
child and throws `Choose a child of the current history state` instead of
returning no redo. Use an own-property check or a null-prototype dictionary for
the preference map. Locally generated UUIDs do not trigger this case.

## Checks that held

Ordinary competing head writes were serialized correctly: one succeeded, the
other rejected with `CanvasConflictError`, and the stored version was 1. The
model's existing tests cover exact SQL/intent history, both completion/finish
orders, failed execution recovery, late sequences, superseded sessions,
alternative branches, monotonic undo versions and basic graph validation.

Import validation already rejects missing sources, missing/different chart
revisions, parent cycles, duplicate records and changed original questions along
a parent edge. No additional server synchronization or migration architecture
is required to address these findings.
