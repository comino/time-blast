# Demo deployment and operations

The public synthetic-data demo is served at
https://time-blast.46-224-133-201.sslip.io by the host's existing Caddy service.
The GitHub repository remains private. Caddy exposes the running Rust inference
service at `/api/inference/`; database execution and rendering remain in the
visiting browser. The demo defaults to OpenRouter's
`google/gemini-2.5-flash-lite`, retained after the
[hosted model comparison](../docs/experiments/hosted-models-2026-10-10.md).

> **Batch 1 is not deployed.** The live demo is the prototype build (JSON-plan inference
> service, Canvas2D), whose source was deleted from `main` after `1afe91c`. The tb1 inference
> server speaks a different protocol than the deployed browser build: deploy the new server and
> a new browser build **together**, once the renderer is merged. Notes for that step:
> [docs/batch-1/inference.md](../docs/batch-1/inference.md#deployment-notes-not-done). Health
> must then report `"protocol":"tb1"`.

## Verified deployment — 2026-10-10 (prototype)

| Component | Live state |
| --- | --- |
| Static release | `/srv/time-blast/releases/20261010T173044Z-a1890942`, selected by `/srv/time-blast/current`. |
| Frontend index SHA-256 | `0f31aedc69ea9a65938c89959f11b35c868ba8be17542eb410bd380eee416534` |
| Rust service | `time-blast-inference.service`, active; `/srv/time-blast/backend/time-blast-inference` on `127.0.0.1:8787`. |
| Deployed backend source | `197b445`; binary SHA-256 `cbe6e99402d1e1ef6445326e5e082dc84aa8f634fcbc2b61fed266d0159c6ff8`. |
| Provider configuration | `/etc/time-blast/inference.env`, owned by `root:root`, mode `0600`. |
| Browser inference endpoint | `wss://time-blast.46-224-133-201.sslip.io/api/inference/session`. |

Source commit `661a1d9` adds reasoning-effort and sampling-temperature controls
used in the model comparison. That binary has **not** replaced the live backend;
the comparison started isolated local processes. The deployed model and its
existing settings are unchanged. Build and deploy the newer service before
expecting those new controls to take effect.

This token-free health check verifies Caddy routing and service readiness:

```sh
curl --fail --silent --show-error \
  https://time-blast.46-224-133-201.sslip.io/api/inference/health
```

It currently returns `status: "ready"`, model `google/gemini-2.5-flash-lite` and
`providerWarmth: "unknown"`. It does not execute a model or database query.

## Static hosting

Build and atomically deploy:

```sh
pnpm install --frozen-lockfile
VITE_INFERENCE_ENDPOINT=wss://time-blast.46-224-133-201.sslip.io/api/inference/session pnpm build
sudo python3 scripts/deploy-static.py dist
```

Omitting `VITE_INFERENCE_ENDPOINT` produces a browser-WebGPU default instead.
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
