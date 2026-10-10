// Builds the app plus render-bench.html. `vite --config vite.render-bench.config.ts` for dev;
// the default vite.config.ts stays untouched (the dev server serves render-bench.html anyway).
import { mergeConfig } from 'vite';
import base from './vite.config';

// Cross-origin isolation gives the bench 5 µs timers instead of 100 µs.
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default mergeConfig(base, {
  server: { headers: isolation },
  preview: { headers: isolation },
  build: { rollupOptions: { input: { main: 'index.html', renderBench: 'render-bench.html' } } },
});
