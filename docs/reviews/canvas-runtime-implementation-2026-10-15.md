# Persistent canvas runtime implementation review — 2026-10-15

**Verified closed at 21:21 UTC.** All nine reproduced runtime findings below now
pass regression checks against the rebuilt coordinator Wasm and current host.
The review added [17 permanent regression tests](../../tests/canvas-runtime.test.ts).
The five affected TypeScript suites pass **58/58 tests**; `pnpm exec tsc --noEmit`
passes. No production implementation files were edited by this reviewer.

Scope: target registration, revision adoption, terminal outcomes, source changes,
startup queues, renderer controls and the draft encoder. Reviewed against
`AGENTS.md` and `docs/vision.md`. This verifies the runtime contract, not the whole
persistent canvas UI or reload/recovery feature.

## Highest-priority failures found and fixed

### P1 — Adopted revisions could be replaced by an older answer

The original `adopt()` changed `Request.revision` without advancing the separate
`Target.shown_revision` used by `show_target()`.

Reproduction: A succeeds at sequence 1; B starts inference at sequence 2; returning
to A at sequence 3 adopts A's completed result. B's slower SQL then passed the old
sequence-1 target fence and received BIND/EXEC, replacing the correct sequence-3
answer. This occurred with the supported `latest` policy and when the intervening
translation was committed.

**Verified fix:** `crates/tb-coordinator/src/lib.rs:986` advances the bound target's
shown revision on adoption. Permanent tests exercise both scheduling cases and
assert that the intervening answer receives cancellation without BIND or EXEC.
The adopted SQL and successful outcome retain the original execution identity and
new sequence.

### P1 — Startup replay could draw an obsolete generation

The host previously filtered target frames when queuing them but replayed them
directly after renderer creation. An older REGISTER/BIND/schema/batch could draw
before the queue reached the newer REGISTER already accepted by the host.

**Verified fix:** `src/engine/host.ts:136` checks queued frames against current
ownership through `admitsQueuedRender` at line 418. Real-host/real-renderer tests
hold renderer initialization pending, replace the generation or QUERY revision,
then start rendering. Only the latest request emits DRAWN, table data and GPU draw
commands. Late database frames for the replaced request remain rejected.

### P1 — Source cancellation could still draw unfinished queued data

The first startup fix checked current `renderBindings`, but database cancellation
removed only `executions`. A source change cancelled an unfinished request while
leaving its old binding eligible for replay.

**Verified fix:** cancellation routing at `src/engine/host.ts:474` also removes the
cancelled request's render binding. Tests gate the renderer, receive schema and one
batch without DONE, then release the target, cancel globally or activate another
source. Resolving renderer startup produces no DRAWN, table data or GPU draw
commands; late database replies remain rejected.

The positive control completes a query before renderer startup and changes source.
That completed chart still renders and retains its successful terminal outcome.
The fix therefore preserves completed charts rather than suppressing every queued
result after a source transition.

### P1 — Explicit QUERY bypassed target sequence ordering

QUERY sequence 2 followed by sequence 1 previously cancelled the newer execution
and executed the old SQL.

**Verified fix:** `crates/tb-coordinator/src/lib.rs:576` rejects sequences at/below
the shown sequence and below the latest target draft before superseding anything.
Tests verify old and duplicate explicit SQL are ignored, the newer execution can
still succeed, and a newer draft also fences older QUERY frames.

### P1 — Reordered release and registration could resurrect discarded work

RELEASE for an unseen generation originally left no tombstone, so a delayed
REGISTER for that generation could become active.

**Verified fix:** `crates/tb-coordinator/src/targets.rs:45`,
`src/engine/host.ts:390` and `src/engine/render/index.ts:141` retain release
tombstones, including unseen/future generations. The Wasm regression releases an
unseen generation, verifies registration/execution are refused, releases a future
generation while another is running, and verifies only a still newer generation
can resume work.

## Other failures found and fixed

| Priority | Original defect | Verified behavior |
| --- | --- | --- |
| P2 | `Translated + Idle` work never received a terminal cancellation. | `targets.rs:78` and the global cancellation loop in `lib.rs:679` terminalize it. With speculation disabled, release, global cancel and source suspension each emit one cancellation; late DONE cannot change it. |
| P2 | CONFIG could put registered/tombstoned slots back in the legacy pool. | `lib.rs:668` excludes every registered slot. Tests offer the document slot and an ordinary slot together; legacy work binds only the ordinary slot, both before and after document release. |
| P2 | Same-sequence COMMIT with different text silently reused the old SQL. | `lib.rs:512` rejects conflicting target text as malformed; the unchanged COMMIT remains valid without extra inference or execution. |
| P2 | Adopting an in-flight translation emitted CANDIDATE with empty SQL. | `targets.rs:111` skips candidate emission until SQL exists. The eventual SQL is emitted under the adopted sequence. |

The implementation agent also fixed detach-after-release admission at
`host.ts:233`: an exact-generation detach is allowed for an inactive tombstone.
That issue was found by the implementation agent and is not counted among this
review's nine independently reproduced failures.

## Verification

The permanent suite uses actual `public/wasm/tb-coordinator.wasm` and
`public/wasm/tb-render.wasm`, the real engine host and a null GPU backend. Its fake
database emits real Arrow batches synchronously. Assertions concern protocol
outcomes, data admission and generated GPU commands; they are not browser-pixel or
physical-display measurements. No provider calls or heavy builds were run.

At 21:20 UTC:

```sh
pnpm exec vitest run tests/canvas-runtime.test.ts tests/engine-host.test.ts tests/render-node.test.ts tests/ui-draft-encoder.test.ts tests/coordinator-core.test.ts
pnpm exec tsc --noEmit
```

Results: **5 suites, 58 tests passed; TypeScript passed.** The earlier baseline's
invalid-UTF-8 test failure was corrected by sending its malformed DRAFT under the
current epoch; stale-epoch rejection itself was working correctly.

Initial defect probes remain outside the repository in
`/tmp/timeblast-runtime-review-20261015/`. They asserted the old failures and are
historical reproduction evidence. The permanent suite asserts the corrected
behavior and is the regression artifact to retain.

The reviewed runtime also fences live database frames by request/epoch/context,
fences target controls and non-frame renderer replies by generation/request, and
resets both stored presentation parameters and existing renderer-family state.
No blocking runtime findings remain from this review. Browser persistence/reload,
source restoration, storage conflicts and UI revision promotion require their own
integration verification.
