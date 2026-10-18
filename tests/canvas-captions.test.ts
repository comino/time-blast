import { describe, expect, it } from 'vitest';
import { CAPTION_BUDGET_PAUSE_MS, CaptionService, MemoryCaptionStore, type CaptionLinkFactory, type CaptionWork } from '../src/canvas/captions';
import { header, json, Kind, readJson, type Frame } from '../src/protocol/frame';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function setup(work: (revisionId: string) => CaptionWork = id => ({ kind: 'request', canvasId: 'c', chartId: 'k', revisionId: id, sql: `SELECT '${id}'`,
  payload: { v: 1, sql: `SELECT '${id}'`, question: '', dialect: 'duckdb', tables: [] } })) {
  const links: Array<{ sent: Frame[]; onFrame: (f: Frame) => void; onClose: (r: string) => void; closed: boolean }> = [];
  const factory: CaptionLinkFactory = (_endpoint, onFrame, onClose) => {
    const link = { sent: [] as Frame[], onFrame, onClose, closed: false }; links.push(link);
    return { send: f => { link.sent.push(f); }, close: () => { link.closed = true; } };
  };
  let now = 0;
  const shown: string[] = [];
  const store = new MemoryCaptionStore();
  const service = new CaptionService(store, item => work(item.revisionId), c => shown.push(`${c.revisionId}:${c.title}`), factory, () => now);
  service.setEndpoint('wss://x/session');
  const link = () => links.at(-1)!;
  const ready = () => link().onFrame({ ...header(Kind.READY), stamps: [], payload: json({ capabilities: ['describe-v1'] }) });
  const describes = () => links.flatMap(l => l.sent).filter(f => f.kind === Kind.DESCRIBE);
  const reply = (kind: number, body: object, request = describes().at(-1)!.request) => link().onFrame({ ...header(kind as Frame['kind'], { request }), stamps: [], payload: json(body) });
  return { service, links, link, ready, describes, reply, shown, store, advance: (ms: number) => { now += ms; } };
}

describe('caption service', () => {
  it('sends one request at a time, in order, and stores replies against the captured revision', async () => {
    const t = setup(); await t.service.load('c');
    t.service.want('c', ['r1', 'r2']); t.ready();
    expect(t.describes().map(f => readJson<{ sql: string }>(f.payload).sql)).toEqual(["SELECT 'r1'"]);
    t.reply(Kind.DESCRIPTION, { title: 'One', explanation: 'x' });
    expect(t.describes()).toHaveLength(2);
    t.reply(Kind.DESCRIPTION, { title: 'Two', explanation: 'y' });
    expect(t.shown).toEqual(['r1:One', 'r2:Two']);
    expect(t.service.get('r1', "SELECT 'r1'")?.title).toBe('One');
    expect(t.service.get('r1', 'SELECT other')).toBeUndefined();
    await flush();
    expect([...t.store.records.values()].map(c => c.title)).toEqual(['One', 'Two']);
  });

  it('retries an unanswered request after the link drops, and pauses after a quota refusal', async () => {
    const t = setup(); await t.service.load('c');
    t.service.want('c', ['r1']); t.ready();
    t.link().onClose('network');
    t.service.want('c', []);
    expect(t.links).toHaveLength(2);
    t.ready();
    expect(t.describes().map(f => readJson<{ sql: string }>(f.payload).sql)).toEqual(["SELECT 'r1'", "SELECT 'r1'"]);
    t.reply(Kind.ERROR, { code: 'budget', message: 'quota' });
    expect(t.link().closed).toBe(true);
    t.service.want('c', ['r2']);
    expect(t.links).toHaveLength(2);
    t.advance(CAPTION_BUDGET_PAUSE_MS);
    t.service.want('c', []);
    expect(t.links).toHaveLength(3);
  });

  it('never asks an endpoint without describe-v1 again, drops oversized payloads, and ignores late replies after a switch', async () => {
    const big = setup(id => ({ kind: 'request', canvasId: 'c', chartId: 'k', revisionId: id, sql: 'x', payload: { v: 1, sql: 'x'.repeat(20000), question: '', dialect: 'duckdb', tables: [] } }));
    await big.service.load('c'); big.service.want('c', ['r1']);
    expect(big.links).toHaveLength(0);

    const t = setup(); await t.service.load('c');
    t.service.want('c', ['r1']);
    t.link().onFrame({ ...header(Kind.READY), stamps: [], payload: json({ capabilities: ['edit-context-v1'] }) });
    t.service.want('c', ['r2']);
    expect(t.describes()).toHaveLength(0);
    expect(t.service.available).toBe(false);

    const s = setup(); await s.service.load('c');
    s.service.want('c', ['r1']); s.ready();
    const request = s.describes()[0].request;
    s.service.cancel(); await s.service.load('d');
    s.reply(Kind.DESCRIPTION, { title: 'Late', explanation: 'x' }, request);
    expect(s.shown).toEqual([]);
    expect(s.link().sent.some(f => f.kind === Kind.CANCEL && f.request === request)).toBe(true);
  });
});
