# Working on time-blast

Time-blast minimizes natural-language request commit to the first correct visible chart point. Read README.md and the relevant design notes before implementing.

- Distinguish proposals, implemented capabilities, and measured results. Never invent latency numbers or describe draw submission as photons.
- Preserve exact commit/context/result identities, freshness semantics, bounded buffers, cancellation, and stale-result rejection.
- Keep local and remote execution behind the same logical contracts without forcing local work through network serialization.
- Use embedded DuckDB-Wasm to prove the first prototype; treat ClickHouse as the primary deployment backend and a Rust service as the leading relay/coordinator candidate.
- Stream columnar batches into drawing components with zero avoidable copies. Avoid full-result collection, per-row objects, gratuitous Wasm-memory detours, and repeated whole-history concatenation. Draw once the first complete timestamp/value point and its semantics are available.
- Prefer a small measurable implementation. Introduce lower-level code only for a demonstrated or explicitly tested benefit.
- Report correctness, tail latency, cold/warm state, and speculative resource cost together.
- Pin engine/browser versions and verify optional streaming, cache, snapshot, and cancellation capabilities.
- Keep benchmark artifacts reproducible; avoid committing credentials, private datasets, or model weights.

Run `pnpm test` and `pnpm build` for implementation changes. After changing the Rust compiler run `pnpm build:wasm` and `cargo test --manifest-path crates/query-core/Cargo.toml`; commit the rebuilt `public/wasm/query-core.wasm`. Browser smoke scripts in `tests/` require a running local server and Python Playwright. The prototype implementation and remote contracts are described in `docs/prototype.md`; older design notes also include future proposals.
