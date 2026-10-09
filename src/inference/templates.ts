import type { DatasetContext, QueryPlan } from '../core/types';
import { MAX_PROMPT_CHARS, validateQueryPlan } from './plan';

const metrics: Record<string, QueryPlan['metric']> = {
  speed: 'speed', speeds: 'speed', 'vessel speed': 'speed', 'vessel speeds': 'speed',
  wind: 'wind', 'wind speed': 'wind', 'wave height': 'wave_height',
  'water temperature': 'water_temp', 'water temp': 'water_temp',
};
const aggregates: Record<string, QueryPlan['aggregate']> = {
  average: 'avg', mean: 'avg', avg: 'avg', minimum: 'min', min: 'min', maximum: 'max', max: 'max',
};
const buckets: Record<string, number> = { minute: 1, hour: 60, day: 1440 };
const metricPattern = '(vessel speeds?|speeds?|wind speed|wind|wave height|water temperature|water temp)';
const suffix = '(?: for vessel (.+?))?(?: by (minute|hour|day|(?:1|5|15|60|360|1440) minutes?))?(?: (?:over|for) (?:the )?last (\\d+) (hours?|days?))?(?: as (?:a )?(line|bar)(?: chart)?)?';
const normal = new RegExp(`^(?:(?:show|plot) )?(?:(average|mean|avg|minimum|min|maximum|max) )?${metricPattern}${suffix}$`);
const compare = new RegExp(`^compare vessel (speeds?|wind|wave height|water temperature)${suffix}$`);

/** Full-match grammar: unknown clauses must go to the model or an explicit error. */
export function parseTemplate(text: string, context?: DatasetContext): QueryPlan | null {
  if (text.length > MAX_PROMPT_CHARS) return null;
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.?]$/, '');
  const compared = normalized.match(compare);
  const matched = compared ?? normalized.match(normal);
  if (!matched) return null;
  const [, aggregate, metric, vesselName, bucket, windowValue, windowUnit, view] = compared
    ? [matched[0], 'avg', ...matched.slice(1)] : matched;
  let vessel: number | null = null;
  if (vesselName) {
    if (!context) return null;
    const names = context.vessels.map((name) => name.toLowerCase());
    vessel = /^\d+$/.test(vesselName) ? Number(vesselName) : names.indexOf(vesselName);
    if (vessel < 0 || vessel >= Math.min(6, names.length)) return null;
  }
  const bucketMinutes = bucket ? (buckets[bucket] ?? Number(bucket.split(' ')[0])) : 60;
  const windowHours = windowValue ? Number(windowValue) * (windowUnit?.startsWith('day') ? 24 : 1) : 24;
  try {
    return validateQueryPlan({
      metric: metrics[metric ?? ''], aggregate: aggregates[aggregate ?? ''] ?? 'avg', bucketMinutes, windowHours,
      splitByVessel: Boolean(compared), vessel, view: view ?? 'line',
    }, context);
  } catch { return null; }
}
