#!/usr/bin/env bash
# Load the vessels fixture (scripts/clickhouse-vessels.sql) into ClickHouse over HTTP.
#   CLICKHOUSE_URL       default http://127.0.0.1:18123
#   CLICKHOUSE_DATABASE  default time_blast_dev (created if missing; nothing else is touched)
#   CLICKHOUSE_USER / CLICKHOUSE_PASSWORD  optional
# Skips the load when the table already holds 1,209,600 rows; --replace reloads it.
set -euo pipefail
url=${CLICKHOUSE_URL:-http://127.0.0.1:18123}
db=${CLICKHOUSE_DATABASE:-time_blast_dev}
here=$(cd "$(dirname "$0")" && pwd)
auth=()
if [[ -n ${CLICKHOUSE_USER:-} ]]; then
  auth=(-H "X-ClickHouse-User: $CLICKHOUSE_USER" -H "X-ClickHouse-Key: ${CLICKHOUSE_PASSWORD:-}")
fi
q() { curl -sS --fail-with-body "${auth[@]}" "$url/?database=$1" --data-binary @-; }

echo "CREATE DATABASE IF NOT EXISTS \`$db\`" | q default
if [[ ${1:-} != --replace ]] \
  && [[ $(echo "SELECT count() FROM system.tables WHERE database = currentDatabase() AND name = 'telemetry'" | q "$db") == 1 ]] \
  && [[ $(echo "SELECT count() FROM telemetry" | q "$db") == 1209600 ]]; then
  echo "telemetry already loaded in $db"
  exit 0
fi
echo "DROP TABLE IF EXISTS telemetry" | q "$db"
# HTTP runs one statement per request: drop comment lines, split on ';'.
grep -v '^--' "$here/clickhouse-vessels.sql" | awk -v RS=';' 'NF { printf "%s%c", $0, 0 }' |
  while IFS= read -r -d '' statement; do printf '%s' "$statement" | q "$db"; done
echo "loaded $(echo "SELECT count() FROM telemetry" | q "$db") rows into $db.telemetry"
