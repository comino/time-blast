#!/usr/bin/env bash
# Fetch the official prebuilt libduckdb v1.4.3 (Linux) into .cache/libduckdb-v1.4.3 of the repo,
# verified by SHA-256 (digests from the GitHub release API). Same DuckDB version as the browser's
# DuckDB-Wasm and the CLI used for prebuilt datasets.
set -euo pipefail
VERSION=v1.4.3
case "$(uname -m)" in
  aarch64|arm64) ASSET=libduckdb-linux-arm64.zip; SHA256=2882ed153f620a7f185b232d13694d481db3458ad1e4c04a4775d97b60567b4a ;;
  x86_64) ASSET=libduckdb-linux-amd64.zip; SHA256=3c7bb8d586d39ccce56442c3f6bafa97f53d7b6bb5405dac827442fcb31494aa ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${1:-$ROOT/.cache/libduckdb-$VERSION}"
if [[ -f "$DEST/libduckdb.so" && -f "$DEST/duckdb.h" ]]; then echo "$DEST"; exit 0; fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$ASSET" "https://github.com/duckdb/duckdb/releases/download/$VERSION/$ASSET"
echo "$SHA256  $TMP/$ASSET" | sha256sum -c - >&2
mkdir -p "$DEST"
unzip -q -o "$TMP/$ASSET" libduckdb.so duckdb.h -d "$DEST"
echo "$DEST"
