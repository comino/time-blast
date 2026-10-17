import type { DatasetContext, DatasetSource } from '../engine/contracts';
import { newId, type SourceRef } from './model';
import { validatePatch } from './validation';

export class MissingSourceError extends Error {
  override name = 'MissingSourceError';
  constructor(readonly source: SourceRef, message = `Reattach ${source.name} to load this chart`) { super(message); }
}
export async function sha256(file: Blob): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const schemaOf = (context: DatasetContext): SourceRef['tables'] => context.tables.map(t => ({ name: t.name,
  columns: t.columns.map(c => ({ name: c.name, type: c.type })) }));

/** File bytes/handles stay in this runtime-only registry. A SourceRef owns only a
 * locator, exact logical aliases, schema metadata and a reattachment fingerprint. */
export class SourceBindings {
  private readonly files = new Map<string, File>();
  async describe(source: DatasetSource, context: DatasetContext): Promise<Omit<SourceRef, 'canvasId'>> {
    const id = newId(), common = { id, name: source.name, tables: schemaOf(context) };
    const checked = (ref: Omit<SourceRef, 'canvasId'>) => {
      validatePatch({ canvasId: 'source-check', sources: [{ ...ref, canvasId: 'source-check' }] });
      return ref;
    };
    switch (source.kind) {
      case 'fixture': return checked({ ...common, locator: { kind: 'fixture', name: source.name }, policy: 'current' });
      case 'remote': return checked({ ...common, locator: { kind: 'remote', endpoint: source.endpoint }, policy: 'current' });
      case 'url': return checked({ ...common, locator: { kind: 'url', url: source.url }, policy: 'current', ...(source.format ? { format: source.format } : {}) });
      case 'file': {
        const fingerprint = await sha256(source.file);
        const prefix = new TextDecoder().decode(await source.file.slice(0, 4).arrayBuffer());
        const ref = checked({ ...common, locator: { kind: 'file', name: source.file.name, size: source.file.size, lastModified: source.file.lastModified, sha256: fingerprint },
          policy: 'pinned', fingerprint, format: source.format ?? (prefix === 'PAR1' ? 'parquet' : 'csv') });
        this.files.set(id, source.file);
        return ref;
      }
    }
  }
  resolve(source: SourceRef): DatasetSource {
    const locator = source.locator;
    if (source.policy === 'pinned' && locator.kind !== 'file') throw new MissingSourceError(source, 'This pinned source version cannot be verified. Add the current source as a new source before rebinding this chart.');
    if (locator.kind === 'fixture') return { kind: 'fixture', name: locator.name };
    if (locator.kind === 'remote') return { kind: 'remote', name: source.name, endpoint: locator.endpoint };
    const options = { name: source.name, table: source.tables[0]?.name, format: source.format };
    if (locator.kind === 'url') return { ...options, kind: 'url', url: locator.url };
    const file = this.files.get(source.id);
    if (!file) throw new MissingSourceError(source);
    return { ...options, kind: 'file', file };
  }
  async reattach(source: SourceRef, file: File): Promise<void> {
    if (source.locator.kind !== 'file') throw new Error('This source does not need a file');
    if (file.size !== source.locator.size || await sha256(file) !== source.locator.sha256) throw new Error('This file has different contents. Choose the original file, or add it as a new source.');
    this.files.set(source.id, file);
  }
  release(): void { this.files.clear(); }
}
