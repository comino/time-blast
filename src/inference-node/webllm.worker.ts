// STUB (wave 0). Owner: inference agent. In-browser inference node: speaks tb1 frames as
// transferred ArrayBuffers over its global postMessage. The engine spawns it as
// new Worker(new URL('../inference-node/webllm.worker.ts', import.meta.url), { type: 'module' })
// and sends HELLO {"node":"coordinator","model":"<id>"} first.
export {};
