# Working on time-blast

Time-blast minimizes natural-language request commit to the first correct visible chart point. Read README.md and the relevant design notes before implementing.

- Distinguish proposals, implemented capabilities, and measured results. Never invent latency numbers or describe draw submission as photons.
- Preserve exact commit/context/result identities, freshness semantics, bounded buffers, cancellation, and stale-result rejection.
- Keep local and remote execution behind the same logical contracts without forcing local work through network serialization.
- Prefer a small measurable implementation. Introduce lower-level code only for a demonstrated or explicitly tested benefit.
- Report correctness, tail latency, cold/warm state, and speculative resource cost together.
- Pin engine/browser versions and verify optional streaming, cache, snapshot, and cancellation capabilities.
- Keep benchmark artifacts reproducible; avoid committing credentials, private datasets, or model weights.

This repository currently contains architecture and experiment plans only. There is no application build or test command yet.
