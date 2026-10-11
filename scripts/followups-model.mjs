#!/usr/bin/env node
/**
 * Experiment: model-generated follow-up questions vs the deterministic variants (src/ui/suggest.ts).
 * For N corpus questions, one OpenRouter call per question with the production system prompt
 * (same cacheable prefix as translation) plus the shown question and SQL, asking for four
 * follow-ups as JSON lines {label, question, sql}. Every returned SQL is executed on the generated
 * `vessels` fixture. Reports latency, tokens, provider-reported cost, validity, and how many
 * proposals the deterministic generator would also have made (same result).
 *
 *   OPENROUTER_API_KEY=… node scripts/followups-model.mjs [--n 15] [--model openai/gpt-oss-120b] [--json out.json]
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
const prompt = await load('src/inference-node/prompt.ts');
const { suggest } = await load('src/ui/suggest.ts');
const keepAlive = setInterval(() => {}, 1000);
const db = await lib.openDatabase();
const corpus = JSON.parse(readFileSync(resolve(root, 'evals/sql-corpus.json'), 'utf8'));
const n = Number(option('--n', '15')), model = option('--model', 'openai/gpt-oss-120b');

const INSTRUCTION = (question, sql) =>
  `The user asked: ${question}\nThe SQL shown:\n${sql}\n\n` +
  'Propose the 4 follow-up questions this user is most likely to ask next about this result. ' +
  'Reply with exactly 4 lines, each one JSON object {"label": "<2-4 words>", "question": "<the full follow-up question>", "sql": "<one SQL query answering it>"}. No other text.';

const cases = corpus.cases.filter((_, i) => i % Math.max(1, Math.floor(corpus.cases.length / n)) === 0).slice(0, n);
const rows = [];
let cost = 0;
for (const c of cases) {
  const sql = lib.references(c, corpus.now)[0];
  const base = await db.run(sql);
  if (!base.ok) continue;
  const t0 = performance.now();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model, temperature: 0, max_tokens: 1200, usage: { include: true },
      reasoning: { effort: 'low' }, provider: { order: ['groq'], require_parameters: true },
      messages: [{ role: 'system', content: prompt.systemPrompt(db.context) }, { role: 'user', content: INSTRUCTION(c.question, sql) }],
    }),
  });
  const body = await response.json();
  const ms = performance.now() - t0; // whole reply (not streamed): chips need the complete JSON lines
  const text = body.choices?.[0]?.message?.content ?? '';
  const usage = body.usage ?? {};
  cost += usage.cost ?? 0;
  const proposals = [];
  for (const line of text.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'))) {
    try { proposals.push(JSON.parse(line)); } catch { proposals.push({ invalidJson: line.slice(0, 120) }); }
  }
  const deterministic = suggest(c.question, sql, db.context, 4);
  const detResults = [];
  for (const d of deterministic) { const r = await db.run(d.sql); detResults.push(r.ok ? JSON.stringify(r.rows) : null); }
  for (const p of proposals) {
    if (!p.sql) { p.ok = false; continue; }
    const r = await db.run(p.sql);
    p.ok = r.ok; p.error = r.ok ? undefined : r.code; p.rows = r.ok ? r.rows.length : undefined;
    p.sameAsDeterministic = r.ok && detResults.includes(JSON.stringify(r.rows));
  }
  rows.push({ id: c.id, question: c.question, ms: Math.round(ms), status: response.status, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens, costUsd: usage.cost, proposals, deterministic: deterministic.map(d => d.label) });
  console.error(`${c.id}: ${Math.round(ms)} ms, ${proposals.filter(p => p.ok).length}/${proposals.length} valid, $${(usage.cost ?? 0).toFixed(6)}`);
}
clearInterval(keepAlive);
db.dispose();
const ms = rows.map(r => r.ms).sort((a, b) => a - b), q = f => ms[Math.min(ms.length - 1, Math.round(f * (ms.length - 1)))];
const all = rows.flatMap(r => r.proposals);
const summary = {
  model, calls: rows.length, latencyMs: { p50: q(0.5), p95: q(0.95) }, costUsd: +cost.toFixed(6), costPerCallUsd: +(cost / rows.length).toFixed(7),
  proposals: all.length, valid: all.filter(p => p.ok).length, sameResultAsADeterministicVariant: all.filter(p => p.sameAsDeterministic).length,
  promptTokensMean: Math.round(rows.reduce((a, r) => a + (r.promptTokens ?? 0), 0) / rows.length),
  completionTokensMean: Math.round(rows.reduce((a, r) => a + (r.completionTokens ?? 0), 0) / rows.length),
};
console.log(JSON.stringify(summary, null, 1));
const out = option('--json');
if (out) writeFileSync(resolve(root, out), JSON.stringify({ date: new Date().toISOString(), summary, rows }, null, 1));
