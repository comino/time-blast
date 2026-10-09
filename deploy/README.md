# HTTPS static hosting

The public synthetic-data demo is served at
https://time-blast.46-224-133-201.sslip.io by the host's existing Caddy service.
The GitHub repository remains private. No inference or database server is hosted
here: the default runtime executes those components in the visiting browser.

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
