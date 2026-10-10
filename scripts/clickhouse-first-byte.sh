#!/usr/bin/env bash
# First-byte vs total time from ClickHouse's HTTP interface for the remote database's scan
# (158,400 rows) and 60k aggregate under the settings that decide when the first block leaves
# the server. Median of 9 by first byte. No relay involved.
#   CLICKHOUSE_URL (default http://127.0.0.1:18123), CLICKHOUSE_DATABASE (default time_blast_dev)
# Results: docs/batch-1/remote-database.md ("First batch").
set -euo pipefail
url=${CLICKHOUSE_URL:-http://127.0.0.1:18123}
db=${CLICKHOUSE_DATABASE:-time_blast_dev}
base="$url/?database=$db&readonly=1&output_format_arrow_compression_method=none"
scan="SELECT ts, speed, lat, lon FROM telemetry WHERE vessel = 'Aurora' AND ts < TIMESTAMP '2026-09-12' ORDER BY ts FORMAT ArrowStream"
aggregate="SELECT date_trunc('minute', ts) AS t, vessel, avg(speed) AS speed FROM telemetry WHERE ts < TIMESTAMP '2026-09-08' GROUP BY ALL ORDER BY 1, 2 FORMAT ArrowStream"

run() { # label, query, url suffix
  local label=$1 query=$2 suffix=$3
  for _ in $(seq 9); do
    curl -s -o /dev/null -w '%{time_starttransfer} %{time_total}\n' "$base$suffix" --data-binary "$query"
  done | sort -n | sed -n 5p | awk -v l="$label" '{printf "%-44s first byte %6.1f ms  total %6.1f ms\n", l, $1*1000, $2*1000}'
}

for q in scan aggregate; do
  sql=${!q}
  run "$q default (wait_end_of_query=0)" "$sql" ""
  run "$q wait_end_of_query=1" "$sql" "&wait_end_of_query=1"
  run "$q send_progress_in_http_headers=1" "$sql" "&send_progress_in_http_headers=1"
  run "$q max_block_size=8192" "$sql" "&max_block_size=8192"
  run "$q max_block_size=1024" "$sql" "&max_block_size=1024"
  run "$q output_format_arrow_record_batch_size=1024" "$sql" "&output_format_arrow_record_batch_size=1024"
  run "$q max_threads=1" "$sql" "&max_threads=1"
done
