# HTTPS static hosting

The public synthetic-data demo is served at
https://time-blast.46-224-133-201.sslip.io by the host's existing Caddy service.
The GitHub repository remains private. The Rust inference service can be exposed
at `/api/inference/` through the included Caddy configuration. Database execution
and rendering remain in the visiting browser.

Build and atomically deploy:

```sh
pnpm install --frozen-lockfile
pnpm build
sudo python3 scripts/deploy-static.py dist
```

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
port 8787. Check `systemctl status time-blast-inference` and `/health` before
installing the updated Caddy site and reloading Caddy.

Build the browser with its public endpoint to enable remote inference by default:

```sh
VITE_INFERENCE_ENDPOINT=wss://time-blast.46-224-133-201.sslip.io/api/inference/session pnpm build
sudo python3 scripts/deploy-static.py dist
python3 tests/browser_production.py \
  --url https://time-blast.46-224-133-201.sslip.io --default-inference remote
```

That production smoke deliberately switches to local WebGPU/templates to check
unavailable-model and real database regressions without spending provider tokens.
Live model verification is separate. See [the backend contract and limits](../docs/backend-prototype.md).
The prototype has origin checks, bounded sessions/concurrency and process-local
generation budgets, but no user authentication or durable billing quota.
