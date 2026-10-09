# Second control and inference review

Reviewed 2026-10-09. This pass read the implemented contract, coordinator clients,
model adapters and generation queue. Reproductions used controlled adapters and
worker responses; no model download, hardware GPU execution or latency benchmark
was performed.

## Confirmed findings and fixes

### P2: delayed acceptance discarded a newer translation

Sequence: submit A, edit to B while A awaits remote ACCEPT, receive PREPARE for B,
then receive ACCEPT for A. Before the fix, B reached `SQL prepared before Enter`,
but accepting A discarded B. The client had already consumed B's preparation
permission, so it ignored another PREPARE for that revision. Enter on B performed
inference again. A controlled reproduction recorded two B translations and no
`prepared_sql_promoted` event.

The remote client now defers preparation while a submission awaits ACCEPT. It
retains one authorized revision, starts the immutable foreground submission on
ACCEPT, then admits the authorization if it still names the current newer draft.
Another submission or cancellation clears that deferred permission. The executor
does not rewind its observed draft, cancel a newer preparation timer, or clear the
newer draft's preparation indicator when executing an older accepted snapshot.
Ordinary mismatched candidate cancellation remains intact.

This deliberately gives the pending submission admission before its newer draft.
Preserving an already active speculative model/database task would instead queue
the submitted work behind it. The change does not add queue preemption or claim
that speculation can never contend with foreground work after admission.

Transport regressions cover SQL-only and result preparation, deferred timer
admission, a held newer translation while the foreground completes, stale
permissions, successive submissions, and reuse on the newer draft's Enter. They
assert inference order, one translation per request, preserved draft/UI state,
and `prepared_sql_promoted` or `prepared_result_promoted` as appropriate.

### P2: unloaded model engines remained marked ready

Pinned WebLLM 0.2.85 handles GPU device loss by unloading its engine. This need not
crash the worker. Its next generation can report `ModelNotLoadedError`, while the
application still retains a successful warmup promise and marks the model ready.
Explicit preparation then reuses that stale state. A controlled engine-unload
reproduction recorded one initialization, a generation failure, a successful
preparation response, and the same generation failure again.

The adapter now recognizes `ModelNotLoadedError` and `DeviceLostError` as fatal
engine failures. It clears readiness and warmup, terminates the stale worker,
rejects its pending requests, and reports the failure. Explicit preparation can
then create a new worker. Fatal errors are handled even if their originating
request was canceled and no longer has a pending listener. Errors from replaced
workers remain fenced by worker identity. Ordinary semantic/validation failures
do not force a model reload.

Controlled worker tests cover both fatal error names, pending-request rejection,
readiness invalidation, successful explicit recovery, late old-worker errors,
fatal errors after cancellation, and warmed-worker retention after an unsupported
request. These checks establish application recovery behavior, not a successful
hardware device-loss recovery measurement.

## Verification

The focused coordinator, transport and inference suites passed **112 tests**;
TypeScript checking and `git diff --check` also passed:

```sh
pnpm exec vitest run tests/coordinator.test.ts tests/coordinator-transport.test.ts tests/inference.test.ts
pnpm exec tsc --noEmit
git diff --check
```

No additional concrete defect was found in local commit/cancel epochs, cold-model
waiter removal, exact SQL/result promotion, bounded generation admission, or
interruption ownership. Previously documented limitations remain outside these
fixes.
