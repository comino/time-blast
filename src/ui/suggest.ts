/**
 * Next-question anticipation, deterministic part: SQL variants of the result on screen.
 *
 * Given the question, its SQL and the DatasetContext, propose up to four follow-ups whose SQL is
 * derived from the shown SQL by one exact, local edit. Every variant is "the same question, one
 * thing changed", so the chip's label states precisely what its SQL does:
 *
 *   split    add a low-cardinality text column (≤ 12 known values) as series / category
 *   bucket   change the time bucket's unit (minute ↔ hour ↔ day)
 *   window   restrict to the last 24 hours / 7 days before the data's latest timestamp
 *            (the prompt's convention for "now", so a typed "last 24 hours" means the same)
 *   agg      swap the one aggregate function (avg → max, max → avg, sum → avg, …)
 *   view     same SQL with a `-- view:` hint the follow-up question asks for (heatmap / table)
 *
 * No model, no network, ~tens of µs. The edits work on a small SQL tokenizer (strings, quoted
 * identifiers, comments, parentheses) and only on top-level clauses of one plain SELECT; anything
 * else (WITH, set operations, unknown shapes) yields fewer or no variants rather than a guess.
 * Generic: columns come from the DatasetContext, nothing assumes a schema.
 */
import type { DatasetContext } from '../engine/contracts';

export type SuggestionKind = 'split' | 'bucket' | 'window' | 'agg' | 'view';
export interface Suggestion {
  kind: SuggestionKind;
  /** Short chip text. */
  label: string;
  /** The full follow-up question (what the input shows and the coordinator translates). */
  question: string;
  sql: string;
}

// ───────────────────────── tokenizer ─────────────────────────

type TokType = 'ws' | 'comment' | 'str' | 'qident' | 'word' | 'num' | 'lp' | 'rp' | 'comma' | 'op';
interface Tok { t: TokType; s: string; depth: number }

export function tokenize(sql: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0, depth = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i], start = i;
    let t: TokType;
    if (/\s/.test(c)) { while (i < n && /\s/.test(sql[i])) i++; t = 'ws'; }
    else if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; t = 'comment'; }
    else if (c === '/' && sql[i + 1] === '*') { const end = sql.indexOf('*/', i + 2); if (end < 0) return null; i = end + 2; t = 'comment'; }
    else if (c === "'" || c === '"') {
      i++;
      for (;;) {
        if (i >= n) return null;
        if (sql[i] === c) { if (sql[i + 1] === c) { i += 2; continue; } i++; break; }
        i++;
      }
      t = c === "'" ? 'str' : 'qident';
    } else if (/[A-Za-z_]/.test(c)) { while (i < n && /[A-Za-z0-9_$]/.test(sql[i])) i++; t = 'word'; }
    else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) { while (i < n && /[0-9._eE]/.test(sql[i])) i++; t = 'num'; }
    else if (c === '(') { i++; out.push({ t: 'lp', s: c, depth }); depth++; continue; }
    else if (c === ')') { i++; depth--; if (depth < 0) return null; out.push({ t: 'rp', s: c, depth }); continue; }
    else if (c === ',') { i++; t = 'comma'; }
    else if (c === '$') return null; // dollar-quoted strings: not handled
    else { i++; while (i < n && /[<>=!|:+\-*/%&^~]/.test(sql[i]) && !(sql[i] === '-' && sql[i + 1] === '-')) i++; t = 'op'; }
    out.push({ t, s: sql.slice(start, i), depth });
  }
  return depth === 0 ? out : null;
}

const render = (toks: Tok[]): string => toks.map(t => t.s).join('');
const isWord = (tok: Tok | undefined, word: string) => tok?.t === 'word' && tok.s.toLowerCase() === word;
const code = (toks: Tok[]): number[] => toks.flatMap((t, i) => (t.t === 'ws' || t.t === 'comment' ? [] : [i]));
const identName = (tok: Tok): string => (tok.t === 'qident' ? tok.s.slice(1, -1).replace(/""/g, '"') : tok.s);

// ───────────────────────── statement structure ─────────────────────────

type ClauseName = 'select' | 'from' | 'where' | 'group' | 'having' | 'qualify' | 'window' | 'order' | 'limit' | 'offset';
interface Clause { name: ClauseName; /** index of the keyword token */ at: number; /** first body token */ body: number; /** end (exclusive) */ end: number }
interface Statement { toks: Tok[]; clauses: Map<ClauseName, Clause>; /** leading comments (view hint) end here */ lead: number }

const CLAUSE_WORDS: Record<string, ClauseName> = {
  select: 'select', from: 'from', where: 'where', having: 'having', qualify: 'qualify', window: 'window', limit: 'limit', offset: 'offset',
};

function parse(sql: string): Statement | null {
  const toks = tokenize(sql.replace(/;\s*$/, ''));
  if (!toks) return null;
  const idx = code(toks);
  if (!idx.length || !isWord(toks[idx[0]], 'select')) return null; // WITH, VALUES, FROM-first, …
  const marks: Array<{ name: ClauseName; at: number; body: number }> = [];
  for (let k = 0; k < idx.length; k++) {
    const tok = toks[idx[k]];
    if (tok.depth !== 0 || tok.t !== 'word') continue;
    const w = tok.s.toLowerCase();
    if (w === 'union' || w === 'intersect' || w === 'except') return null;
    if ((w === 'group' || w === 'order') && isWord(toks[idx[k + 1]], 'by')) {
      marks.push({ name: w === 'group' ? 'group' : 'order', at: idx[k], body: idx[k + 1] + 1 });
      k++;
      continue;
    }
    const name = CLAUSE_WORDS[w];
    if (name) {
      if (name === 'select' && marks.length) return null; // a second top-level SELECT
      marks.push({ name, at: idx[k], body: idx[k] + 1 });
    }
  }
  if (toks.some(t => t.t === 'op' && t.s.includes(';'))) return null;
  const clauses = new Map<ClauseName, Clause>();
  for (let m = 0; m < marks.length; m++) {
    if (clauses.has(marks[m].name)) return null;
    // A clause ends right after its last code token: text inserted at the end must never land
    // inside a trailing `-- comment`.
    let end = m + 1 < marks.length ? marks[m + 1].at : toks.length;
    while (end > marks[m].body && (toks[end - 1].t === 'ws' || toks[end - 1].t === 'comment')) end--;
    clauses.set(marks[m].name, { ...marks[m], end });
  }
  if (!clauses.has('from')) return null;
  return { toks, clauses, lead: idx[0] };
}

/** Split a clause body into its top-level comma-separated items (token index ranges). */
function items(st: Statement, clause: Clause): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = clause.body;
  for (let i = clause.body; i < clause.end; i++) {
    const tok = st.toks[i];
    if (tok.t === 'comma' && tok.depth === 0) { out.push([start, i]); start = i + 1; }
  }
  out.push([start, clause.end]);
  return out.filter(([a, b]) => code(st.toks.slice(a, b)).length > 0);
}

interface SelectItem { range: [number, number]; alias?: string; aliasAt?: number; text: string }
function selectItems(st: Statement): SelectItem[] | null {
  const clause = st.clauses.get('select')!;
  const body = code(st.toks.slice(clause.body, clause.end)).map(i => i + clause.body);
  if (isWord(st.toks[body[0]], 'distinct')) return null;
  return items(st, clause).map(range => {
    const c = code(st.toks.slice(range[0], range[1])).map(i => i + range[0]);
    const last = st.toks[c[c.length - 1]];
    const item: SelectItem = { range, text: render(st.toks.slice(range[0], range[1])).trim() };
    if (c.length >= 3 && isWord(st.toks[c[c.length - 2]], 'as') && (last.t === 'word' || last.t === 'qident')) {
      item.alias = identName(last); item.aliasAt = c[c.length - 1];
    }
    return item;
  });
}

// ───────────────────────── context helpers ─────────────────────────

type Table = DatasetContext['tables'][number];
type Column = Table['columns'][number];
const isTime = (c: Column) => /^(TIMESTAMP|DATE|DATETIME)/i.test(c.type);
const isText = (c: Column) => /^(VARCHAR|TEXT|STRING|CHAR|LOWCARDINALITY\(STRING|ENUM)/i.test(c.type);

function fromTable(st: Statement, context: DatasetContext): Table | undefined {
  const from = st.clauses.get('from')!;
  const c = code(st.toks.slice(from.body, from.end)).map(i => i + from.body);
  // One plain table (optionally schema-qualified, optionally aliased); joins and subqueries: none.
  if (c.some(i => st.toks[i].t === 'lp' || st.toks[i].t === 'comma' || isWord(st.toks[i], 'join'))) return undefined;
  let name = st.toks[c[0]], rest = c.slice(1);
  if (c.length >= 3 && st.toks[c[1]].s === '.') { name = st.toks[c[2]]; rest = c.slice(3); }
  // Only `name`, `name alias` or `name AS alias` (no SAMPLE, no table functions).
  if (rest.length > 2 || (rest.length === 2 && !isWord(st.toks[rest[0]], 'as'))) return undefined;
  if (rest.length === 1 && /^(using|tablesample|sample)$/i.test(st.toks[rest[0]].s)) return undefined;
  if (!name || (name.t !== 'word' && name.t !== 'qident')) return undefined;
  const wanted = identName(name).toLowerCase();
  return context.tables.find(t => t.name.toLowerCase() === wanted);
}

/** Columns referenced anywhere in the statement (case-insensitive identifiers). */
function referenced(st: Statement): Set<string> {
  return new Set(st.toks.filter(t => t.t === 'word' || t.t === 'qident').map(t => identName(t).toLowerCase()));
}

const quote = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

/** "2026-09-14 23:59:54" / ISO → SQL timestamp literal body. */
function timestampLiteral(value: string | number | undefined): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(value);
  return m ? `${m[1]} ${m[2]}` : null;
}

// ───────────────────────── edits ─────────────────────────

/** Replace token ranges (non-overlapping) with text; returns the new SQL. */
function edit(toks: Tok[], edits: Array<[number, number, string]>): string {
  const sorted = [...edits].sort((a, b) => a[0] - b[0]);
  let out = '', at = 0;
  for (const [a, b, s] of sorted) { out += render(toks.slice(at, a)) + s; at = b; }
  return out + render(toks.slice(at));
}

const AGG_SWAP: Record<string, { to: string; phrase: string; label: string }> = {
  avg: { to: 'max', phrase: 'maximum instead of average', label: 'max' },
  mean: { to: 'max', phrase: 'maximum instead of average', label: 'max' },
  max: { to: 'avg', phrase: 'average instead of maximum', label: 'average' },
  min: { to: 'avg', phrase: 'average instead of minimum', label: 'average' },
  sum: { to: 'avg', phrase: 'average instead of total', label: 'average' },
  median: { to: 'avg', phrase: 'average instead of median', label: 'average' },
};
const AGG_WORDS: Record<string, string[]> = {
  avg: ['avg', 'average', 'mean'], mean: ['avg', 'average', 'mean'], max: ['max', 'maximum'], min: ['min', 'minimum'],
  sum: ['sum', 'total'], median: ['median'],
};

/** Token indices of the clauses whose aggregate calls describe the result (select, having, order). */
function resultClauses(st: Statement): number[] {
  const out: number[] = [];
  for (const name of ['select', 'having', 'order'] as const) {
    const c = st.clauses.get(name);
    if (c) for (let i = c.body; i < c.end; i++) out.push(i);
  }
  return out;
}

function aggSwap(st: Statement, base: string): Suggestion | null {
  const scope = resultClauses(st);
  // Subqueries in the result clauses: their aggregates mean something else. No variant.
  if (scope.some(i => isWord(st.toks[i], 'select'))) return null;
  // No window functions (OVER): the swap would change a different computation.
  if (st.toks.some(t => isWord(t, 'over'))) return null;
  const sel = st.clauses.get('select')!;
  const isCall = (i: number) => st.toks[i].t === 'word' && AGG_SWAP[st.toks[i].s.toLowerCase()] !== undefined && st.toks[i + 1]?.t === 'lp';
  const calls = scope.filter(i => i >= sel.body && i < sel.end && isCall(i));
  const names = new Set(calls.map(i => st.toks[i].s.toLowerCase()));
  if (calls.length === 0 || names.size !== 1) return null;
  const from = [...names][0], swap = AGG_SWAP[from];
  // Every call of that function in select / having / order: one consistent swap.
  const edits: Array<[number, number, string]> = scope.filter(i => isCall(i) && st.toks[i].s.toLowerCase() === from).map(i => [i, i + 1, swap.to]);
  // Aliases naming the old aggregate (avg_speed → max_speed) follow, with their references.
  const renames = new Map<string, string>();
  for (const item of selectItems(st) ?? []) {
    if (!item.alias) continue;
    const words = AGG_WORDS[from];
    const parts = item.alias.split('_');
    const k = parts.findIndex(p => words.includes(p.toLowerCase()));
    if (k >= 0) { parts[k] = swap.to; renames.set(item.alias.toLowerCase(), parts.join('_')); }
  }
  if (renames.size) renameIdents(st, renames, edits);
  return { kind: 'agg', label: swap.label, question: `${base}, ${swap.phrase}`, sql: edit(st.toks, edits) };
}

/** Rename aliases: their definitions (`AS name`) and bare references in GROUP BY / ORDER BY /
 * HAVING / QUALIFY. Never inside an edited range, a function name, a qualified name or a unit. */
function renameIdents(st: Statement, renames: Map<string, string>, edits: Array<[number, number, string]>): void {
  const covered = (i: number) => edits.some(([a, b]) => i >= a && i < Math.max(b, a + 1));
  const scope = new Set<number>();
  const sel = st.clauses.get('select')!;
  for (let i = sel.body; i < sel.end; i++) {
    const prev = code(st.toks.slice(0, i)).pop();
    if (prev !== undefined && isWord(st.toks[prev], 'as') && st.toks[prev].depth === 0) scope.add(i);
  }
  for (const name of ['group', 'order', 'having', 'qualify'] as const) {
    const c = st.clauses.get(name);
    if (c) for (let i = c.body; i < c.end; i++) scope.add(i);
  }
  for (const i of scope) {
    const tok = st.toks[i];
    if (covered(i) || (tok.t !== 'word' && tok.t !== 'qident')) continue;
    const to = renames.get(identName(tok).toLowerCase());
    if (to === undefined || st.toks[i + 1]?.t === 'lp') continue;
    const prev = code(st.toks.slice(0, i)).pop();
    if (prev !== undefined && (st.toks[prev].s === '.' || st.toks[prev].t === 'num' || st.toks[prev].t === 'str' || isWord(st.toks[prev], 'interval'))) continue;
    edits.push([i, i + 1, quote(to)]);
  }
}

const UNITS = ['minute', 'hour', 'day'] as const;
type Unit = typeof UNITS[number];
const UNIT_OF: Record<string, Unit> = { minute: 'minute', minutes: 'minute', hour: 'hour', hours: 'hour', day: 'day', days: 'day' };

/** The time bucket in the first select item: `date_trunc('unit', col)` or `time_bucket(INTERVAL …, col)`. */
function bucket(st: Statement): { unit: Unit; count: number; edits: (to: Unit) => Array<[number, number, string]> } | null {
  const [first] = selectItems(st) ?? [];
  if (!first) return null;
  const c = code(st.toks.slice(first.range[0], first.range[1])).map(i => i + first.range[0]);
  const fn = st.toks[c[0]];
  if (fn?.t !== 'word' || st.toks[c[1]]?.t !== 'lp') return null;
  const name = fn.s.toLowerCase();
  // The call's tokens: fn ( … ) — find the matching ')'.
  let close = -1;
  for (let k = 2; k < c.length; k++) if (st.toks[c[k]].t === 'rp' && st.toks[c[k]].depth === fn.depth) { close = k; break; }
  if (close < 0) return null;
  const inner = c.slice(2, close);
  const callText = render(st.toks.slice(c[0], c[close] + 1)).replace(/\s+/g, ' ').toLowerCase();
  // Same call elsewhere (GROUP BY / ORDER BY spelled out): edit it too.
  const occurrences = (): number[] => {
    const at: number[] = [];
    st.toks.forEach((tok, i) => {
      if (tok.t !== 'word' || tok.s.toLowerCase() !== name || st.toks[i + 1]?.t !== 'lp') return;
      let j = i + 1; while (j < st.toks.length && !(st.toks[j].t === 'rp' && st.toks[j].depth === tok.depth)) j++;
      if (render(st.toks.slice(i, j + 1)).replace(/\s+/g, ' ').toLowerCase() === callText) at.push(i);
    });
    return at;
  };
  if (name === 'date_trunc') {
    const unitTok = st.toks[inner[0]];
    if (unitTok?.t !== 'str') return null;
    const unit = UNIT_OF[unitTok.s.slice(1, -1).toLowerCase()];
    if (!unit) return null;
    const offset = inner[0] - c[0];
    return { unit, count: 1, edits: to => occurrences().map(i => [i + offset, i + offset + 1, `'${to}'`] as [number, number, string]) };
  }
  if (name === 'time_bucket') {
    // INTERVAL '1 hour' | INTERVAL 1 HOUR | INTERVAL '1' HOUR
    if (!isWord(st.toks[inner[0]], 'interval')) return null;
    let end = 1;
    while (end < inner.length && st.toks[inner[end]].t !== 'comma') end++;
    const spec = inner.slice(1, end).map(i => st.toks[i].s.replace(/'/g, '')).join(' ').trim().toLowerCase();
    const m = /^(\d+)\s*([a-z]+)$/.exec(spec);
    if (!m || !UNIT_OF[m[2]]) return null;
    const unit = UNIT_OF[m[2]], count = Number(m[1]);
    const from = inner[0] - c[0], to = inner[end - 1] - c[0] + 1;
    return { unit, count, edits: target => occurrences().map(i => [i + from, i + to, `INTERVAL '1 ${target}'`] as [number, number, string]) };
  }
  return null;
}

function bucketSwap(st: Statement, base: string, spanHours: number | null): Suggestion | null {
  // Only aggregated time series: on raw rows a new bucket relabels rows instead of regrouping them.
  if (!st.clauses.has('group')) return null;
  const b = bucket(st);
  if (!b) return null;
  // Coarser if the result would stay ≥ ~8 points, else finer; minute only for spans ≤ 2 days.
  let to: Unit | null;
  if (b.unit === 'day') to = 'hour';
  else if (b.unit === 'hour') to = spanHours === null || spanHours >= 8 * 24 ? 'day' : spanHours <= 48 ? 'minute' : 'day';
  else to = 'hour';
  if (b.unit === to && b.count === 1) return null;
  const edits = b.edits(to);
  if (!edits.length) return null;
  // An alias naming the old unit (AS hour) follows.
  const first = selectItems(st)![0];
  if (first.alias && UNIT_OF[first.alias.toLowerCase()]) renameIdents(st, new Map([[first.alias.toLowerCase(), to]]), edits);
  const label = `per ${to}`;
  return { kind: 'bucket', label, question: `${base}, ${label} instead`, sql: edit(st.toks, edits) };
}

function windowed(st: Statement, base: string, table: Table): Suggestion | null {
  const time = table.columns.find(c => isTime(c) && c.max !== undefined);
  if (!time) return null;
  const max = timestampLiteral(time.max as string), min = timestampLiteral(time.min as string);
  if (!max) return null;
  const spanHours = min ? (Date.parse(max.replace(' ', 'T') + 'Z') - Date.parse(min.replace(' ', 'T') + 'Z')) / 3_600_000 : null;
  if (spanHours !== null && spanHours <= 48) return null; // the window would not change much
  const where = st.clauses.get('where');
  // Already filtered on time: the window is part of the question; don't stack another.
  const col = time.name.toLowerCase();
  if (where && st.toks.slice(where.body, where.end).some(t => (t.t === 'word' || t.t === 'qident') && identName(t).toLowerCase() === col)) return null;
  const [n, unit, label] = spanHours !== null && spanHours > 24 * 30 ? [7, 'days', 'last 7 days'] : [24, 'hours', 'last 24 hours'];
  const predicate = `${quote(time.name)} >= TIMESTAMP '${max}' - INTERVAL '${n} ${unit}'`;
  let sql: string;
  if (where) {
    sql = edit(st.toks, [[where.body, where.body, ` (`], [where.end, where.end, `) AND ${predicate}`]]);
  } else {
    const at = st.clauses.get('from')!.end;
    sql = edit(st.toks, [[at, at, ` WHERE ${predicate}`]]);
  }
  return { kind: 'window', label, question: `${base}, ${label}`, sql };
}

function split(st: Statement, base: string, table: Table): Suggestion | null {
  const refs = referenced(st);
  const candidates = table.columns.filter(c => isText(c) && c.values?.length && c.values.length >= 2 && c.values.length <= 12 && !refs.has(c.name.toLowerCase()));
  if (!candidates.length) return null;
  // Already split (or categorised) by some text column in the select list: no second split.
  const selected = new Set(selectItems(st)?.flatMap(item => st.toks.slice(item.range[0], item.range[1]).filter(t => t.t === 'word' || t.t === 'qident').map(t => identName(t).toLowerCase())) ?? []);
  if (table.columns.some(c => isText(c) && selected.has(c.name.toLowerCase()))) return null;
  if (st.toks.some(t => isWord(t, 'over')) || st.clauses.has('limit') || st.clauses.has('qualify')) return null;
  const col = candidates.sort((a, b) => (a.values!.length - b.values!.length))[0];
  const sel = selectItems(st);
  if (!sel?.length) return null;
  const group = st.clauses.get('group');
  const ref = quote(col.name);
  const edits: Array<[number, number, string]> = [];
  const hasAgg = st.toks.some((t, i) => t.t === 'word' && /^(avg|mean|min|max|sum|count|median|stddev|stddev_samp|stddev_pop|variance|quantile_cont|quantile|first|last|arg_max|arg_min|any_value)$/i.test(t.s) && st.toks[i + 1]?.t === 'lp');
  if (!hasAgg) return null; // raw rows: a split adds nothing exact
  if (group) {
    const groupBody = render(st.toks.slice(group.body, group.end)).trim().toLowerCase();
    // Insert as the series column after the x column.
    const firstEnd = code(st.toks.slice(sel[0].range[0], sel[0].range[1])).pop()! + sel[0].range[0] + 1;
    edits.push([firstEnd, firstEnd, `, ${ref}`]);
    if (groupBody !== 'all') edits.push([group.end, group.end, `, ${ref}`]);
    // Positional references ≥ 2 shift by one (GROUP BY / ORDER BY items that are a bare number).
    for (const name of ['group', 'order'] as const) {
      const clause = st.clauses.get(name);
      if (!clause) continue;
      for (const [a, b] of items(st, clause)) {
        const c = code(st.toks.slice(a, b)).map(i => i + a);
        const tok = st.toks[c[0]];
        if (tok.t === 'num' && /^\d+$/.test(tok.s) && Number(tok.s) >= 2) edits.push([c[0], c[0] + 1, String(Number(tok.s) + 1)]);
      }
    }
    if (st.clauses.get('order')) {
      const order = st.clauses.get('order')!;
      // Keep series rows ordered within x for line rendering.
      const orderItems = items(st, order);
      if (orderItems.length === 1) edits.push([order.end, order.end, `, ${ref}`]);
    }
  } else {
    // A scalar aggregate (every item aggregates): becomes one bar per value.
    edits.push([sel[0].range[0], sel[0].range[0], ` ${ref}, `]);
    const tail = st.clauses.get('having') ?? st.clauses.get('qualify') ?? st.clauses.get('window') ?? st.clauses.get('order') ?? st.clauses.get('limit');
    if (tail) return null; // ORDER/LIMIT on a scalar: unusual, skip
    const end = code(st.toks).pop()! + 1;
    edits.push([end, end, ` GROUP BY ${ref} ORDER BY ${ref}`]);
  }
  const label = `by ${col.name}`;
  return { kind: 'split', label, question: `${base}, split ${label}`, sql: edit(st.toks, edits).trim() };
}

function viewVariant(st: Statement, sql: string, base: string, table: Table | undefined): Suggestion | null {
  const sel = selectItems(st);
  if (!sel || /\b(heatmap|table)\b/i.test(base)) return null;
  const body = sql.replace(/^\s*--\s*view\s*:[^\n]*\n/i, '');
  const refs = referenced(st);
  const hasSeries = table?.columns.some(c => isText(c) && refs.has(c.name.toLowerCase())) ?? false;
  const timeSeries = bucket(st) !== null;
  if (timeSeries && hasSeries && sel.length >= 3) {
    return { kind: 'view', label: 'as heatmap', question: `${base}, as a heatmap`, sql: `-- view: heatmap\n${body}` };
  }
  return { kind: 'view', label: 'as table', question: `${base}, as a table`, sql: `-- view: table\n${body}` };
}

/** Up to `max` follow-ups for the result of `question` → `sql`. */
export function suggest(question: string, sql: string, context: DatasetContext | null, max = 4): Suggestion[] {
  const base = question.trim().replace(/[\s,.;:!?]+$/, '');
  if (!base || !sql.trim()) return [];
  const st = parse(sql);
  if (!st) return [];
  const table = context ? fromTable(st, context) : undefined;
  // An alias that shadows a column (`time_bucket(…) AS ts … GROUP BY ts`) groups by the column,
  // not the alias: the statement does not mean what it reads like, so no structural variant.
  const group = st.clauses.get('group');
  const grouped = new Set(group ? st.toks.slice(group.body, group.end).filter(t => t.t === 'word' || t.t === 'qident').map(t => identName(t).toLowerCase()) : []);
  const shadowed = table !== undefined && (selectItems(st) ?? []).some(item => item.alias && grouped.has(item.alias.toLowerCase())
    && table.columns.some(c => c.name.toLowerCase() === item.alias!.toLowerCase())
    && item.text.replace(/\s+as\s+\S+$/i, '').trim().toLowerCase() !== item.alias!.toLowerCase());
  if (shadowed) return [];
  const time = table?.columns.find(c => isTime(c) && c.max !== undefined);
  const max_ = timestampLiteral(time?.max as string), min_ = timestampLiteral(time?.min as string);
  const span = max_ && min_ ? (Date.parse(max_.replace(' ', 'T') + 'Z') - Date.parse(min_.replace(' ', 'T') + 'Z')) / 3_600_000 : null;
  const out: Suggestion[] = [];
  const add = (s: Suggestion | null) => { if (s && s.sql.trim() !== sql.trim() && !out.some(o => o.sql === s.sql)) out.push(s); };
  const attempt = (fn: () => Suggestion | null) => { try { add(fn()); } catch { /* an unexpected shape: no variant */ } };
  if (table) attempt(() => split(st, base, table));
  attempt(() => bucketSwap(st, base, span));
  if (table) attempt(() => windowed(st, base, table));
  attempt(() => aggSwap(st, base));
  attempt(() => viewVariant(st, sql, base, table));
  return out.slice(0, max);
}
