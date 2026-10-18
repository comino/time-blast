/**
 * Caption prompt: a title and a short explanation for one saved chart revision (DESCRIBE).
 * TypeScript twin of crates/inference-server/src/caption.rs: both must produce byte-identical
 * text, checked against crates/inference-server/tests/fixtures/caption-*.
 * The request is self-contained (no CONTEXT): the SQL, the question, the referenced tables'
 * columns, and the previous title and change, so titles stay stable along a refinement chain.
 */

export const CAPTION_CAPABILITY = 'describe-v1';
export const CAPTION_PROMPT_VERSION = 1;
/** Largest DESCRIBE payload in UTF-8 bytes; larger SQL gets the deterministic fallback. */
export const MAX_CAPTION_PAYLOAD = 16384;
export const MAX_TITLE_CHARS = 80;
export const MAX_EXPLANATION_CHARS = 320;
const MAX_TABLES = 16;
const MAX_COLUMNS = 128;
const MAX_FIELD_CHARS = 2048;

export interface CaptionRequest {
  v: 1;
  sql: string;
  question: string;
  dialect: 'duckdb' | 'clickhouse';
  /** Referenced tables only, in source order: columns are [name, type]. */
  tables: Array<{ name: string; columns: Array<[string, string]> }>;
  previousTitle?: string;
  change?: string;
}

export interface CaptionText { title: string; explanation: string }

export const CAPTION_SYSTEM = [
  'You write the caption of a chart. The chart shows the result of one SQL query.',
  'Describe what the SQL computes, not what the user asked: when they differ, the SQL is right.',
  'Reply with exactly two lines and nothing else:',
  'TITLE: <chart title, at most 8 words, no final period>',
  'EXPLAIN: <one or two plain sentences, at most 40 words: what is measured, how it is grouped or bucketed, which filters and time range apply, and a limit if there is one>',
  'Use the words a person would use. Use column or table names only when they are the clearest word. Never mention SQL, queries, tables, columns or records as such.',
  'Say what the chart includes. Do not list what it leaves out (no filter, no limit) or how rows are sorted unless the order is the point.',
  'When a previous title is given, keep its wording for what did not change and change only what the SQL changed.',
].join('\n');

const clean = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
const chars = (text: string): number => Array.from(text).length;

/** Throws on a request the server would refuse. Mirrors `validate` in caption.rs. */
export function validateCaptionRequest(raw: unknown): CaptionRequest {
  const fail = (message: string): never => { throw new Error(message); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('DESCRIBE payload must be an object');
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!['v', 'sql', 'question', 'dialect', 'tables', 'previousTitle', 'change'].includes(key)) fail(`Unknown DESCRIBE field ${key}`);
  if (r.v !== 1) fail('Unsupported DESCRIBE version');
  if (typeof r.sql !== 'string' || !r.sql.trim()) fail('DESCRIBE needs SQL');
  if (typeof r.question !== 'string') fail('DESCRIBE question must be a string');
  if (r.dialect !== 'duckdb' && r.dialect !== 'clickhouse') fail('Unknown dialect');
  for (const key of ['previousTitle', 'change'] as const) {
    if (r[key] !== undefined && (typeof r[key] !== 'string' || chars(r[key] as string) > MAX_FIELD_CHARS)) fail(`Invalid ${key}`);
  }
  if (chars(r.question as string) > MAX_FIELD_CHARS * 8) fail('Question too long');
  if (!Array.isArray(r.tables) || r.tables.length > MAX_TABLES) fail('DESCRIBE tables must be an array of at most 16');
  for (const t of r.tables as unknown[]) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) fail('Invalid table');
    const { name, columns, ...rest } = t as Record<string, unknown>;
    if (typeof name !== 'string' || Object.keys(rest).length) fail('Invalid table');
    if (!Array.isArray(columns) || columns.length > MAX_COLUMNS) fail('Invalid columns');
    for (const c of columns as unknown[]) {
      if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== 'string' || typeof c[1] !== 'string') fail('Invalid column');
    }
  }
  return r as unknown as CaptionRequest;
}

/** The user message. Mirrors `user_message` in caption.rs. */
export function captionUserMessage(r: CaptionRequest): string {
  const lines = [`Dialect: ${r.dialect === 'clickhouse' ? 'ClickHouse' : 'DuckDB'}`, 'Columns:'];
  for (const { name: table, columns } of r.tables) {
    lines.push(`${clean(table)}(${columns.map(([name, type]) => `${clean(name)} ${clean(type)}`).join(', ')})`);
  }
  if (r.question.trim()) lines.push(`Question: ${clean(r.question.trim())}`);
  if (r.previousTitle?.trim()) lines.push(`Previous title: ${clean(r.previousTitle.trim())}`);
  if (r.change?.trim()) lines.push(`Latest change: ${clean(r.change.trim())}`);
  lines.push('SQL:', r.sql.trim());
  return lines.join('\n');
}

/** Cut to `max` characters at a word boundary, with an ellipsis. */
function cut(text: string, max: number): string {
  const all = Array.from(text);
  if (all.length <= max) return text;
  const head = all.slice(0, max - 1).join('');
  const space = head.lastIndexOf(' ');
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** Parse the model's two lines. Mirrors `parse_reply` in caption.rs. */
export function parseCaption(reply: string): CaptionText | null {
  let title = '', explanation = '';
  for (const line of reply.split('\n')) {
    const t = line.trim().replace(/^\*+|\*+$/g, '').trim();
    const m = /^(TITLE|EXPLAIN)\s*:\s*(.*)$/i.exec(t);
    if (!m) continue;
    const value = clean(m[2].replace(/^[*\s]+/, '')).replace(/\s+/g, ' ').trim();
    if (m[1].toUpperCase() === 'TITLE' && !title) title = value.replace(/^["'“]+|["'”]+$/g, '').replace(/\.$/, '').trim();
    else if (m[1].toUpperCase() === 'EXPLAIN' && !explanation) explanation = value;
  }
  if (!title || !explanation) return null;
  return { title: cut(title, MAX_TITLE_CHARS), explanation: cut(explanation, MAX_EXPLANATION_CHARS) };
}

/** The tables a SQL text names (whole-word, case-insensitive), in source order, with their
 * columns. Over-inclusion is harmless; the payload stays small because only these are sent. */
export function referencedTables(tables: ReadonlyArray<{ name: string; columns: ReadonlyArray<{ name: string; type: string }> }>, sql: string): CaptionRequest['tables'] {
  const words = new Set((sql.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) ?? []));
  return tables.filter(t => words.has(t.name.toLowerCase()) || sql.toLowerCase().includes(`"${t.name.toLowerCase()}"`))
    .slice(0, MAX_TABLES).map(t => ({ name: t.name, columns: t.columns.slice(0, MAX_COLUMNS).map(c => [c.name, c.type] as [string, string]) }));
}
