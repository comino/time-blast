import type { ChartView, DatasetContext, QueryPlan } from '../core/types';
import { MAX_PROMPT_CHARS, validateQueryPlan } from './plan';

const metrics: Record<string, QueryPlan['metric']> = {
  speed: 'speed', speeds: 'speed',
  wind: 'wind', 'wind speed': 'wind', 'wave height': 'wave_height',
  'water temperature': 'water_temp', 'water temp': 'water_temp',
};
const aggregates: Record<string, QueryPlan['aggregate']> = {
  average: 'avg', mean: 'avg', avg: 'avg', minimum: 'min', min: 'min', maximum: 'max', max: 'max',
};
const buckets: Record<string, number> = { minute: 1, hour: 60, day: 1440 };
const views: Record<string, ChartView> = {
  line: 'line', 'line chart': 'line', 'time series': 'line',
  bar: 'bar', 'bar chart': 'bar', scatter: 'scatter', 'scatter plot': 'scatter',
  table: 'table', 'data table': 'table', heatmap: 'heatmap', 'heat map': 'heatmap',
  surface: 'surface', 'surface plot': 'surface', '3d surface': 'surface', '3d surface plot': 'surface',
  map: 'map', 'geographic map': 'map', 'density map': 'density',
  tracks: 'tracks', 'vessel tracks': 'tracks', 'voyage tracks': 'tracks', 'voyage view': 'tracks',
  'seasonal wheel': 'seasons', 'seasonal chart': 'seasons',
};
const viewPattern = Object.keys(views).sort((a, b) => b.length - a.length).join('|');
const suffix = '(?: for vessel (?<vessel>.+?))?(?: by (?<bucket>minute|hour|day|(?:1|5|15|60|360|1440) minutes?))?(?: (?:over|for) (?:the )?last (?<windowValue>\\d+) ?(?<windowUnit>hours?|days?))?';
const normal = new RegExp(`^(?:(?:show|plot) )?(?<compared>compare vessel )?(?:(?<aggregate>average|mean|avg|minimum|min|maximum|max) )?(?:(?<group>vessel|fleet) )?(?<metric>speeds?|wind speed|wind|wave height|water temperature|water temp)${suffix}(?: as (?:a |an )?(?<view>${viewPattern}))?$`);
const prefix = new RegExp(`^(?:(?:show|plot) )?(?:a |an )?(?<view>${viewPattern}) of (?<request>.+)$`);

/** Full-match grammar: unknown clauses must go to the model or an explicit error. */
export function parseTemplate(text: string, context?: DatasetContext): QueryPlan | null {
  if (text.length > MAX_PROMPT_CHARS) return null;
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.?]$/, '');
  const wrapped = normalized.match(prefix)?.groups;
  const matched = (wrapped?.request ?? normalized).match(normal)?.groups;
  if (!matched) return null;
  const { aggregate, metric, vessel: vesselName, bucket, windowValue, windowUnit, compared, group } = matched;
  const view = views[wrapped?.view ?? matched.view ?? 'line'];
  // Two independently specified chart types are ambiguous even if one is supported.
  if (wrapped && matched.view) return null;
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
      splitByVessel: Boolean(compared) || ['map', 'density', 'tracks'].includes(view)
        || (['heatmap', 'surface'].includes(view) && Boolean(group)), vessel, view,
    }, context);
  } catch { return null; }
}
