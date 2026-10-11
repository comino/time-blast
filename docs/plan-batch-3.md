# Batch 3: cold start, generality, measurement discipline

Status: in progress (started 2026-10-11). Direction: [vision.md](vision.md). Owner's priorities:
performance and maturity. No time on operational chores such as logins. **No work on hosted
inference latency**: the owner expects inference to run locally soon.

## Why these four

Measured on the public demo (2026-10-11): last keystroke → first draw 547 ms with real inference,
of which inference ~366 ms, cold first query ~138 ms and our pipeline ~40 ms. Opening the page takes
~15 s before the first question can run. The 91 % NL→SQL score and the prompt come from 45 questions
about one synthetic dataset, and nothing guards against performance regressions.

| # | Workstream | Done when |
|---|---|---|
| 1 | **Cold start** (page open → first answerable question, and first query before rollups exist) | Boot measured stage by stage. First visit and repeat visit both drop by an order of magnitude, or the remaining floor is explained. Prebuilt databases with rollups; persistence across visits; engines start during HTML parse |
| 3 | **Generality**: 3–4 real public datasets of different shapes, each with its own executed-result corpus | Eval scores per dataset with the current default model. Prompt changes only if they help across datasets. The vessels score is no longer the only number |
| 4 | **Performance regression harness**: one command runs e2e, SQL eval (optional, costs money), database bench and boot bench, appending p50/p95 per stage to a history file keyed by commit | A dashboard page shows trends. A regression budget check fails loudly. `docs/perf/` holds the history |
| 5 | **Real-hardware measurement page** the owner opens on their machine | It reports keystroke → GPU-presented frame, boot stages, GPU adapter info and network RTT, and exports JSON the harness ingests |

## Shared contract added for this batch: dataset manifest

`public/data/datasets.json` lists fixtures the browser can open by name (`{kind:'fixture', name}`):

```json
[{ "name": "vessels", "title": "…", "description": "…",
   "tables": [{ "name": "telemetry", "url": "data/vessels/telemetry.parquet", "rows": 1209600 }],
   "prebuilt": "data/vessels/vessels.duckdb",
   "license": "…", "source": "…" }]
```

- `prebuilt` is optional: a DuckDB database file with tables and rollups already built (workstream 1).
- The generality workstream adds datasets and corpora; the cold-start workstream owns how fixtures load.
- `DatasetSource` fixture names become `string` (any manifest entry).
