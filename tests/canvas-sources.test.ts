import { describe, expect, it } from 'vitest';
import { SourceBindings, MissingSourceError, schemaOf } from '../src/canvas/sources';
import type { DatasetContext } from '../src/engine/contracts';

const context: DatasetContext = { id: 5, name: 'Imported data', dialect: 'duckdb', tables: [{ name: 'readings', rows: 100,
  columns: [{ name: 'time', type: 'TIMESTAMP', min: 'private minimum', max: 'private maximum' }, { name: 'value', type: 'DOUBLE', distinct: 5, values: ['private value'] }], sample: [['private row', 42]] }] };
describe('durable source references', () => {
  it('keeps logical aliases and schema types without result values, file bytes or handles', async () => {
    const bindings = new SourceBindings(), file = new File(['time,value\n1,42'], 'original.csv', { lastModified: 100 });
    const source = { ...await bindings.describe({ kind: 'file', name: 'Weather observations', file }, context), canvasId: 'canvas' };
    expect(source).toMatchObject({ policy: 'pinned', format: 'csv', locator: { kind: 'file', name: 'original.csv', size: file.size, lastModified: 100 } });
    expect(source.locator.kind === 'file' && source.locator.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(source.tables).toEqual(schemaOf(context));
    expect(JSON.stringify(source)).not.toMatch(/private|sample|file":|rows|distinct/);
    expect(bindings.resolve(source)).toMatchObject({ kind: 'file', table: 'readings', file });
    bindings.release(); expect(() => bindings.resolve(source)).toThrow(MissingSourceError);
    await expect(bindings.reattach(source, new File(['time,value\n1,43'], 'original.csv'))).rejects.toThrow('different contents');
    const renamed = new File(['time,value\n1,42'], 'renamed.data');
    await bindings.reattach(source, renamed);
    expect(bindings.resolve(source)).toMatchObject({ kind: 'file', table: 'readings', format: 'csv', file: renamed });
  });
  it('rejects credential-bearing locators before adding them to authoring state', async () => {
    const bindings = new SourceBindings();
    await expect(bindings.describe({ kind: 'url', name: 'Private', url: 'https://data.example/a.csv?token=secret' }, context)).rejects.toThrow();
    await expect(bindings.describe({ kind: 'remote', name: 'Private', endpoint: 'wss://user:secret@data.example/session' }, context)).rejects.toThrow();
  });
  it('distinguishes current locators from pinned sources which cannot be verified', async () => {
    const bindings = new SourceBindings();
    const source = { ...await bindings.describe({ kind: 'fixture', name: 'weather' }, context), canvasId: 'canvas' };
    expect(bindings.resolve(source)).toEqual({ kind: 'fixture', name: 'weather' });
    expect(() => bindings.resolve({ ...source, policy: 'pinned', fingerprint: 'unavailable-version' })).toThrow(/cannot be verified/);
  });
});
