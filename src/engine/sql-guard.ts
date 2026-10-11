/**
 * Read-only, single-statement guard for model-written SQL, decided by DuckDB itself:
 *
 * 1. DuckDB's own tokenizer (the parser's scanner, so strings, quoted identifiers, dollar
 *    quotes and comments are handled exactly as the parser will) finds `;` tokens. Anything
 *    after the first `;` other than more `;` means multiple statements → rejected. This
 *    matters: DuckDB-Wasm's pending-query API runs every statement of a script and only
 *    streams the last.
 * 2. The statement is wrapped as `SELECT * FROM (<sql>\n)`. Only a SELECT-shaped query
 *    (SELECT, WITH … SELECT, VALUES, FROM-first, PIVOT, DESCRIBE, SUMMARIZE, set operations)
 *    parses inside a subquery, so DDL, DML, SET, PRAGMA, ATTACH, COPY, transactions, … fail
 *    at parse time. The newline keeps a trailing `-- comment` from swallowing the `)`.
 *
 * Defence in depth around it: external access is disabled and configuration locked after
 * boot (src/engine/database-node.ts), and SELECT cannot write in DuckDB.
 *
 * Cost (measured, see docs/batch-1/engine.md): the tokenizer call is tens of µs; the
 * alternative `json_serialize_sql` check is a separate query costing ~1–3 ms in DuckDB-Wasm
 * and needs the json extension.
 */
export interface Tokenizer {
  tokenize(text: string): { offsets: number[]; types: number[] };
}

/** duckdb-wasm ScriptTokens type for operators (IDENTIFIER 0, NUMERIC 1, STRING 2, OPERATOR 3, KEYWORD 4). */
const OPERATOR = 3;
const SEMICOLON = 0x3b;

export type GuardResult =
  /** `sql` is the wrapped statement to execute, `inner` the single statement it wraps. */
  | { ok: true; sql: string; inner: string }
  | { ok: false; code: 'empty' | 'multiple_statements'; message: string };

export function guardSql(sql: string, tokenizer: Tokenizer): GuardResult {
  const { offsets, types } = tokenizer.tokenize(sql);
  let end = -1;
  for (let i = 0; i < offsets.length; i++) {
    const semicolon = types[i] === OPERATOR && sql.charCodeAt(offsets[i]) === SEMICOLON;
    if (semicolon) { if (end < 0) end = offsets[i]; }
    else if (end >= 0) return { ok: false, code: 'multiple_statements', message: 'Only one SQL statement may be executed' };
  }
  if (offsets.length === 0 || (end >= 0 && offsets[0] === end)) {
    return { ok: false, code: 'empty', message: 'The SQL text contains no statement' };
  }
  const inner = end >= 0 ? sql.slice(0, end) : sql;
  return { ok: true, sql: wrapStatement(inner), inner };
}

/** The guard's subquery wrapper (also applied to statements the database node rewrites). */
export function wrapStatement(inner: string): string {
  return `SELECT * FROM (${inner}\n)`;
}

/** Error text from DuckDB refers to the wrapped statement; strip our wrapper prefix from
 * echoed source lines so a repair prompt sees the model's own SQL. */
export function unwrapError(message: string): string {
  const prefix = 'LINE 1: SELECT * FROM (', wrapper = prefix.length - 'LINE 1: '.length;
  const lines = message.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(prefix)) continue;
    lines[i] = 'LINE 1: ' + lines[i].slice(prefix.length);
    const caret = lines[i + 1];
    if (caret !== undefined && /^ *\^ *$/.test(caret) && caret.indexOf('^') >= wrapper) lines[i + 1] = caret.slice(wrapper);
  }
  return lines.join('\n');
}
