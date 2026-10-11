/** Thin wrapper over the raw C-ABI exports of crates/tb-render (no wasm-bindgen).
 * Every export may grow Wasm memory and detach old views, so typed-array views are
 * re-derived lazily whenever `memory.buffer` changed. */
import type { ViewName } from '../contracts';

export interface RenderExports {
  memory: WebAssembly.Memory;
  tb_init(): number;
  tb_out_ptr(): number; tb_out_len(): number;
  tb_staging(bytes: number): number;
  tb_attach(slot: number, width: number, height: number, dpr: number): void;
  tb_resize(slot: number, width: number, height: number, dpr: number): void;
  tb_detach(slot: number): void;
  tb_set_view(slot: number, view: number): void;
  tb_set_param(slot: number, nameLength: number, value: number): void;
  tb_bind(slot: number, request: number, revision: number, epoch: number): number;
  tb_bind_view(slot: number, view: number): void;
  tb_unbind(slot: number, request: number): number;
  tb_accepts(request: number, epoch: number): number;
  tb_schema(request: number, epoch: number, columns: number): number;
  tb_batch(request: number, epoch: number, rows: number, columns: number): number;
  tb_done(request: number, epoch: number): number;
  tb_views(slot: number): number;
  tb_needs_frame(): number;
  tb_frame(urgentOnly: number): number;
  tb_words_ptr(): number;
  tb_frame_done(): void;
  tb_events_ptr(): number; tb_events_len(): number; tb_strings_ptr(): number;
  tb_bench_minmax(count: number, simd: number): number;
  tb_bench_convert(count: number): number;
}

/** View codes are the Rust `View` discriminants. */
export const VIEW_NAMES: ViewName[] = ['line', 'bar', 'scatter', 'table', 'heatmap', 'surface', 'map', 'density', 'tracks', 'seasons'];
export const AUTO_VIEW = 255;

export const Ev = { VIEWS: 1, AXES: 2, FIRST_DRAW: 3 } as const;
export const Flags = { ACCEPTED: 1, URGENT: 2 } as const;
export interface CoreEvent { kind: number; slot: number; request: number; a: number; text: string }

export interface PipelineJson {
  name: string; strip: boolean; wgsl: string; vert: string; frag: string;
  buffers: Array<{ stride: number; instance: boolean; attrs: Array<{ location: number; format: 'float32' | 'float32x2' | 'float32x4' | 'unorm8x4'; offset: number }> }>;
}

const utf8 = new TextDecoder();

export class RenderCore {
  private buffer?: ArrayBuffer;
  private u8View = new Uint8Array(0);
  private u32View = new Uint32Array(0);
  readonly pipelines: PipelineJson[];

  constructor(readonly x: RenderExports) {
    if (x.tb_init() !== 1) throw new Error('tb-render ABI mismatch');
    this.pipelines = JSON.parse(this.text(x.tb_out_ptr(), x.tb_out_len())) as PipelineJson[];
  }

  static async load(source: BufferSource | URL | string): Promise<RenderCore> {
    let module: WebAssembly.Module;
    if (source instanceof URL || typeof source === 'string') {
      const response = await fetch(source);
      if (!response.ok) throw new Error(`tb-render.wasm: HTTP ${response.status}`);
      module = await WebAssembly.compileStreaming?.(response) ?? await WebAssembly.compile(await response.arrayBuffer());
    } else module = await WebAssembly.compile(source);
    const instance = await WebAssembly.instantiate(module, {});
    return new RenderCore(instance.exports as unknown as RenderExports);
  }

  /** The current backing buffer of Wasm memory (changes when memory grows). */
  get memory(): ArrayBuffer { this.refresh(); return this.buffer!; }
  get u8(): Uint8Array { this.refresh(); return this.u8View; }
  get u32(): Uint32Array { this.refresh(); return this.u32View; }
  private refresh(): void {
    const buffer = this.x.memory.buffer;
    if (buffer !== this.buffer) {
      this.buffer = buffer;
      this.u8View = new Uint8Array(buffer);
      this.u32View = new Uint32Array(buffer);
    }
  }

  text(ptr: number, length: number): string { return utf8.decode(this.u8.subarray(ptr, ptr + length)); }

  /** Events produced by the last call (cleared by the next emitting call). */
  events(): CoreEvent[] {
    const length = this.x.tb_events_len();
    if (!length) return [];
    const words = this.u32, base = this.x.tb_events_ptr() >>> 2, strings = this.x.tb_strings_ptr();
    const out: CoreEvent[] = [];
    for (let i = 0; i < length; i += 6) {
      const at = base + i;
      out.push({ kind: words[at], slot: words[at + 1], request: words[at + 2], a: words[at + 3],
        text: words[at + 5] ? this.text(strings + words[at + 4], words[at + 5]) : '' });
    }
    return out;
  }

  viewsOf(mask: number): ViewName[] { return VIEW_NAMES.filter((_, i) => mask & (1 << i)); }

  setParam(slot: number, name: string, value: number): void {
    const bytes = new TextEncoder().encode(name);
    const ptr = this.x.tb_staging(bytes.byteLength);
    this.u8.set(bytes, ptr);
    this.x.tb_set_param(slot, bytes.byteLength, value);
  }
}
