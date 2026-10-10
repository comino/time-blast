/** Arrow → Wasm staging. One memcpy per needed buffer per batch (`Uint8Array.set` from the
 * Arrow buffer into a view of Wasm memory); no per-row JS objects. Layouts are documented in
 * crates/tb-render/src/ffi.rs. */
import { Type, type Data, type DataType, type RecordBatch, type Schema } from 'apache-arrow';
import type { RenderCore } from './core';

/** Rust `TypeCode` values. */
export const Code = {
  UNSUPPORTED: 0, BOOL: 1, I8: 2, I16: 3, I32: 4, I64: 5, U8: 6, U16: 7, U32: 8, U64: 9, F32: 11, F64: 12,
  DECIMAL: 13, DATE32: 15, DATE64: 16, TIMESTAMP: 17, UTF8: 18, LARGE_UTF8: 19, DICT: 20, TIME: 21, DURATION: 22,
} as const;

const NONE = 0xffff_ffff;
const DESCRIPTOR_WORDS = 12;

function intCode(bitWidth: number, signed: boolean): number {
  const codes = signed ? { 8: Code.I8, 16: Code.I16, 32: Code.I32, 64: Code.I64 } : { 8: Code.U8, 16: Code.U16, 32: Code.U32, 64: Code.U64 };
  return (codes as Record<number, number>)[bitWidth] ?? Code.UNSUPPORTED;
}

/** [code, param] for an Arrow type. */
export function describeType(type: DataType): [number, number] {
  const t = type as any;
  switch (type.typeId) {
    case Type.Int: return [intCode(t.bitWidth, t.isSigned), 0];
    case Type.Float: return [t.precision === 2 ? Code.F64 : t.precision === 1 ? Code.F32 : Code.UNSUPPORTED, 0];
    case Type.Decimal: return t.bitWidth === 128 || t.bitWidth === 64 ? [Code.DECIMAL, (t.scale & 0xffff) | t.bitWidth << 16] : [Code.UNSUPPORTED, 0];
    case Type.Date: return [t.unit === 0 ? Code.DATE32 : Code.DATE64, 0];
    case Type.Timestamp: return [Code.TIMESTAMP, t.unit];
    case Type.Utf8: return [Code.UTF8, 0];
    case Type.LargeUtf8: return [Code.LARGE_UTF8, 0];
    case Type.Bool: return [Code.BOOL, 0];
    case Type.Time: return [Code.TIME, t.unit | t.bitWidth << 8];
    case Type.Duration: return [Code.DURATION, t.unit];
    case Type.Dictionary: {
      if (t.dictionary?.typeId !== Type.Utf8) return [Code.UNSUPPORTED, 0];
      return [Code.DICT, intCode(t.indices.bitWidth, t.indices.isSigned)];
    }
    default: return [Code.UNSUPPORTED, 0];
  }
}

const encoder = new TextEncoder();

/** Write the schema descriptor; returns the column count. */
export function writeSchema(core: RenderCore, schema: Schema): number {
  const names = schema.fields.map(f => encoder.encode(f.name));
  const head = schema.fields.length * 16;
  const total = head + names.reduce((n, b) => n + b.byteLength, 0);
  const ptr = core.x.tb_staging(total);
  const u8 = core.u8, u32 = core.u32, base = ptr >>> 2;
  let at = head;
  schema.fields.forEach((field, i) => {
    const [code, param] = describeType(field.type);
    u32[base + i * 4] = code; u32[base + i * 4 + 1] = param;
    u32[base + i * 4 + 2] = at; u32[base + i * 4 + 3] = names[i].byteLength;
    u8.set(names[i], ptr + at); at += names[i].byteLength;
  });
  return schema.fields.length;
}

/** Byte views of one column's buffers for this batch (no copies yet). */
interface Plan {
  index: number;
  data?: Uint8Array;
  validity?: Uint8Array; bit: number;
  offsets?: Uint8Array;
  dictOffsets?: Uint8Array; dictData?: Uint8Array;
}

const bytesOf = (v: ArrayBufferView, from = 0, length = v.byteLength - from) =>
  new Uint8Array(v.buffer, v.byteOffset + from, Math.max(0, Math.min(length, v.byteLength - from)));
const align = (n: number) => (n + 7) & ~7;

function widthOf(code: number, param: number): number {
  switch (code) {
    case Code.I8: case Code.U8: return 1;
    case Code.I16: case Code.U16: return 2;
    case Code.I32: case Code.U32: case Code.F32: case Code.DATE32: return 4;
    case Code.DECIMAL: return (param >>> 16) / 8;
    case Code.TIME: return (param >>> 8) / 8;
    default: return 8;
  }
}

/** Concatenate a (possibly chunked) utf8 dictionary into offsets + bytes. */
function dictionaryBytes(dictionary: { data: Data[] }): [Uint8Array, Uint8Array] {
  const chunks = dictionary.data;
  if (chunks.length === 1) {
    const d = chunks[0], offs = (d.valueOffsets as Int32Array).subarray(0, d.length + 1);
    return [bytesOf(offs), bytesOf(d.values as Uint8Array, offs[0], offs[d.length] - offs[0])];
  }
  let count = 0, size = 0;
  for (const d of chunks) { const o = d.valueOffsets as Int32Array; count += d.length; size += o[d.length] - o[0]; }
  const offsets = new Int32Array(count + 1), data = new Uint8Array(size);
  let k = 0, at = 0;
  for (const d of chunks) {
    const o = d.valueOffsets as Int32Array;
    for (let i = 0; i < d.length; i++) offsets[++k] = offsets[k - 1] + o[i + 1] - o[i];
    data.set((d.values as Uint8Array).subarray(o[0], o[d.length]), at); at += o[d.length] - o[0];
  }
  return [bytesOf(offsets), data];
}

/** Per-request ingest state: the last dictionary per column, so unchanged dictionaries are
 * not re-sent (DuckDB repeats the same dictionary object across batches). */
export class BatchWriter {
  private dictionaries = new Map<number, unknown>();
  /** Bytes copied into Wasm memory by the last `write`. */
  copied = 0;
  constructor(private readonly core: RenderCore, private readonly codes: Array<[number, number]>, private readonly needed: number[]) {}

  /** Copy the needed columns of `batch` into staging; returns the descriptor count. */
  write(batch: RecordBatch): number {
    const rows = batch.numRows, plans: Plan[] = [];
    let total = this.needed.length * DESCRIPTOR_WORDS * 4;
    const reserve = (v?: Uint8Array) => { if (v) total = align(total) + v.byteLength; };
    for (const index of this.needed) {
      const data = batch.data.children[index] as Data;
      if (!data) continue;
      const [code, param] = this.codes[index];
      const plan: Plan = { index, bit: data.offset & 7 };
      const offset = data.offset;
      if (code === Code.BOOL) plan.data = bytesOf(data.values as Uint8Array, offset >> 3, ((offset & 7) + rows + 7) >> 3);
      else if (code === Code.UTF8) {
        const offs = (data.valueOffsets as Int32Array).subarray(0, rows + 1);
        plan.offsets = bytesOf(offs);
        plan.data = bytesOf(data.values as Uint8Array, offs[0], offs[rows] - offs[0]);
      } else if (code === Code.LARGE_UTF8) {
        const offs = (data.valueOffsets as unknown as BigInt64Array).subarray(0, rows + 1);
        plan.offsets = bytesOf(offs);
        plan.data = bytesOf(data.values as Uint8Array, Number(offs[0]), Number(offs[rows] - offs[0]));
      } else if (code === Code.DICT) {
        plan.data = bytesOf(data.values as ArrayBufferView, 0, rows * widthOf(param, 0));
        const dictionary = data.dictionary;
        if (dictionary && this.dictionaries.get(index) !== dictionary) {
          [plan.dictOffsets, plan.dictData] = dictionaryBytes(dictionary as unknown as { data: Data[] });
          this.dictionaries.set(index, dictionary);
        }
      } else if (code !== Code.UNSUPPORTED) plan.data = bytesOf(data.values as ArrayBufferView, 0, rows * widthOf(code, param));
      const bitmap = data.nullBitmap as Uint8Array | undefined;
      if (bitmap && bitmap.byteLength && data.nullCount !== 0) plan.validity = bytesOf(bitmap, offset >> 3, ((offset & 7) + rows + 7) >> 3);
      reserve(plan.data); reserve(plan.validity); reserve(plan.offsets); reserve(plan.dictOffsets); reserve(plan.dictData);
      plans.push(plan);
    }
    const ptr = this.core.x.tb_staging(total);
    // Views after the call: tb_staging may have grown memory.
    const u8 = this.core.u8, u32 = this.core.u32, base = ptr >>> 2;
    let at = plans.length * DESCRIPTOR_WORDS * 4;
    this.copied = 0;
    const put = (v?: Uint8Array): [number, number] => {
      if (!v) return [NONE, 0];
      at = align(at);
      u8.set(v, ptr + at);
      const result: [number, number] = [at, v.byteLength];
      at += v.byteLength; this.copied += v.byteLength;
      return result;
    };
    plans.forEach((p, i) => {
      const d = base + i * DESCRIPTOR_WORDS;
      const [dataOff, dataLen] = put(p.data), [validOff, validLen] = put(p.validity), [offsOff, offsLen] = put(p.offsets);
      const [dictOffsOff, dictOffsLen] = put(p.dictOffsets), [dictDataOff, dictDataLen] = put(p.dictData);
      u32[d] = p.index; u32[d + 1] = dataOff === NONE ? 0 : dataOff; u32[d + 2] = dataLen;
      u32[d + 3] = validOff; u32[d + 4] = validLen; u32[d + 5] = p.bit;
      u32[d + 6] = offsOff === NONE ? 0 : offsOff; u32[d + 7] = offsLen;
      u32[d + 8] = p.dictOffsets ? dictOffsOff : NONE; u32[d + 9] = dictOffsLen;
      u32[d + 10] = p.dictData ? dictDataOff : 0; u32[d + 11] = dictDataLen;
    });
    return plans.length;
  }
}
