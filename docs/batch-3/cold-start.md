# Cold start (batch 3, workstream 1)

Goal: page open → first answerable question, and the first query before rollups exist, an order
of magnitude faster. Result on this host: **first visit 1.6× faster, repeat visit 2.8×, first
query after boot 5.5×, rollups ready 4.3× sooner** (they now ship prebuilt). Not 10×. The rest is
DuckDB-Wasm's own compile and instantiate. That floor is explained below.

## How it is measured

- **Boot trace** (`src/engine/boot-trace.ts`, `src/ui/boot-trace.ts`): named marks on both threads
  in absolute time. The worker forwards them as `{type:'trace'}`. The page prints a console table at
  "first question answerable" and again at "rollups ready", and exposes
  `globalThis.__timeBlastBoot.report()`. Answerable means the dataset context is out and the
  coordinator, renderer and inference link are READY, the same definition `scripts/perf/e2e.py` uses.
- `scripts/bench-boot.py`: stage-by-stage trace with median/p95. First visit uses a fresh context.
  Repeat visit uses a persistent profile, so the disk cache and Cache API are real. Then one
  question is typed (optionally after `--query-delay`).
- `vite preview` now sends the production host's headers (`vite.config.ts` `caddyLikePreview`):
  immutable `/assets/*`, `no-cache` elsewhere, and engines decoded by HTTP. It does not compress
  JS (Caddy does); on loopback this does not matter.
- Environment: openclaw-fred, 4-core Neoverse-N1, shared and **heavily loaded** (load 12–27,
  once 180 with swap full; runs from that period were discarded). Headless Chromium 145 with a
  SwiftShader GPU, DuckDB-Wasm 1.32.0 (DuckDB v1.4.3). All numbers are software timestamps, in ms
  from navigation start.

## Before / after

Fair comparison: **alternating A/B** with `scripts/perf/e2e.py` against main (72cbb5b) and this
branch. Both are production builds behind the same preview headers, 8 boots per side, load 12–18
([cold-start-ab-2026-10-11.json](cold-start-ab-2026-10-11.json)):

| ms, p50 / p95 | main | branch | |
|---|---|---|---|
| first visit → answerable | 11 906 / 16 593 | **7 517 / 9 734** | 1.6× |
| repeat visit → answerable | 12 577 / 18 527 | **4 464 / 6 822** | 2.8× |
| first question after boot, keystroke → first draw | 497 / 748 | **91 / 211** | 5.5× |
| keystroke → first draw, steady state | 79 / 103 | 75 / 98 | same |

Stage traces (`bench-boot.py`, n = 4 per row; before at load ~25, after at ~17, so compare the
shapes, not the totals): [before](cold-start-boot-trace-before.json),
[after](cold-start-boot-trace-after.json).

| stage (first visit, p50 duration) | before | after |
|---|---|---|
| DuckDB fetch (JS gunzip into a Blob) + compile + instantiate | 1 282 + 4 440 | compile 1 712 while streaming, from worker start, overlapped; instantiate 2 736 |
| `LOAD parquet` | 1 817 | 0 (loaded only when a Parquet source opens) |
| `LOAD json` + lock | 629 | 630, **after** answerable (deferred lockdown) |
| generate `vessels` (1.2 M rows) | 7 732 | 0 (prebuilt file attached: fetch 76, attach 384) |
| statistics / context | 1 108 | 0 (stored in the file) |
| rollups minute/hour/day (background) | 4 538, ready at 27 973 | 0, ready with the context at 6 468 |
| answerable | 20 162 | **6 472** (repeat **4 300**) |

The first query after boot, typed instantly at answerable, waits for the deferred lockdown
(~0.6 s): 1.2 s p50. Typed 2 s after answerable, it takes **199 ms** with the warm-up and 773 ms
without it (alternating, n = 6 each, [cold-start-warmup-2026-10-11.json](cold-start-warmup-2026-10-11.json)).

## What changed (all kept, each measured above)

1. **Prebuilt databases.** `scripts/build-datasets.mjs` reads `public/data/datasets.json`
   (manifest contract from plan-batch-3). For each `prebuilt` entry it loads the data with the
   browser's own `DuckDatabaseNode` on the node-blocking bundle (same engine): the context,
   statistics, rollup specs and function catalog are exactly what the browser would compute. The
   **DuckDB CLI v1.4.3** then writes the file (tables from Parquet, rollups using the same
   `buildSql`, single-threaded) with one metadata row `__tb_rollup.__tb_meta`. The file is read
   back in DuckDB-Wasm and compared: raw tables hash-equal, rollup row counts equal. DuckDB-Wasm
   cannot write the file itself: its file system appends checkpoint writes, so the database
   header lands at the end of the file (traced: header write at offset 536 576 instead of 4096).
   `vessels.duckdb` is 25.0 MiB (11.5 MiB gzip; raw table 16 MiB, minute rollup 8 MiB). The
   browser attaches it read-only as `tb_fixture` and uses the stored context, rollups and catalog
   (the catalog only on a DuckDB version match). `duckdb_functions()` alone costs 0.2–1.5 s cold.
2. **Blob, not buffer.** The prebuilt file is registered as a Blob (`registerFileHandle`,
   FileReaderSync protocol). DuckDB reads only the blocks it needs, and 25 MiB is never copied into
   JS or Wasm memory. Before this, fetch plus copy plus registration cost 2.9 s.
3. **Persistence.** The Cache API keeps the file across visits, validated by the server's ETag
   (one conditional request; 304 → stored copy, a new ETag → refetch; unit-tested in
   `tests/datasets-persist.test.ts`). Repeat-visit download: 0 bytes, about 200 ms.
4. **Parallel, earlier boot.** `src/ui/boot.ts` spawns the worker before the UI is built. The worker
   name carries the boot fixture. A 5 KB worker entry (`src/engine/worker-entry.ts`, shared with
   `/measure.html`) starts the DuckDB `compileStreaming`, the coordinator and renderer compiles,
   the manifest, the prebuilt fetch and the json-extension prefetch before the 218 KB main chunk
   (`engine-main.ts`) and the 1.26 MB DuckDB glue chunk (`database.ts`, loaded lazily) arrive.
   The compiled module goes to DuckDB's Emscripten loader (`instantiateWasm` hook), so the engine
   is fetched once.
5. **Renderer head start.** DuckDB's instantiate holds the worker thread for seconds. The DuckDB
   boot waits up to 1.5 s for the renderer, so the GPU pipelines compile in the GPU process
   meanwhile. Before this, the renderer finished after the dataset; now it finishes about 2 s
   before it.
6. **Parquet on demand.** The boot no longer loads `parquet` (1.8 s here). Opening a Parquet source
   re-instantiates DuckDB from the already compiled module with Parquet loaded
   (`ParquetOnDemand`), because no extension can load after the lockdown.
7. **Deferred lockdown.** `LOAD json` and the setting locks run right after the first open. The
   database node runs no EXEC before the lockdown completes, so no model SQL ever runs unlocked.
8. **Warm-up.** After the lockdown, two background statements derived from the context (a scan
   aggregate, and an hourly bucket rewritten onto a rollup) compile DuckDB's lazily compiled paths
   and the parser. They yield to any EXEC.
9. The first open on a fresh instance skips the needless `dropAll` (~0.4 s).

## Correctness

- `node scripts/bench-database.mjs --load prebuilt`: **308/308 statements identical** to the
  generated batch-1 baseline. `--load parquet`: **308/308**.
  ([prebuilt](cold-start-db-exact-prebuilt.json), [parquet](cold-start-db-exact-parquet.json))
- `tests/engine-prebuilt.test.ts`: context and rollups come from the file, the hourly query uses
  `source: 'rollup'`, the node detaches back to memory; manifest table loading.
- `pnpm test`, `tsc`, `pnpm build`; e2e (`e2e_fake_inference`, `e2e_manipulate`,
  `e2e_suggest_voice`) all pass on the dev server.

## Shipping

The prebuilt files are built during deployment, not committed (25 MiB plus 12 MiB per build);
see [deploy/README.md](../../deploy/README.md). `deploy-static.py` precompresses `.duckdb`.
Without the files the page falls back to generating the data in the browser.

## Contract changes

- `EngineToUi` gains `{ type: 'trace'; marks: BootMark[] }` (additive; the controller ignores it).
- Manifest: unchanged from plan-batch-3. The prebuilt file's layout (`__tb_rollup.__tb_meta`,
  `PrebuiltMeta` in `src/engine/datasets.ts`) is internal to the database node.

## The floor, and next

On this host the critical path is now: worker main chunk (~1.3 s under load), DuckDB compile
(1.0–1.7 s, off-thread), instantiate (1.6–2.7 s, Emscripten init and lazy compilation on the
worker thread), `open` (0.4–0.5 s), attach (0.3–0.4 s). V8's Wasm code cache does not help:
after 4 visits only 24 KB of Wasm code was cached, none of it DuckDB, so every visit
recompiles 34 MB. On the engine agent's quieter runs, instantiate cost a third of what it costs
here.

Next:
- Get the DuckDB module into V8's code cache, or ship a smaller DuckDB build (custom build without
  unused extensions/functions): the largest remaining stage.
- Measure on real hardware (`/measure.html`); this host is CPU-starved during compile.
- Drop the minute rollup from the file and build it in the background if transfer size matters
  more than minute-level queries (−8 MiB raw).
- Self-host the json extension and serve it with immutable caching (currently an
  extensions.duckdb.org fetch, prefetched in parallel).
- Run `pnpm perf` on the merged main for the history file: the A/B above used its e2e driver
  directly, alternating builds.
