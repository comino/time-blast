// Build Rust/Wasm crates into public/wasm/. Usage: pnpm build:wasm [crate ...]
// Default: every browser crate. No wasm-bindgen: crates export a raw C ABI.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';

const CRATES = {
  'tb-coordinator': { target: 'target/wasm32-unknown-unknown/release/tb_coordinator.wasm', out: 'public/wasm/tb-coordinator.wasm', args: ['-p', 'tb-coordinator'] },
  'tb-render': { target: 'target/wasm32-unknown-unknown/release/tb_render.wasm', out: 'public/wasm/tb-render.wasm', args: ['-p', 'tb-render'] },
};
const selected = process.argv.slice(2);
const names = selected.length ? selected : ['tb-coordinator', 'tb-render'];
mkdirSync('public/wasm', { recursive: true });
for (const name of names) {
  const crate = CRATES[name];
  if (!crate) { console.error(`Unknown crate ${name}; known: ${Object.keys(CRATES).join(', ')}`); process.exit(2); }
  const command = spawnSync('cargo', ['build', ...crate.args, '--target', 'wasm32-unknown-unknown', '--release', '-j', '2'], { stdio: 'inherit' });
  if (command.status !== 0) process.exit(command.status ?? 1);
  copyFileSync(crate.target, crate.out);
  console.log(`Built ${crate.out}`);
}
