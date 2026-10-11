import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// DuckDB engine binaries exceed common static-host per-file limits. Keep their
// imported URLs stable; the production loader appends .gz and expands once.
function compressedEngines():Plugin {
  return {
    name:'time-blast-compressed-engines',apply:'build',enforce:'post',
    generateBundle(_options,bundle) {
      for(const [name,asset] of Object.entries(bundle)) {
        if(asset.type!=='asset'||!name.endsWith('.wasm'))continue;
        const filename=`${name}.gz`;
        this.emitFile({type:'asset',fileName:filename,source:gzipSync(asset.source,{level:9})});
        delete bundle[name];
      }
    },
  };
}

// `vite preview` with the production host's headers (deploy/time-blast.Caddyfile): hashed
// /assets/* immutable, everything else revalidated; packaged engines decoded by the HTTP stack
// (Content-Encoding gzip, Content-Type application/wasm) so the browser compiles them while
// streaming and keeps V8's code cache. Boot measurements (scripts/bench-boot.py) depend on it.
function caddyLikePreview(): Plugin {
  return {
    name: 'time-blast-caddy-like-preview',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '/').split('?')[0];
        const engine = /^\/assets\/.*\.wasm\.gz$/.test(path);
        const set = res.setHeader.bind(res);
        res.setHeader = ((name: string, value: number | string | readonly string[]) => {
          if (engine && /^content-type$/i.test(name)) return set(name, 'application/wasm');
          if (/^cache-control$/i.test(name)) return res;
          return set(name, value);
        }) as typeof res.setHeader;
        set('Cache-Control', path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
        if (engine) { set('Content-Type', 'application/wasm'); set('Content-Encoding', 'gzip'); }
        next();
      });
    },
  };
}

// Cross-origin isolation: SharedArrayBuffer and 5 µs performance.now() resolution (100 µs
// without). `credentialless` instead of `require-corp` so cross-origin CORS fetches (model
// weights, DuckDB extensions) keep working without those hosts sending CORP headers.
// Keep in sync with deploy/time-blast.Caddyfile.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  plugins:[compressedEngines(), caddyLikePreview()],
  resolve: {
    alias: {
      // DuckDB-Wasm's blocking browser build is not in its package exports map (src/engine/duckdb-blocking.d.ts).
      'duckdb-browser-blocking': fileURLToPath(new URL('./node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-blocking.mjs', import.meta.url)),
    },
  },
  // Agent worktrees live under .claude/; changes there must not reload the dev page.
  server: { port: 5173, strictPort: true, headers: isolation, watch: { ignored: ['**/.claude/**', '**/target/**'] } },
  preview: { port: 4173, strictPort: true, headers: isolation },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm', '@mlc-ai/web-llm'] },
  // measure.html: the real-hardware measurement page (docs/batch-3/measurement.md), deployed with the app.
  build: { target: 'es2022', chunkSizeWarningLimit: 1600, rollupOptions: { input: { main: 'index.html', measure: 'measure.html' } } },
});
