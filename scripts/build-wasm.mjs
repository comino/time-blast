import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
const command = spawnSync('cargo', ['build', '--manifest-path', 'crates/query-core/Cargo.toml', '--target', 'wasm32-unknown-unknown', '--release'], { stdio: 'inherit' });
if (command.status !== 0) process.exit(command.status ?? 1);
mkdirSync('public/wasm', { recursive: true });
copyFileSync('crates/query-core/target/wasm32-unknown-unknown/release/time_blast_query_core.wasm', 'public/wasm/query-core.wasm');
console.log('Built public/wasm/query-core.wasm');
