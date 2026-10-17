# Canvas session and recovery implementation review

Reviewed 2026-10-15: `src/canvas/session.ts`, `recovery.ts`, the read-transaction
error handling in `store.ts`, and `tests/canvas-session.test.ts`, against
`docs/reviews/canvas-recovery-contract-2026-10-15.md`. No production code or tests
were edited by this reviewer.

Two session defects and one recovery-size mismatch were found, fixed by the
implementer and independently verified. No remaining P1/P2 issue was confirmed
in the reviewed paths. Original reproductions are retained below.
The expanded focused suite passes: 8 session tests plus 18 model tests.

Browser checks used real Chromium IndexedDB, loading only the canvas modules on
an empty Vite page. Failure injection gated writes, rejected one promotion, or
aborted a real import/read transaction. No inference or dataset queries ran.

## 1. P1, fixed: A microtask can strand the final autosave

**Original location:** `src/canvas/session.ts:57` in the initial session version.
**Fix location:** current `session.ts:60` and `:117`.

The original queue starter declined to start when `running` was set. A new command
could be queued after the drain's final acknowledgement but before its `finally`
handler cleared `running`. The drain had already exited; `finally` did not restart
it. That final command stayed queued indefinitely until another command arrived.

Observed reproduction using real IndexedDB:

```ts
await session.settled();
let scheduled = false;
session.subscribe(() => {
  if (session.saveState.state === 'saved' && !scheduled) {
    scheduled = true;
    queueMicrotask(() => session.command(m => m.rename('Second name')));
  }
});
session.command(m => m.rename('First name'));
await session.settled();
```

Before the fix, state remained `saving`, pending was 1, RAM contained `Second
name`, and IndexedDB still contained `First name`. Waiting another 40 ms did not
drain it. Recovery export correctly retained the difference, but autosave stalled.

The new `pump()` rechecks the queue after clearing `running`; `settled()` waits
through restarts. The same browser reproduction now ends `saved`, pending 0,
with `Second name` in IndexedDB.

## 2. P2, fixed: A closed staged session can replace the active canvas

**Original location:** `src/canvas/session.ts:70` and `:110`.
**Fix location:** current `session.ts:78` and `:118`.

Closing a newly created/imported session did not revoke its deferred activation.
Its outstanding initial write still ran to completion and then called
`setActive()`, even after the user had selected another canvas.

Observed sequence: create B and save it; gate A's initial write; create and close
A; select B; release A's write. IndexedDB's active preference changed back to A.
The fix clears activation on close and checks the closed flag before starting the
preference write. Repeating the sequence now preserves B. Completing the old
document transaction itself remains safe and preserves its data.

## 3. P2, fixed: Recovery accepts less working history than an ordinary export

**Locations:** `src/canvas/recovery.ts:5`, `:39`, `:46`;
`src/canvas/session.ts:109`.

Both ordinary files and recovery envelopes share a 32 MiB whole-file limit.
Recovery contains the acknowledged and working snapshots, so a perfectly valid
ordinary canvas above roughly 16 MiB can no longer be recovery-exported after
even one unsaved action. This defeats the offered escape hatch precisely when
storage fails.

Real IndexedDB reproduction:

1. Construct 45 valid chart revisions whose SQL is `SELECT <n> /* ... */`, with
   a 200 KiB comment each. These are within the supported per-SQL limit. No SQL
   execution is required to test file/storage behavior.
2. Encode the ordinary document: **18,502,316 bytes**, below 32 MiB.
3. Import it through `CanvasSession.import()` into real IndexedDB and wait for
   `saved`.
4. Inject a quota error for the next write and rename the canvas.
5. Call `exportFile()`.

Observed result: the saved import succeeds, the rename correctly reports `error`,
but recovery export throws `Canvas file exceeds 32 MiB; no history was truncated`.
The graph remains in RAM, with no usable recovery file from this API.

**Minimal remedy:** give recovery envelopes enough budget for two supported
ordinary snapshots plus envelope overhead, with matching parser validation.
Keep per-snapshot limits explicit so accepting a recovery file does not permit an
arbitrarily larger ordinary document. A broader large-document/archive design is
not needed for this mismatch; history must not be truncated to fit.

**Verified fix:** recovery now has a two-document envelope budget and validates
each embedded snapshot against the ordinary 32 MiB limit. The original browser
reproduction exported and parsed a **37,005,206-byte** recovery file, preserving
all 45 revisions and the unsaved title. A separate **36,934,316-byte** embedded
working snapshot was rejected with `An embedded canvas exceeds 32 MiB`, so the
larger envelope does not bypass the ordinary per-document boundary.

## Recovery behavior independently verified

- **Failed promotion:** saved SQL remained `SELECT 1`; the recovery working graph
  retained `SELECT 1` and `SELECT 2`, including the optimistic committed draft.
  The envelope represented the acknowledgement boundary correctly.
- **Atomic import failure:** aborted a real import transaction after object-store
  puts were queued. No partial canvas appeared in `list()`, active preference was
  unchanged, the imported session reported error, and its own recovery export
  remained valid with `acknowledged: null`.
- **Successful recovery:** importing the same recovery file used a new canvas
  namespace, saved both revisions, selected a `Recover working copy` commit and
  left the original canvas head unchanged.
- **Read failures:** forcibly aborted `load()`, `list()` and `getActive()` read
  transactions. All rejected with `AbortError`; no unhandled rejections occurred;
  a subsequent normal load still succeeded. Awaiting transaction completion in
  the same `Promise.all` as requests fixes the earlier read-error handling risk.
- **Other required cases:** focused tests cover failed layout/rename/restore/undo,
  preservation of both branches, initial-save failure with no acknowledged
  baseline, closed-draft protection, conflict freezing, and imported successful
  candidates requiring a fresh edit session before promotion.

The acknowledged mirror is updated from exact successful patches, not a later
optimistic snapshot. Recovery import does not replay old compare-and-swap writes
or overwrite the source canvas. Those boundaries are implemented as intended.
