#!/usr/bin/env bash
# Regenerate the Arrow stream fixtures for src/ipc/tests.rs from a ClickHouse server.
#   CLICKHOUSE_URL (default http://127.0.0.1:18123). Captured from ClickHouse 26.8.
set -euo pipefail
cd "$(dirname "$0")"
url=${CLICKHOUSE_URL:-http://127.0.0.1:18123}
plain="$url/?output_format_arrow_compression_method=none"
curl -sS "$plain&max_block_size=4" -o small.arrows --data-binary \
  "SELECT number AS n, toString(number) AS s, toDateTime64('2026-09-01 00:00:00', 6, 'UTC') + number AS t, toDateTime('2026-09-01 00:00:00', 'UTC') AS dt FROM numbers(10) FORMAT ArrowStream"
curl -sS "$plain&max_block_size=1000&max_result_rows=1500&result_overflow_mode=throw" -o exception.arrows --data-binary \
  "SELECT number AS n FROM numbers(100000) FORMAT ArrowStream" || true  # ClickHouse closes the chunked body after the exception block
curl -sS "$plain" -o empty.arrows --data-binary "SELECT number AS n FROM numbers(0) FORMAT ArrowStream"
curl -sS "$url/?output_format_arrow_compression_method=lz4_frame" -o lz4.arrows --data-binary \
  "SELECT number AS n FROM numbers(1000) FORMAT ArrowStream"
ls -l ./*.arrows
