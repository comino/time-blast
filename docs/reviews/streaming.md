# Data plane and remote control review

Reviewed and fixed on 2026-10-09 against the pinned Arrow 17.0.0 and DuckDB-Wasm 1.32.0 dependencies. This is correctness and resource-accounting evidence, not a latency benchmark. No Rust query shape or hosting changes were made in this workstream.

## Reproductions and fixes

| Finding | Before | After |
| --- | --- | --- |
| False successful Arrow completion | Concatenated valid streams containing `y=11` and `y=22` returned only `[11]` and completed successfully. The decoder stopped at the first EOS while the wrapper checked only the final eight bytes. | Incremental framing accepts one schema, supported record batches, exactly one explicit EOS at a message boundary, and clean HTTP completion. Any subsequent bytes fail, whether they share a network chunk with EOS or arrive later. A second schema without an intervening EOS also fails. |
| Retained-memory undercount | A one-row slice reported 20 logical bytes while retaining 20,971,520 backing bytes. Through the real remote adapter, a one-row IPC response with an unused 8 MiB string column reported 20 bytes but retained an 8,389,456-byte buffer and the unused column. | Schema validation rejects extra and duplicate columns. Batches expose unique retained backing buffers, including validity allocations and full allocations behind slices. Adapters count each allocation once with a WeakSet; coordinator accounting uses the same references across the job. Logical `byteLength` remains separate for telemetry. |
| Old results after a new remote commit | ACCEPT A, hold A's inference, COMMIT B without ACCEPT, then finish A: A remained active and emitted `start`, `batch`, and `complete` after Enter on B. | COMMIT immediately cancels the previous foreground and invalidates mismatched candidates. An exact candidate remains available for promotion after ACCEPT. Late inference, batches, and completion from A are suppressed. |
| Unbounded outbound control messages | A 1,000,000-character draft was transmitted when the socket's existing `bufferedAmount` was zero. | Oversized drafts are neither retained nor transmitted; they invalidate prior speculative work through an empty local draft. Oversized commits produce a recoverable error. The send guard charges existing queued bytes plus the next serialized message's UTF-8 bytes against 64 KiB. Incoming controls are bounded to 16 KiB of UTF-8. |
| Cancellation during a stalled stream read | Cancellation depended on the underlying fetch stream rejecting its pending read. | The source also cancels its reader on abort, promptly unblocking stalled reads and releasing its lock once during cleanup. Parsing/transport failures remain sticky even if Arrow's iterator adapter consumes an exception. |

## Buffer and framing contract

The result schema is exactly `x: Float64`, `y: Float64`, `series: Int32`, with optional paired `lat: Float64` and `lon: Float64`. Null/value validation still runs before publishing a batch. No result body is copied by the framing validator: it skips body spans and passes original chunks into Arrow. An eight-byte header scratch buffer handles split prefixes; contiguous metadata is decoded by view, and only fragmented metadata is assembled into a bounded buffer. Arrow decoding and its own IPC assembly retain their existing allocation behavior.

Metadata messages are limited to 64 KiB, appropriate to this narrow primitive schema. Declared body size and record counts are validated before publication. A byte pattern resembling EOS inside a body is data, not success. Successful completion requires an explicit modern eight-byte EOS and clean transport EOF; legacy positive-length message prefixes remain readable, but a legacy four-byte terminator does not satisfy the bridge completion contract.

The independent wire-byte cap remains 32 MiB. Actual backing allocations may be larger than a logical view; they now count toward adapter and coordinator retained-memory budgets. Shared backing buffers count once across adjacent batches. Accounting itself creates no numerical copy; adapter WeakSets do not keep released buffers alive.

## Verification

Before changes, the existing focused database, coordinator-transport, and compiler suites passed all 28 tests; Rust passed all 3 tests. The failures above were isolated reproductions outside those existing cases.

After changes, `pnpm exec vitest run tests/database.test.ts tests/coordinator-transport.test.ts` passed **48 tests**, and `pnpm exec tsc --noEmit` passed. Regression coverage includes:

- Full backing allocations behind slices; shared allocations charged once; validity buffers; unsupported/duplicate fields.
- Every-byte fragmentation; empty valid streams; truncated EOS and bodies; EOS-like body suffixes; repeated schemas; concatenated streams within one chunk and across chunks; text plus a later EOS; malformed metadata lengths; late transport failure; stalled-read cancellation and idempotent cleanup.
- Old inference and database output after a new remote commit; mismatched and exact candidate handling; oversized draft invalidation and commit recovery; exact queue boundaries using multibyte UTF-8; oversized HELLO and inbound controls.

Final whole-application tests/build and browser smoke results are recorded by the integrating workstream. These functional checks do not establish a latency improvement.

## Remaining performance experiments and limitations

The compiler still aggregates and sorts the whole selected time range (`crates/query-core/src/lib.rs`). The main next experiment is an exact first bucket or aligned time tile followed by the remaining range, using one immutable snapshot. Preserve the original lower bound for the first partial bucket, do not split the same aggregate bucket across queries, handle empty initial tiles, and compare against a single whole-range query. Measure first point, useful coverage, completion, scanned work, and cancellation cost. No tiling was implemented in this patch.

An in-flight speculative request now exposes its current priority to the browser adapter at admission through the coordinator's priority getter. Once a remote POST has already been submitted, the existing bridge contract has no operation to upgrade its server-side priority. Such promotion remains local; no remote priority-upgrade endpoint was invented. The admission gate remains one active query and one waiter, with coordinator cancellation providing the current replacement policy.

Whole-batch validity checks precede publication. A small first record batch is a candidate for reducing that barrier, but it requires measured batch-size sweeps and must preserve complete-point validation. The framing check introduces bounded metadata parsing work; there is no claimed speedup from that correctness check.

## Follow-up: live translation and dataset profiles

Remote HELLO now explicitly includes `liveTranslation` (default false) and `translationMinChars` (default 20). With live translation enabled, PREPARE is eligible only at the trimmed-text threshold and outside composition; the browser still requires server authorization for each revision. Composition state changes advance the revision even when text is unchanged, preventing an earlier permission from restarting canceled composition work. With database speculation disabled, the candidate contains validated SQL only and reaches the database after the matching ACCEPT. Tests cover all four independent inference/database placement combinations, immediate stale cancellation, threshold boundaries, and same-text composition transitions. No remote scheduling service is implemented, so these client changes do not guarantee immediate remote translation latency.

The browser database now offers two explicitly synthetic profiles:

| Profile | Snapshot ID | Observations | Sampling |
| --- | --- | ---: | --- |
| Demo | `synthetic-vessels-2026-09-v1` | 120,960 | One minute |
| Large (default) | `synthetic-vessels-2026-09-6s-v1` | 1,209,600 | Six seconds |

Both contain six fictional vessels over the same 14-day UTC window. Demo loads the existing small Parquet file. Large evaluates the original continuous-time synthetic formulas directly inside DuckDB using SQL `range`; it does not repeat downloaded rows, construct JavaScript row objects, or add a large asset. Natural range order avoids a global startup sort. The 256 MB database memory limit now applies before materialization. A 6,048,000-row stress option was not added: its primitive columns alone would occupy about 363 MB, exceeding that engine budget before execution overhead.

Increasing source observations does not directly multiply the number of aggregated chart points. Minute buckets across all six vessels produce 8,640 chart points for one day or 60,480 for one week. `tests/browser_database.py --dataset-profile demo|large` verifies actual materialized row counts, date bounds, vessel count, normal query results, and cancellation, while reporting startup duration as an observation. The default smoke profile remains explicit `demo`; integrating browser checks and startup/memory observations for `large` are run separately, without concurrent browser benchmarks.
