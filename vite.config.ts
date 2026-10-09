import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm', '@mlc-ai/web-llm'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
});
