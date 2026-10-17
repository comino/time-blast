# Persistent canvas: consolidated critical review

2026-10-15. Three independent static reviews of the
[proposal](../persistent-canvas.md), checked against the current implementation.
These are design findings and implementation constraints, not observed bugs in an
implemented persistent canvas. No runtime code changed; no tests, builds or
provider calls were needed for this review. The proposal has not yet been revised.

**Verdict:** keep the durable document, immutable revisions, SQL-first hydration
and preserved original question. Resolve the edit and recovery contracts below
before implementing their state machines. Concurrent source sessions are optional;
they are not required to prove the requested create → reload → refine → rollback
loop.

## Required corrections

1. **Save authoring work independently of successful execution.** Persist exact
   final generated SQL even when execution fails, is cancelled or cannot open its
   source. Direct SQL editor text survives regardless of validity. Keep execution
   status separate from generation status and draft durability. A creation draft
   needs its own source, presentation and layout before any successful revision
   exists. A failed draft stays recoverable while the previous successful revision
   remains active. Neither draft nor revision persistence includes result rows.

2. **Make finishing an edit deterministic.** Enter and semantic editor exit must
   record the same pending checkpoint intent, tied to one edit session, sequence
   and base revision. Query timing must not decide whether leaving the editor
   creates history. A query-changing gesture on a preview belongs to that exact
   candidate: capture its semantic meaning immediately and retain the dependency;
   never apply it to whichever revision happens to be current later. View controls
   during editing update the draft's presentation. Define cancellation, reopening
   and failed-parent behavior explicitly. Streaming previews remain immediate.

3. **Protect drafts as well as the canvas head from late writes.** Each edit needs
   a unique session, monotonically increasing persisted version and durable closed
   state. Delayed autosaves must not resurrect a committed, discarded or deleted
   draft. Checkpoint transactions must check the expected draft version and canvas
   store version. Head ID alone misses an A → B → A transition after undo. A stale
   save acknowledgement must not label newer work as saved. Preserve competing
   drafts instead of silently overwriting another tab's work.

4. **Define target lifetime and completion before connecting persistence.**
   Today's Cancel is global, completed requests are collected, and RESULT/KEEP do
   not mean successful completion. Register chart targets independently of request
   records; validate target generation on incoming controls and outgoing results.
   The coordinator must own terminal outcomes and adoption associations, including
   cancellation and reuse of already completed executions. Promotion is idempotent
   for the exact candidate served. SQL execution outcome and renderer failure are
   separate. Otherwise an edit can checkpoint twice, never checkpoint, or attach
   another request's result to its revision.

5. **Restore presentation by replacing its complete state.** Renderer parameters
   currently only upsert, so restoring an earlier empty parameter set would leave
   newer rotation or playback settings behind. Inference bindings can also reset
   a manually selected view. Persist Auto versus manual intent, clear absent
   parameters on restore, and preserve presentation during refinement unless the
   new request explicitly changes it. The historical question is not a reliable
   source of current presentation intent.

6. **Make contextual editing an explicit inference operation.** Send the original
   question, selected SQL, relevant change lineage and new request as typed
   context with defined size limits. Include that context in every translation
   reuse/adoption decision and in both implementations' repair prompts. Bypass
   unsupported reuse paths initially. Negotiate support before sending new message
   kinds; existing peers reject unknown kinds. Distinguish refinement, which
   preserves its selected base, from regeneration, which reassesses the selected
   intent. Label the original question and subsequent changes separately in the
   UI so the root question does not misdescribe the current chart.

7. **Make recovery and portability preserve all authored work.** Recovery export
   must include RAM-only drafts and pending changes after a failed save. History
   export must retain abandoned branches, not just ancestors of the selected head;
   draft bases also keep referenced revisions alive. Import into a new canvas by
   default. Save logical table aliases and load options so reattaching an identical
   file under a different filename does not break its SQL. Export/import and
   regeneration details can follow the first slice, but these data ownership rules
   belong in the initial model.

The [semantics review](persistent-canvas-semantics-2026-10-15.md) covers editing,
preview gestures and intent. The
[persistence review](persistent-canvas-persistence-2026-10-15.md) specifies draft
transactions and recovery scenarios. The
[architecture review](persistent-canvas-architecture-2026-10-15.md) supplies code
references for runtime, inference, protocol and renderer constraints.

## Smaller first implementation

Build one complete path on one source: create a chart, persist question and SQL,
reload by executing saved SQL, refine with the original question plus selected SQL
and the new request, then restore an earlier revision while late work is arriving.
Use registered targets and the existing QUERY/EXEC/Arrow path, with explicit
completion and full presentation replacement. Add no inference call to SQL reload
or to rewriting a question summary.

For multiple sources, first schedule hydration by source through one coordinator
and renderer. Await source activation, run a bounded group of queries, then switch;
completed chart results can remain visible. Foreground edits and gestures activate
their chart's saved source. This can interrupt background hydration, so measure
activation and interaction latency. Concurrent engines can follow with a globally
unique renderer request namespace; separate coordinators currently reuse request
numbers.

Bound hydrated chart residency independently of source residency. Also distinguish
re-executing against loaded data from reloading a source: a forced refresh must
bypass stale-result adoption. Source identity and equal schemas do not prove equal
data. These are correctness and resource contracts, not measured performance claims.

Browser-local IndexedDB plus export remains a working assumption. Cross-device
persistence is still an open product choice.

## Evidence required from the implementation

- Finish an edit immediately before and after query completion; both produce the
  same saved revision. Failed execution retains exact question and SQL on reload.
- Deliver old frames, controls and autosaves after cancel, delete, undo and restore;
  they cannot mutate or resurrect the replacement state.
- Exercise running and completed result adoption, zero rows, failure after a batch
  and renderer failure without losing or duplicating checkpoints.
- Restore Auto/manual views and empty parameter sets exactly; brush a streaming
  preview and verify its parentage through undo and reload.
- Round-trip a branched history and a recovery export after storage failure;
  reattach a renamed source without changing its logical SQL table names.
- Evaluate contextual refinement and repair with both inference implementations;
  verify old/new peer compatibility and that SQL reload calls no inference.
