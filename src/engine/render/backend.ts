/** GPU shims: replay the Rust command stream (crates/tb-render/src/gpu.rs `op`) on WebGPU or
 * WebGL2. They hold no chart logic — only GPU objects keyed by the ids Rust assigns.
 * Uploads read straight from Wasm memory (`writeBuffer(buffer, offset, memory, src, len)`). */
import type { PipelineJson } from './core';

// Minimal module-local WebGPU typings (the repo has no @webgpu/types and adds no npm deps).
/* eslint-disable @typescript-eslint/no-explicit-any */
type GPUTextureFormat = string;
interface GPUBuffer { destroy(): void }
interface GPUBindGroup { readonly __brand?: 'bindgroup' }
interface GPUBindGroupLayout { readonly __brand?: 'bgl' }
interface GPURenderPipeline { readonly __brand?: 'pipeline' }
interface GPUBlendState { color: object; alpha: object }
interface GPUAdapterInfo { vendor?: string; architecture?: string; description?: string }
interface GPURenderPassEncoder {
  setPipeline(p: GPURenderPipeline): void;
  setVertexBuffer(slot: number, buffer: GPUBuffer, offset: number): void;
  setBindGroup(index: number, group: GPUBindGroup, offsets: Uint32Array, start: number, length: number): void;
  setScissorRect(x: number, y: number, w: number, h: number): void;
  draw(vertices: number, instances: number): void;
  end(): void;
}
interface GPUCommandEncoder { beginRenderPass(desc: object): GPURenderPassEncoder; finish(): object }
interface GPUQueue {
  writeBuffer(buffer: GPUBuffer, offset: number, data: ArrayBuffer, dataOffset: number, size: number): void;
  submit(buffers: object[]): void;
  onSubmittedWorkDone(): Promise<void>;
}
interface GPUDevice {
  readonly queue: GPUQueue;
  createBuffer(desc: { size: number; usage: number }): GPUBuffer;
  createBindGroup(desc: object): GPUBindGroup;
  createBindGroupLayout(desc: object): GPUBindGroupLayout;
  createPipelineLayout(desc: object): object;
  createShaderModule(desc: object): object;
  createRenderPipelineAsync(desc: object): Promise<GPURenderPipeline>;
  createCommandEncoder(): GPUCommandEncoder;
}
interface GPUCanvasContext {
  configure(desc: object): void;
  unconfigure(): void;
  getCurrentTexture(): { createView(): object };
}
const GPUBufferUsage = { COPY_DST: 0x8, VERTEX: 0x20, UNIFORM: 0x40 } as const;
const GPUShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2 } as const;

export const Op = { CTX: 1, BUF_CREATE: 2, BUF_DESTROY: 3, BUF_WRITE: 4, PASS: 5, PIPE: 6, VB: 7, UNI: 8, SCISSOR: 9, DRAW: 10, END: 11 } as const;
const KIND_UNIFORM = 2;
const UNIFORM_SIZE = 96;

export type BackendKind = 'webgpu' | 'webgl2' | 'null';

export interface GpuBackend {
  readonly kind: BackendKind;
  readonly label: string;
  /** Configure a slot's canvas at a device-pixel size. */
  attach(slot: number, canvas: OffscreenCanvas, width: number, height: number): void;
  resize(slot: number, width: number, height: number): void;
  detach(slot: number): void;
  /** Execute one frame's commands and submit. `memory` is Wasm memory's current buffer. */
  replay(words: Uint32Array, memory: ArrayBuffer): void;
  /** Best-effort completion of the last submit (FIRST_PRESENTED). */
  presented(): Promise<void>;
  /** Commands and GPU calls of the last replay, for measurement. */
  readonly stats: { commands: number; calls: number; uploadedBytes: number };
}

const f32 = new Float32Array(1), f32u = new Uint32Array(f32.buffer);
const asFloat = (bits: number) => { f32u[0] = bits; return f32[0]; };

/** Size a canvas without reallocating when unchanged. */
function size(canvas: OffscreenCanvas, width: number, height: number): void {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

const nextFrame = (): Promise<void> => new Promise(resolve => {
  const raf = (globalThis as any).requestAnimationFrame as ((cb: () => void) => number) | undefined;
  if (raf) raf(() => resolve()); else setTimeout(resolve, 16);
});

// ───────────────────────── WebGPU ─────────────────────────

export class WebGpuBackend implements GpuBackend {
  readonly kind = 'webgpu' as const;
  readonly stats = { commands: 0, calls: 0, uploadedBytes: 0 };
  private readonly contexts = new Map<number, { canvas: OffscreenCanvas; context: GPUCanvasContext }>();
  private readonly buffers = new Map<number, GPUBuffer>();
  private readonly groups = new Map<number, GPUBindGroup>();
  private readonly offsets = new Uint32Array(1);

  private constructor(readonly label: string, private readonly device: GPUDevice, private readonly format: GPUTextureFormat,
    private readonly layout: GPUBindGroupLayout, private readonly pipelines: GPURenderPipeline[]) {}

  static async create(pipelines: PipelineJson[]): Promise<WebGpuBackend | null> {
    const gpu = (globalThis.navigator as any)?.gpu;
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const device: GPUDevice = await adapter.requestDevice();
    const format: GPUTextureFormat = gpu.getPreferredCanvasFormat();
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: UNIFORM_SIZE } }] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const blend: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
    // Compile every pipeline up front (engine boot), never on the first-draw path.
    const built = await Promise.all(pipelines.map((p): Promise<GPURenderPipeline> => {
      const module = device.createShaderModule({ code: p.wgsl, label: p.name });
      return device.createRenderPipelineAsync({
        label: p.name, layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs', buffers: p.buffers.map(b => ({ arrayStride: b.stride, stepMode: b.instance ? 'instance' : 'vertex',
          attributes: b.attrs.map(a => ({ shaderLocation: a.location, format: a.format, offset: a.offset })) })) },
        fragment: { module, entryPoint: 'fs', targets: [{ format, blend }] },
        primitive: { topology: p.strip ? 'triangle-strip' : 'triangle-list' },
      });
    }));
    const info = (adapter as any).info as GPUAdapterInfo | undefined;
    const label = info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'webgpu' : 'webgpu';
    return new WebGpuBackend(label, device, format, layout, built);
  }

  attach(slot: number, canvas: OffscreenCanvas, width: number, height: number): void {
    size(canvas, width, height);
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) throw new Error('OffscreenCanvas has no webgpu context');
    context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
    this.contexts.set(slot, { canvas, context });
  }
  resize(slot: number, width: number, height: number): void {
    const c = this.contexts.get(slot);
    if (c) size(c.canvas, width, height);
  }
  detach(slot: number): void {
    this.contexts.get(slot)?.context.unconfigure();
    this.contexts.delete(slot);
  }

  replay(w: Uint32Array, memory: ArrayBuffer): void {
    const device = this.device, queue = device.queue;
    let encoder: GPUCommandEncoder | undefined, pass: GPURenderPassEncoder | undefined, group: GPUBindGroup | undefined;
    let calls = 0, commands = 0, uploaded = 0;
    const destroyed: number[] = [];
    for (let i = 0; i < w.length;) {
      commands++;
      switch (w[i]) {
        case Op.CTX: i += 2; break;
        case Op.BUF_CREATE: {
          const id = w[i + 1], bytes = w[i + 2], uniform = w[i + 3] === KIND_UNIFORM;
          const buffer = device.createBuffer({ size: bytes, usage: (uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.VERTEX) | GPUBufferUsage.COPY_DST });
          this.buffers.set(id, buffer); calls++;
          if (uniform) { this.groups.set(id, device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: { buffer, size: UNIFORM_SIZE } }] })); calls++; }
          i += 4; break;
        }
        case Op.BUF_DESTROY: destroyed.push(w[i + 1]); i += 2; break;
        case Op.BUF_WRITE: {
          const buffer = this.buffers.get(w[i + 1]);
          if (buffer) { queue.writeBuffer(buffer, w[i + 2], memory, w[i + 3], w[i + 4]); calls++; uploaded += w[i + 4]; }
          i += 5; break;
        }
        case Op.PASS: {
          const target = this.contexts.get(w[i + 1]);
          i += 7;
          if (!target) { pass = undefined; break; }
          encoder ??= device.createCommandEncoder();
          group = this.groups.get(w[i - 6]);
          pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.context.getCurrentTexture().createView(),
            clearValue: { r: asFloat(w[i - 5]), g: asFloat(w[i - 4]), b: asFloat(w[i - 3]), a: asFloat(w[i - 2]) }, loadOp: 'clear', storeOp: 'store' }] });
          calls += 4; break;
        }
        case Op.PIPE: pass?.setPipeline(this.pipelines[w[i + 1]]); calls++; i += 2; break;
        case Op.VB: { const b = this.buffers.get(w[i + 2]); if (b) pass?.setVertexBuffer(w[i + 1], b, w[i + 3]); calls++; i += 4; break; }
        case Op.UNI: if (group) { this.offsets[0] = w[i + 1]; pass?.setBindGroup(0, group, this.offsets, 0, 1); calls++; } i += 2; break;
        case Op.SCISSOR: pass?.setScissorRect(w[i + 1], w[i + 2], w[i + 3], w[i + 4]); calls++; i += 5; break;
        case Op.DRAW: pass?.draw(w[i + 1], w[i + 2]); calls++; i += 3; break;
        case Op.END: pass?.end(); pass = undefined; calls++; i += 1; break;
        default: throw new Error(`tb-render: bad opcode ${w[i]} at ${i}`);
      }
    }
    if (encoder) { queue.submit([encoder.finish()]); calls += 2; }
    for (const id of destroyed) { this.buffers.get(id)?.destroy(); this.buffers.delete(id); this.groups.delete(id); }
    this.stats.commands = commands; this.stats.calls = calls; this.stats.uploadedBytes = uploaded;
  }

  presented(): Promise<void> { return this.device.queue.onSubmittedWorkDone(); }
}

// ───────────────────────── WebGL2 ─────────────────────────

interface GlSlot {
  gl: WebGL2RenderingContext; canvas: OffscreenCanvas;
  programs: WebGLProgram[]; enabled: Set<number>;
}
interface GlBuffer { slot: number; buffer: WebGLBuffer; target: number }

const GL_FORMATS: Record<string, [number, number, boolean]> = {
  float32: [1, 0x1406, false], float32x2: [2, 0x1406, false], float32x4: [4, 0x1406, false], unorm8x4: [4, 0x1401, true],
};

/** One WebGL2 context per slot (contexts can't share buffers). The same Rust stream drives it;
 * buffer ids map to the context of the slot that created them. */
export class WebGl2Backend implements GpuBackend {
  readonly kind = 'webgl2' as const;
  readonly label = 'webgl2';
  readonly stats = { commands: 0, calls: 0, uploadedBytes: 0 };
  private readonly slots = new Map<number, GlSlot>();
  private readonly buffers = new Map<number, GlBuffer>();
  private memory?: ArrayBuffer;
  private bytes = new Uint8Array(0);

  constructor(private readonly pipelines: PipelineJson[]) {}

  static available(): boolean {
    try { return !!new OffscreenCanvas(1, 1).getContext('webgl2'); } catch { return false; }
  }

  attach(slot: number, canvas: OffscreenCanvas, width: number, height: number): void {
    size(canvas, width, height);
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance' }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('OffscreenCanvas has no webgl2 context');
    const programs = this.pipelines.map(p => this.program(gl, p));
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.slots.set(slot, { gl, canvas, programs, enabled: new Set() });
  }

  private program(gl: WebGL2RenderingContext, p: PipelineJson): WebGLProgram {
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${p.name}: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, p.vert));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, p.frag));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`${p.name}: ${gl.getProgramInfoLog(program)}`);
    const block = gl.getUniformBlockIndex(program, 'U');
    if (block !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, block, 0);
    return program;
  }

  resize(slot: number, width: number, height: number): void {
    const s = this.slots.get(slot);
    if (s) size(s.canvas, width, height);
  }
  detach(slot: number): void {
    const s = this.slots.get(slot);
    if (!s) return;
    for (const [id, b] of this.buffers) if (b.slot === slot) { s.gl.deleteBuffer(b.buffer); this.buffers.delete(id); }
    s.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.slots.delete(slot);
  }

  replay(w: Uint32Array, memory: ArrayBuffer): void {
    if (memory !== this.memory) { this.memory = memory; this.bytes = new Uint8Array(memory); }
    let cur: GlSlot | undefined, slotId = -1, pipe: PipelineJson | undefined, ubo: WebGLBuffer | undefined, strip = true;
    let calls = 0, commands = 0, uploaded = 0;
    const destroyed: number[] = [];
    for (let i = 0; i < w.length;) {
      commands++;
      switch (w[i]) {
        case Op.CTX: slotId = w[i + 1]; cur = this.slots.get(slotId); i += 2; break;
        case Op.BUF_CREATE: {
          if (cur) {
            const gl = cur.gl, target = w[i + 3] === KIND_UNIFORM ? gl.UNIFORM_BUFFER : gl.ARRAY_BUFFER, buffer = gl.createBuffer()!;
            gl.bindBuffer(target, buffer); gl.bufferData(target, w[i + 2], gl.DYNAMIC_DRAW);
            this.buffers.set(w[i + 1], { slot: slotId, buffer, target }); calls += 3;
          }
          i += 4; break;
        }
        case Op.BUF_DESTROY: destroyed.push(w[i + 1]); i += 2; break;
        case Op.BUF_WRITE: {
          const b = this.buffers.get(w[i + 1]), s = b && this.slots.get(b.slot);
          if (b && s) { s.gl.bindBuffer(b.target, b.buffer); s.gl.bufferSubData(b.target, w[i + 2], this.bytes, w[i + 3], w[i + 4]); calls += 2; uploaded += w[i + 4]; }
          i += 5; break;
        }
        case Op.PASS: {
          cur = this.slots.get(w[i + 1]);
          if (cur) {
            const gl = cur.gl;
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            gl.disable(gl.SCISSOR_TEST);
            gl.clearColor(asFloat(w[i + 3]), asFloat(w[i + 4]), asFloat(w[i + 5]), asFloat(w[i + 6]));
            gl.clear(gl.COLOR_BUFFER_BIT);
            ubo = this.buffers.get(w[i + 2])?.buffer; pipe = undefined; calls += 5;
          }
          i += 7; break;
        }
        case Op.PIPE: {
          if (cur) {
            const gl = cur.gl, p = this.pipelines[w[i + 1]];
            gl.useProgram(cur.programs[w[i + 1]]); pipe = p; strip = p.strip;
            const wanted = new Set(p.buffers.flatMap(b => b.attrs.map(a => a.location)));
            for (const loc of cur.enabled) if (!wanted.has(loc)) { gl.disableVertexAttribArray(loc); cur.enabled.delete(loc); }
            calls++;
          }
          i += 2; break;
        }
        case Op.VB: {
          const b = this.buffers.get(w[i + 2]), layout = pipe?.buffers[w[i + 1]];
          if (cur && b && layout) {
            const gl = cur.gl, offset = w[i + 3];
            gl.bindBuffer(gl.ARRAY_BUFFER, b.buffer); calls++;
            for (const a of layout.attrs) {
              const [n, type, normalized] = GL_FORMATS[a.format];
              if (!cur.enabled.has(a.location)) { gl.enableVertexAttribArray(a.location); cur.enabled.add(a.location); }
              gl.vertexAttribPointer(a.location, n, type, normalized, layout.stride, offset + a.offset);
              gl.vertexAttribDivisor(a.location, layout.instance ? 1 : 0); calls += 2;
            }
          }
          i += 4; break;
        }
        case Op.UNI: if (cur && ubo) { cur.gl.bindBufferRange(cur.gl.UNIFORM_BUFFER, 0, ubo, w[i + 1], 256); calls++; } i += 2; break;
        case Op.SCISSOR: {
          if (cur) {
            const gl = cur.gl;
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(w[i + 1], gl.drawingBufferHeight - w[i + 2] - w[i + 4], w[i + 3], w[i + 4]); calls += 2;
          }
          i += 5; break;
        }
        case Op.DRAW: if (cur) { cur.gl.drawArraysInstanced(strip ? cur.gl.TRIANGLE_STRIP : cur.gl.TRIANGLES, 0, w[i + 1], w[i + 2]); calls++; } i += 3; break;
        case Op.END: i += 1; break;
        default: throw new Error(`tb-render: bad opcode ${w[i]} at ${i}`);
      }
    }
    for (const id of destroyed) {
      const b = this.buffers.get(id);
      if (b) { this.slots.get(b.slot)?.gl.deleteBuffer(b.buffer); this.buffers.delete(id); }
    }
    this.stats.commands = commands; this.stats.calls = calls; this.stats.uploadedBytes = uploaded;
  }

  presented(): Promise<void> { return nextFrame(); }
}

// ───────────────────────── null (tests, environments without a GPU) ─────────────────────────

/** Validates and counts the stream without a GPU. Used by unit tests and as the last resort
 * so the data path (roles, views, table, export, DRAWN) still works without any GPU. */
export class NullBackend implements GpuBackend {
  readonly kind = 'null' as const;
  readonly label = 'null';
  readonly stats = { commands: 0, calls: 0, uploadedBytes: 0 };
  readonly live = new Set<number>();
  draws = 0; passes = 0; frames = 0;
  readonly drawsBySlot = new Map<number, number>();
  attach(): void {}
  resize(): void {}
  detach(): void {}
  replay(w: Uint32Array): void {
    let commands = 0, uploaded = 0, slot = -1;
    this.frames++;
    for (let i = 0; i < w.length;) {
      commands++;
      const op = w[i];
      switch (op) {
        case Op.CTX: slot = w[i + 1]; i += 2; break;
        case Op.BUF_CREATE: this.live.add(w[i + 1]); i += 4; break;
        case Op.BUF_DESTROY: this.live.delete(w[i + 1]); i += 2; break;
        case Op.BUF_WRITE: if (!this.live.has(w[i + 1])) throw new Error(`write to unknown buffer ${w[i + 1]}`); uploaded += w[i + 4]; i += 5; break;
        case Op.PASS: this.passes++; slot = w[i + 1]; this.drawsBySlot.set(slot, 0); i += 7; break;
        case Op.PIPE: case Op.UNI: i += 2; break;
        case Op.VB: if (!this.live.has(w[i + 2])) throw new Error(`unknown vertex buffer ${w[i + 2]}`); i += 4; break;
        case Op.SCISSOR: i += 5; break;
        case Op.DRAW: this.draws++; this.drawsBySlot.set(slot, (this.drawsBySlot.get(slot) ?? 0) + 1); i += 3; break;
        case Op.END: i += 1; break;
        default: throw new Error(`tb-render: bad opcode ${op} at ${i}`);
      }
    }
    this.stats.commands = commands; this.stats.calls = 0; this.stats.uploadedBytes = uploaded;
  }
  presented(): Promise<void> { return Promise.resolve(); }
}
