# Second data-plane review

Reviewed 2026-10-09: adapters, retained Arrow allocations, remote framing, synthetic profiles, and the Rust/Wasm compiler contract. No deployment or model download was performed.

## Fixed findings

**P2 — inconsistent Arrow record-batch metadata reached the decoder before resource checks.** `ArrowStreamFraming.readMetadata()` checked the batch's advertised row count but did not compare its field-node lengths, null counts, or numeric buffer ranges. A 504-byte response advertising one row with zero-length fields completed successfully with zero points. A field longer than its peers also makes Arrow backfill validity bitmaps while constructing the batch, before the adapter's retained-memory accounting runs. This permitted metadata to drive allocations outside the intended row budget.

The remote adapter now checks that a batch has exactly one field node and two buffers per schema column before Arrow expands the metadata vectors. Each field must match the advertised row count and contain no nulls. Value buffers must hold all complete numeric elements; optional validity buffers must be long enough when present. Offsets must be aligned and every buffer must fit inside the advertised body. These checks run before the original chunks reach Arrow's result decoder.

Buffer lengths may include producer padding. Cross-review caught an initially overstrict eight-byte padding ceiling; the final check accepts larger padding within the existing body and encoded-byte budgets. A real decoder regression covers 64-byte-padded columns and asserts that their numeric views retain the incoming buffer. No numerical result copy or whole-result collection was added.

**P2 — big-endian Arrow values were silently interpreted in the browser's byte order.** Arrow 17 drops the schema endianness flag without converting primitive values. Cross-review reproduced a valid big-endian stream with `x = 0`, `series = 0`, and `y = [10, 20, 30]` that passed existing numeric checks as tiny, incorrect finite values. The bridge now explicitly supports little-endian buffers and rejects other schema byte orders before Arrow decodes the schema. A one-point positive/negative pair verifies correct little-endian values, buffer identity, and rejection of the big-endian response before publication; no byte-swapping or result-copy path was added.

## Verification

- `pnpm exec vitest run tests/database.test.ts`: **48 tests passed**, including 22 new cases for inconsistent field lengths/null counts, missing or extra metadata entries, short/misaligned/out-of-body buffers, logical Int32 lengths, optional validity buffers, padded streams, and explicit schema byte order through the real remote adapter. Existing fragmentation, EOS, transport failure, cancellation, and backing-allocation tests still pass.
- Final combined verification reported by the root reviewer: `pnpm test` passed **198 tests across 10 files**, and `pnpm build` passed TypeScript and the production Vite build with the final padding and endianness changes included.
- `cargo test --manifest-path crates/query-core/Cargo.toml`: **3 tests passed**; compiler source and checked-in Wasm were unchanged.
- `python3 tests/browser_database.py --dataset-profile large --url http://127.0.0.1:5173`: passed on Chromium **145.0.7632.0**, DuckDB-Wasm **1.32.0**, and Arrow **17.0.0**. Verified **1,209,600** materialized rows, exact six-second date bounds, six vessels, **144** hourly result points, cancellation after a **2,048**-row raw batch, and a subsequent **144**-point query. No page errors occurred.

The browser check is functional evidence, not a latency benchmark. Existing whole-window aggregation/sorting and renderer/engine memory outside the result-buffer budgets remain documented limits.
