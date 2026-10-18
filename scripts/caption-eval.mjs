#!/usr/bin/env node
/**
 * Experiment (plan-captions.md, phase 1): caption quality, cost and latency per model.
 *
 * Cases, all with known-correct SQL:
 *   create  — corpus questions with their reference SQL (n per dataset)
 *   refine  — canvas edit cases: caption the base, then the refined SQL with previousTitle + change
 *   sql     — the refined SQL as a manual SQL edit: stale question, change "Edited the SQL";
 *             the title must follow the SQL, not the question
 * Variants: the compact caption prompt (src/inference-node/caption.ts) on each --models entry,
 * and option B (translation prompt + "title after the SQL") on the translation model for create
 * cases, which also checks that the SQL stays correct and counts the extra output tokens.
 * A judge model (--judge) grades each caption blind to the variant.
 *
 *   OPENROUTER_API_KEY=… node scripts/caption-eval.mjs [--n 6] [--models a,b] [--judge m] [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY is not set'); process.exit(2); }
const load = path => runnerImport(resolve(root, path), { root, configFile: false, logLevel: 'error' }).then(r => r.module);
const lib = await load('evals/sql-eval.ts');
const edits = await load('evals/canvas-edit-eval.ts');
const prompt = await load('src/inference-node/prompt.ts');
const caption = await load('src/inference-node/caption.ts');
const keepAlive = setInterval(() => {}, 1000);

const n = Number(option('--n', '6'));
const models = option('--models', 'openai/gpt-oss-20b,openai/gpt-oss-120b,meta-llama/llama-3.1-8b-instruct,anthropic/claude-haiku-5.5').split(',');
const judge = option('--judge', 'anthropic/claude-sonnet-5.5');
const translationModel = 'openai/gpt-oss-120b';
const CORPORA = { vessels: 'sql-corpus.json', weather: 'sql-corpus-weather.json', cities: 'sql-corpus-cities.json', flights: 'sql-corpus-flights.json', 'flights-2024': 'sql-corpus-flights-2024.json', 'nyc-taxi': 'sql-corpus-nyc-taxi.json' };

const effortOf = variant => variant.split('@')[1];
const modelOf = variant => variant.split('@')[0];
const route = model => model.startsWith('openai/gpt-oss') || model.startsWith('meta-llama/') ? { provider: { order: ['groq'], allow_fallbacks: false } } : {};
const reasoning = variant => effortOf(variant) ? { reasoning: { effort: effortOf(variant) } } : modelOf(variant).startsWith('openai/gpt-oss') ? { reasoning: { effort: 'low' } } : {};
let spent = 0;
async function chat(model, messages, maxTokens = 600) {
  const t0 = performance.now();
  for (let attempt = 0; ; attempt++) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelOf(model), temperature: 0, max_tokens: maxTokens, usage: { include: true }, ...route(modelOf(model)), ...reasoning(model), messages }),
    });
    const body = await response.json().catch(() => ({}));
    if ((response.status === 429 || response.status >= 500) && attempt < 3) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
    const usage = body.usage ?? {};
    spent += usage.cost ?? 0;
    return { ms: Math.round(performance.now() - t0), status: response.status, text: body.choices?.[0]?.message?.content ?? '', error: body.error?.message,
      prompt: usage.prompt_tokens, completion: usage.completion_tokens, reasoning: usage.completion_tokens_details?.reasoning_tokens, cost: usage.cost ?? 0, provider: body.provider };
  }
}

const referenced = (context, sql) => caption.referencedTables(context.tables, sql);
const request = (context, sql, question, previousTitle, change) => caption.validateCaptionRequest({
  v: 1, sql, question, dialect: 'duckdb', tables: referenced(context, sql),
  ...(previousTitle ? { previousTitle } : {}), ...(change ? { change } : {}) });

async function describe(model, req) {
  const r = await chat(model, [{ role: 'system', content: caption.CAPTION_SYSTEM }, { role: 'user', content: caption.captionUserMessage(req) }]);
  return { ...r, caption: caption.parseCaption(r.text) };
}

const OPTION_B = '\n\nAfter the SQL, add one last line: -- title: <chart title for this result, at most 8 words>';
const sqlOf = text => text.replace(/^```(?:sql)?\s*/i, '').replace(/```\s*$/, '').split('\n').filter(l => !/^\s*--\s*title\s*:/i.test(l)).join('\n').trim();
const titleOf = text => /--\s*title\s*:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? null;

const cases = [];
const datasets = [...new Set([...Object.keys(CORPORA)])];
for (const dataset of datasets) {
  const db = await lib.openDatabase(dataset, { root, node: { rollups: false, compressed: false, resultCache: false } });
  const corpus = JSON.parse(readFileSync(resolve(root, 'evals', CORPORA[dataset]), 'utf8'));
  const step = Math.max(1, Math.floor(corpus.cases.length / n));
  const picked = corpus.cases.filter((_, i) => i % step === 0).slice(0, n);
  for (const c of picked) {
    const sql = lib.corpusReferences(corpus, c)[0];
    cases.push({ id: `${dataset}/${c.id}`, kind: 'create', dataset, question: c.question, sql, req: request(db.context, sql, c.question) });
    // Option B: the translation prompt plus a trailing title line; baseline without it.
    const system = prompt.systemPrompt(db.context);
    const [base, withTitle] = [await chat(translationModel, [{ role: 'system', content: system }, { role: 'user', content: c.question }], 2048),
      await chat(translationModel, [{ role: 'system', content: system }, { role: 'user', content: c.question + OPTION_B }], 2048)];
    const ref = await db.run(sql);
    const verdict = async text => { const r = await db.run(sqlOf(text)); return r.ok && ref.ok ? lib.compareResults(ref, r, c.ordered).category : r.ok ? 'ref-error' : 'sql-error'; };
    cases.at(-1).optionB = { baseline: { completion: base.completion, ms: base.ms, cost: base.cost, verdict: await verdict(base.text) },
      withTitle: { completion: withTitle.completion, ms: withTitle.ms, cost: withTitle.cost, verdict: await verdict(withTitle.text), title: titleOf(withTitle.text) } };
    console.error(`${dataset}/${c.id}: option B ${cases.at(-1).optionB.baseline.verdict} → ${cases.at(-1).optionB.withTitle.verdict}, +${(withTitle.completion ?? 0) - (base.completion ?? 0)} tokens`);
  }
  for (const e of edits.canvasEditCases().filter(e => e.dataset === dataset)) {
    const change = e.request;
    cases.push({ id: `${dataset}/${e.id}`, kind: 'refine', dataset, question: e.base.originalQuestion, baseSql: e.base.sql, sql: e.reference, change,
      baseReq: request(db.context, e.base.sql, e.base.originalQuestion), reqFor: prev => request(db.context, e.reference, e.base.originalQuestion, prev, change) });
    cases.push({ id: `${dataset}/${e.id}#sql`, kind: 'sql', dataset, question: e.base.originalQuestion, baseSql: e.base.sql, sql: e.reference, change: 'Edited the SQL',
      baseReq: request(db.context, e.base.sql, e.base.originalQuestion), reqFor: prev => request(db.context, e.reference, e.base.originalQuestion, prev, 'Edited the SQL') });
  }
  db.dispose();
}

const results = [];
for (const model of models) {
  for (const c of cases) {
    let previous;
    if (c.kind !== 'create') previous = await describe(model, c.baseReq);
    const req = c.kind === 'create' ? c.req : c.reqFor(previous?.caption?.title);
    const r = await describe(model, req);
    results.push({ variant: model, id: c.id, kind: c.kind, previousTitle: previous?.caption?.title, title: r.caption?.title ?? null, explanation: r.caption?.explanation ?? null,
      parsed: !!r.caption, raw: r.caption ? undefined : r.text.slice(0, 300), error: r.error, ms: r.ms, prompt: r.prompt, completion: r.completion, reasoning: r.reasoning, cost: r.cost, provider: r.provider });
    console.error(`${model} ${c.id}: ${r.ms} ms ${r.caption ? `“${r.caption.title}”` : `UNPARSED ${r.error ?? r.text.slice(0, 80)}`}`);
  }
}
for (const c of cases.filter(c => c.optionB?.withTitle.title)) {
  results.push({ variant: 'optionB/' + translationModel, id: c.id, kind: 'create', title: c.optionB.withTitle.title, explanation: null, parsed: true,
    completion: c.optionB.withTitle.completion - c.optionB.baseline.completion, ms: null, cost: c.optionB.withTitle.cost - c.optionB.baseline.cost });
}

const JUDGE = `You grade chart captions. A caption is a title (and maybe an explanation) generated for a chart that shows the result of the given SQL.
Grade against the SQL only; the user's question may be stale and is given only as context.
Scores: 2 = accurate and names the essentials (measure, grouping/bucket, key filters or limit); 1 = accurate but vague or missing one essential; 0 = wrong: states something the SQL does not do, or describes the question/previous chart instead of this SQL.
For a refinement, also say whether the title reflects what changed between the previous SQL and this SQL (yes/no; "n/a" when nothing visible changed).
Reply with one JSON object only: {"title": 0|1|2, "explanation": 0|1|2|null, "change": "yes"|"no"|"n/a"|null, "note": "<at most 15 words>"}`;
const byId = new Map(cases.map(c => [c.id, c]));
for (const r of results) {
  if (!r.parsed) { r.grade = { title: 0, explanation: r.explanation === null ? null : 0, change: null, note: 'unparsed' }; continue; }
  const c = byId.get(r.id);
  const body = [`Question (context only): ${c.question}`, ...(c.baseSql ? [`Previous SQL:\n${c.baseSql}`, `Change: ${c.change}`] : []), `SQL:\n${c.sql}`,
    `Title: ${r.title}`, `Explanation: ${r.explanation ?? '(none)'}`].join('\n\n');
  const g = await chat(judge, [{ role: 'system', content: JUDGE }, { role: 'user', content: body }], 300);
  try { r.grade = JSON.parse(/\{[\s\S]*\}/.exec(g.text)[0]); } catch { r.grade = { error: g.text.slice(0, 200) }; }
  r.judgeCost = g.cost;
}
clearInterval(keepAlive);

const q = (xs, f) => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.round(f * (s.length - 1)))] : null; };
const summary = {};
for (const variant of [...new Set(results.map(r => r.variant))]) {
  const rs = results.filter(r => r.variant === variant);
  const rate = (pred, xs = rs) => xs.length ? +(xs.filter(pred).length / xs.length).toFixed(3) : null;
  summary[variant] = {
    captions: rs.length, parsed: rate(r => r.parsed),
    titleScore2: rate(r => r.grade?.title === 2), titleWrong: rate(r => r.grade?.title === 0),
    explanationScore2: rate(r => r.grade?.explanation === 2, rs.filter(r => r.explanation)), explanationWrong: rate(r => r.grade?.explanation === 0, rs.filter(r => r.explanation)),
    changeReflected: rate(r => r.grade?.change === 'yes', rs.filter(r => r.kind !== 'create' && r.grade?.change !== 'n/a')),
    sqlEditFollowsSql: rate(r => r.grade?.title > 0, rs.filter(r => r.kind === 'sql')),
    latencyMs: { p50: q(rs.map(r => r.ms), .5), p95: q(rs.map(r => r.ms), .95) },
    costPerCaptionUsd: +(rs.reduce((s, r) => s + (r.cost ?? 0), 0) / rs.length).toFixed(7),
    completionTokens: { p50: q(rs.map(r => r.completion), .5) }, reasoningTokens: { p50: q(rs.map(r => r.reasoning), .5) },
  };
}
const b = cases.filter(c => c.optionB);
summary.optionBSql = { cases: b.length, baselineCorrect: b.filter(c => ['exact', 'equivalent'].includes(c.optionB.baseline.verdict)).length,
  withTitleCorrect: b.filter(c => ['exact', 'equivalent'].includes(c.optionB.withTitle.verdict)).length,
  titlePresent: b.filter(c => c.optionB.withTitle.title).length,
  extraCompletionTokens: { p50: q(b.map(c => c.optionB.withTitle.completion - c.optionB.baseline.completion), .5) } };
const report = { kind: 'timeblast.caption-eval', version: 1, date: new Date().toISOString(), judge, models, translationModel, promptVersion: caption.CAPTION_PROMPT_VERSION,
  measurement: 'Sequential, non-streamed OpenRouter calls from this host (ARM64, Hetzner); latency is request → whole reply, provider warmth unknown. Option B token deltas are whole-reply completion tokens (incl. reasoning), not a SQL-boundary timing.',
  spentUsd: +spent.toFixed(4), summary, cases: cases.map(({ req, baseReq, reqFor, ...c }) => c), results };
const out = option('--json');
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ spentUsd: report.spentUsd, summary }, null, 2));
