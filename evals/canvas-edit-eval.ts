/** Executed-result checks for the persistent canvas EDIT_CONTEXT / EDIT_INFER path. */
import { CanvasModel } from '../src/canvas/model';
import { editBase, prepareEdit } from '../src/canvas/protocol';
import { EDIT_CAPABILITY, type EditBase } from '../src/protocol/edit';
import { decode, encode, header, json, Kind, readJson, readText, Stage, SUBPROTOCOL, text, type Frame } from '../src/protocol/frame';
import { compareResults, viewHint, type Database, type QueryResult, type Translation, type Verdict } from './sql-eval';

interface Counterexample { label: string; sql: string }
export interface CanvasEditCase {
  id: string; dataset: 'weather' | 'cities' | 'vessels' | 'flights'; base: EditBase; request: string; reference: string;
  counterexamples: Counterexample[];
  expectedView?: string;
  /** Execute a known-invalid attempted edit and send its real database error with the request. */
  repairSql?: string;
}
const base = (question: string, sql: string, changes: string[] = [], mode: EditBase['mode'] = 'refine'): EditBase => ({
  mode, originalQuestion: question, sql,
  history: [{ kind: 'create', text: question }, ...changes.map(text => ({ kind: 'refine', text }))],
  presentation: { view: 'line', params: {} },
});
const berlin = "city = 'Berlin' AND time >= TIMESTAMP '2024-01-01' AND time < TIMESTAMP '2025-01-01'";
const daily = (metric: string, filter = berlin) => `SELECT date_trunc('day', time) AS day, ${metric}(temperature) AS temperature FROM weather WHERE ${filter} GROUP BY 1 ORDER BY 1`;
const monthly = (filter = berlin) => `SELECT date_trunc('month', time) AS month, avg(temperature) AS temperature FROM weather WHERE ${filter} GROUP BY 1 ORDER BY 1`;
const population = (metric: string, continent = 'Europe', threshold = true) =>
  `SELECT k.name AS country, ${metric}(c.population) AS population FROM cities c JOIN countries k ON c.country_code = k.code WHERE k.continent = '${continent}'${threshold ? ' AND c.population > 100000' : ''} GROUP BY k.name ORDER BY k.name`;
const top = (continent: string, limit: number) => `SELECT c.name, c.population FROM cities c JOIN countries k ON c.country_code = k.code WHERE k.continent = '${continent}' ORDER BY c.population DESC, c.name LIMIT ${limit}`;

/** Exercise the real document lineage extractor, with a retained future on another branch. */
function selectedBranch(): EditBase {
  const model = CanvasModel.create('Branch context evaluation');
  model.addSource({ id: 'source', name: 'weather', locator: { kind: 'fixture', name: 'weather' }, policy: 'current', tables: [] });
  const question = 'Daily average temperature in Berlin during 2024';
  let chartId: string | undefined;
  const commit = (request: string, sql: string) => {
    const { draft } = model.startDraft({ ...(chartId ? { chartId } : { sourceRefId: 'source' }), text: request });
    model.recordSql(draft.id, draft.sequence, sql); model.outcome(draft.id, draft.sequence, sql, 'succeeded'); model.finishDraft(draft.id);
    chartId = draft.chartId;
  };
  commit(question, daily('avg'));
  commit('Only include hours above freezing.', daily('avg', `${berlin} AND temperature > 0`));
  commit('Remove the above-freezing restriction; include all temperatures again.', daily('avg'));
  const selected = model.selected(chartId!)!.id;
  model.undo();
  commit('Use London instead of Berlin.', daily('avg', berlin.replace('Berlin', 'London')));
  model.restoreChart(chartId!, selected);
  const draft = model.startDraft({ chartId, text: 'Use monthly buckets instead.' }).draft;
  const result = editBase(model, draft)!;
  if (result.history.some(h => h.text.includes('London'))) throw new Error('Abandoned branch leaked into edit context');
  return result;
}

export function canvasEditCases(): CanvasEditCase[] {
  const question = 'Daily average temperature in Berlin during 2024';
  const limited = `${berlin} AND temperature < 0`;
  const july = "city = 'Berlin' AND time >= TIMESTAMP '2024-07-01' AND time < TIMESTAMP '2024-08-01'";
  const brushWindow = "ts >= TIMESTAMP '2026-09-10 06:00:00' AND ts < TIMESTAMP '2026-09-10 12:00:00'";
  const brushFilter = `vessel = 'Aurora' AND ${brushWindow}`;
  const vesselWind = (minutes: number, filter = brushFilter) => `SELECT time_bucket(INTERVAL '${minutes} minutes', ts) AS bucket, vessel, avg(wind) AS wind FROM telemetry WHERE ${filter} GROUP BY 1, 2 ORDER BY 1, 2`;
  const gestureBase = base('Hourly average wind for each vessel', vesselWind(60));
  gestureBase.history.push({ kind: 'gesture', text: 'Keep Aurora in the brushed time interval.', details: brushFilter });
  const flightFilter = "f.origin = 'JFK' AND f.flight_date >= DATE '2024-06-24' AND NOT f.cancelled AND f.dep_delay > 0";
  const carrierDelay = `SELECT c.name AS airline, avg(f.dep_delay) AS delay FROM flights f JOIN carriers c ON f.carrier = c.code WHERE ${flightFilter} GROUP BY c.name ORDER BY c.name`;
  const destinationDelay = (filter = flightFilter) => `SELECT a.name AS airport, avg(f.dep_delay) AS delay FROM flights f JOIN airports a ON f.dest = a.code WHERE ${filter} GROUP BY a.name ORDER BY a.name`;
  const flightBase = base('Average departure delay by airline for non-cancelled flights from JFK since June 24, 2024', carrierDelay);
  flightBase.history.push({ kind: 'gesture', text: 'Keep only departures delayed more than zero minutes.', details: 'f.dep_delay > 0' });
  return [
    { id: 'preserve_sql_filter_and_bucket', dataset: 'weather',
      base: base(question, daily('avg', limited), ['Only include below-freezing hours.']), request: 'Use the maximum instead of the average.', reference: daily('max', limited),
      counterexamples: [{ label: 'drops selected SQL filter', sql: daily('max') }, { label: 'keeps old aggregate', sql: daily('avg', limited) }] },
    { id: 'selected_branch_removal', dataset: 'weather', base: selectedBranch(), request: 'Use monthly buckets instead of daily buckets.', reference: monthly(),
      counterexamples: [{ label: 'resurrects removed filter', sql: monthly(`${berlin} AND temperature > 0`) }, { label: 'uses retained London branch', sql: monthly(berlin.replace('Berlin', 'London')) }] },
    { id: 'regenerate_from_question_and_lineage', dataset: 'weather',
      base: base(question, "SELECT city, max(humidity) AS humidity FROM weather WHERE city = 'Madrid' GROUP BY city ORDER BY city", ['Restrict the time range to July 2024.'], 'regenerate'),
      request: 'Regenerate from the original question and selected revision history.', reference: daily('avg', july),
      counterexamples: [{ label: 'treats selected SQL drift as authoritative', sql: "SELECT city, max(humidity) AS humidity FROM weather WHERE city = 'Madrid' GROUP BY city ORDER BY city" }, { label: 'ignores selected lineage', sql: daily('avg') }] },
    { id: 'database_error_repair_keeps_context', dataset: 'weather', base: base(question, daily('avg', limited), ['Only include below-freezing hours.']),
      request: 'Use the maximum instead of the average.', reference: daily('max', limited), repairSql: daily('max', limited).replace('max(temperature)', 'max(temperature_celsius)'),
      counterexamples: [{ label: 'repair drops selected filter', sql: daily('max') }] },
    { id: 'guard_repair_alias', dataset: 'weather', base: base(question, daily('avg')),
      request: 'Use the maximum instead of the average. For the time bucket, use day as a bare alias, without AS and without quotes: date_trunc(\'day\', time) day.', reference: daily('max'),
      counterexamples: [{ label: 'repair forgets changed aggregate', sql: daily('avg') }, { label: 'bare day alias does not parse', sql: daily('max').replace('AS day', 'day') }] },
    { id: 'preserve_join_filter_grouping', dataset: 'cities', base: base('Total city population per country in Europe', population('sum'), ['Only include cities with more than 100,000 people.']),
      request: 'Change the total to an average.', reference: population('avg'),
      counterexamples: [{ label: 'drops population filter', sql: population('avg', 'Europe', false) }, { label: 'keeps total', sql: population('sum') },
        { label: 'drops country join', sql: "SELECT country_code, avg(population) AS population FROM cities WHERE population > 100000 GROUP BY country_code ORDER BY country_code" }] },
    { id: 'europe_limit_refinement', dataset: 'cities', base: base('Largest cities by population', top('Europe', 10), ['Only Europe.']),
      request: 'Only show five.', reference: top('Europe', 5),
      counterexamples: [{ label: 'drops selected region', sql: 'SELECT name, population FROM cities ORDER BY population DESC, name LIMIT 5' }, { label: 'keeps old limit', sql: top('Europe', 10) }] },
    { id: 'asia_same_request_cache_isolation', dataset: 'cities', base: base('Largest cities by population', top('Asia', 10), ['Only Asia.']),
      request: 'Only show five.', reference: top('Asia', 5),
      counterexamples: [{ label: 'replays Europe answer for same request', sql: top('Europe', 5) }, { label: 'keeps old limit', sql: top('Asia', 10) }] },
    { id: 'vessels_captured_gesture_regroup', dataset: 'vessels', base: gestureBase,
      request: 'Use 30-minute buckets instead of hourly buckets.', reference: vesselWind(30),
      counterexamples: [{ label: 'drops brushed time interval', sql: vesselWind(30, "vessel = 'Aurora'") },
        { label: 'drops selected vessel', sql: vesselWind(30, brushWindow) }, { label: 'keeps hourly grouping', sql: vesselWind(60) }] },
    { id: 'flights_regroup_preserves_gesture', dataset: 'flights', base: flightBase,
      request: 'Group by destination airport name instead of airline name.', reference: destinationDelay(),
      counterexamples: [{ label: 'drops positive-delay gesture', sql: destinationDelay(flightFilter.replace(' AND f.dep_delay > 0', '')) },
        { label: 'drops departure airport restriction', sql: destinationDelay(flightFilter.replace("f.origin = 'JFK' AND ", '')) },
        { label: 'keeps airline grouping', sql: carrierDelay }] },
    { id: 'flights_explicit_bar_preserves_definition', dataset: 'flights', base: flightBase,
      request: 'Show this as a bar chart without changing the data.', reference: `-- view: bar\n${carrierDelay}`, expectedView: 'bar',
      counterexamples: [{ label: 'omits explicit presentation change', sql: carrierDelay },
        { label: 'keeps previous line presentation', sql: `-- view: line\n${carrierDelay}` },
        { label: 'changes presentation but drops the gesture', sql: `-- view: bar\n${carrierDelay.replace(' AND f.dep_delay > 0', '')}` }] },
  ];
}

export interface EditTranslator {
  model?: string;
  translate(base: EditBase, request: string): Promise<Translation>;
  close(): void;
}

/** Real backend protocol with one immutable target generation per request. No provider keys here. */
export async function openEditTranslator(url: string, context: Uint8Array, timeoutMs = 45_000): Promise<EditTranslator> {
  const socket = new WebSocket(url, SUBPROTOCOL); socket.binaryType = 'arraybuffer';
  let listener: ((frame: Frame) => void) | undefined, disconnected: (() => void) | undefined;
  socket.addEventListener('message', event => { if (event.data instanceof ArrayBuffer) listener?.(decode(new Uint8Array(event.data))); });
  socket.addEventListener('close', () => disconnected?.());
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Timed out connecting to inference')); }, 10_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inference WebSocket connection failed')); }, { once: true });
  });
  const send = (frame: Frame) => socket.send(encode(frame));
  let ready: { model?: string; capabilities?: string[] };
  try {
    ready = await new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: typeof ready) => { clearTimeout(timer); listener = undefined; disconnected = undefined; if (error) reject(error); else resolve(value!); };
      const timer = setTimeout(() => finish(new Error('Inference did not send READY')), 10_000);
      disconnected = () => finish(new Error('Inference disconnected before READY'));
      listener = frame => {
        if (frame.kind === Kind.READY) finish(undefined, readJson(frame.payload));
        else if (frame.kind === Kind.ERROR) finish(new Error(readText(frame.payload)));
      };
      send({ ...header(Kind.HELLO), stamps: [], payload: json({ node: 'coordinator', name: 'canvas-edit-eval', version: 1 }) });
    });
    if (!ready.capabilities?.includes(EDIT_CAPABILITY)) throw new Error('Backend lacks edit-context-v1; run the changed backend, not the deployed older service');
  } catch (error) { socket.close(); throw error; }
  send({ ...header(Kind.CONTEXT, { context: 1 }), stamps: [], payload: context });
  let requestId = 0;
  return {
    model: ready.model,
    translate(base, request) {
      const id = ++requestId, generation = id, slot = 1;
      return new Promise<Translation>(resolve => {
        const out: Translation = {}, started = performance.now();
        let grace: ReturnType<typeof setTimeout> | undefined, done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); clearTimeout(grace); listener = undefined; disconnected = undefined; resolve(out); };
        const timer = setTimeout(() => { out.error = { code: 'client_timeout', message: `No result after ${timeoutMs} ms` }; finish(); }, timeoutMs);
        disconnected = () => { out.error = { code: 'disconnected', message: 'Inference disconnected' }; finish(); };
        listener = frame => {
          if (frame.request !== id && !(frame.request === 0 && frame.kind === Kind.ERROR)) return;
          if (frame.kind === Kind.SQL_DELTA) out.firstDeltaMs ??= performance.now() - started;
          else if (frame.kind === Kind.SQL) {
            out.sql = readText(frame.payload); out.sqlMs = performance.now() - started; out.cached = (frame.flags & 1) !== 0;
            const at = (stage: number) => frame.stamps.find(s => s.stage === stage)?.at;
            const sent = at(Stage.PROVIDER_REQUEST), first = at(Stage.FIRST_TOKEN);
            if (sent !== undefined && first !== undefined) out.providerFirstTokenMs = first - sent;
            if (out.cached) finish();
          } else if (frame.kind === Kind.INFER_STATS) { out.stats = readJson(frame.payload); finish(); }
          else if (frame.kind === Kind.ERROR) { out.error = readJson(frame.payload); grace = setTimeout(finish, 3000); }
        };
        socket.send(prepareEdit({ slot, generation }, 1, base));
        const body = text(request), payload = new Uint8Array(8 + body.byteLength), view = new DataView(payload.buffer);
        view.setUint32(0, slot, true); view.setUint32(4, generation, true); payload.set(body, 8);
        send({ ...header(Kind.EDIT_INFER, { request: id, revision: id, context: 1 }), stamps: [], payload });
      });
    },
    close() { socket.close(); },
  };
}

const correct = (verdict: Verdict) => verdict.category === 'exact' || verdict.category === 'equivalent';
function score(reference: QueryResult, result: QueryResult): Verdict {
  if (!reference.ok) throw new Error(`Invalid reference: ${reference.message}`);
  return result.ok ? compareResults(reference, result, true) : { category: 'sql-error', reason: result.message };
}
function scoreCase(c: CanvasEditCase, reference: QueryResult, sql: string, result: QueryResult): Verdict {
  const verdict = score(reference, result);
  if (correct(verdict) && c.expectedView && viewHint(sql) !== c.expectedView) {
    return { category: 'shape-violation', reason: `Expected explicit ${c.expectedView} view, got ${viewHint(sql) ?? 'no hint'}` };
  }
  return verdict;
}
export async function selfTestCase(c: CanvasEditCase, database: Database): Promise<{ id: string; checks: number }> {
  const reference = await database.run(c.reference);
  if (!reference.ok || !reference.rows.length) throw new Error(`${c.id}: reference must return rows`);
  if (!correct(scoreCase(c, reference, c.reference, await database.run(c.reference)))) throw new Error(`${c.id}: correct SQL rejected`);
  for (const wrong of c.counterexamples) if (correct(scoreCase(c, reference, wrong.sql, await database.run(wrong.sql)))) throw new Error(`${c.id}: scorer accepted ${wrong.label}`);
  if (c.repairSql && (await database.run(c.repairSql)).ok) throw new Error(`${c.id}: expected an actual database error`);
  return { id: c.id, checks: 1 + c.counterexamples.length + (c.repairSql ? 1 : 0) };
}
export async function evaluateCase(c: CanvasEditCase, database: Database, translator: EditTranslator) {
  const reference = await database.run(c.reference);
  if (!reference.ok || !reference.rows.length) throw new Error(`${c.id}: invalid or empty reference`);
  let request = c.request, repairError: string | undefined;
  if (c.repairSql) {
    const failed = await database.run(c.repairSql);
    if (failed.ok) throw new Error(`${c.id}: repair seed unexpectedly executed`);
    repairError = failed.message;
    request += `\nAn attempted edit failed. Fix the SQL for this change, preserving the selected chart context.\nFailed SQL:\n${c.repairSql}\nDatabase error:\n${failed.message}`;
  }
  const translation = await translator.translate(c.base, request);
  const result = translation.sql ? await database.run(translation.sql) : undefined;
  const verdict = result ? scoreCase(c, reference, translation.sql!, result) : { category: 'sql-error' as const, reason: translation.error?.message ?? 'No SQL returned' };
  return { id: c.id, dataset: c.dataset, base: c.base, request, reference: c.reference, repairError,
    ...translation, ...verdict, correct: correct(verdict), expectedRows: reference.rows.length,
    expectedView: c.expectedView, returnedView: translation.sql ? viewHint(translation.sql) : undefined,
    resultRows: result?.ok ? result.rows.length : undefined, executionMs: result?.ms,
    automaticRepairObserved: (translation.stats?.attempts ?? 0) > 1 };
}
