# Performance and correctness review

Three parallel reviewers examined rendering, inference/speculation, and database
streaming/transport. Each first reproduced failures independently, then implemented
focused fixes. A final cross-review of integration caught local commit supersession
and runtime-initialization error handling. Root integration checked real DuckDB and
the public HTTPS build. Detailed evidence and limitations:

- [Rendering](rendering.md): free first rendering opportunity, bounded work,
  incremental paths, hidden-chart suppression, buffer identity and cancellation.
- [Inference and coordination](inference.md): warmed adapter reuse, exact draft
  identity, bounded generation admission, retry, promotion and staged delivery.
- [Streaming and transport](streaming.md): strict Arrow completion, actual retained
  allocations, immediate request supersession and bounded UTF-8 controls.

The strongest deterministic rendering evidence is command count: a stable-domain
4,000-point stream in 40 batches went from 82,165 time-series `lineTo` calls to
3,999. The corresponding track went from 82,600 to 4,015. The hidden time-series
chart went from 4,004 calls to zero. With a 100,000-point batch, the number of rows
indexed before the first animation-frame callback went from 100,000 to zero.
These checks establish reduced work and better scheduling; they are not physical
display measurements.

Integrated verification on 2026-10-09: **145 tests passed**, TypeScript and the
production build passed. Chromium 145.0.7632.0 passed real DuckDB execution and
cancellation (144 aggregate points; a raw stream canceled after 2,048 rows; the
following query returned 144 points), UI chart/table/CSV/trace and responsive
checks, and the controlled rendering harness. The public HTTPS smoke verified a
trailing-space prepared hit, zero database reloads after changing inference,
native HTTP engine decompression, immutable engine caching, and no page errors.

```sh
pnpm test
pnpm build
python3 tests/browser_database.py --url http://127.0.0.1:5173
python3 tests/browser_ui.py --base-url http://127.0.0.1:5173
python3 tests/ui_rendering.py --base-url http://127.0.0.1:5173
python3 tests/browser_production.py --url https://time-blast.46-224-133-201.sslip.io
```

A separate [warm production-build sample](../benchmark-review-browser.json) at
source `7429a62` used 20 paired trials per mode, after two warmups. Median
commit-to-first-draw submission was **22.3 ms without speculation** and **5.8 ms
for a prepared hit**; nearest-rank p95 was 31.3 ms and 17.7 ms respectively.
The prepared case waits for all 144 points before Enter. This measures templates
on warm DuckDB, with no LLM, no observed hit-rate estimate and no photon claim.
The earlier benchmark used a different Chromium/build combination and is not a
controlled before/after comparison with this sample.

The next substantial database experiment is an exact first time bucket/tile
followed by the remaining query against the same snapshot. Current whole-window
aggregation and sorting can still block the first result. Remote services,
post-submission priority upgrades, actual incremental model KV preparation, model
accuracy, and successful hardware-WebGPU generation remain separate work.

Public hosting serves production files directly through Caddy with HTTPS,
precompressed assets, native HTTP engine decompression and immutable hashed-asset
caching. See [deployment instructions](../../deploy/README.md). A source repository
being private does not make the static browser demo private; it contains only the
bundled synthetic dataset and browser application assets.
