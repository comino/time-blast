# Documentation map

Start with **[vision.md](vision.md)**. It is canonical. Everything below was written
before the vision was stated (2026-10-10) unless marked otherwise. Read it as
background, and where it conflicts with the vision, the vision wins.

## Current: read these

| Doc | What it is for |
|---|---|
| [vision.md](vision.md) | Purpose, metric, architecture principles, what to unlearn. **Canonical.** |
| [status.md](status.md) | What is deployed and running right now, and the next steps |
| [plan-batch-2.md](plan-batch-2.md) | The current batch: database and inference latency, shipping, interactions |
| [plan-batch-1.md](plan-batch-1.md) | Batch 1 (done): protocol, Rust/Wasm coordinator and renderer, SQL, ClickHouse node |
| [protocol-v1.md](protocol-v1.md) | tb1: the one frame format and message vocabulary for every component and placement |
| [batch-2/](batch-2/) | Batch 2 per area: [database.md](batch-2/database.md), [inference.md](batch-2/inference.md), [manipulation.md](batch-2/manipulation.md) (chart-as-query, steady charts) |
| [batch-1/](batch-1/) | What batch 1 built and measured, per area: coordinator, engine, inference, ui, render; [evals.md](batch-1/evals.md) scores NL→SQL by executed results |
| [../deploy/README.md](../deploy/README.md) | Operating and updating the live demo (still the prototype build) |

## Still-valid research and evidence

These hold up regardless of the 7-field plan. They are worth reading before
working on the relevant layer.

| Doc | Why it is still useful |
|---|---|
| [streaming-without-repacking.md](streaming-without-repacking.md) | Database buffers to drawing without copies |
| [rust-service-and-channels.md](rust-service-and-channels.md) | Socket and channel options for the uniform protocol |
| [browser-and-transport.md](browser-and-transport.md) | Browser networking, memory movement and rendering limits |
| [rust-and-wasm.md](rust-and-wasm.md) | Where Rust/Wasm helps and where bindings add copies |
| [protocol.md](protocol.md) | `tb/0` draft: identities, draft/commit, cancellation. Superseded by protocol-v1.md; the reasoning still holds |
| [data-plane.md](data-plane.md) | Getting an early point from DuckDB and ClickHouse |
| [experiments.md](experiments.md) | Latency definitions and benchmark design (redefine around thought → result) |
| [experiments/](experiments/) | Dated measurements: first-bucket query, hosted model comparison |
| [benchmarks/](benchmarks/) | Dated benchmark records. The QueryPlan meaning corpus and its runners were deleted in batch 1 (last present at commit 1afe91c) |

## Historical: superseded by the vision

| Doc | What changed |
|---|---|
| [architecture.md](architecture.md) | Day-one proposals; principles now in vision.md |
| [inference.md](inference.md) | Built around the typed plan and Enter; speculation ideas remain relevant |
| [roadmap.md](roadmap.md) | Prototype milestones; the priorities in status.md replace its "next" sections |
| [canvas-reference.md](canvas-reference.md) | Notes on the Data Canvas reference; already absorbed into the UI |
| [reviews/](reviews/) | Reviews of the prototype, including its 7-field plan |
| [prototype.md](prototype.md) | The prototype's browser implementation (adapters, plan compiler, Canvas2D); code deleted in batch 1 |
| [backend-prototype.md](backend-prototype.md) | The prototype's JSON-plan inference service; replaced by the tb1 server ([batch-1/inference.md](batch-1/inference.md)) |
| [verification.md](verification.md), [benchmark-browser.json](benchmark-browser.json) | Test and benchmark records of the prototype; their commands refer to deleted scripts |
