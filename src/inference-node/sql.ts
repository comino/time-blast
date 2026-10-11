/**
 * Raw model text → SQL, incrementally. TypeScript twin of crates/inference-server/src/sql.rs.
 * SqlStream strips a leading <think>…</think> block and Markdown fences, holds back trailing
 * whitespace/`;`/backticks, and streams nothing until the first word looks like a query, so
 * concatenated deltas are always a prefix of finish(). check() only rejects what is obviously
 * not one SELECT; the database node does the real validation.
 */
const FENCE = '```';
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

export class SqlStream {
  private raw = '';
  private emitted = 0;
  private started: boolean | undefined;

  /** Feed raw model text; returns newly certain SQL text, or undefined. */
  push(text: string): string | undefined {
    this.raw += text;
    const body = extract(this.raw, false);
    if (body === undefined) return undefined;
    const ready = body.replace(/[\s;`]+$/, '');
    if (this.started === undefined) this.started = startsLikeQuery(ready);
    if (this.started !== true || ready.length <= this.emitted) return undefined;
    const delta = ready.slice(this.emitted);
    this.emitted = ready.length;
    return delta;
  }

  finish(): string {
    return (extract(this.raw, true) ?? '').replace(/[\s;]+$/, '');
  }
}

function extract(raw: string, done: boolean): string | undefined {
  let text = raw.trimStart();
  if (text.startsWith(THINK_OPEN)) {
    const end = text.indexOf(THINK_CLOSE);
    if (end < 0) return undefined;
    text = text.slice(end + THINK_CLOSE.length).trimStart();
  } else if (!done && text !== '' && THINK_OPEN.startsWith(text)) {
    return undefined;
  }
  if (text.startsWith(FENCE)) {
    const newline = text.indexOf('\n');
    if (newline < 0) return done ? '' : undefined;
    text = text.slice(newline + 1).trimStart();
  } else if (!done && FENCE.startsWith(text)) {
    return undefined;
  }
  const close = text.indexOf(FENCE);
  if (close >= 0) text = text.slice(0, close);
  return text.trimStart();
}

const isQueryStart = (word: string): boolean => ['SELECT', 'WITH', 'FROM', '('].includes(word.toUpperCase());

function startsLikeQuery(ready: string): boolean | undefined {
  const lexer = new Lexer(ready);
  if (!lexer.skipTrivia() || lexer.unterminated) return undefined;
  const word = lexer.nextWord();
  if (word === undefined) return undefined;
  if (lexer.at === ready.length && word !== '(') return undefined;
  return isQueryStart(word);
}

/** DuckDB date-part keywords: as a bare column alias (`flight_date day,`) they are a syntax error;
 * `AS day` works. Mirrors `PART_KEYWORDS` in sql.rs. */
const PART_KEYWORDS = new Set(['day', 'days', 'hour', 'hours', 'minute', 'minutes', 'month', 'months', 'second', 'seconds', 'week', 'weeks', 'year', 'years']);
const NOT_ALIAS_AFTER = new Set(['all', 'and', 'as', 'by', 'case', 'distinct', 'else', 'from', 'group', 'having', 'in', 'interval', 'is', 'join', 'not', 'on', 'or', 'order', 'select', 'then', 'when', 'where', 'with']);
const asciiLower = (text: string): string => text.replace(/[A-Z]/g, c => c.toLowerCase());
const aliasReason = (word: string): string => `the bare alias ${word} is a DuckDB keyword and does not parse; write AS ${word}`;

/** A DuckDB part keyword used as a bare alias (twin of `keyword_alias` in sql.rs). Returns the
 * repair reason, or undefined. */
export function keywordAlias(sql: string): string | undefined {
  const lexer = new Lexer(sql);
  let prev: string | undefined, pending: string | undefined;
  while (lexer.skipTrivia()) {
    const c = sql[lexer.at];
    let token: string | undefined;
    if (c === "'" || c === '"' || c === '`') lexer.skipQuoted(c);
    else { const word = lexer.nextWord(); token = word === undefined ? undefined : asciiLower(word); }
    if (pending !== undefined) {
      const word = pending;
      pending = undefined;
      if (token === ',' || token === 'from') return aliasReason(word);
    }
    if (token !== undefined) {
      const afterExpression = prev === ')' || (prev !== undefined && /^[A-Za-z_]/.test(prev) && !NOT_ALIAS_AFTER.has(prev));
      if (afterExpression && PART_KEYWORDS.has(token)) pending = token;
    }
    prev = token;
  }
  return pending === undefined ? undefined : aliasReason(pending);
}

/** Rejects replies that are obviously not one SELECT. Returns the reason, or undefined. */
export function check(sql: string): string | undefined {
  const lexer = new Lexer(sql);
  const first = lexer.nextWord();
  if (first === undefined) return 'the reply contained no SQL';
  if (!isQueryStart(first)) return `the reply must start with SELECT or WITH, not ${JSON.stringify(Array.from(first).slice(0, 24).join(''))}`;
  if (lexer.restHasSemicolon()) return 'the reply contained more than one statement';
  if (lexer.unterminated) return 'the reply ended inside a string, identifier or comment';
  return undefined;
}

/** Most rows a translation may return (the prompt's row rule). */
export const MAX_RESULT_ROWS = 5000;

const AGGREGATES = new Set([
  'any', 'any_value', 'anylast', 'approx_count_distinct', 'approx_quantile', 'arg_max',
  'arg_min', 'argmax', 'argmin', 'array_agg', 'avg', 'bool_and', 'bool_or', 'corr', 'count',
  'covar_pop', 'covar_samp', 'entropy', 'favg', 'first', 'fsum', 'group_concat', 'grouparray',
  'histogram', 'kurtosis', 'last', 'list', 'max', 'max_by', 'mean', 'median', 'min', 'min_by',
  'mode', 'percentile_cont', 'percentile_disc', 'product', 'quantile', 'quantile_cont',
  'quantile_disc', 'regr_intercept', 'regr_r2', 'regr_slope', 'skewness', 'stddev',
  'stddev_pop', 'stddev_samp', 'string_agg', 'sum', 'topk', 'uniq', 'uniqexact', 'var_pop',
  'var_samp', 'variance',
]);

const isAggregate = (word: string): boolean =>
  AGGREGATES.has(word) || (word.endsWith('if') && AGGREGATES.has(word.slice(0, -2)));

/** Large tables (lower-case name, rows) and time columns of a context, for rawRows(). */
export function rowCheckInputs(context: { tables: Array<{ name: string; rows: unknown; columns: Array<{ name: string; type: string }> }> }): { large: Array<[string, number]>; time: string[] } {
  const large: Array<[string, number]> = [];
  const time: string[] = [];
  for (const table of context.tables) {
    if (typeof table.rows === 'number' && table.rows > MAX_RESULT_ROWS) large.push([table.name.toLowerCase(), table.rows]);
    for (const column of table.columns) {
      const ty = column.type.toUpperCase();
      if (ty.startsWith('TIMESTAMP') || ty.startsWith('DATE')) time.push(column.name.toLowerCase());
    }
  }
  return { large, time };
}

/**
 * Pre-check twin of `raw_rows` in sql.rs: SQL reading a table above MAX_RESULT_ROWS without
 * GROUP BY, an aggregate, DISTINCT, QUALIFY, a sample, LIMIT ≤ 5000 or an equality filter on a
 * time column returns raw rows. Returns the repair reason, or undefined.
 */
export function rawRows(sql: string, large: Array<[string, number]>, time: string[]): string | undefined {
  const tokens = tokenize(sql);
  let table: [string, number] | undefined;
  for (const t of tokens) { table = large.find(([name]) => name === t); if (table) break; }
  if (!table) return undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], next = tokens[i + 1];
    if (token === 'group' && next === 'by') return undefined;
    if (token === 'qualify' || token === 'distinct' || token === 'sample' || token === 'tablesample') return undefined;
    if (token === 'limit') {
      const n = next !== undefined && /^[0-9.]+$/.test(next) ? Number(next) : NaN;
      return n > MAX_RESULT_ROWS ? `its LIMIT ${n} exceeds ${MAX_RESULT_ROWS} rows` : undefined;
    }
    if (token === '=' && i > 0 && time.includes(tokens[i - 1])) return undefined;
    if (next === '(' && isAggregate(token) && !windowed(tokens, i + 1)) return undefined;
  }
  return `it returns raw rows of ${table[0]} (${table[1]} rows) without GROUP BY, an aggregate or LIMIT; aggregate it, for example GROUP BY a time bucket, or add LIMIT`;
}

function windowed(tokens: string[], open: number): boolean {
  let depth = 0;
  for (let j = open; j < tokens.length; j++) {
    if (tokens[j] === '(') depth++;
    else if (tokens[j] === ')') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) return tokens[j + 1] === 'over';
    }
  }
  return false;
}

function tokenize(sql: string): string[] {
  const lexer = new Lexer(sql);
  const out: string[] = [];
  while (lexer.skipTrivia()) {
    const start = lexer.at;
    const c = sql[start];
    if (c === "'") { lexer.skipQuoted("'"); out.push("'"); }
    else if (c === '"' || c === '`') {
      lexer.skipQuoted(c);
      const end = Math.max(lexer.at - 1, start + 1);
      out.push(sql.slice(start + 1, end).replaceAll('""', '"').toLowerCase());
    } else if ('<>=!'.includes(c)) {
      while (lexer.at < sql.length && '<>=!'.includes(sql[lexer.at])) lexer.at++;
      out.push(sql.slice(start, lexer.at));
    } else if (c >= '0' && c <= '9') {
      while (lexer.at < sql.length && /[0-9.]/.test(sql[lexer.at])) lexer.at++;
      out.push(sql.slice(start, lexer.at));
    } else {
      const word = lexer.nextWord();
      if (word !== undefined) out.push(word.toLowerCase());
    }
  }
  return out;
}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isWord = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

class Lexer {
  at = 0;
  unterminated = false;
  constructor(private readonly src: string) {}

  skipTrivia(): boolean {
    for (;;) {
      while (this.at < this.src.length && isSpace(this.src[this.at])) this.at++;
      if (this.src.startsWith('--', this.at)) {
        const n = this.src.indexOf('\n', this.at);
        this.at = n < 0 ? this.src.length : n;
      } else if (this.src.startsWith('/*', this.at)) {
        const n = this.src.indexOf('*/', this.at + 2);
        if (n < 0) { this.unterminated = true; this.at = this.src.length; } else this.at = n + 2;
      } else {
        return this.at < this.src.length;
      }
    }
  }

  nextWord(): string | undefined {
    if (!this.skipTrivia()) return undefined;
    const start = this.at;
    if (this.src[start] === '(') { this.at++; return '('; }
    while (this.at < this.src.length && isWord(this.src[this.at])) this.at++;
    if (this.at === start) this.at += String.fromCodePoint(this.src.codePointAt(start)!).length;
    return this.src.slice(start, this.at);
  }

  restHasSemicolon(): boolean {
    while (this.skipTrivia()) {
      const c = this.src[this.at];
      if (c === "'" || c === '"' || c === '`') this.skipQuoted(c);
      else if (c === ';') { this.at++; if (this.skipTrivia()) return true; }
      else this.at++;
    }
    return false;
  }

  skipQuoted(quote: string): void {
    this.at++;
    while (this.at < this.src.length) {
      if (this.src[this.at] === quote) {
        if (this.src[this.at + 1] === quote) { this.at += 2; continue; }
        this.at++;
        return;
      }
      if (this.src[this.at] === '\\' && quote === "'") this.at++;
      this.at++;
    }
    this.unterminated = true;
  }
}
