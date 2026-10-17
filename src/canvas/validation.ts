/** Strict portable-document validation. No File, Blob, samples, results or credentials. */
import { CANVAS_FORMAT, newId, type CanvasPatch, type CanvasSnapshot, type Id } from './model';

export class CanvasFormatError extends Error { override name = 'CanvasFormatError'; }
const fail = (message: string): never => { throw new CanvasFormatError(message); };
type Obj = Record<string, unknown>;
function object(value: unknown, keys: string[], where: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(`${where} must be an object`);
  const obj = value as Obj;
  for (const key of Object.keys(obj)) if (!keys.includes(key)) fail(`Unsupported field ${where}.${key}`);
  return obj;
}
function string(value: unknown, where: string, max = 16384, empty = true): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(`Invalid ${where}`);
  return value as string;
}
function id(value: unknown): string {
  const result = string(value, 'identity', 128, false);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) fail('Invalid identity');
  return result;
}
function number(value: unknown, where: string, integer = false, min = -Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || (integer && !Number.isSafeInteger(value))) fail(`Invalid ${where}`);
  return value as number;
}
function oneOf(value: unknown, choices: readonly unknown[], where: string): void { if (!choices.includes(value)) fail(`Invalid ${where}`); }
function array(value: unknown, where: string, max = 100000): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`Invalid ${where}`);
  return value as unknown[];
}
function optional(value: unknown, fn: (value: unknown) => unknown): void { if (value !== undefined) fn(value); }
function owned(obj: Obj, canvasId: string): string {
  const ownId = id(obj.id);
  if (obj.canvasId !== canvasId) fail('Record belongs to another canvas');
  return ownId;
}
/** Interactive resizing stays within 300–1200 × 900; imported layouts get the same
 * order of bound, so a crafted size cannot exceed GPU texture limits. */
const MAX_EXTENT = 4096, MAX_POSITION = 1_000_000;
function layout(value: unknown): void {
  const l = object(value, ['x', 'y', 'width', 'height'], 'layout');
  for (const key of ['x', 'y'] as const) if (Math.abs(number(l[key], `layout ${key}`)) > MAX_POSITION) fail(`Invalid layout ${key}`);
  for (const key of ['width', 'height'] as const) if (number(l[key], `layout ${key}`, false, 1) > MAX_EXTENT) fail(`Invalid layout ${key}`);
}
function presentation(value: unknown): void {
  const p = object(value, ['view', 'params'], 'presentation');
  oneOf(p.view, [null, 'line', 'bar', 'scatter', 'table', 'heatmap', 'surface', 'map', 'density', 'tracks', 'seasons'], 'view');
  const params = object(p.params, ['rotation', 'playback'], 'presentation params');
  for (const [name, value] of Object.entries(params)) number(value, name);
  if (typeof params.playback === 'number' && (params.playback < 0 || params.playback > 1)) fail('Playback must be in [0,1]');
}
function url(value: unknown, kind: 'url' | 'remote'): void {
  const text = string(value, 'source URL', 8192, false);
  let parsed: URL;
  try { parsed = new URL(text, 'https://timeblast.invalid/'); } catch { fail('Invalid source URL'); }
  if (!(kind === 'remote' ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(parsed!.protocol)) fail('Unsupported source URL protocol');
  if (parsed!.username || parsed!.password || [...parsed!.searchParams.keys()].some(k => /token|secret|password|authorization|credential|signature|(^|_)key$|^sig$/i.test(k))) fail('Source credentials must not be saved in a canvas');
}
function unique<T extends { id: string }>(values: T[], where: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of values) { if (map.has(item.id)) fail(`Duplicate ${where} identity`); map.set(item.id, item); }
  return map;
}
function acyclic<T extends { id: string; parentId: string | null }>(map: Map<string, T>, where: string): void {
  const done = new Set<string>();
  for (const start of map.keys()) {
    const visiting = new Set<string>();
    let next: string | null = start;
    while (next && !done.has(next)) {
      if (visiting.has(next)) fail(`Cycle in ${where}`);
      const item = map.get(next); if (!item) fail(`Missing ${where} parent`);
      visiting.add(next); next = item!.parentId;
    }
    for (const item of visiting) done.add(item);
  }
}

/** Validates the entire owned graph before any import transaction is opened. */
function validateShape(value: unknown): CanvasSnapshot {
  const root = object(value, ['format', 'formatVersion', 'canvas', 'commits', 'revisions', 'sources', 'drafts'], 'document');
  if (root.format !== 'timeblast-canvas') fail('This is not a Timeblast canvas');
  if (root.formatVersion !== CANVAS_FORMAT) fail(`Unsupported canvas format ${String(root.formatVersion)}; the original file has not been changed`);
  const h = object(root.canvas, ['id', 'formatVersion', 'storeVersion', 'createdAt', 'headCommitId', 'redoChoices'], 'canvas');
  const canvasId = id(h.id); id(h.headCommitId);
  if (h.formatVersion !== CANVAS_FORMAT) fail('Mismatching canvas format');
  number(h.storeVersion, 'store version', true, 0); number(h.createdAt, 'created time', false, 0);
  if (!h.redoChoices || typeof h.redoChoices !== 'object' || Array.isArray(h.redoChoices)) fail('Invalid redo choices');
  for (const [parent, child] of Object.entries(h.redoChoices as Obj)) { id(parent); id(child); }

  for (const v of array(root.sources, 'sources', 10000)) {
    const s = object(v, ['id', 'canvasId', 'name', 'locator', 'policy', 'tables', 'format', 'fingerprint'], 'source');
    owned(s, canvasId); string(s.name, 'source name', 1024, false);
    oneOf(s.policy, ['current', 'pinned'], 'source policy');
    optional(s.format, v => oneOf(v, ['csv', 'parquet'], 'source format'));
    optional(s.fingerprint, v => string(v, 'fingerprint', 256, false));
    const loc = object(s.locator, ['kind', 'name', 'url', 'endpoint', 'size', 'lastModified', 'sha256'], 'source locator');
    oneOf(loc.kind, ['fixture', 'url', 'remote', 'file'], 'source kind');
    const keys = loc.kind === 'fixture' ? ['kind', 'name'] : loc.kind === 'url' ? ['kind', 'url'] : loc.kind === 'remote' ? ['kind', 'endpoint'] : ['kind', 'name', 'size', 'lastModified', 'sha256'];
    object(loc, keys, 'source locator');
    if (loc.kind === 'fixture' || loc.kind === 'file') string(loc.name, 'source filename', 1024, false);
    if (loc.kind === 'url') url(loc.url, 'url');
    if (loc.kind === 'remote') url(loc.endpoint, 'remote');
    if (loc.kind === 'file') {
      number(loc.size, 'file size', true, 0); number(loc.lastModified, 'file modification time', false, 0);
      if (!/^[a-f0-9]{64}$/.test(string(loc.sha256, 'file digest', 64))) fail('File identity needs a SHA-256 digest');
    }
    if (s.policy === 'pinned' && !s.fingerprint && loc.kind !== 'file') fail('A pinned source needs its version fingerprint');
    const names = new Set<string>();
    for (const table of array(s.tables, 'source tables', 1000)) {
      const t = object(table, ['name', 'columns'], 'table');
      const name = string(t.name, 'table name', 1024, false);
      if (names.has(name)) fail('Duplicate logical table name'); names.add(name);
      const columns = new Set<string>();
      for (const column of array(t.columns, 'table columns', 10000)) {
        const c = object(column, ['name', 'type'], 'column');
        const name = string(c.name, 'column name', 1024, false); string(c.type, 'column type', 1024, false);
        if (columns.has(name)) fail('Duplicate column name'); columns.add(name);
      }
    }
  }
  for (const v of array(root.revisions, 'revisions')) {
    const r = object(v, ['id', 'canvasId', 'chartId', 'parentId', 'at', 'originalQuestion', 'sourceRefId', 'sql', 'presentation', 'change'], 'revision');
    owned(r, canvasId); id(r.chartId); id(r.sourceRefId); if (r.parentId !== null) id(r.parentId);
    number(r.at, 'revision time', false, 0); string(r.originalQuestion, 'original question'); string(r.sql, 'SQL', 1024 * 1024, false); presentation(r.presentation);
    const change = object(r.change, ['kind', 'text', 'details'], 'change');
    oneOf(change.kind, ['create', 'refine', 'regenerate', 'sql', 'view', 'gesture'], 'change kind');
    string(change.text, 'change text', 1024 * 1024); optional(change.details, v => string(v, 'change details', 1024 * 1024));
  }
  for (const v of array(root.commits, 'commits')) {
    const c = object(v, ['id', 'canvasId', 'parentId', 'at', 'action', 'restoredFrom', 'state'], 'commit');
    owned(c, canvasId); if (c.parentId !== null) id(c.parentId); optional(c.restoredFrom, id);
    number(c.at, 'commit time', false, 0); string(c.action, 'action', 1024, false);
    const s = object(c.state, ['title', 'charts'], 'canvas state'); string(s.title, 'canvas title', 1024, false);
    const chartIds = new Set<string>();
    for (const v of array(s.charts, 'charts', 10000)) {
      const chart = object(v, ['id', 'revisionId', 'layout'], 'chart'); const chartId = id(chart.id);
      id(chart.revisionId); layout(chart.layout);
      if (chartIds.has(chartId)) fail('Duplicate chart in canvas state'); chartIds.add(chartId);
    }
  }
  for (const v of array(root.drafts, 'drafts')) {
    const d = object(v, ['id', 'canvasId', 'chartId', 'baseRevisionId', 'version', 'sequence', 'at', 'updatedAt', 'mode', 'originalQuestion', 'text', 'sourceRefId', 'presentation', 'layout', 'candidate', 'finishSequence', 'state', 'closedAs', 'committedRevisionId'], 'draft');
    owned(d, canvasId); id(d.chartId); id(d.sourceRefId); if (d.baseRevisionId !== null) id(d.baseRevisionId);
    number(d.version, 'draft version', true, 0); number(d.sequence, 'edit sequence', true, 0);
    number(d.at, 'draft time', false, 0); number(d.updatedAt, 'draft update time', false, 0);
    oneOf(d.mode, ['question', 'sql', 'regenerate', 'gesture'], 'draft mode'); oneOf(d.state, ['open', 'closed'], 'draft state');
    string(d.originalQuestion, 'original question'); string(d.text, 'draft text', 1024 * 1024);
    presentation(d.presentation); layout(d.layout);
    optional(d.finishSequence, v => { if (v !== d.sequence) fail('Checkpoint sequence does not match draft'); });
    optional(d.candidate, v => {
      const c = object(v, ['sequence', 'sql', 'status', 'error'], 'candidate');
      if (c.sequence !== d.sequence) fail('Candidate does not match draft sequence');
      string(c.sql, 'draft SQL', 1024 * 1024); oneOf(c.status, ['pending', 'succeeded', 'failed', 'cancelled'], 'execution status');
      optional(c.error, v => string(v, 'execution error', 16384));
    });
    if (d.state === 'closed') oneOf(d.closedAs, ['committed', 'discarded', 'superseded'], 'closed draft reason');
    else if (d.closedAs !== undefined || d.committedRevisionId !== undefined) fail('Open draft cannot be committed or discarded');
    if (d.closedAs === 'committed') id(d.committedRevisionId);
    else if (d.committedRevisionId !== undefined) fail('Only a committed draft may refer to its committed revision');
  }

  return value as CanvasSnapshot;
}

/** Also used for every write: a successful save must not produce an unreadable record. */
export function validatePatch(patch: CanvasPatch): void {
  id(patch.canvasId);
  if (patch.head && patch.head.value.id !== patch.canvasId) fail('Canvas patch changes ownership');
  for (const key of ['commits', 'revisions', 'sources'] as const) unique<{ id: Id }>(patch[key] ?? [], key);
  unique(patch.drafts?.map(d => d.value) ?? [], 'draft write');
  validateShape({ format: 'timeblast-canvas', formatVersion: CANVAS_FORMAT,
    canvas: patch.head?.value ?? { id: patch.canvasId, formatVersion: CANVAS_FORMAT, storeVersion: 0, createdAt: 0, headCommitId: 'pending', redoChoices: {} },
    commits: patch.commits ?? [], revisions: patch.revisions ?? [], sources: patch.sources ?? [], drafts: patch.drafts?.map(d => d.value) ?? [] });
}

export function validateCanvas(value: unknown): CanvasSnapshot {
  const snapshot = validateShape(value);
  const sources = unique(snapshot.sources, 'source'), revisions = unique(snapshot.revisions, 'revision');
  const commits = unique(snapshot.commits, 'commit'); unique(snapshot.drafts, 'draft');
  if (!commits.has(snapshot.canvas.headCommitId)) fail('Missing canvas head');
  if (snapshot.commits.filter(c => c.parentId === null).length !== 1) fail('Canvas needs one history root');
  acyclic(commits, 'canvas history'); acyclic(revisions, 'chart history');
  for (const r of revisions.values()) {
    if (!sources.has(r.sourceRefId)) fail('Missing revision source');
    const parent = r.parentId ? revisions.get(r.parentId) : undefined;
    if (parent && (parent.chartId !== r.chartId || parent.originalQuestion !== r.originalQuestion)) fail('Revision parent changes chart identity or original question');
  }
  for (const c of commits.values()) {
    if (c.restoredFrom && !commits.has(c.restoredFrom)) fail('Missing restored canvas state');
    for (const chart of c.state.charts) if (revisions.get(chart.revisionId)?.chartId !== chart.id) fail('Canvas references a missing or different chart revision');
  }
  for (const [parent, child] of Object.entries(snapshot.canvas.redoChoices)) if (commits.get(child)?.parentId !== parent) fail('Redo choice is not a history child');
  for (const d of snapshot.drafts) {
    if (!sources.has(d.sourceRefId)) fail('Missing draft source');
    if (d.baseRevisionId) {
      const base = revisions.get(d.baseRevisionId);
      if (!base || base.chartId !== d.chartId || base.originalQuestion !== d.originalQuestion) fail('Invalid draft base');
    }
    if (d.committedRevisionId) {
      const r = revisions.get(d.committedRevisionId);
      if (!r || r.chartId !== d.chartId || r.parentId !== d.baseRevisionId || r.sql !== d.candidate?.sql || d.candidate.status !== 'succeeded') fail('Invalid committed draft');
    }
  }
  return snapshot;
}

export function parseCanvas(text: string): CanvasSnapshot {
  if (text.length > 32 * 1024 * 1024) fail('Canvas import exceeds the 32 MiB document limit');
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail('Canvas file is not valid JSON'); }
  return validateCanvas(value);
}

/** Import retains every branch but cannot overwrite another canvas's records. */
export function forkCanvas(original: CanvasSnapshot, makeId: () => Id = newId): CanvasSnapshot {
  validateCanvas(original);
  const snapshot = structuredClone(original), identities = new Map<string, string>();
  const remap = (old: Id): Id => { let next = identities.get(old); if (!next) { next = makeId(); identities.set(old, next); } return next; };
  const canvasId = remap(snapshot.canvas.id);
  snapshot.canvas = { ...snapshot.canvas, id: canvasId, storeVersion: 0, createdAt: Date.now(), headCommitId: remap(snapshot.canvas.headCommitId),
    redoChoices: Object.fromEntries(Object.entries(snapshot.canvas.redoChoices).map(([a, b]) => [remap(a), remap(b)])) };
  for (const s of snapshot.sources) { s.id = remap(s.id); s.canvasId = canvasId; }
  for (const r of snapshot.revisions) {
    r.id = remap(r.id); r.canvasId = canvasId; r.chartId = remap(r.chartId); r.parentId = r.parentId ? remap(r.parentId) : null; r.sourceRefId = remap(r.sourceRefId);
  }
  for (const c of snapshot.commits) {
    c.id = remap(c.id); c.canvasId = canvasId; c.parentId = c.parentId ? remap(c.parentId) : null;
    if (c.restoredFrom) c.restoredFrom = remap(c.restoredFrom);
    for (const chart of c.state.charts) { chart.id = remap(chart.id); chart.revisionId = remap(chart.revisionId); }
  }
  for (const d of snapshot.drafts) {
    d.id = remap(d.id); d.canvasId = canvasId; d.chartId = remap(d.chartId); d.sourceRefId = remap(d.sourceRefId);
    d.baseRevisionId = d.baseRevisionId ? remap(d.baseRevisionId) : null;
    if (d.committedRevisionId) d.committedRevisionId = remap(d.committedRevisionId);
    d.version = 0;
  }
  return validateCanvas(snapshot);
}
