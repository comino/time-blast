# Demo deployment and operations

The public synthetic-data demo is served at
https://time-blast.46-224-133-201.sslip.io by the host's existing Caddy service.
The GitHub repository remains private. Caddy exposes the Rust tb1 inference service at
`/api/inference/`; the coordinator, DuckDB and rendering run in the visiting browser
(engine worker). The server's default profile is `openai/gpt-oss-120b` on Groq, reasoning low
([batch-2/inference.md](../docs/batch-2/inference.md)).

## Verified deployment — 2026-10-17 (persistent canvas)

| Component | Live state |
| --- | --- |
| Source | `main` at `8e4fdc5` (persistent canvas + review fixes + motion + fullscreen focus mode, on top of batches 1–3) |
| Static release | `/srv/time-blast/releases/20261017T194930Z-de24b6a6`; index SHA-256 `b6d8f31cdcd88ad76702542ab10e501fe64b0f4ac0f361740afbf9d64391e7fb` (previous: `20261017T183958Z-d1f48ff5`) |
| Rust service | binary SHA-256 prefix `a7d27c12fec8a93c` (adds `edit-context-v1`; base prompt unchanged, v6), model `openai/gpt-oss-120b` |
| Rollback copies | binary `/srv/time-blast/backend/time-blast-inference.bak-4efbf437` (batches 1–3 server); previous release `20261011T130843Z-27f6869e` |

Public check (headless Chromium, software GPU, real inference over HTTPS, fresh profile):
cross-origin isolated, no console errors, boot 2.6 s. "average wind speed per vessel by hour"
drew and checkpointed; after a reload the chart came back with the same revision and SQL without
inference; refining it with "only the last 24 hours" added the time filter as a new revision.
The first check found a bug (Edit clicked during boot started a new chart), fixed in `69c107e`.
Motion (`b7dcd6a`) checked live the same way: the first chart seeded, grew on its first result
(seed → grow 1.6 s while typing with real inference) and finished; no console errors.

## Previous deployment — 2026-10-11 (batches 1–3)


| Component | Live state |
| --- | --- |
| Source | `main` at `f6882de` (batches 1–3, dataset picker) |
| Static release | `/srv/time-blast/releases/20261011T130843Z-27f6869e`, selected by `/srv/time-blast/current`; index SHA-256 `be07328dd70421c7a9405ecc532d29050530200701f537c69dc0acdf9f3e6b73`; includes prebuilt `data/vessels/vessels.duckdb` and `/measure.html` |
| Rust service | `time-blast-inference.service`, `/srv/time-blast/backend/time-blast-inference` on `127.0.0.1:8787`, binary SHA-256 `4efbf43726102cfcf39a78570badbf1a7ea4f17f46e76069365cc606c1708858` (prompt v6); health reports `"protocol":"tb1"`, model `openai/gpt-oss-120b` |
| Provider configuration | `/etc/time-blast/inference.env` (`root:root`, `0600`): no `TIME_BLAST_MODEL` (server default applies), 600 requests/min, 30,000/day, `TIME_BLAST_DAILY_BUDGET_USD="3"` |
| Caddy | `/etc/caddy/sites/time-blast.caddy` from `deploy/time-blast.Caddyfile` (unchanged), COOP `same-origin` + COEP `credentialless` |
| Rollback copies | binary `/srv/time-blast/backend/time-blast-inference.bak-002ae9b` (batch-2 server), previous releases `20261011T130438Z-3f078165`, `20261011T083529Z-b73120fc` (batch 2), older backups from the batch-2 deploy |

Public browser check (headless Chromium, software GPU, real inference over HTTPS, fresh profile):
cross-origin isolated, no console errors.

- Boot to all components ready: 5.1–7.9 s on a first visit, 4.5 s on a repeat visit.
- "average wind speed per vessel by hour" drew the per-vessel hourly lines without Enter: last
  keystroke → first draw 588 ms (first token 311 ms, DB first batch 51 ms, draw 8 ms).
- Switching datasets in settings: `flights` loaded in 7.5 s (3 tables) and drew a JOIN query
  ("average arrival delay by carrier name") in 575 ms. `cities` loaded in 0.4 s (JOIN, 1013 ms).
  `weather` loaded in 0.9 s (533 ms).
- **Open issue:** the first two checks after the deploy failed to load all three new datasets
  ("Could not load …"); it did not reproduce in four later runs. The suspect, unconfirmed, is the
  runtime fetch of DuckDB's Parquet extension from extensions.duckdb.org. Self-hosting the
  extensions would remove that dependency.

No ClickHouse node is deployed.

This token-free health check verifies Caddy routing and service readiness:

```sh
curl --fail --silent --show-error \
  https://time-blast.46-224-133-201.sslip.io/api/inference/health
```

It returns `status: "ready"`, `protocol: "tb1"`, the model and today's budget counters. It does
not execute a model or database query.

## Static hosting

Build and atomically deploy:

```sh
pnpm install --frozen-lockfile
node scripts/build-datasets.mjs --fetch-duckdb   # prebuilt databases into public/data/ (~1 min here)
VITE_INFERENCE_ENDPOINT=wss://time-blast.46-224-133-201.sslip.io/api/inference/session pnpm build
sudo python3 scripts/deploy-static.py dist
```

Omitting `VITE_INFERENCE_ENDPOINT` produces a browser-WebGPU default instead.

### Datasets: built at deploy time, not committed

`public/data/datasets.json` (committed) lists the fixtures (contract in
[plan-batch-3.md](../docs/plan-batch-3.md)). For every entry with a `prebuilt` path,
`scripts/build-datasets.mjs` writes that DuckDB file (tables, dataset context, minute/hour/day
rollups, function catalog) and, for generated tables, their Parquet `url`
([cold-start.md](../docs/batch-3/cold-start.md)). The outputs are gitignored
(`public/data/vessels/`: `vessels.duckdb` 25 MiB, 11.5 MiB gzip; `telemetry.parquet` 12 MiB) and
must exist before `pnpm build`, which copies `public/` into `dist/`. Without them the page still
works: it generates `vessels` in the browser (seconds slower; the boot trace shows it).

The build needs the DuckDB **CLI of the engine's version (v1.4.3)**: DuckDB-Wasm's file system
cannot write a database file (checkpoints land at the wrong offset). `--fetch-duckdb` downloads
the official release zip once into `.cache/` and checks its pinned SHA-256; `--duckdb path` or
`$DUCKDB_CLI` use an installed one. It also needs extensions.duckdb.org (json/parquet) at build
time. When `@duckdb/duckdb-wasm` is upgraded, update `CLI_VERSION` and the hashes in
`scripts/build-datasets-lib.ts` and `DUCKDB_VERSION` in `src/engine/early.ts`, and rebuild the
datasets: a prebuilt file's function catalog is only used when versions match.

`deploy-static.py` precompresses `.duckdb` files (gzip -9) next to them; Caddy's
`precompressed gzip` serves the 11.5 MiB variant. Data files revalidate (`no-cache`, ETag); the
page keeps prebuilt files in the Cache API and sends one conditional request per visit.
`deploy-static.py` installs the build and switches the release symlink; it does
not edit Caddy, deploy the backend, or restart services.

Initial Caddy setup: install `time-blast.Caddyfile` into
`/etc/caddy/sites/time-blast.caddy`, then append exactly one
`import /etc/caddy/sites/time-blast.caddy` to the existing Caddyfile, preserving its
other sites. Back up that file first. Validate with
`sudo caddy validate --config /etc/caddy/Caddyfile` before
`sudo systemctl reload caddy`. The hostname must resolve to the host and inbound
ports 80/443 must reach Caddy for HTTPS certificate provisioning.

Caddy serves production files directly, with precompressed JS/CSS/HTML and HTTP
decompression of the packaged DuckDB engines. Only content-hashed assets receive
immutable caching; fixed filenames revalidate. See the official
[precompressed file server documentation](https://caddyserver.com/docs/caddyfile/directives/file_server).

Releases live under `/srv/time-blast/releases`; `current` changes with an atomic
symlink replacement. Hashed assets are shared and retained across releases to
keep worker imports working for already-open tabs. Rollback uses the same atomic
symlink replacement to the previous release. Prune old releases/assets manually
only after allowing open clients to expire; this script never deletes them.

Browser tests must verify real queries over HTTPS, not just an HTML status code.
Model downloads depend on the model host and require a supported WebGPU device;
serving the page over HTTPS does not establish inference performance.

## Rust inference service

Build and test the service first:

```sh
cargo test --locked --manifest-path crates/inference-server/Cargo.toml
cargo build --release --locked --manifest-path crates/inference-server/Cargo.toml
# First install only: preserve the existing private API-key environment variable.
sudo --preserve-env=OPENROUTER_API_KEY python3 scripts/deploy-inference.py \
  crates/inference-server/target/release/time-blast-inference
```

The script installs the service binary and systemd unit, writes a root-readable
`/etc/time-blast/inference.env` on first installation and preserves it thereafter.
Edit that file to change the provider/model; credentials never enter the build.
The unit is specific to this demo host's `fred` service user. It binds loopback
port 8787. Changing a source default does not replace an existing configured
model. After editing the environment file with `sudoedit`, restart the service
and check its reported model:

```sh
sudoedit /etc/time-blast/inference.env
sudo systemctl restart time-blast-inference.service
systemctl is-active time-blast-inference.service
curl --fail --silent --show-error http://127.0.0.1:8787/health
```

Keep the file root-owned with mode `0600`; do not copy it into logs or the
repository. A service restart closes inference sockets and resets its
process-local plan caches and request budgets. Browser clients reconnect for
subsequent requests. The install script atomically replaces the executable,
installs the systemd unit, restarts it, and checks local health. It does not retain
an old backend binary for rollback; keep a known-good executable before updates.
Static and backend releases are independent.

The commands above use Cargo's default target directory. If `CARGO_TARGET_DIR`
is set, pass its `release/time-blast-inference` path to the installer. On this
demo host, builds use the mounted volume to avoid the nearly full root disk:

```sh
export CARGO_HOME=/mnt/HC_Volume_105875173/hf-cache/time-blast-eval/rust-cargo
export CARGO_TARGET_DIR=/mnt/HC_Volume_105875173/hf-cache/time-blast-eval/rust-target
```

Check the health endpoint before installing an updated Caddy site and reloading
Caddy. The included `handle_path /api/inference/*` removes that prefix before
forwarding to the service.

Build the browser with its public endpoint to enable remote inference by default:

```sh
VITE_INFERENCE_ENDPOINT=wss://time-blast.46-224-133-201.sslip.io/api/inference/session pnpm build
sudo python3 scripts/deploy-static.py dist
```

The prototype's production smokes (`tests/browser_production.py`, `tests/browser_backend_live.py`)
were deleted with its code; their recorded results stay in
[verification.md](../docs/verification.md). End-to-end browser smokes for the batch-1 build are
wave-2 work. Until then, check a new server with `node scripts/eval-sql.mjs --endpoint
ws://127.0.0.1:8787/session` (spends provider tokens; scores SQL by executed results).
The prototype has origin checks, bounded sessions/concurrency and process-local
generation budgets, but no user authentication or durable billing quota.
