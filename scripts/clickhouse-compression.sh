#!/usr/bin/env bash
# Compression options for the remote database's 60,480-row aggregate, straight from ClickHouse's
# HTTP interface (no relay): time to first byte, total time and bytes; median of 9 by total.
#   CLICKHOUSE_URL (default http://127.0.0.1:18123), CLICKHOUSE_DATABASE (default time_blast_dev)
# Results: docs/batch-1/remote-database.md ("Compression").
set -euo pipefail
url=${CLICKHOUSE_URL:-http://127.0.0.1:18123}
db=${CLICKHOUSE_DATABASE:-time_blast_dev}
base="$url/?database=$db&max_block_size=8192"
query="SELECT date_trunc('minute', ts) AS t, vessel, avg(speed) AS speed FROM telemetry WHERE ts < TIMESTAMP '2026-09-08' GROUP BY ALL ORDER BY 1, 2 FORMAT ArrowStream"

run() { # label, url suffix, extra curl args…
  local label=$1 suffix=$2
  shift 2
  for _ in $(seq 9); do
    curl -s -o /dev/null -w '%{time_starttransfer} %{time_total} %{size_download}\n' "$@" "$base$suffix" --data-binary "$query"
  done | sort -k2 -n | sed -n 5p |
    awk -v l="$label" '{printf "%-30s first byte %6.1f ms  total %6.1f ms  bytes %8d\n", l, $1*1000, $2*1000, $3}'
}

run "none" "&output_format_arrow_compression_method=none"
run "HTTP lz4" "&output_format_arrow_compression_method=none&enable_http_compression=1" -H 'Accept-Encoding: lz4'
run "HTTP zstd" "&output_format_arrow_compression_method=none&enable_http_compression=1" -H 'Accept-Encoding: zstd'
run "HTTP gzip level 1" "&output_format_arrow_compression_method=none&enable_http_compression=1&http_zlib_compression_level=1" -H 'Accept-Encoding: gzip'
run "Arrow IPC body lz4_frame" "&output_format_arrow_compression_method=lz4_frame"
run "Arrow IPC body zstd" "&output_format_arrow_compression_method=zstd"
