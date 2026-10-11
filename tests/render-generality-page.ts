/** tests/render-generality.html: real query results of the public datasets (exported by
 * `node scripts/eval-sql.mjs --export-arrow …`) through the Rust/Wasm renderer, with automatic
 * view choice (or the SQL's `-- view:` hint, as the coordinator would pass it). Results in
 * `window.__generality` for tests/render_generality.py. `?file=<url of the export>&backend=…`. */
import { tableFromIPC, type RecordBatch } from 'apache-arrow';
import type { EngineToUi, LocalFrame, ViewName } from '../src/engine/contracts';
import { createRenderer } from '../src/engine/render';
import type { BackendKind } from '../src/engine/render/backend';
import { header, Kind, Stage, type Frame } from '../src/protocol/frame';

const grid = document.getElementById('grid')!;
const params = new URLSearchParams(location.search);
const frameTick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };

interface Item { id: string; origin: string; question: string; sql: string; hint: string | null; rows: number; ipc: string }

async function main(): Promise<void> {
  const backend = (params.get('backend') ?? 'webgpu') as BackendKind;
  const exported = await (await fetch(params.get('file')!)).json() as { dataset: string; items: Item[] };
  const frames: Frame[] = [], ui: EngineToUi[] = [];
  const renderer = await createRenderer(f => frames.push(f as Frame), m => ui.push(m), { backend });
  const results: Array<Record<string, unknown>> = [];
  let request = 1;
  for (const [i, item] of exported.items.entries()) {
    const slot = i + 1;
    const figure = document.createElement('figure');
    figure.innerHTML = `<figcaption></figcaption><canvas></canvas>`;
    figure.querySelector('figcaption')!.textContent = `${item.id} · ${item.origin}`;
    grid.append(figure);
    const canvas = figure.querySelector('canvas')!;
    renderer.attach(slot, canvas.transferControlToOffscreen(), { width: 320, height: 180, devicePixelRatio: 1 });
    const hint = item.hint && ['line', 'bar', 'scatter', 'table', 'heatmap', 'surface', 'map', 'density', 'tracks', 'seasons'].includes(item.hint) ? item.hint as ViewName : null;
    renderer.setView(slot, hint);
    const bytes = Uint8Array.from(atob(item.ipc), c => c.charCodeAt(0));
    const batches: RecordBatch[] = tableFromIPC(bytes).batches;
    const r = request++;
    const send = (frame: LocalFrame) => renderer.handle(frame);
    send({ ...header(Kind.BIND, { request: r, revision: r, epoch: 0 }), stamps: [], payload: u32(slot) });
    send({ ...header(Kind.RESULT_SCHEMA, { request: r }), stamps: [], payload: batches[0].schema });
    for (const b of batches) send({ ...header(Kind.BATCH, { request: r }), stamps: [], payload: b });
    send({ ...header(Kind.DONE, { request: r }), stamps: [], payload: new Uint8Array(16) });
    await frameTick();
    renderer.detach(slot);
    canvas.remove();
    const views = ui.filter(m => m.type === 'views' && m.slot === slot) as Array<Extract<EngineToUi, { type: 'views' }>>;
    const last = views.at(-1);
    results.push({
      id: item.id, origin: item.origin, question: item.question, sql: item.sql, hint, rows: item.rows,
      chosen: last?.chosen ?? null, available: last?.available ?? [],
      roles: (last?.columns ?? []).map(c => `${c.name}:${c.role || '-'}`),
      drawn: frames.some(f => f.kind === Kind.DRAWN && f.request === r && f.stamps.some(s => s.stage === Stage.FIRST_DRAW_SUBMITTED)),
    });
  }
  (window as unknown as { __generality: unknown }).__generality = { dataset: exported.dataset, backend: renderer.backend.kind, results };
}

main().catch(error => { (window as unknown as { __error: string }).__error = String(error?.stack ?? error); });
