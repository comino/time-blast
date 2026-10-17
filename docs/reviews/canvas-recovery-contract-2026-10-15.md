# Canvas recovery export contract

**Design recommendation, 2026-10-15; no implementation changes or runtime tests.**
Reviewed `docs/canvas-implementation.md`, the earlier persistence/semantics reviews,
and `src/canvas/{model,store,validation}.ts`.

## Decision

Use a distinct recovery file containing **the last acknowledged snapshot and the
current working snapshot**. Do not convert failed layout/title/restore actions into
chart drafts, and do not make the internal patch queue a public replay format.

```ts
type CanvasRecovery = {
  format: 'timeblast-canvas-recovery';
  formatVersion: 1;
  exportedAt: number;
  acknowledged: CanvasSnapshot | null;
  working: CanvasSnapshot;
};
```

`null` means this session has never received a successful initial-save acknowledgement.
Both snapshots use the existing strict canvas schema. The envelope marks the entire
working graph as provisional relative to `acknowledged`; an optimistic
`closedAs: 'committed'` is not evidence that its write succeeded.

This is sufficient because the model retains every owned commit/revision/source,
including alternate branches (`model.ts:80`, `:112–114`). A failed chart promotion
already exists in RAM as a revision, commit and closed draft (`:285–314`). Failed
layout/title/restore actions likewise have immutable commits (`:220–253`); a failed
undo/redo is represented by the working header and redo choices (`:255–266`,
`:329–336`). The working graph preserves those actions without replaying thousands
of superseded per-keystroke draft writes.

## Required session and export behavior

1. Keep an acknowledged mirror alongside the optimistic model. Update the mirror
   by applying an exact patch **only after** `write()` resolves from transaction
   completion (`store.ts:81–88`). Do not copy the live model on acknowledgement:
   it may already contain later unsaved commands. Applying acknowledged patches
   to a mirror is incremental; full cloning is only needed when exporting.
2. Queue a command's returned patch synchronously with its model mutation. Submit
   one patch at a time. On the first failure/conflict stop draining the dependent
   queue, retain it and allow local authoring to continue. The mirror remains the
   last acknowledged prefix; an older acknowledgement cannot mark newer work Saved.
3. Capture both snapshots in one synchronous session operation. Do not wait for a
   storage read or pending write to export. An in-flight transaction belongs to the
   unacknowledged side until its callback is processed, even if IndexedDB physically
   committed it moments earlier. “Unacknowledged” is the claim, not “definitely
   absent from storage.”
4. With no unacknowledged work, ordinary export uses the acknowledged snapshot and
   the existing `.timeblast.json` format. With pending/failed work, the default
   export produces `.timeblast-recovery.json` and says it includes work not yet
   acknowledged by browser storage. An explicit “Export last saved version” may
   export just the mirror, but must not be the recovery escape hatch.
5. Never reload storage over the mirror/model to resolve a conflict during export.
   The acknowledged snapshot means “last acknowledged by this session”; another
   tab may have newer branches. Its work stays in the original canvas. Recovery
   preserves every branch known to this session and does not pretend to merge
   unseen work.

This resolves the original concern: exporting `model.snapshot()` as a normal canvas
would silently promote unacknowledged history. Putting it in the explicit `working`
side of a recovery envelope preserves that history without claiming a successful
save or rewriting an author's actions into a different kind of record.

## Required validation and import behavior

Validate the envelope before mutating storage. Run `validateCanvas()` on both
snapshots, enforce the normal payload/record limits, and additionally require:

- Both snapshots have the same original canvas identity when acknowledged exists.
- Every acknowledged immutable commit/revision/source exists identically in working.
  No ancestor-only filtering is permitted; alternate branches remain included.
- Every acknowledged draft still exists. Its version cannot decrease; the same
  version must be identical; a closed session cannot become open. Reopening uses
  the existing fresh-session behavior (`model.ts:180–195`).
- The working store version cannot decrease. At an equal version, the entire
  header must be identical: draft/source-only saves do not change the header.
- Unknown recovery versions/fields fail without rewriting the file. The ordinary
  canvas parser must reject a recovery envelope instead of extracting `working`.

An import of this file means **recover the working copy into a new canvas**, not
overwrite the source canvas and not silently retry its old compare-and-swap writes.

1. Stage the validated working graph in a fresh namespace using the existing full
   identity remapping in `forkCanvas()` (`validation.ts:211–235`). Preserve both
   branches, all draft content, source definitions, layout and selected head state.
2. Add one new, clearly named `Recover working copy` canvas commit at import time,
   parented to the remapped working head and containing the same selected state.
   The imported history is thereby identified as recovered work. Keep the initial
   store version at zero when constructing this initial snapshot; do not increment
   it before an initial insert that requires version zero (`store.ts:107–108`).
3. Write that complete new snapshot in one initial transaction. Until it succeeds,
   display a staged recovered canvas as Not saved and retain recovery export. After
   success, those records are **newly durable in the new canvas**. This is legitimate
   recovery, not a claim that the failed source transaction succeeded. Publish the
   active-canvas preference only after this write succeeds.
4. Preserve open drafts and their exact question/SQL/finish intent as recoverable
   authoring records. Import is not a new SQL execution outcome and must not trigger
   automatic promotion from a stored `succeeded` status. Resuming an imported draft
   creates a fresh edit/runtime association and revalidates its candidate; current
   `reopenDraft()` already clears old finish authority and resets the candidate.
   SQL hydration of selected saved revisions is a separate normal runtime action.

No second confirmation is required: the recovery import action itself explicitly
creates the recovered canvas. A persistent recovery marker is sufficient for this
first version; per-record historical save-status annotations are optional.

## Testable invariants

1. **Failed promotion:** acknowledged A stays A; working contains B with exact
   question/SQL and its closed draft. Recovery round-trip retains both, while plain
   parsing rejects the recovery format. Only a successful import transaction makes
   B durable in its new namespace.
2. **Failed non-chart actions:** fail a layout write, then rename and restore an
   earlier state in RAM. Export/import retains every intermediate commit, the final
   selection, and drafts superseded by restore. Undo/redo-only changes also survive.
3. **Branches:** save A → B → C, undo to B, create D while storage fails. Recovery
   import retains C and D, their revisions/sources, and the intended selected head.
4. **No saved baseline:** fail initial creation, author a source-bound draft, and
   export with acknowledged null. Recovery works without any storage read.
5. **Acknowledgement race:** capture immediately before and after a write callback.
   Each file has one coherent boundary; no partial checkpoint has a new revision
   without its corresponding head and draft closure. A later queued edit is never
   copied into acknowledged merely because an earlier write finished.
6. **Conflict/import failure:** a different tab's newer canvas is unchanged. An
   aborted recovery import publishes no partial canvas or active preference; its
   RAM state can still be exported and retried.
7. **No runtime resurrection:** pending work, failed SQL and stored successful draft
   candidates stay recoverable without import starting inference or auto-promoting
   an old session. Source bytes, result rows, handles and credentials remain absent.

## Optional complexity

Automatic merging into an existing canvas, retry/rebase of the old patch suffix,
per-command acknowledgement metadata, journal serialization, graph compaction,
envelope compression and individual recovery-action selection are not required.
The two-snapshot duplication occurs only at export/import and keeps storage failure
off the drawing path. Enforce a total file limit consistently; if exceeded, retain
RAM work and report the export failure rather than emitting a truncated history.
