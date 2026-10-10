/**
 * NL→SQL prompt. TypeScript twin of crates/inference-server/src/prompt.rs: both must
 * produce byte-identical text, checked against crates/inference-server/tests/fixtures/*.
 * The system message depends only on the DatasetContext (a stable, cacheable prefix);
 * the question is the last and only user message.
 */
import type { DatasetContext } from '../engine/contracts';

export const MAX_SAMPLE_ROWS = 5;
export const MAX_CELL_CHARS = 64;
export const MAX_VALUES = 32;
export const VIEWS = 'line, bar, scatter, table, heatmap, surface, map, density, tracks, seasons';

export const dialectName = (dialect: string): string => (dialect === 'clickhouse' ? 'ClickHouse' : 'DuckDB');

const bucketExample = (dialect: string): string =>
  dialect === 'clickhouse' ? 'toStartOfInterval(ts, INTERVAL 1 hour)' : "time_bucket(INTERVAL '1 hour', ts)";

const asciiUpper = (text: string): string => text.replace(/[a-z]/g, (c) => c.toUpperCase());
const clean = (text: string): string => text.replace(/[\u0000-\u001f]/g, ' ');
const present = (value: unknown): boolean => value !== undefined && value !== null;

export function ident(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${clean(name).replace(/"/g, '""')}"`;
}

/** A JSON value as a SQL-ish literal. Mirrors `literal` in prompt.rs. */
export function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'string') {
    const chars = Array.from(clean(value));
    const text = chars.slice(0, MAX_CELL_CHARS).join('') + (chars.length > MAX_CELL_CHARS ? '…' : '');
    return `'${text.replace(/'/g, "''")}'`;
  }
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  return '{…}';
}

function latestTimestamp(context: DatasetContext): [string, string, unknown] | undefined {
  for (const table of context.tables) {
    for (const column of table.columns) {
      const type = asciiUpper(column.type);
      if ((type.startsWith('TIMESTAMP') || type.startsWith('DATE')) && present(column.max)) {
        return [table.name, column.name, column.max];
      }
    }
  }
  return undefined;
}

export function systemPrompt(context: DatasetContext): string {
  const dialect = dialectName(context.dialect);
  let out =
    `You translate a question about the dataset below into exactly one ${dialect} SQL query.\n` +
    '\n' +
    'Output:\n' +
    '- Reply with the SQL only: one read-only SELECT statement (WITH is allowed). No prose, no markdown, no code fences, no trailing semicolon.\n' +
    '- Use only the tables and columns listed below, spelled exactly as listed.\n' +
    '- The question is typed live and may be unfinished. Answer the most plausible complete question. Never ask for clarification.\n' +
    '\n' +
    'Result shape (the chart is chosen from column order and types):\n' +
    '- First column: the x axis, a time or a category.\n' +
    '- Then optionally one text column that splits the result into series.\n' +
    '- Last column: the main numeric value. Further numeric columns before it are extra measures.\n' +
    '- Name latitude and longitude columns lat and lon.\n' +
    '- ORDER BY the x column, then the series column.\n' +
    `- Keep results small: bucket time, e.g. ${bucketExample(context.dialect)}, so each series has at most about 1000 points. Return at most 5000 rows; LIMIT plain row listings.\n` +
    `- Only when the question asks for a presentation (a chart type, map, table), make the first line the comment -- view: <name> with name one of ${VIEWS}. Otherwise write no comments.\n` +
    '\n' +
    'Time:\n';
  const latest = latestTimestamp(context);
  out += latest
    ? `- "Now" is the latest timestamp in the data, not today's date: ${ident(latest[0])}.${ident(latest[1])} = ${literal(latest[2])}. Relative times such as "last 7 days" or "today" count back from it.\n`
    : '- Relative times such as "last 7 days" count back from the latest timestamp in the data (its max()), not from today\'s date.\n';
  out += `\nDataset: ${clean(context.name)}`;
  if (context.description && context.description.trim() !== '') out += ` (${clean(context.description)})`;
  out += '\n';
  for (const table of context.tables) {
    out += `\nTable ${ident(table.name)}: ${literal(table.rows)} rows\n`;
    for (const column of table.columns) {
      out += `  ${ident(column.name)} ${clean(column.type)}`;
      if (present(column.min) && present(column.max)) out += `, range ${literal(column.min)} to ${literal(column.max)}`;
      if (column.values && column.values.length > 0) {
        out += `, values ${column.values.slice(0, MAX_VALUES).map(literal).join(', ')}`;
      } else if (present(column.distinct)) {
        out += `, ${literal(column.distinct)} distinct`;
      }
      out += '\n';
    }
    if (table.sample && table.sample.length > 0) {
      out += '  Sample rows:\n';
      for (const row of table.sample.slice(0, MAX_SAMPLE_ROWS)) out += `  (${row.map(literal).join(', ')})\n`;
    }
  }
  return out;
}

export const userMessage = (question: string): string => question.trim();

export const repairMessage = (context: DatasetContext, reason: string): string =>
  `That reply was rejected: ${reason}. Reply with only one ${dialectName(context.dialect)} SELECT statement for my original question.`;
