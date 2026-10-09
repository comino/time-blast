import { defineConfig, type Plugin } from 'vite';
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

export default defineConfig({
  plugins:[compressedEngines()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm', '@mlc-ai/web-llm'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
});
