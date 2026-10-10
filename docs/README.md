# Documentation map

Start with **[vision.md](vision.md)**. It is canonical. Everything below was written
before the vision was stated (2026-10-10) unless marked otherwise. Read it as
background, and where it conflicts with the vision, the vision wins.

## Current: read these

| Doc | What it is for |
|---|---|
| [vision.md](vision.md) | Purpose, metric, architecture principles, what to unlearn. **Canonical.** |
| [status.md](status.md) | What is deployed and running right now, and the next steps |
| [../deploy/README.md](../deploy/README.md) | Operating and updating the live demo |
| [backend-prototype.md](backend-prototype.md) | The running Rust inference service (its protocol is one of the ones to unify) |
| [prototype.md](prototype.md) | Browser implementation as it exists: adapters, cancellation, streaming, canvas |

## Still-valid research and evidence

These hold up regardless of the 7-field plan. They are worth reading before
working on the relevant layer.

| Doc | Why it is still useful |
|---|---|
| [streaming-without-repacking.md](streaming-without-repacking.md) | Database buffers to drawing without copies |
| [rust-service-and-channels.md](rust-service-and-channels.md) | Socket and channel options for the uniform protocol |
| [browser-and-transport.md](browser-and-transport.md) | Browser networking, memory movement and rendering limits |
| [rust-and-wasm.md](rust-and-wasm.md) | Where Rust/Wasm helps and where bindings add copies |
| [protocol.md](protocol.md) | `tb/0` draft: identities, draft/commit, cancellation. **Starting point** for the uniform protocol; never implemented |
| [data-plane.md](data-plane.md) | Getting an early point from DuckDB and ClickHouse |
| [experiments.md](experiments.md) | Latency definitions and benchmark design (redefine around thought → result) |
| [experiments/](experiments/) | Dated measurements: first-bucket query, hosted model comparison |
| [verification.md](verification.md), [benchmarks/](benchmarks/) | Dated test and benchmark records |

## Historical: superseded by the vision

| Doc | What changed |
|---|---|
| [architecture.md](architecture.md) | Day-one proposals; principles now in vision.md |
| [inference.md](inference.md) | Built around the typed plan and Enter; speculation ideas remain relevant |
| [roadmap.md](roadmap.md) | Prototype milestones; the priorities in status.md replace its "next" sections |
| [canvas-reference.md](canvas-reference.md) | Notes on the Data Canvas reference; already absorbed into the UI |
| [reviews/](reviews/) | Reviews of the prototype, including its 7-field plan |
| [../evals/](../evals/) | Meaning corpus scoring full 7-field `QueryPlan`s; needs replacing with SQL/result-based evaluation |
