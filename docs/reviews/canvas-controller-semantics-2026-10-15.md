# Persistent canvas controller semantics review — 2026-10-15

**Verified closed at 22:06 UTC.** All 23 controller regressions pass; the five
affected controller, suggestion, model and session suites pass 87/87 tests.
TypeScript passed at 22:05 UTC. No blocking findings remain from this review.

Implementation review of `src/canvas/controller.ts`, checked against the user's
durable-question/SQL/history request and `docs/vision.md`. This review owns the
DOM-free regressions in `tests/canvas-controller.test.ts`. The implementation agent
made the initial production fixes; this reviewer made the narrow suggestion
compatibility corrections described below.

## Findings and regression evidence

| Priority | Failure or risk reviewed | Required behavior and evidence |
| --- | --- | --- |
| P1 | A gesture on an older displayed preview could regenerate its parent from text or attach to a different selected revision. | Capture the exact displayed question, SQL, source and presentation; execute that SQL under a fresh target before promotion; retain newer abandoned text. Tests cover both an unfinished preview and a preview committed while the hit test is resolving. |
| P1 | A cancelled source activation or capability wait could hold the serial queue or later send obsolete text. | Invalidation resolves the owned wait, rejects late activation tokens and permits the next source job. Tests cover cancellation in both waits, plus typing and Enter before source readiness. |
| P1 | Refresh could detach the runtime target while leaving the editor attached to its unfinished draft. | Clear the active editor association and retain the draft for Resume. A regression refreshes during pending refinement, completes hydration, then verifies new input sends a DRAFT and the earlier text survives. |
| P1 | A presentation change during source loading creates a new revision and caused hydration's old revision-id guard to abandon the query. | Continue when selected SQL and source still match, using the selected presentation. A regression changes the picker while a different source is activating and requires the exact saved QUERY plus the new view. |
| P1 | Resuming saved refinement SQL required inference edit capability despite needing only SQL execution. | Exact candidate replay and checkpoint work without inference. Subsequent natural-language changes rotate the runtime lifetime and require the saved edit context and endpoint capability. Regression verifies QUERY-only replay and checkpoint with an unsupported inference endpoint. |
| P2 | The first input after an empty refinement editor had already activated used the wrong wire sequence. | Model sequence plus one must equal DRAFT and COMMIT revision. The regression waits for empty-editor activation before typing, then verifies the new revision commits. This failure was first found by the implementation agent's browser check. |
| P2 | An explicit natural-language view was lost on reload; a late automatic hint could overwrite a newer manual picker choice. | Persist the accepted view with the definition and preserve the newer manual choice. Separate regressions exercise both cases and verify reload sends the saved presentation with exact SQL. |
| P2 | Starting another edit could mark a failed edit discarded, hiding recoverable question/SQL from the Drafts panel. | Supersede unfinished edits while retaining their text, SQL and terminal failure; never change the selected validated revision. Regression checks the persisted record. |
| P2 | After an unsupported endpoint rejected refinement, choosing a capable endpoint left the open editor unready. | Retry the retained edit with EDIT_CONTEXT when the selected endpoint advertises support. Regression verifies the original draft identity, pending text and saved edit context; existing queued or running waits are not duplicated. |

Additional passing scenarios verify create at sequence zero → Enter → reload →
refine → undo, saved original question/current SQL/history in EDIT_CONTEXT,
SQL-only reload, per-chart source identity across a changed default dataset,
interrupted draft restoration without automatic inference, aligned sequences after
SQL replay, leaving an empty edit, and rejection of old execution/render/export/
gesture callbacks after restore.

## Suggestion compatibility follow-up

The 22:05 follow-up reviewed accepted RESULT observation, suggestion scheduling,
source identity, stale chips, input/frame counters and the exact-SQL click path.

- **P1 — Global PRIME keys could conflate different chart definitions.** A chart
  retains its original question after refinement, gesture or manual SQL changes.
  Suggestions derived from different SQL could consequently share the same
  normalized question/context key. Canvas suggestions now execute the chip's
  exact SQL in a new definition bound to its originating source. They no longer
  publish global PRIME entries. WARM SQL execution remains available; its old
  latency or cache-hit behavior is not claimed for this new path.
- **P1 — Delayed preparation could race source replacement.** Until activation
  finishes, the controller can still expose the previous context object.
  `questionFor` now also requires the active source to match the originating
  definition and no activation to be pending. A delayed timer and a later stale
  timing frame produce no PRIME or WARM work across that transition.
- **P2 — A rejected stale chip could replace the visible editor text.** Suggestion
  acceptance is now explicit. The UI changes the textarea and counts a pick only
  after the controller accepts it. The regression verifies an invalidated result
  is not observed and its old chip cannot alter the active draft or issue work.
- **P2 — View chips would lose their view on exact SQL execution.** The runtime
  reviewer and implementation agent identified that targeted QUERY preserves
  presentation rather than interpreting the SQL hint. Generated view chips now
  carry explicit `view` metadata; the controller persists it before execution.
  The exact-definition regression covers a table chip through reload.

Three new integration regressions cover those paths, including a change of default
source before picking an older source's chip, unchanged originating revisions,
QUERY-only execution and the public input/frame counters. The legacy controller
retains its existing COMMIT and PRIME behavior.

One additional acceptance regression blocks `storage.write` after boot. DRAFT is
sent, RESULT reaches the host and a successful definition checkpoints in RAM while
save state remains `saving`; both the acknowledged snapshot and storage still
contain no chart revisions. Releasing the gate saves that same definition. This
proves result delivery and model promotion do not await the storage acknowledgement;
it is not a GPU or physical-display timing measurement.

## Verification scope

At 22:06 UTC:

```sh
pnpm exec vitest run tests/canvas-controller.test.ts tests/ui-controller.test.ts tests/ui-suggest.test.ts tests/canvas-model.test.ts tests/canvas-session.test.ts
```

At 22:05 UTC, after the production compatibility changes:

```sh
pnpm exec tsc --noEmit
```

Results: **5 suites, 87 tests passed; TypeScript passed.** The controller suite
contains 23 tests. The earlier 21:53 controller/model/session check passed 54/54.

These tests instantiate the real controller, model and session. A memory storage
adapter validates atomic patches and version expectations; FakeEngine, FakeHost
and FakeRail script real encoded protocol frames and source activation replies.
They verify emitted requests, durable metadata, history and stale-result rejection.
They do not execute DuckDB, call a model, use IndexedDB or inspect browser pixels.
Runtime, browser and persistence reviews provide those separate checks.

No performance claims follow from this suite. It tests correctness of interleaved
authoring and execution events, not measured thought-to-result latency.
