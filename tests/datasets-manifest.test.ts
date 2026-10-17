/**
 * public/data/datasets.json follows the dataset manifest contract (docs/plan-batch-3.md), every
 * listed Parquet file exists, and each public dataset has an eval corpus. Loading the files needs
 * DuckDB's parquet extension from the network, so that is checked by
 * `node scripts/eval-sql.mjs --self-test --dataset all`, not here.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Corpus, ManifestEntry } from '../evals/sql-eval';

const root = new URL('..', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(`${root}public/data/datasets.json`, 'utf8')) as ManifestEntry[];

describe('dataset manifest', () => {
  it('lists unique names with tables, license and source', () => {
    expect(new Set(manifest.map(e => e.name)).size).toBe(manifest.length);
    for (const entry of manifest) {
      expect(entry.name).toMatch(/^[a-z][a-z0-9_-]*$/);
      expect(entry.tables.length).toBeGreaterThan(0);
      expect(entry.license, entry.name).toBeTruthy();
      expect(entry.source, entry.name).toBeTruthy();
      for (const table of entry.tables) {
        expect(table.name).toMatch(/^[a-z_][a-z0-9_]*$/);
        expect(table.url).toMatch(/^data\/([a-z0-9_-]+\/)?[a-z0-9_]+\.parquet$/);
        expect(table.rows).toBeGreaterThan(0);
      }
    }
  });

  // Committed datasets: small Parquet files in the repo. Large ones (a `prebuilt` file, gitignored)
  // are fetched by scripts/fetch-datasets.mjs and built by scripts/build-datasets.mjs at deploy
  // time; their files are checked when present. The synthetic vessels belong to cold start.
  const large = (e: ManifestEntry) => !!e.prebuilt;
  const isParquet = (file: string) => {
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('PAR1');
    expect(bytes.subarray(bytes.length - 4).toString('latin1')).toBe('PAR1');
  };

  it('points committed datasets at Parquet files of at most 50 MB', () => {
    for (const entry of manifest.filter(e => !e.name.startsWith('vessels') && !large(e))) {
      for (const table of entry.tables) {
        const file = `${root}public/${table.url}`;
        expect(existsSync(file), file).toBe(true);
        expect(statSync(file).size).toBeLessThan(50e6);
        isParquet(file);
      }
    }
  });

  it('keeps large datasets out of git, with a prebuilt database next to their tables', () => {
    for (const entry of manifest.filter(e => !e.name.startsWith('vessels') && large(e))) {
      const dir = `public/data/${entry.name}/`;
      expect(readFileSync(`${root}.gitignore`, 'utf8').split('\n'), entry.name).toContain(dir);
      expect(entry.prebuilt).toBe(`data/${entry.name}/${entry.name}.duckdb`);
      for (const table of entry.tables) {
        expect(table.url.startsWith(`data/${entry.name}/`), table.url).toBe(true);
        const file = `${root}public/${table.url}`;
        if (existsSync(file)) isParquet(file);
      }
    }
  });

  it('has an executed-result corpus per dataset (vessels-small shares none)', () => {
    for (const entry of manifest.filter(e => e.name !== 'vessels-small')) {
      const path = entry.name === 'vessels' ? `${root}evals/sql-corpus.json` : `${root}evals/sql-corpus-${entry.name}.json`;
      const corpus = JSON.parse(readFileSync(path, 'utf8')) as Corpus;
      expect(corpus.dataset).toBe(entry.name);
      expect(corpus.cases.length).toBeGreaterThanOrEqual(25);
      expect(new Set(corpus.cases.map(c => c.id)).size).toBe(corpus.cases.length);
    }
  });
});
