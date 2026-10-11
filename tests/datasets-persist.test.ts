/**
 * Prebuilt-file persistence (src/engine/datasets.ts fetchPersisted): first visit fetches and stores,
 * a repeat visit revalidates with the stored ETag (304 → stored copy), a changed file (new ETag)
 * replaces the stored copy. Cache API and fetch are in-memory fakes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fetchPersisted, parseManifest } from '../src/engine/datasets';

class FakeCache {
  store = new Map<string, Response>();
  async match(url: string) { const r = this.store.get(url); return r?.clone(); }
  async put(url: string, response: Response) { this.store.set(url, new Response(await response.arrayBuffer(), { headers: response.headers })); }
}

const server = { body: 'v1', etag: '"a"', requests: [] as Array<string | null> };
const fakeFetch = (async (_url: string, init?: RequestInit) => {
  const sent = new Headers(init?.headers).get('If-None-Match');
  server.requests.push(sent);
  if (sent === server.etag) return new Response(null, { status: 304 });
  return new Response(server.body, { status: 200, headers: { etag: server.etag } });
}) as typeof fetch;

const cache = new FakeCache();
(globalThis as { caches?: unknown }).caches = { open: async () => cache };
afterEach(() => { server.requests = []; });

describe('fetchPersisted', () => {
  it('stores on first visit, revalidates on repeat, refetches a changed file', async () => {
    const url = 'https://x/data/v.duckdb';
    const first = await fetchPersisted(url, fakeFetch);
    expect(first.source).toBe('network');
    expect(await first.blob.text()).toBe('v1');
    await new Promise(r => setTimeout(r, 0)); // the put is not awaited by the caller
    expect(server.requests).toEqual([null]);

    const repeat = await fetchPersisted(url, fakeFetch);
    expect(repeat.source).toBe('cache');
    expect(await repeat.blob.text()).toBe('v1');
    expect(server.requests).toEqual([null, '"a"']);

    server.body = 'v2'; server.etag = '"b"';
    const changed = await fetchPersisted(url, fakeFetch);
    expect(changed.source).toBe('revalidated');
    expect(await changed.blob.text()).toBe('v2');
    await new Promise(r => setTimeout(r, 0));
    const again = await fetchPersisted(url, fakeFetch);
    expect(again.source).toBe('cache');
    expect(await again.blob.text()).toBe('v2');
  });
});

describe('manifest', () => {
  it('parses public/data/datasets.json entries and drops malformed ones', async () => {
    const { readFileSync } = await import('node:fs');
    const entries = parseManifest(JSON.parse(readFileSync(new URL('../public/data/datasets.json', import.meta.url), 'utf8')));
    expect(entries.map(e => e.name)).toContain('vessels');
    expect(entries.find(e => e.name === 'vessels')?.prebuilt).toBe('data/vessels/vessels.duckdb');
    expect(parseManifest([{ name: 'x' }, null, { name: 'y', tables: [] }]).map(e => e.name)).toEqual(['y']);
  });
});
