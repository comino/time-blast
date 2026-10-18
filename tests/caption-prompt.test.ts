import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAPTION_SYSTEM, captionUserMessage, MAX_TITLE_CHARS, parseCaption, referencedTables, validateCaptionRequest } from '../src/inference-node/caption';

const fixture = (name: string) => readFileSync(new URL(`../crates/inference-server/tests/fixtures/${name}`, import.meta.url), 'utf8');

describe('caption prompt (twin of crates/inference-server/src/caption.rs)', () => {
  it('renders the shared golden system prompt byte for byte', () => {
    expect(CAPTION_SYSTEM).toBe(fixture('caption-system.txt'));
  });
  it.each(['create', 'refine'])('renders the shared golden user message for %s', name => {
    const request = validateCaptionRequest(JSON.parse(fixture(`caption-${name}.json`)));
    expect(captionUserMessage(request)).toBe(fixture(`caption-${name}-user.txt`));
  });
  it('rejects what the server rejects', () => {
    const ok = { v: 1, sql: 'SELECT 1', question: '', dialect: 'duckdb', tables: [] };
    expect(() => validateCaptionRequest(ok)).not.toThrow();
    for (const bad of [{ ...ok, v: 2 }, { ...ok, sql: ' ' }, { ...ok, dialect: 'oracle' }, { ...ok, extra: 1 }, { ...ok, tables: [{ name: 't', columns: [['a']] }] }]) {
      expect(() => validateCaptionRequest(bad)).toThrow();
    }
  });
  it('parses the two lines like the server', () => {
    expect(parseCaption('TITLE: "Daily max temperature in Berlin."\nEXPLAIN:  Highest   reading per day.\n'))
      .toEqual({ title: 'Daily max temperature in Berlin', explanation: 'Highest reading per day.' });
    expect(parseCaption('**TITLE:** Delays\n**EXPLAIN:** Average delay.')?.title).toBe('Delays');
    expect(parseCaption('TITLE: only a title')).toBeNull();
    expect(parseCaption('My TITLE: x\nEXPLAIN: y')).toBeNull();
    const long = parseCaption(`TITLE: ${'word '.repeat(40)}\nEXPLAIN: x`)!;
    expect(Array.from(long.title).length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(long.title.endsWith('…')).toBe(true);
  });
  it('sends only the tables the SQL names', () => {
    const tables = [{ name: 'flights', columns: [{ name: 'carrier', type: 'VARCHAR' }] }, { name: 'airports', columns: [] }, { name: 'carriers', columns: [] }];
    expect(referencedTables(tables, 'SELECT carrier FROM flights f').map(t => t.name)).toEqual(['flights']);
    expect(referencedTables(tables, 'SELECT * FROM FLIGHTS JOIN carriers USING (code)').map(t => t.name)).toEqual(['flights', 'carriers']);
  });
});
