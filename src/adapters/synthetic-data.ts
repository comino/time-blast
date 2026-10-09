import contextJSON from '../../public/data/context.json';
import type { DatasetContext, DatasetProfile } from '../core/types';

const vessels = Object.freeze([...contextJSON.vessels]) as unknown as string[];
export const SYNTHETIC_CONTEXTS: Readonly<Record<DatasetProfile, DatasetContext>> = Object.freeze({
  demo: Object.freeze({ ...contextJSON, vessels }),
  large: Object.freeze({
    ...contextJSON, vessels,
    id: 'synthetic-vessels-2026-09-6s-v1',
    label: 'North Atlantic · dense synthetic telemetry',
    rowCount: 1_209_600,
    description: 'Six fictional vessels, one reading every six seconds, 1–14 September 2026 UTC. Deterministic synthetic signals evaluated at six-second intervals; speed and wind in knots, wave height in metres, water temperature in °C.',
  }),
});

/** The original generator's continuous-time signals, sampled at six-second intervals.
 * Generate and store columns inside DuckDB; no JavaScript rows or larger asset download.
 * Natural range order keeps nearby timestamps together without a global startup sort. */
export const LARGE_DATASET_SQL = `CREATE TABLE telemetry AS
WITH grid AS (
  SELECT (i % 6)::INTEGER AS vessel, (i // 6) * 6000 AS elapsed_ms,
         (i // 6)::DOUBLE / 10.0 AS minute_index
  FROM range(${SYNTHETIC_CONTEXTS.large.rowCount}) AS readings(i)
), signals AS (
  SELECT *, minute_index / 1440.0 AS day,
         exp(-pow((minute_index / 1440.0 - 7.0 - vessel * 0.18) / 1.2, 2)) AS storm
  FROM grid
)
SELECT (${contextJSON.start} + elapsed_ms)::DOUBLE AS t,
       vessel,
       round(12.8 + vessel * 0.7 + 2.1 * sin(minute_index / 420 + vessel) - storm * 4.7, 2)::DOUBLE AS speed,
       round(11.0 + 4.0 * sin(minute_index / 660 + vessel * 0.8) + storm * 25.0 + vessel * 0.4, 2)::DOUBLE AS wind,
       round(1.3 + 0.35 * sin(minute_index / 720 + vessel) + storm * 3.7 + vessel * 0.08, 3)::DOUBLE AS wave_height,
       round(18.0 - vessel * 0.5 + 0.65 * cos(minute_index / 1440 * 6.283185307179586) - day * 0.08, 2)::DOUBLE AS water_temp,
       round(36.0 + vessel * 2.3 + day * 0.48 + 1.2 * sin(day * 0.5 + vessel), 5)::DOUBLE AS lat,
       round(-61.0 + vessel * 1.2 + day * 2.1 + 1.5 * cos(day * 0.37 + vessel), 5)::DOUBLE AS lon
FROM signals`;
