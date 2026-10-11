/**
 * Work the engine worker starts before its main module graph has loaded (docs/batch-3/cold-start.md):
 * the DuckDB module's streaming compile, the dataset manifest, the boot dataset's prebuilt
 * database and the DuckDB extensions' bytes. Each is started once and awaited later by whoever
 * needs it (src/engine/database.ts). This module stays tiny: it is part of the worker's first chunk.
 *
 * Compiling with `WebAssembly.compileStreaming` on an HTTP response (instead of a Blob URL) lets
 * the browser cache the compiled code: a repeat visit skips most of the DuckDB compile.
 */
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import { bootClock, bootMark } from './boot-trace';
import { fetchPersisted, parseManifest, type ManifestEntry } from './datasets';
import { fetchEngineWasm } from './wasm-asset';

/** DuckDB version inside @duckdb/duckdb-wasm 1.32.0 (checked after instantiation). */
export const DUCKDB_VERSION = 'v1.4.3';
const EXTENSION_REPOSITORY = 'https://extensions.duckdb.org';

export type Bundle = 'eh' | 'mvp';
export interface CompiledDuckDB { bundle: Bundle; url: string; module: WebAssembly.Module; streamed: boolean }

// DuckDB's own feature test for Wasm exceptions (duckdb-browser-blocking getPlatformFeatures).
const EH_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11]);
export const duckBundle = (): Bundle => WebAssembly.validate(EH_PROBE) ? 'eh' : 'mvp';

const base = (): string => (import.meta.env?.BASE_URL ?? '/');
const absolute = (path: string): string => new URL(path, globalThis.location?.href ?? 'http://localhost/').href;

let duck: Promise<CompiledDuckDB> | undefined;
/** Fetch + compile the DuckDB module (once). Production serves it gzip-packaged: the HTTP stack
 * decodes it (Content-Encoding, deploy/time-blast.Caddyfile) and the compile streams; a host that
 * sends the raw .gz falls back to a JS gunzip and a non-streaming compile (no code cache). */
export function compileDuckDB(): Promise<CompiledDuckDB> {
  return duck ??= (async () => {
    const t0 = bootClock();
    const bundle = duckBundle();
    const asset = bundle === 'eh' ? ehWasm : mvpWasm;
    const url = import.meta.env?.PROD ? `${asset}.gz` : asset;
    let module: WebAssembly.Module, streamed = true;
    try {
      module = await WebAssembly.compileStreaming(fetch(url, { credentials: 'same-origin' }));
    } catch {
      streamed = false;
      const blob = await fetchEngineWasm(url);
      module = await WebAssembly.compile(await blob.arrayBuffer());
    }
    bootMark('duckdb.compile', t0, `${bundle}${streamed ? ' streaming' : ' gunzip+compile'}`);
    return { bundle, url, module, streamed };
  })();
}

const wasmModules = new Map<string, Promise<WebAssembly.Module>>();
/** Compile one of our own Wasm modules (`public/wasm/<name>.wasm`) while streaming, once. */
export function compileOwnWasm(name: 'tb-coordinator' | 'tb-render'): Promise<WebAssembly.Module> {
  let pending = wasmModules.get(name);
  if (!pending) {
    pending = WebAssembly.compileStreaming(fetch(absolute(`${base()}wasm/${name}.wasm`)));
    wasmModules.set(name, pending);
    pending.catch(() => wasmModules.delete(name));
  }
  return pending;
}

let manifest: Promise<ManifestEntry[]> | undefined;
export function manifestUrl(): string { return absolute(`${base()}data/datasets.json`); }
export function dataUrl(path: string): string { return absolute(`${base()}${path.replace(/^\//, '')}`); }
/** The dataset manifest (revalidated on every visit: it is tiny and names the prebuilt files). */
export function loadManifest(): Promise<ManifestEntry[]> {
  return manifest ??= (async () => {
    const response = await fetch(manifestUrl(), { cache: 'no-cache' });
    if (!response.ok) throw new Error(`datasets.json: HTTP ${response.status}`);
    return parseManifest(await response.json());
  })();
}

const prebuilt = new Map<string, Promise<Blob>>();
/** A prebuilt database's bytes (Cache API persisted), fetched once per URL. A failed fetch is forgotten. */
export function fetchPrebuilt(url: string): Promise<Blob> {
  let pending = prebuilt.get(url);
  if (!pending) {
    pending = fetchPersisted(url).then(r => { bootMark('dataset.download', undefined, `${r.source} ${(r.blob.size / 1048576).toFixed(1)} MiB ${r.ms.toFixed(0)} ms`); return r.blob; });
    prebuilt.set(url, pending);
    pending.catch(() => prebuilt.delete(url));
  }
  return pending;
}
/** Take (and forget) prefetched bytes: the engine copies them into Wasm memory once. */
export function takePrebuilt(url: string): Promise<Blob> {
  const pending = fetchPrebuilt(url);
  prebuilt.delete(url);
  return pending;
}

/** Start fetching a fixture's prebuilt database as soon as its name is known. */
export function prefetchFixture(name: string): void {
  void loadManifest().then(entries => {
    const entry = entries.find(e => e.name === name);
    if (entry?.prebuilt) void fetchPrebuilt(dataUrl(entry.prebuilt)).catch(() => {});
  }).catch(() => {});
}

export function extensionUrl(name: string, bundle: Bundle, version = DUCKDB_VERSION): string {
  return `${EXTENSION_REPOSITORY}/${version}/wasm_${bundle}/${name}.duckdb_extension.wasm`;
}
/** Warm the HTTP cache for extensions DuckDB loads with a synchronous XHR at boot, so the XHR finds
 * the bytes local instead of blocking the worker on the network. */
const extensionsFetched = new Set<string>();
export function prefetchExtensions(names: string[], bundle: Bundle = duckBundle()): void {
  for (const name of names) {
    const url = extensionUrl(name, bundle);
    if (extensionsFetched.has(url)) continue;
    extensionsFetched.add(url);
    const t0 = bootClock();
    void fetch(url).then(r => r.arrayBuffer()).then(b => bootMark(`ext.${name}.prefetch`, t0, `${b.byteLength} B`)).catch(() => {});
  }
}
