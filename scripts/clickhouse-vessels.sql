-- The `vessels` fixture for the remote ClickHouse database node (crates/database-server).
-- Same rows as the browser fixture (src/engine/dataset.ts VESSELS_SQL, generated in DuckDB):
-- six vessels, one reading every six seconds, 1-14 September 2026 UTC, 1,209,600 rows.
--
-- DuckDB evaluates `12.8 + vessel * 0.7` as exact DECIMAL arithmetic and converts the result
-- to DOUBLE when it meets a DOUBLE term. ClickHouse would multiply in Float64
-- (0.7 * 3 = 2.0999999999999996), so every decimal-literal x integer term is written as an
-- integer numerator over a power of ten: the correctly rounded quotient equals DuckDB's
-- DECIMAL -> DOUBLE conversion. Additions keep DuckDB's left-to-right order.
-- Load with scripts/clickhouse-vessels.sh (one statement per HTTP request).
CREATE TABLE IF NOT EXISTS telemetry
(
    ts DateTime64(6, 'UTC'),
    vessel LowCardinality(String),
    speed Float64,
    wind Float64,
    wave_height Float64,
    water_temp Float64,
    lat Float64,
    lon Float64
)
ENGINE = MergeTree
ORDER BY (vessel, ts);

INSERT INTO telemetry
SELECT
    fromUnixTimestamp64Micro(toInt64((1788220800000 + intDiv(number, 6) * 6000) * 1000), 'UTC') AS ts,
    arrayElement(['Aurora', 'Meridian', 'Kestrel', 'Solstice', 'Atlas', 'Nomad'], v + 1) AS vessel,
    round((((128 + 7 * v) / 10) + 2.1 * sin(minute_index / 420 + v)) - storm * 4.7, 2) AS speed,
    round(((11.0 + 4.0 * sin(minute_index / 660 + (8 * v) / 10)) + storm * 25.0) + (4 * v) / 10, 2) AS wind,
    round(((1.3 + 0.35 * sin(minute_index / 720 + v)) + storm * 3.7) + (8 * v) / 100, 3) AS wave_height,
    round(((36 - v) / 2 + 0.65 * cos(minute_index / 1440 * 6.283185307179586)) - day * 0.08, 2) AS water_temp,
    round((((360 + 23 * v) / 10) + day * 0.48) + 1.2 * sin(day * 0.5 + v), 5) AS lat,
    round((((-610 + 12 * v) / 10) + day * 2.1) + 1.5 * cos(day * 0.37 + v), 5) AS lon
FROM
(
    SELECT number, toInt32(number % 6) AS v, intDiv(number, 6) / 10.0 AS minute_index,
           minute_index / 1440.0 AS day,
           exp(-pow(((minute_index / 1440.0 - 7.0) - (18 * v) / 100) / 1.2, 2)) AS storm
    FROM numbers(1209600)
);
