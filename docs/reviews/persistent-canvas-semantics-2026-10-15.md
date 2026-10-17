# Persistent canvas: product semantics review

**Design review, 2026-10-15. These are specification gaps, not verified runtime bugs.**

Reviewed `docs/persistent-canvas.md`, the owner's request, `docs/vision.md`, and the
existing composer, card and controller behavior. No implementation or runtime tests
were performed. P1 means resolve before implementing the affected state machine;
P2 means resolve before exposing the affected behavior.

The central model fits the request: persist intent and exact SQL, hydrate SQL without
inference, retain definitions rather than data, and append changes rather than erasing
the original question. The proposal also preserves the vision's per-keystroke drawing.
The remaining problems are concentrated in what constitutes a saved edit and how
different forms of editing compose.

## Findings

### P1 — Leaving an editor has a different outcome depending on query timing

**References:** `docs/persistent-canvas.md:142–155`, `docs/vision.md:28–37`.

Leaving the editor checkpoints a matching **completed** candidate, but only Enter
explicitly records a pending checkpoint intent. Type “daily instead” and select
another chart: if execution finished just before the click, the edit becomes a
revision; if it finishes just after, the proposal only promises an unresolved draft.
Reload can therefore restore different active definitions after identical user
actions. Enter remains the reliable completion gesture despite the stated automatic
checkpoint on exit.

**Minimal remedy:** define one `finishEdit(sessionId, sequence, baseRevisionId)` for
Enter, dismissal, and changing the editing target. Persist its pending intent even
when inference/execution is incomplete. Successful completion promotes that exact
candidate if its base still matches; failure or cancellation retains a visible draft.
Reopening the unfinished session explicitly supersedes its old pending intent. A
textarea losing focus to another control inside the same editor is not an editor
exit. Drawing remains independent of this state transition.

**Acceptance:** finish the same edit by changing the selected chart just before and
just after terminal completion, then reload. Both paths must select the same revision
once the frozen candidate succeeds, with one history step and no extra inference.

### P1 — A gesture on an uncommitted preview has no defined history parent

**References:** `docs/persistent-canvas.md:126–133`, `:140–150`, `:215–231`;
`src/ui/slot-card.ts:234–260`; `src/ui/controller.ts:155–179`.

Text edits keep an immutable committed base, previews draw in place before execution
finishes, and chart gestures independently produce revisions. Consider a saved hourly
chart A. A text edit previews daily SQL B, still streaming. The user brushes B's
visible points or chooses a new view. B is not yet an eligible revision. Parenting
the gesture under A loses the text edit's provenance; applying it to A changes a
different chart from the one clicked; allowing B's late completion to win can erase
the gesture. Runtime identity fencing alone cannot choose the intended history.
The existing plot takes focus on pointer-down and submits query gestures on
pointer-up/click, so this is a normal interaction to specify.

**Minimal explicit rule:** view controls inside an edit update that draft's
presentation. A query-changing gesture is bound to the exact displayed candidate
and is accepted only when it matches the latest text sequence. Resolve the hit to a
semantic filter immediately, freeze/finish that edit, and retain the gesture as a
pending child action. Once the text candidate succeeds, commit it and apply the
gesture as its child. If it fails or the user cancels/restores, preserve or cancel the
dependent action explicitly; never retarget it to the current chart. This rule can
defer a gesture until the preceding stream finishes, so measure that interaction
latency. Speculative child execution can be added without changing the dependency
or promotion rules.

**Acceptance:** brush a preview during streaming, change its view, and repeat while
a newer text sequence is pending. Inspect the resulting history, undo twice, and
reload. The recorded question, SQL, presentation and gesture must describe the same
path the user saw.

### P1 — Draft durability must include final SQL before execution succeeds

**References:** `docs/persistent-canvas.md:18–19`, `:98–100`, `:146–165`, `:182–183`.

The owner explicitly wants both question and SQL to survive reload. The proposal
stores a “completed SQL candidate,” then makes successful terminal execution the
condition for a checkpoint, without defining whether the draft retains final SQL
when execution fails or is unavailable. The committed chart must remain protected,
but an offline, invalid, or interrupted definition is still authoring work. A
question-only new draft also has no base revision from which to recover its source
or presentation.

**Minimal remedy:** distinguish durable draft storage, SQL generation completion,
and successful execution. Save the exact final generated SQL as soon as generation
finishes, even if execution later fails; save direct SQL editor text independently
of validity. A draft must carry its source reference and presentation as well as its
text/SQL sequence identities, including before the first revision exists. Show
“Saved draft · Query failed” or “Saved draft · Source unavailable,” while keeping the
previous validated revision active. This does **not** require accepting invalid SQL
as the active chart. A reload restores the draft in the canvas with an explicit
retry/resume path, without invoking the model simply to recover lost SQL.

**Acceptance:** generate final SQL, fail the database after the first batch, reload,
and compare the exact saved question and SQL. Repeat for a new chart with no prior
revision and a source that cannot currently be opened.

### P2 — “Regenerate from intent” needs a distinct authority rule

**References:** `docs/persistent-canvas.md:115–122`, `:180–185`.

Refinement correctly treats current SQL as the implementation to preserve. The
proposal also says historical instructions do not override it. “Regenerate from
intent” sends the same question, lineage and SQL without specifying a different
precedence. If the original request says “vessel 7” but the saved, successfully
executed SQL omitted that filter, ordinary refinement preserves the error; using the
same rule for regeneration can reproduce it as well. Successful execution is not
evidence that SQL satisfies intent.

**Minimal remedy:** make operation mode explicit. `refine` preserves the selected
implementation except for the new change; `regenerate` reconstructs intent from the
selected lineage, with later explicit instructions superseding earlier ones and
current SQL supplied as an inspectable implementation rather than unconditional
authority. Record direct SQL edits and gestures as explicit intent-changing events
so regeneration can retain those choices. `refresh` remains SQL execution only.
This is not a blocker to SQL-based reload, but it is a blocker to a well-defined
regeneration control.

**Acceptance:** save SQL that executes correctly but omits an original requested
filter. Verify refresh preserves it, a narrow unrelated refinement preserves its
base as specified, and regeneration is evaluated against the full selected intent.

### P2 — The UI can display the original question as if it were the current one

**References:** `docs/persistent-canvas.md:82–87`, `:105–119`, `:140–141`;
`src/ui/slot-card.ts:108–113`.

The only mandatory question is the immutable original; a description of the current
chart is optional, yet the editor is said to show “its question.” In the proposal's
own example the final chart is maximum wind, daily, vessel 7, while the original
still says average wind per vessel by hour. Existing cards use the question directly
as their title. Reusing that convention would present incompatible question/SQL
pairs even though the complete provenance is safely stored elsewhere.

**Minimal remedy:** label the original as “Original question,” and show the selected
revision's change text plus an accessible ordered change trail alongside it. Give
saved versus draft SQL separate labels. A concise current description can remain
optional; no extra model call or rewrite of the original question is required.

## Scope and non-blocking choices

- Retaining branches and keeping restore itself undoable are coherent choices. The
  two actions need clear names: Undo moves the history cursor; Restore records a new
  action selecting older state. These are not contradictory operations.
- Persist the redo selection/cursor or deliberately show a branch chooser after
  reload. The current records only explicitly mention camera and selection
  preferences (`docs/persistent-canvas.md:97`, `:221–226`). This is a small UX decision,
  not a reason to replace the history model.
- Browser-local storage plus export is a defensible working assumption, not an
  answer to cross-device persistence. No server/account system is needed to validate
  this feature's core interactions.
- The first implementation milestone should demonstrate one complete path—create,
  reload, refine with question and SQL, rollback—on one source, then exercise mixed
  sources and portability. Keep stable IDs, source references, cancellation and
  branches in the model from the beginning. Do not claim that an intermediate
  persistence-only slice completes the owner's request.
- The vision welcomes complexity for a concrete result. Branch recovery and source
  identity have such reasons; no redesign is justified merely because this model is
  substantial. The critical missing artifact is an edit-state transition table,
  including the cases above, rather than more architecture layers.
