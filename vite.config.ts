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

// Cross-origin isolation: SharedArrayBuffer and 5 µs performance.now() resolution (100 µs
// without). `credentialless` instead of `require-corp` so cross-origin CORS fetches (model
// weights, DuckDB extensions) keep working without those hosts sending CORP headers.
// Keep in sync with deploy/time-blast.Caddyfile.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  plugins:[compressedEngines()],
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
