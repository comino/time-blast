/**
 * Chart-as-query: a pointer gesture on a chart becomes a deterministic SQL change, with no model
 * in the loop (docs/batch-2/manipulation.md).
 *
 *   renderer hit-test (exact data under the pointer) → restriction → SQL rewrite → QUERY frame
 *
 * A restriction is "rows of the shown result whose column c is in this range / equals this
 * value". Two ways to apply it:
 *
 * 1. **Rewrite** (DuckDB's own parser and printer, `json_serialize_sql`/`json_deserialize_sql`):
 *    when the statement is one plain SELECT over one table — no CTE, subquery, window, LIMIT,
 *    QUALIFY, grouping sets — and the output column is a deterministic, non-aggregate expression E
 *    over that table's columns, the restriction is ANDed into WHERE. Every output row is a group
 *    (or row) whose key E is fixed, so filtering input rows on E keeps exactly the output rows with
 *    E in range, unchanged: the result equals the original result filtered. For time buckets
 *    E = date_trunc(part, ts) / time_bucket(interval, ts) the filter is written on the raw column
 *    (`ts >= first AND ts < last + width`, where first/last are bucket starts on screen), which is
 *    the same set of rows, and lets zone maps and the rollup rewrite work. Only then the bucket may
 *    be refined (hour → 15 min → minute) when the brushed window holds few buckets: every
 *    occurrence of E in the select list, GROUP BY and ORDER BY becomes the finer bucket.
 * 2. **Wrap**: `SELECT * FROM (<sql>) AS tb_drill WHERE <restriction on the output column>`.
 *    Always exactly the filtered result (LIMIT, windows, joins included), never refines buckets.
 *    Used whenever the rewrite's conditions do not hold, for ClickHouse, or without the parser.
 */
import type { Hit, HitValue, PointerGesture } from './contracts';
import { quoteIdent, quoteLiteral } from './dataset';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ast = any;

/** DuckDB's parser and printer (the database node's, on its own connection). */
export interface SqlTools {
  /** json_serialize_sql(sql), JSON.parse'd. */
  parse(sql: string): Ast;
  /** json_deserialize_sql of each statement tree `{error:false, statements:[…]}`. */
  print(trees: Ast[]): string[];
}

export type Restriction =
  /** Inclusive range of output values (time/date: µs since the epoch). */
  | { kind: 'range'; column: number; name: string; type: HitValue['type']; lo: number; hi: number; refine: boolean }
  /** Output text value in a set. */
  | { kind: 'in'; column: number; name: string; type: HitValue['type']; labels: string[] }
  /** Output value equals (null: IS NULL). */
  | { kind: 'eq'; column: number; name: string; type: HitValue['type']; value: string | number | boolean | null };

export interface ManipulateOptions {
  tools?: SqlTools;
  dialect?: 'duckdb' | 'clickhouse';
  /** Lower-case column names of the dataset's tables (an output expression may only reference
   * these to be rewritten). Undefined: unknown, so wrap. */
  columns?: Set<string>;
  /** Buckets a brushed window should hold before the bucket is refined (default 48). */
  targetBuckets?: number;
}

export interface Manipulation {
  sql: string | null;
  method: 'rewrite' | 'wrap' | 'none';
  reason: string;
  restriction?: Restriction;
}

const TEXT_TYPES = new Set(['text', 'boolean']);
const TIME_TYPES = new Set(['timestamp', 'date']);

/** What a gesture asks for, from the renderer's hit. */
export function restrictionOf(hit: Hit, gesture: PointerGesture): Restriction | undefined {
  if (gesture.kind === 'brush') {
    const r = hit.range;
    if (!r) return undefined;
    if (r.labels) return r.labels.length ? { kind: 'in', column: r.column, name: r.name, type: r.type, labels: r.labels } : undefined;
    if (typeof r.lo !== 'number' || typeof r.hi !== 'number') return undefined;
    return { kind: 'range', column: r.column, name: r.name, type: r.type, lo: r.lo, hi: r.hi, refine: TIME_TYPES.has(r.type) };
  }
  // Point and legend: a series (line, heatmap row, map point, legend entry) wins over x.
  const v = hit.series ?? hit.x;
  if (!v) return undefined;
  if (v.label !== undefined) {
    const value = v.null ? null : v.type === 'boolean' ? v.label === 'true' : v.type === 'integer' || v.type === 'number' ? Number(v.label) : v.label;
    return { kind: 'eq', column: v.column, name: v.name, type: v.type, value };
  }
  if (typeof v.value !== 'number') return v.value === null ? { kind: 'eq', column: v.column, name: v.name, type: v.type, value: null } : undefined;
  // A time bucket (bar on a time axis, heatmap column): zoom into it.
  if (TIME_TYPES.has(v.type)) return { kind: 'range', column: v.column, name: v.name, type: v.type, lo: v.value, hi: v.value, refine: true };
  return { kind: 'eq', column: v.column, name: v.name, type: v.type, value: v.value };
}

/** The whole path: restriction → rewrite, else wrap. */
export function manipulate(sql: string, hit: Hit, gesture: PointerGesture, options: ManipulateOptions = {}): Manipulation {
  const restriction = restrictionOf(hit, gesture);
  if (!restriction) return { sql: null, method: 'none', reason: 'nothing under the pointer' };
  return apply(sql, restriction, options);
}

export function apply(sql: string, restriction: Restriction, options: ManipulateOptions = {}): Manipulation {
  const dialect = options.dialect ?? 'duckdb';
  let reason = dialect === 'clickhouse' ? 'clickhouse: wrap' : 'no parser';
  if (dialect === 'duckdb' && options.tools) {
    try {
      const out = rewrite(sql, restriction, options.tools, options);
      if (out.sql) return { sql: out.sql, method: 'rewrite', reason: out.reason, restriction };
      reason = out.reason;
    } catch (error) {
      reason = `rewrite failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
    }
  }
  return { sql: wrap(sql, restriction, dialect), method: 'wrap', reason, restriction };
}

// ───────────────────────── literals ─────────────────────────

/** µs since the epoch → 'YYYY-MM-DD HH:MM:SS[.ffffff]' (UTC). */
export function formatMicros(us: number): string {
  const ms = Math.floor(us / 1000), rest = us - ms * 1000;
  const iso = new Date(ms).toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  const fraction = `${iso.slice(20, 23)}${String(Math.round(rest)).padStart(3, '0')}`.replace(/0+$/, '');
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}${fraction ? `.${fraction}` : ''}`;
}

function literal(type: HitValue['type'], value: string | number | boolean | null, dialect: 'duckdb' | 'clickhouse'): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return quoteLiteral(value);
  if (type === 'timestamp') {
    const text = formatMicros(value);
    return dialect === 'clickhouse' ? `toDateTime64(${quoteLiteral(text)}, 6, 'UTC')` : `TIMESTAMP ${quoteLiteral(text)}`;
  }
  if (type === 'date') {
    const text = formatMicros(value).slice(0, 10);
    return dialect === 'clickhouse' ? `toDate(${quoteLiteral(text)})` : `DATE ${quoteLiteral(text)}`;
  }
  if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return String(value);
  // Exact round trip: DuckDB reads a bare 0.1 as DECIMAL; a cast from text keeps the double.
  return dialect === 'clickhouse' ? `toFloat64(${quoteLiteral(String(value))})` : `CAST(${quoteLiteral(String(value))} AS DOUBLE)`;
}

/** Predicate text over `target` (an expression's SQL text). */
function predicate(target: string, r: Restriction, dialect: 'duckdb' | 'clickhouse'): string {
  switch (r.kind) {
    case 'range':
      return r.lo === r.hi ? `${target} = ${literal(r.type, r.lo, dialect)}`
        : `${target} >= ${literal(r.type, r.lo, dialect)} AND ${target} <= ${literal(r.type, r.hi, dialect)}`;
    case 'in':
      return `${target} IN (${r.labels.map(l => literal(r.type, r.type === 'boolean' ? l === 'true' : l, dialect)).join(', ')})`;
    case 'eq':
      return r.value === null ? `${target} IS NULL` : `${target} = ${literal(r.type, r.value, dialect)}`;
  }
}

// ───────────────────────── wrap ─────────────────────────

/** Leading comment lines (e.g. `-- view: bar`) stay in front so hints keep working. */
export function splitLead(sql: string): [string, string] {
  const m = /^(\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/))*\s*/.exec(sql);
  const lead = m ? m[0] : '';
  return [lead, sql.slice(lead.length)];
}

/** Drop trailing comment lines, whitespace and semicolons (one statement goes inside the wrap). */
function stripTail(body: string): string {
  const lines = body.split('\n');
  for (;;) {
    while (lines.length && /^\s*(--.*)?$/.test(lines[lines.length - 1])) lines.pop();
    const last = lines.length ? lines[lines.length - 1].replace(/[\s;]+$/, '') : '';
    if (!lines.length || last === lines[lines.length - 1]) break;
    lines[lines.length - 1] = last;
  }
  return lines.join('\n');
}

export function wrap(sql: string, r: Restriction, dialect: 'duckdb' | 'clickhouse' = 'duckdb'): string {
  const [lead, body] = splitLead(sql);
  // Newlines around the body: a trailing `-- comment` must not swallow the closing parenthesis.
  return `${lead}SELECT * FROM (\n${stripTail(body)}\n) AS tb_drill WHERE ${predicate(quoteIdent(r.name), r, dialect)}`;
}

// ───────────────────────── rewrite ─────────────────────────

const AGGREGATES = new Set([
  'count', 'count_star', 'sum', 'avg', 'mean', 'min', 'max', 'median', 'mode', 'quantile', 'quantile_cont', 'quantile_disc',
  'arg_max', 'arg_min', 'argmax', 'argmin', 'max_by', 'min_by', 'first', 'last', 'any_value', 'list', 'array_agg', 'string_agg',
  'group_concat', 'listagg', 'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp', 'corr', 'covar_pop',
  'covar_samp', 'regr_slope', 'regr_intercept', 'regr_r2', 'regr_count', 'regr_avgx', 'regr_avgy', 'regr_sxx', 'regr_syy',
  'regr_sxy', 'kurtosis', 'kurtosis_pop', 'skewness', 'entropy', 'product', 'histogram', 'bool_and', 'bool_or', 'bit_and',
  'bit_or', 'bit_xor', 'approx_count_distinct', 'approx_quantile', 'reservoir_quantile', 'fsum', 'sumkahan', 'kahan_sum',
  'favg', 'mad', 'bitstring_agg', 'geomean', 'geometric_mean', 'weighted_avg', 'wavg',
]);
const VOLATILE = new Set(['random', 'now', 'current_timestamp', 'get_current_timestamp', 'current_date', 'current_time', 'today',
  'transaction_timestamp', 'gen_random_uuid', 'uuid', 'nextval', 'currval', 'setseed', 'localtimestamp', 'localtime']);

const lower = (s: unknown) => String(s).toLowerCase();

/** Visit every object in a tree. Stops descending where `fn` returns false. */
function walk(node: Ast, fn: (n: Ast) => boolean | void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, fn); return; }
  if (fn(node) === false) return;
  for (const key of Object.keys(node)) walk(node[key], fn);
}

function some(node: Ast, test: (n: Ast) => boolean): boolean {
  let found = false;
  walk(node, n => { if (found) return false; if (test(n)) { found = true; return false; } });
  return found;
}

/** Structural equality ignoring source positions and aliases. */
function same(a: Ast, b: Ast): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k === 'query_location' || k === 'alias') continue;
    if (!same(a[k], b[k])) return false;
  }
  return true;
}

function count(node: Ast, target: Ast): number {
  let n = 0;
  walk(node, x => { if (x?.class && same(x, target)) { n++; return false; } });
  return n;
}

/** The top-level expressions of a SELECT that name its groups and order: select items, GROUP BY
 * keys, ORDER BY keys. A bucket is refined only where it appears as one of these. */
function topLevel(node: Ast): Array<[Ast, string | number]> {
  const out: Array<[Ast, string | number]> = [];
  (node.select_list ?? []).forEach((_: Ast, i: number) => out.push([node.select_list, i]));
  (node.group_expressions ?? []).forEach((_: Ast, i: number) => out.push([node.group_expressions, i]));
  for (const m of node.modifiers ?? []) if (m.type === 'ORDER_MODIFIER') for (const o of m.orders ?? []) out.push([o, 'expression']);
  return out;
}

const isAggregate = (n: Ast) => n?.class === 'FUNCTION' && (AGGREGATES.has(lower(n.function_name)) || n.filter || n.distinct);
const isVolatile = (n: Ast) => n?.class === 'FUNCTION' && VOLATILE.has(lower(n.function_name));

interface Bucket {
  /** The raw time column under the bucket. */
  column: Ast;
  /** SQL text of the bucket width (`INTERVAL '1 hour'`), printed by DuckDB for time_bucket. */
  width: Ast | string;
  /** Approximate width in µs (months ≈ 30.44 days), for the refinement decision only. */
  micros: number;
  /** date_trunc / time_bucket can be refined; CAST(ts AS DATE) cannot. */
  refinable: boolean;
}

const PART_MICROS: Record<string, number> = {
  second: 1e6, minute: 60e6, hour: 3600e6, day: 86400e6, week: 7 * 86400e6, month: 30.44 * 86400e6, quarter: 91.31 * 86400e6, year: 365.25 * 86400e6,
};
const UNIT_MICROS: Record<string, number> = {};
for (const [units, us] of [[['second', 'seconds', 'sec', 'secs'], 1e6], [['minute', 'minutes', 'min', 'mins'], 60e6],
  [['hour', 'hours', 'hr', 'hrs'], 3600e6], [['day', 'days'], 86400e6], [['week', 'weeks'], 7 * 86400e6],
  [['month', 'months', 'mon', 'mons'], 30.44 * 86400e6], [['year', 'years', 'yr', 'yrs'], 365.25 * 86400e6]] as Array<[string[], number]>) {
  for (const u of units) UNIT_MICROS[u] = us;
}
const TO_UNIT: Record<string, number> = { to_seconds: 1e6, to_minutes: 60e6, to_hours: 3600e6, to_days: 86400e6, to_weeks: 7 * 86400e6, to_months: 30.44 * 86400e6, to_years: 365.25 * 86400e6 };

function intervalMicros(e: Ast): number | undefined {
  if (e?.class === 'CAST' && e.cast_type?.id === 'INTERVAL' && e.child?.class === 'CONSTANT' && e.child.value?.type?.id === 'VARCHAR') {
    let total = 0, consumed = '';
    const text = lower(e.child.value.value).trim();
    for (const m of text.matchAll(/(\d+)\s*([a-z]+)/g)) {
      const unit = UNIT_MICROS[m[2]];
      if (!unit) return undefined;
      total += Number(m[1]) * unit; consumed += m[0];
    }
    return consumed.replace(/\s+/g, '') === text.replace(/\s+/g, '') && total > 0 ? total : undefined;
  }
  if (e?.class === 'FUNCTION' && TO_UNIT[lower(e.function_name)] && e.children?.length === 1) {
    let c = e.children[0];
    while (c && (c.class === 'CAST' || (c.class === 'FUNCTION' && lower(c.function_name) === 'trunc'))) c = c.class === 'CAST' ? c.child : c.children[0];
    const n = c?.class === 'CONSTANT' ? Number(c.value?.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n * TO_UNIT[lower(e.function_name)] : undefined;
  }
  return undefined;
}

/** date_trunc('part', col) · time_bucket(interval, col) · CAST(col AS DATE). */
function bucketOf(e: Ast): Bucket | undefined {
  if (e?.class === 'FUNCTION' && e.children?.length === 2 && !e.filter && !e.distinct) {
    const [a, b] = e.children, name = lower(e.function_name);
    if (b?.class !== 'COLUMN_REF') return undefined;
    if (name === 'date_trunc' || name === 'datetrunc') {
      const part = a?.class === 'CONSTANT' && a.value?.type?.id === 'VARCHAR' ? lower(a.value.value) : '';
      const micros = PART_MICROS[part];
      if (!micros) return undefined;
      const width = part === 'quarter' ? "INTERVAL '3 months'" : `INTERVAL '1 ${part}'`;
      return { column: b, width, micros, refinable: true };
    }
    if (name === 'time_bucket') {
      const micros = intervalMicros(a);
      return micros ? { column: b, width: a, micros, refinable: true } : undefined;
    }
  }
  if (e?.class === 'CAST' && e.cast_type?.id === 'DATE' && !e.try_cast && e.child?.class === 'COLUMN_REF') {
    return { column: e.child, width: "INTERVAL '1 day'", micros: 86400e6, refinable: false };
  }
  return undefined;
}

/** Finer buckets, coarse → fine: (approx µs, SQL with `$` for the column). */
const LADDER: Array<[number, string]> = [
  [86400e6, "date_trunc('day', $)"],
  [6 * 3600e6, "time_bucket(INTERVAL '6 hours', $)"],
  [3600e6, "date_trunc('hour', $)"],
  [15 * 60e6, "time_bucket(INTERVAL '15 minutes', $)"],
  [5 * 60e6, "time_bucket(INTERVAL '5 minutes', $)"],
  [60e6, "date_trunc('minute', $)"],
];

/** The finer bucket for a window of `window` µs now shown in buckets of `width` µs, if any:
 * the coarsest ladder step that still gives `target` buckets, else the finest one. */
export function refinedBucket(window: number, width: number, target = 48): string | undefined {
  if (window / width >= target) return undefined;
  const finer = LADDER.filter(([us]) => us < width - 1);
  if (!finer.length) return undefined;
  return (finer.find(([us]) => window / us >= target) ?? finer[finer.length - 1])[1];
}

const PLACEHOLDER = 'tb_manipulate_x';
const OLD_WHERE = 'tb_manipulate_where';

function rewrite(sql: string, r: Restriction, tools: SqlTools, options: ManipulateOptions): { sql?: string; reason: string } {
  const [lead, body] = splitLead(sql);
  const parsed = tools.parse(body);
  if (!parsed || parsed.error) return { reason: `parse: ${parsed?.error_message ?? 'failed'}` };
  if (parsed.statements?.length !== 1) return { reason: 'not exactly one statement' };
  const node = parsed.statements[0].node;
  if (node?.type !== 'SELECT_NODE') return { reason: 'not a plain SELECT (set operation?)' };
  if (node.cte_map?.map?.length) return { reason: 'CTE' };
  if (node.from_table?.type !== 'BASE_TABLE') return { reason: 'FROM is not one table' };
  if ((node.modifiers ?? []).some((m: Ast) => m.type !== 'ORDER_MODIFIER' && m.type !== 'DISTINCT_MODIFIER')) return { reason: 'LIMIT/OFFSET' };
  if (node.qualify || node.sample || node.from_table.sample) return { reason: 'QUALIFY/SAMPLE' };
  if ((node.group_sets?.length ?? 0) > 1) return { reason: 'grouping sets' };
  if (some(node, n => n?.class === 'SUBQUERY' || n?.class === 'WINDOW' || n?.type === 'STAR' || n?.class === 'STAR')) return { reason: 'subquery, window or *' };
  const item = node.select_list?.[r.column];
  if (!item) return { reason: 'output column not found' };
  if (some(item, isAggregate)) return { reason: 'output column is an aggregate' };
  if (some(item, isVolatile)) return { reason: 'output column is volatile' };
  // Every column the expression reads must be a table column (not a select alias).
  let unknown = false, refs = 0;
  walk(item, n => {
    if (n?.class !== 'COLUMN_REF') return;
    refs++;
    const name = lower(n.column_names?.[n.column_names.length - 1]);
    if (!options.columns || !options.columns.has(name)) unknown = true;
  });
  if (!refs) return { reason: 'output column reads no table column' };
  if (unknown) return { reason: 'output column references an unknown column or alias' };

  const expression = { ...structuredClone(item), alias: '' };
  const bucket = r.kind === 'range' && TIME_TYPES.has(r.type) ? bucketOf(expression) : undefined;
  let predicateText: string, target: Ast;
  if (bucket && r.kind === 'range') {
    // Raw bounds: every row of the buckets [lo … hi] on screen, and nothing else.
    target = bucket.column;
    const lo = literal('timestamp', r.lo, 'duckdb'), hi = literal('timestamp', r.hi, 'duckdb');
    predicateText = `${PLACEHOLDER} >= ${lo} AND ${PLACEHOLDER} < ${hi} + ${typeof bucket.width === 'string' ? bucket.width : 'tb_manipulate_width'}`;
  } else {
    target = expression;
    predicateText = predicate(PLACEHOLDER, r, 'duckdb');
  }
  const template = tools.parse(`SELECT 1 FROM t WHERE ${node.where_clause ? `${OLD_WHERE} AND ` : ''}(${predicateText})`);
  if (!template || template.error) return { reason: `predicate does not parse: ${template?.error_message}` };
  const where = template.statements[0].node.where_clause;
  const holder = { where };
  const substitute = (h: Ast, k: string | number): void => {
    const n = h[k];
    if (!n || typeof n !== 'object') return;
    if (n.class === 'COLUMN_REF' && n.column_names?.length === 1) {
      const name = n.column_names[0];
      if (name === PLACEHOLDER) { h[k] = structuredClone(target); return; }
      if (name === OLD_WHERE) { h[k] = structuredClone(node.where_clause); return; }
      if (name === 'tb_manipulate_width' && bucket && typeof bucket.width !== 'string') { h[k] = structuredClone(bucket.width); return; }
    }
    for (const key of Array.isArray(n) ? n.keys() : Object.keys(n)) substitute(n, key as never);
  };
  substitute(holder, 'where');
  node.where_clause = holder.where;

  let reason = 'rewritten: restriction in WHERE';
  if (bucket?.refinable && r.kind === 'range' && r.refine) {
    const finer = refinedBucket(r.hi - r.lo + bucket.micros, bucket.micros, options.targetBuckets);
    // Refine only where the bucket names the groups: as whole select items, GROUP BY and ORDER BY
    // keys. Nested uses (inside another expression) or a HAVING would change other meanings.
    const slots = topLevel(node).filter(([h, k]) => same(h[k], expression));
    const everywhere = count(node.select_list, expression) + count(node.group_expressions, expression) + count(node.modifiers, expression);
    const blocked = !!node.having || slots.length !== everywhere;
    if (finer && !blocked) {
      const replacement = tools.parse(`SELECT ${finer.replace('$', PLACEHOLDER)}`);
      if (replacement && !replacement.error) {
        const finerExpr = replacement.statements[0].node.select_list[0];
        const h = { e: finerExpr };
        const col = bucket.column;
        const put = (hh: Ast, k: string | number): void => {
          const n = hh[k];
          if (!n || typeof n !== 'object') return;
          if (n.class === 'COLUMN_REF' && n.column_names?.[0] === PLACEHOLDER) { hh[k] = structuredClone(col); return; }
          for (const key of Array.isArray(n) ? n.keys() : Object.keys(n)) put(n, key as never);
        };
        put(h, 'e');
        for (const [holder, key] of slots) holder[key] = { ...structuredClone(h.e), alias: holder[key].alias ?? '' };
        if (slots.length) reason = `rewritten: restriction in WHERE, bucket refined to ${finer.replace('$', lower(col.column_names.at(-1)))}`;
      }
    }
  }
  const [printed] = tools.print([{ error: false, statements: [parsed.statements[0]] }]);
  if (!printed) return { reason: 'print failed' };
  return { sql: `${lead}${printed}`, reason };
}
