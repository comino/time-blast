# Inference, speculation, and runtime lifecycle review

Reviewed 2026-10-09. Source review and deterministic reproductions were used; no model download, software GPU run, or inference latency benchmark was performed. The existing documentation accurately says draft messages do not incrementally prefill a model cache.

## Confirmed findings and implemented changes

1. **P2: unrelated adapter reinitialization.** Changing only inference settings destroyed and rebuilt DuckDB; changing only database settings destroyed the local model. A mocked pre-fix lifecycle recorded two database constructions/preparations and one disposal after Auto → Templates. `src/main.ts` now reconciles adapter identities independently, reconnects coordination, and updates retained inference context when the database changes. A page restored from the back-forward cache creates fresh adapters after pagehide disposal. Model status callbacks are tied to adapter identity.
2. **P2: whitespace prevented exact promotion.** Drafts preserved textarea text but submission trimmed it. The pre-fix reproduction prepared a trailing-space prompt, then observed two inference calls, two database calls, and no promotion. The UI now submits the raw snapshot, trimming only to check emptiness. The coordinator continues to require exact text/context identity; it does not normalize potentially meaningful request content.
3. **P2: failed model warmup was permanently cached.** Repeating preparation after a simulated download failure sent only one preparation request in total. Failed workers and warmup promises are now reset, while successful preparation remains reusable. A worker failure after readiness can also recover through explicit preparation.
4. **P2: canceled generations accumulated behind an active task.** The promise-tail queue retained 1,001 known/canceled entries when one active task was held and 1,000 successors were canceled. Generation admission now permits one active request and one removable waiter. Canceling the waiter rejects it immediately and releases its slot. Active cancellation still waits for task settlement and its own interruption acknowledgment before another generation runs.
5. **P2: promotion retained speculative admission priority.** Database request priority was captured before Enter. It is now a getter reflecting the job's current committed state, so a request still waiting for admission receives committed priority. **A remote request already serialized and sent cannot be upgraded by this change.** That requires an explicit service-side promotion protocol, which remains unimplemented.

Additional changes support the rendering and remote/data-plane review fixes:

- `cancelForeground()` immediately supersedes submitted work while retaining the speculative candidate, allowing remote coordination to cancel the previous request before the next ACCEPT.
- Local Enter also cancels the foreground synchronously, before MessageChannel delivery. A new transport epoch fences older queued commits/drafts while preserving an already-prepared exact candidate. Regression tests cover held old inference and superseded queued promotion.
- Staged promotion publishes its first batch immediately, then drains remaining batches in yielded tasks bounded by 32 batches or approximately four milliseconds of callback work. It uses `scheduler.yield()` when available and a reusable MessageChannel otherwise, avoiding nested timer clamping. Live batches cannot overtake that drain; completion waits for it. Cancellation and foreground identity fence subsequent delivery.
- Speculation/result budgets count unique retained backing allocations per job through `ColumnBatch.retainedBuffers`, with a typed-array-buffer fallback. Logical `timing.bytes` remains the payload metric. Accounting references are cleared on discard, cancellation, failure, or foreground completion.
- Local draft/commit transport rejects oversized prompts before cloning them through MessageChannel, preserving full committed intent rather than truncating it.
- Runtime initialization catches database-constructor and previous-adapter disposal failures, reports the error, and clears the busy state instead of leaving an unhandled rejected initialization promise.

## Verification

`tests/inference.test.ts` covers bounded admission, immediate canceled-waiter removal, interruption ownership, failed-warmup retry, worker-loss recovery, and successful-worker reuse. `tests/lifecycle.test.ts` checks unaffected adapter retention, new dataset context delivery to retained inference, status callbacks, coordinator-only changes, and page restoration. `tests/coordinator.test.ts` checks exact whitespace snapshots, late-admission priority, retained allocation budgets/deduplication, staged/live ordering, yielded drain cancellation, foreground-only cancellation, and prompt limits before local cloning.

Original read-only check: 54 inference/coordinator tests passed. Post-change targeted checks passed across inference, coordinator, and lifecycle tests, including the MessageChannel yield fallback; TypeScript checking passed. Integration results are recorded in the final review report. These are functional and resource-bound checks, not measured reductions in end-to-end latency.

## Remaining performance questions

Pinned WebLLM checks its interruption flag after prefill, so an expensive active prefill can still delay a committed request despite bounded queue memory. Measure cancellation-to-next-generation admission on actual hardware before selecting a speculation budget or timeout policy. Draft snapshots still do not mutate a KV cache. Completed hardware-WebGPU inference and semantic accuracy remain unverified here. Speculative GPU time, discarded tokens, and remote post-submission priority upgrades need explicit instrumentation/protocol work before stronger performance claims.
