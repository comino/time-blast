import type { ChartView, QueryView } from '../core/types';
import type { RendererCallbacks, RendererSource, ResultRenderer } from './renderer-contract';

export interface ViewDefinition {
  id: ChartView;
  label: string;
  family: 'primary' | 'matrix' | 'geo' | 'calendar' | 'table';
  caption: string;
}
export const VIEWS: readonly ViewDefinition[] = [
  { id: 'line', label: 'Time series', family: 'primary', caption: '' },
  { id: 'bar', label: 'Bar chart', family: 'primary', caption: '' },
  { id: 'scatter', label: 'Scatter plot', family: 'primary', caption: '' },
  { id: 'heatmap', label: 'Heatmap', family: 'matrix', caption: 'Time × vessel · color is the queried metric' },
  { id: 'surface', label: '3D surface', family: 'matrix', caption: 'Time × vessel × value · separate vessel ribbons' },
  { id: 'map', label: 'Geographic map', family: 'geo', caption: 'Mean coordinates per returned vessel / time bucket' },
  { id: 'density', label: 'Density map', family: 'geo', caption: 'Counts of returned bucket positions · not source-reading density' },
  { id: 'tracks', label: 'Voyage playback', family: 'geo', caption: 'Mean bucket positions · UTC playback' },
  { id: 'seasons', label: 'Seasonal wheel', family: 'calendar', caption: 'UTC calendar · each returned bucket · unobserved dates stay empty' },
  { id: 'table', label: 'Data table', family: 'table', caption: '' },
];
export const definition = (mode: ChartView): ViewDefinition => VIEWS.find(view => view.id === mode)!;
export const isPrimary = (mode: ChartView): boolean => definition(mode).family === 'primary';
export const isAdvanced = (mode: ChartView): boolean => !isPrimary(mode) && mode !== 'table';
export function unavailableReason(mode: ChartView, view?: QueryView): string | undefined {
  if (definition(mode).family === 'geo' && view && !view.plan.splitByVessel) return 'Requires a query grouped by vessel; fleet averages are not vessel positions.';
  return undefined;
}
export type RendererFactory = (canvas: HTMLCanvasElement, source: RendererSource, callbacks: RendererCallbacks) => ResultRenderer;
const factories = new Map<ChartView, RendererFactory>();
const loading = new Map<ViewDefinition['family'], Promise<void>>();
export const rendererFactory = (mode: ChartView): RendererFactory | undefined => factories.get(mode);

/** Code is loaded once, independent of query identity; columns are never serialized. */
export function warmRenderer(mode: ChartView): Promise<void> {
  const family = definition(mode).family;
  if (family === 'primary' || family === 'table' || factories.has(mode)) return Promise.resolve();
  const pending = loading.get(family); if (pending) return pending;
  const task = (family === 'matrix' ? import('./matrix-renderer').then(({ MatrixRenderer }) => {
    for (const name of ['heatmap', 'surface'] as const) factories.set(name, (canvas, source, callbacks) => new MatrixRenderer(canvas, name, source, callbacks));
  }) : family === 'geo' ? import('./geo-renderer').then(({ GeoRenderer }) => {
    for (const name of ['map', 'density', 'tracks'] as const) factories.set(name, (canvas, source, callbacks) => new GeoRenderer(canvas, name, source, callbacks));
  }) : import('./season-renderer').then(({ SeasonRenderer }) => {
    factories.set('seasons', (canvas, source, callbacks) => new SeasonRenderer(canvas, source, callbacks));
  })).catch(error => { loading.delete(family); throw error; });
  loading.set(family, task); return task;
}
/** Warm probable presentation code while the draft is being transmitted/inferred. */
export function prewarmViews(text: string): void {
  const modes: ChartView[] = [];
  if (/heat\s?map|surface|\b3d\b/i.test(text)) modes.push('heatmap');
  if (/\bmap\b|\bdensity\b|\bvoyage|\btrack/i.test(text)) modes.push('map');
  if (/season|wheel|calendar/i.test(text)) modes.push('seasons');
  for (const mode of modes) void warmRenderer(mode).catch(() => {});
}
