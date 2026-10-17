# Persistent canvas implementation

Implemented and verified 2026-10-15 in the working tree; not deployed. This page
records the implementation contract and verification evidence against the full
[proposal](persistent-canvas.md) and its
[critical reviews](reviews/persistent-canvas-2026-10-15.md).

## Decisions

- Browser-local IndexedDB, versioned export/import, no persisted result rows or
  source files. Keep all history branches. Import creates a new canvas namespace.
- Immutable chart revisions and canvas snapshots; mutable, independently versioned
  draft sessions. A source reference belongs to each definition, not the picker.
- SQL generation, SQL execution, rendering and storage acknowledgements are
  distinct. Save final generated SQL before execution completes. Failed execution
  preserves the draft and leaves the previous successful revision active.
- Enter and semantic editor exit freeze the same exact draft sequence. A successful
  matching candidate promotes once; failure remains a saved draft. Moving focus to
  a control within the editor does not finish it.
- Runtime targets outlive requests. Cancellation and all data-dependent controls
  are fenced by target lifetime/request. Restore replaces complete presentation,
  including Auto intent and cleared parameters.
- Refinement sends the immutable original question, selected SQL, selected change
  lineage and current request. Regeneration explicitly prioritizes selected intent.
  Repair uses the same edit base. Context identity scopes all inference reuse.
- A gesture on a preview captures the displayed candidate's semantic filter and
  depends on that candidate. It cannot silently attach to a different revision.
- One coordinator/renderer, bounded execution, serial source activation first.
  Source changes preserve completed charts. Chart result residency is bounded
  separately from source activation. Forced refresh bypasses stale adoption.

## Edit transitions

| Event | Durable effect | Runtime effect |
|---|---|---|
| Type | Version the open draft; advance sequence; clear obsolete candidate. Journaled in a microtask after the DRAFT is sent; queued draft writes coalesce | Immediately preview the new sequence |
| Final SQL | Save exact SQL for the matching sequence | Execute/stream independently of storage |
| Enter / leave editor | Save pending checkpoint for that sequence | Continue its work; freeze its base |
| SQL succeeds | Record outcome; checkpoint if the same finish intent is pending | Preserve streaming/drawing status separately |
| SQL fails / source missing | Retain question and SQL with failure state | Keep the previous successful definition recoverable |
| Type after Enter (new chart) | The committed draft keeps its finish intent; the new text starts a new chart | Committed work keeps running in its own target |
| Type after Enter (refinement) | A new draft on the same chart; rebased onto the refinement when it is checkpointed | Waits, then previews against the new revision (or the old one if the refinement failed) |
| Enter again on committed text | Nothing | Nothing |
| Resume a saved draft | Supersede the old finish intent with a new session | Invalidate its old target association |
| Cancel / discard | Stop preserves the draft and keeps it in the editor; explicit Discard closes it durably | Cancel the exact target work; typing on resumes it; queued loads show Stopped |
| Undo / restore / delete | Change head atomically; invalidate affected drafts | Release affected targets before rehydration |
| Storage conflict/failure | Retain local work for recovery export; never report Saved | Drawing remains usable |

## Review fixes (2026-10-17)

A second review found editing and hot-path defects; all are fixed with regression tests
(`canvas editing semantics` in `tests/canvas-controller.test.ts`, `review 2026-10-17` in
`tests/canvas-model.test.ts`, `review_*`-derived tests in `crates/tb-coordinator/src/tests/targets.rs`).
Each new test was checked to fail against the previous code.

- Typing after Enter no longer rewrites the committed question; a second Enter no longer duplicates the chart.
- Escape keeps the edit in the editor; text typed during cold start is replayed.
- Saving no longer runs before the keystroke's DRAFT frame; queued draft writes coalesce
  (the store accepts any forward draft version).
- Jobs hold the queue only until their work is submitted. Only a source switch waits for
  registered work; queued loads prefer the open source. Typing during hydration previews at once.
- Every question-mode edit of a saved chart sends its edit base; an endpoint without
  `edit-context-v1` refuses change requests instead of translating them without context.
- Coordinator: a commit after a targeted QUERY re-executes instead of reporting the superseded
  SQL; re-registration pumps the queue; released targets' requests are collected; the target table
  is bounded with a fencing floor. Inference edit handles share the dataset context.
- Imported canvases contact URL/remote sources only after Refresh; imported layouts are bounded;
  table names never reach file paths. Playback to the end and plot double-click no longer create
  or restore revisions. New charts avoid occupied cells. Saved sessions are closed on switch;
  renderer/host target entries are pruned on detach; a hung save cannot lock canvas switching.

Not changed: saved questions and history are still placed in the system prompt (JSON-escaped,
with an instruction to treat them as data); moving them to a user message needs a live eval.

## Motion (2026-10-17)

Two visual settings in Settings → Motion, both on by default and off when the OS asks for reduced
motion (`src/ui/motion.ts`; stored with the other settings only once the user chooses):

- **Charts grow.** A new card is a 64 px breathing seed at its slot centre until its first result
  (axes, table, RESULT, a timing headline or an error; at most 2.5 s), then grows into the card in
  340 ms (`transform` + `clip-path`, content fades in). The renderer draws underneath the whole
  time, so key → first draw submitted is unchanged; the seed covers the wait, it does not add one.
- **Smooth camera.** Adding or removing a chart glides the camera to fit all charts in 250 ms
  (rAF, ease-out, geometric zoom about the viewport centre); Fit, Arrange and the zoom buttons glide
  too. Wheel, pan and card drags stop a glide immediately.

Measured (headless Chromium 145, software GPU, this 2-core host at load average ~8.8, 4 interleaved
runs each of `canvas_smoke --keystroke-only`): typed-keystroke handler median 0.38–0.47 ms with
motion on vs 0.38–0.44 ms off; `controller.input` median 0.14–0.23 ms vs 0.16–0.21 ms. Tails
varied 3–5× between runs of the same setting on the loaded host and are not attributable either
way; re-measure on a quiet machine.

## Delivery and acceptance ledger

- [x] Durable model, drafts, transactions, source definitions and history ownership.
- [x] Atomic checkpoints; monotonic canvas/draft versions and closure fencing.
- [x] Runtime registration, cancellation, terminal/adoption identity and presentation replacement.
- [x] Complete one-source create → reload → contextual refine → rollback flow.
- [x] Typed edit protocol, negotiation, cache isolation, prompt/repair parity and evals.
- [x] Chart/canvas undo, redo, branches, restoration, deletion and layout history.
- [x] Draft recovery across typing, generation, execution and failed storage.
- [x] Versioned branch-preserving export/import and RAM-only recovery export.
- [x] Multiple charts/sources, source reattachment/aliases and bounded hydration.
- [x] Stale frames/controls/writes, simultaneous tabs, import validation and failures.
- [x] Real browser scenarios, existing required tests/builds and rebuilt Wasm artifacts.
- [x] Executed-result refinement evals across datasets, including repair; record cost.
- [x] Persistence on/off timing and open/hydration/save/size measurements at 1/10/100 charts.
- [x] Independent implementation reviews; resolve substantive findings and verify fixes.
- [x] Requirement-by-requirement completion audit with current evidence.

## Verification evidence

Final required checks on 2026-10-15:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Passed |
| `pnpm test` | 427 passed; one opt-in benchmark skipped |
| `pnpm build` | Passed |
| `cargo test --locked` | 175 passed; two opt-in benchmarks ignored |
| `cargo test --locked --manifest-path crates/inference-server/Cargo.toml` | 38 passed |
| Rebuilt Wasm | Both public artifacts match the release outputs; real-Wasm regression suites pass |
| `python3 tests/ui_smoke.py http://127.0.0.1:5395` | Nine production application flows plus layout reload; zero browser errors |
| Isolated card/board browser smoke | 13 checks passed |
| Contextual scorer / live provider eval | 37 scorer checks; 12 live executed-result checks across four datasets |

Independent reviews: [storage](reviews/canvas-storage-implementation-2026-10-15.md),
[session/recovery](reviews/canvas-session-implementation-2026-10-15.md),
[runtime](reviews/canvas-runtime-implementation-2026-10-15.md), and
[controller semantics](reviews/canvas-controller-semantics-2026-10-15.md).
The controller review includes 23 protocol-level regressions spanning creation,
reload, refinement, preview gestures, undo, interrupted drafts, source scheduling,
capability negotiation and presentation timing. Native Rust and real-Wasm tests
separately exercise renderer startup, stale batches, cancellation and adoption.
One controller regression gates storage acknowledgement and verifies that input,
result delivery and optimistic revision promotion proceed while the save remains
pending; only releasing that gate permits the Saved state.
Two additional database lifecycle regressions reproduce old warm-ups overlapping
a new source load and deferred warm-up using a stale source. The database now joins
both rollup and warm-up work before reusing its load connection, and clears the old
context at the start of a source load. The real DuckDB and lifecycle suites pass
19/19; the full suite above includes those regressions.

Suggested questions create a new definition from the chip's exact SQL, originating
source and explicit view. They make no inference call. Canvas suggestions retain
SQL warming but bypass global question-to-SQL `PRIME` mappings: the same original
question can belong to charts with different selected SQL. The older transient
controller keeps its existing PRIME behavior for its measurement harnesses.

The [live edit evaluation](reviews/canvas-edit-evaluation-2026-10-15.md) passed
12 executed-result checks across vessels, weather, flights and cities, including
an actual automatic repair with two provider attempts. It covers selected branches,
captured gesture filters, regrouping, joins and an explicit view change.
Provider-reported total cost: **$0.00355485**. This is a targeted correctness sample,
not a general accuracy benchmark. Provider quality was evaluated on the Rust
backend; browser inference has separate protocol/repair tests and byte-identical
prompt goldens, without a live local-model quality claim.

The [production browser review](reviews/canvas-browser-verification-2026-10-15.md)
uses the real application, Wasm coordinator/renderer and DuckDB with scripted
inference. It verifies creation, reload without inference, refinement, exact
presentation restore, branched export/import, unfinished-draft recovery, SQL
editing, multiple sources, renamed-file reattachment and layout reload. Separate
real-IndexedDB review probes exercise competing writers, transaction aborts and
recovery export after storage failure.

## Requirement audit

| Requirement | Implementation and evidence |
|---|---|
| Persist definitions, never results | `model.ts` and strict `validation.ts` retain original question, exact SQL, source, presentation and layout; model/source tests and browser exports reject result/file fields. |
| Keep unfinished work | Versioned drafts save text, final SQL and finish intent independently of execution. Model/session tests cover failure, cancellation and storage errors; the browser recovers and resumes an unfinished edit after reload. |
| Reload by SQL | Controller hydration uses saved `QUERY` frames. Browser reload and 1/10/100-chart hydration runs make zero inference calls. |
| Refine from selected intent and SQL | `EDIT_CONTEXT` carries original question, selected SQL, presentation and selected lineage; `EDIT_INFER` carries the change. TS/Rust prompt goldens match; live executed-result evals cover filters, branches, joins, regeneration, cache isolation and repair. |
| Roll back chart or canvas, preserving futures | Immutable revisions/commits retain both branches; model tests cover undo, redo, chart restore, canvas restore and deletion. Browser checks restore Auto and clear later rotation settings, preserve branches through import and restore layout. |
| Reject abandoned work | Target generations, served sequences, execution identity and control fences reject late runtime events. Monotonic storage versions and closed drafts reject stale saves. Independent runtime and storage reviews reproduce and verify these boundaries. |
| Support multiple charts and sources | Per-definition source references, correlated activation and file fingerprints/aliases. Controller tests cover source switches/cancellation; browser checks fixture plus CSV and renamed-file reattachment. Real-Wasm residency tests retain 100 shells with eight active results. |
| Export and recover without data loss | Normal exports preserve all branches. Recovery exports separate last acknowledged state from RAM work; imports fork identities. Session tests and real-IndexedDB review probes cover failed promotion, failed import and a 37 MB recovery round trip. |

## Hydration measurements

The [final raw ledger](reviews/canvas-final-browser-2026-10-15.json) records production runs
at 1/10/100 charts, with exact bundle/Wasm hashes. Final observations, in milliseconds
from navigation, include fresh engine/fixture startup:

| Charts | Metadata visible | First draw submitted | First SQL terminal | Initial resident queries complete | Every definition executed |
|---:|---:|---:|---:|---:|---:|
| 1 | 136 | 2,350 | 2,358 | 2,358 | 2,358 |
| 10 | 126 | 2,294 | 2,565 | 4,525 | 5,329 |
| 100 | 995 | 2,854 | 2,862 | 5,126 | 36,694 |

Resident results remain **1/8/8**. After initial hydration, the harness invokes the
actual Refresh buttons for the remaining definitions, sequentially reopening the
source and executing saved SQL. The remaining 92 charts take 31,539 ms; all 100
distinct selected SQL statements execute, never with more than eight resident
results. Inference calls remain zero. This measures the current Refresh behavior,
not 100 simultaneously loaded results.

These are individual observations on Chromium 145 with a software GPU, not tail
latencies or physical-display measurements. Earlier runs and the source-refresh
failure/control/fix evidence are retained.

## Metadata/storage measurements

[Raw measurements](reviews/canvas-metadata-measurements-2026-10-15.json), Chromium
145.0.7632.0 on the shared ARM host. Five chart revisions per chart, all full canvas
snapshots retained. Initial saves and first loads are single observations; warm
load medians/p95 use five samples. These measure metadata, not SQL hydration or drawing.

| Charts | Portable bytes | Initial save ms | First load ms | Warm load p50/p95 ms |
|---:|---:|---:|---:|---:|
| 1 | 8,842 | 8.7 | 3.0 | 2.1 / 3.8 |
| 10 | 115,640 | 39.4 | 7.5 | 9.3 / 11.9 |
| 100 | 4,547,934 | 597.5 | 125.1 | 130.0 / 137.3 |

With 100 post-warmup edits per size, synchronous document authoring plus the save
queue measured **175–205 µs p50**, **525–795 µs p95**, versus **25 µs p50**,
**45–70 µs p95** for the same model edits without journaling/IndexedDB. Storage
acknowledgement p50 was 1.2–1.5 ms; p95 2.3–4.3 ms. These exclude DOM, frame encoding,
inference and rendering; they are not full input latency. No result data or
speculative inference was involved. The save path adds no debounce or storage await
before subsequent authoring.

Reproduce with a running development server:

```sh
python3 tests/canvas_metadata_bench.py http://127.0.0.1:5394 --json /tmp/canvas-metadata.json
node scripts/eval-canvas.mjs --self-test
```

The scorer self-test passes 37 checks across the current 11-case corpus. Its
counterexamples include dropped filters, wrong branches, lost joins, unchanged
grouping and missing or wrong view intent.

## Operational limits

Browser-local storage is per origin and browser profile. Export a canvas to move
it elsewhere. File bytes stay in memory; reload needs a matching SHA-256 file
reattachment, which preserves logical table aliases even if the filename changes.
Current URL/fixture/remote sources are rerun against current data. Pinned external
versions that cannot be verified require an explicit rebind to a new source.

Only eight chart results are resident at once; other cards retain their definitions
and load on demand. One source activates at a time. Saved SQL can load without any
inference endpoint. Refinement requires `edit-context-v1`; unsupported endpoints
show an actionable error and allow direct SQL editing.
Edit context is capped at 128 KiB and includes the most recent 32 selected-lineage
changes; the complete history remains in the document. An oversized edit base
fails explicitly, without dropping SQL or sending an incomplete change request.

Normal portable documents are capped at 32 MiB. Recovery files can contain both
the last acknowledged 32 MiB document and a 32 MiB working copy. A failed save or
cross-tab conflict retains RAM authoring and exposes recovery export / Save a copy;
it never labels that work Saved. Import forks every identity and keeps all branches.
No deployment is part of this change.
