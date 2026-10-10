/** JS face of the Rust/Wasm sans-IO coordinator (crates/tb-coordinator, raw C ABI in
 * src/abi.rs). Glue only: frames are copied into Wasm memory, the outbox is copied out. */
import type { CoordinatorCore, CreateCoordinator, LinkId } from './contracts';
import { decode, encodedLength, HEADER_LEN, STAMP_LEN, VERSION, type Frame } from '../protocol/frame';

interface Exports {
  memory: WebAssembly.Memory;
  tb_alloc(len: number): number;
  tb_free(ptr: number, len: number): void;
  tb_coord_new(): number;
  tb_coord_free(handle: number): void;
  tb_coord_input(handle: number, link: number, ptr: number, len: number, now: number): number;
  tb_coord_tick(handle: number, now: number): void;
  tb_coord_next_deadline(handle: number): number;
  tb_coord_flush(handle: number): number;
  tb_coord_out_index(handle: number): number;
  tb_coord_out_bytes(handle: number): number;
  tb_last_error_ptr(): number;
  tb_last_error_len(): number;
}

const LINKS: readonly LinkId[] = ['ui', 'inference', 'database', 'renderer'];
const LINK_NUMBER: Record<LinkId, number> = { ui: 0, inference: 1, database: 2, renderer: 3 };

/** The JS `CoordinatorCore` plus a byte-level entry for frames that arrive encoded
 * (MessagePort, WebSocket), which skips a decode + re-encode. */
export interface WasmCoordinator extends CoordinatorCore {
  inputEncoded(link: LinkId, bytes: Uint8Array, now: number): void;
}

/** Where the module comes from: compiled module, raw bytes (tests), or a fetch Response. */
export type CoordinatorSource = WebAssembly.Module | BufferSource | Response | PromiseLike<Response>;

let shared: Promise<WebAssembly.Module> | undefined;

async function compile(source?: CoordinatorSource): Promise<WebAssembly.Module> {
  if (source instanceof WebAssembly.Module) return source;
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return WebAssembly.compile(source as BufferSource);
  const response = source ? await source : fetch(`${import.meta.env.BASE_URL}wasm/tb-coordinator.wasm`);
  const resolved = await response;
  if (!resolved.ok) throw new Error(`tb-coordinator.wasm: HTTP ${resolved.status}`);
  if (WebAssembly.compileStreaming && resolved.headers.get('content-type')?.startsWith('application/wasm')) {
    return WebAssembly.compileStreaming(resolved);
  }
  return WebAssembly.compile(await resolved.arrayBuffer());
}

export async function loadCoordinator(source?: CoordinatorSource): Promise<WasmCoordinator> {
  const module = source === undefined ? await (shared ??= compile()) : await compile(source);
  const instance = await WebAssembly.instantiate(module, {});
  const wasm = instance.exports as unknown as Exports;
  const handle = wasm.tb_coord_new();
  let bytes = new Uint8Array(wasm.memory.buffer);
  let view = new DataView(wasm.memory.buffer);
  let stagePtr = 0, stageCap = 0, disposed = false;

  // Memory can grow during any call; refresh views when the buffer was replaced.
  const fresh = () => {
    if (bytes.buffer !== wasm.memory.buffer) {
      bytes = new Uint8Array(wasm.memory.buffer);
      view = new DataView(wasm.memory.buffer);
    }
  };
  const stage = (len: number): number => {
    if (len > stageCap) {
      if (stageCap) wasm.tb_free(stagePtr, stageCap);
      stageCap = Math.max(len, stageCap * 2, 4096);
      stagePtr = wasm.tb_alloc(stageCap);
    }
    fresh();
    return stagePtr;
  };
  const check = (code: number) => {
    if (code === 0) return;
    fresh();
    const ptr = wasm.tb_last_error_ptr(), len = wasm.tb_last_error_len();
    throw new Error(`tb-coordinator: ${new TextDecoder().decode(bytes.subarray(ptr, ptr + len))} (code ${code})`);
  };
  const live = () => { if (disposed) throw new Error('tb-coordinator: disposed'); };

  const core: WasmCoordinator = {
    input(link, frame, now) {
      live();
      const { stamps, payload } = frame;
      const len = encodedLength(stamps.length, payload.byteLength);
      const at = stage(len);
      // Encode straight into Wasm memory (same layout as protocol/frame.ts `encode`).
      bytes[at] = VERSION; bytes[at + 1] = frame.kind; bytes[at + 2] = frame.flags; bytes[at + 3] = stamps.length;
      view.setUint32(at + 4, payload.byteLength, true);
      view.setUint32(at + 8, frame.epoch, true); view.setUint32(at + 12, frame.request, true);
      view.setUint32(at + 16, frame.revision, true); view.setUint32(at + 20, frame.context, true);
      let p = at + HEADER_LEN;
      for (const s of stamps) {
        view.setUint16(p, s.stage, true); view.setUint16(p + 2, s.node, true);
        view.setUint32(p + 4, 0, true); view.setFloat64(p + 8, s.at, true);
        p += STAMP_LEN;
      }
      bytes.set(payload, p);
      check(wasm.tb_coord_input(handle, LINK_NUMBER[link], at, len, now));
    },
    inputEncoded(link, encoded, now) {
      live();
      const at = stage(encoded.byteLength);
      bytes.set(encoded, at);
      check(wasm.tb_coord_input(handle, LINK_NUMBER[link], at, encoded.byteLength, now));
    },
    tick(now) {
      live();
      wasm.tb_coord_tick(handle, now);
    },
    drain() {
      live();
      const count = wasm.tb_coord_flush(handle);
      if (count === 0) return [];
      fresh();
      const index = wasm.tb_coord_out_index(handle), base = wasm.tb_coord_out_bytes(handle);
      const out: Array<[LinkId, Frame<Uint8Array>]> = new Array(count);
      for (let i = 0; i < count; i++) {
        const link = view.getUint32(index + i * 12, true);
        const offset = view.getUint32(index + i * 12 + 4, true);
        const len = view.getUint32(index + i * 12 + 8, true);
        // Copy out: the Wasm buffer is reused, and each frame gets its own transferable buffer.
        out[i] = [LINKS[link], decode(bytes.slice(base + offset, base + offset + len))];
      }
      return out;
    },
    nextDeadline() {
      live();
      const deadline = wasm.tb_coord_next_deadline(handle);
      return Number.isNaN(deadline) ? null : deadline;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (stageCap) wasm.tb_free(stagePtr, stageCap);
      wasm.tb_coord_free(handle);
    },
  };
  return core;
}

export const createCoordinator: CreateCoordinator = () => loadCoordinator();
