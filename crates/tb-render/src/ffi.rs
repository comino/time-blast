//! Raw C-ABI exports for the JS shim (no wasm-bindgen). All pointers are offsets into Wasm
//! linear memory. Any call may grow memory, so the shim re-derives its typed-array views
//! after every call. Events from the previous call are cleared at the start of each call
//! that can emit, so the shim reads them right after the call returns.
//!
//! Staging layouts (byte offsets relative to the staging pointer):
//! - schema: per column 4×u32 `[code, param, name_off, name_len]`, names after.
//! - batch: per column 12×u32 `[index, data_off, data_len, valid_off, valid_len, bit_offset,
//!   offs_off, offs_len, dict_offs_off, dict_offs_len, dict_data_off, dict_data_len]`;
//!   `NONE` (0xFFFF_FFFF) marks an absent validity bitmap or an unchanged dictionary.

use crate::renderer::{Binding, Renderer};
use crate::schema::{ColumnInfo, ColumnType, TypeCode, View};
use crate::store::RawColumn;
use core::cell::UnsafeCell;

pub const ABI_VERSION: u32 = 1;
pub const NONE: u32 = u32::MAX;

struct Global(UnsafeCell<Option<Renderer>>);
// SAFETY: wasm32-unknown-unknown without threads is single-threaded; native callers are tests
// that use `Renderer` directly.
unsafe impl Sync for Global {}
static STATE: Global = Global(UnsafeCell::new(None));

fn r() -> &'static mut Renderer {
    // SAFETY: single-threaded; no reference outlives one exported call.
    unsafe { (*STATE.0.get()).get_or_insert_with(Renderer::new) }
}

fn staging_bytes(r: &Renderer) -> &[u8] {
    crate::gpu::as_bytes(&r.staging)
}

#[no_mangle]
pub extern "C" fn tb_init() -> u32 {
    let r = r();
    r.out = r.pipes.to_json().into_bytes();
    ABI_VERSION
}

/// Pointer/length of the last string or index list the renderer produced (`tb_init`, `tb_schema`).
#[no_mangle]
pub extern "C" fn tb_out_ptr() -> u32 {
    r().out.as_ptr() as u32
}
#[no_mangle]
pub extern "C" fn tb_out_len() -> u32 {
    r().out.len() as u32
}

/// Ensure `bytes` of 8-byte-aligned staging and return its pointer.
#[no_mangle]
pub extern "C" fn tb_staging(bytes: u32) -> u32 {
    let r = r();
    let words = (bytes as usize + 7) / 8;
    if r.staging.len() < words {
        r.staging.resize(words.next_power_of_two(), 0);
    }
    r.staging.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn tb_attach(slot: u32, width: f32, height: f32, dpr: f32) {
    r().attach(slot, width, height, dpr);
}
#[no_mangle]
pub extern "C" fn tb_resize(slot: u32, width: f32, height: f32, dpr: f32) {
    r().resize(slot, width, height, dpr);
}
#[no_mangle]
pub extern "C" fn tb_detach(slot: u32) {
    r().detach(slot);
}

/// `view` = View code, or anything else for automatic choice.
#[no_mangle]
pub extern "C" fn tb_set_view(slot: u32, view: u32) {
    let r = r();
    r.clear_events();
    r.set_view(slot, View::from_u32(view));
}

/// Parameter name: `name_len` UTF-8 bytes at the staging pointer.
#[no_mangle]
pub extern "C" fn tb_set_param(slot: u32, name_len: u32, value: f64) {
    let r = r();
    let name = String::from_utf8_lossy(&staging_bytes(r)[..name_len as usize]).into_owned();
    r.set_param(slot, &name, value);
}

#[no_mangle]
pub extern "C" fn tb_bind(slot: u32, request: u32, revision: u32, epoch: u32) -> u32 {
    r().bind(slot, Binding { request, revision, epoch }) as u32
}
#[no_mangle]
pub extern "C" fn tb_unbind(slot: u32, request: u32) -> u32 {
    r().unbind(slot, request) as u32
}
/// Slot bound to `request` (created under `epoch`), or -1 (fenced).
#[no_mangle]
pub extern "C" fn tb_accepts(request: u32, epoch: u32) -> i32 {
    r().accepts(request, epoch).map_or(-1, |s| s as i32)
}

fn word(bytes: &[u8], i: usize) -> u32 {
    u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap())
}

/// Describe the result schema (see module docs). Returns the number of needed columns, whose
/// indices (u32) are at `tb_out_ptr`, or -1 if the request is not bound.
#[no_mangle]
pub extern "C" fn tb_schema(request: u32, epoch: u32, ncols: u32) -> i32 {
    let r = r();
    r.clear_events();
    let bytes = staging_bytes(r);
    let mut columns = Vec::with_capacity(ncols as usize);
    for c in 0..ncols as usize {
        let (code, param, off, len) = (word(bytes, c * 4), word(bytes, c * 4 + 1), word(bytes, c * 4 + 2) as usize, word(bytes, c * 4 + 3) as usize);
        let name = String::from_utf8_lossy(&bytes[off..off + len]).into_owned();
        columns.push(ColumnInfo { name, ty: ColumnType { code: TypeCode::from_u32(code), param } });
    }
    match r.schema(request, epoch, columns) {
        Some(needed) => {
            r.out.clear();
            for n in &needed {
                r.out.extend_from_slice(&(*n as u32).to_le_bytes());
            }
            needed.len() as i32
        }
        None => -1,
    }
}

/// Append a batch (see module docs). Returns flags: 1 accepted, 2 first draw ready (urgent).
#[no_mangle]
pub extern "C" fn tb_batch(request: u32, epoch: u32, rows: u32, ncols: u32) -> u32 {
    let r = r();
    r.clear_events();
    let staging = core::mem::take(&mut r.staging);
    let flags = {
        let bytes = crate::gpu::as_bytes(&staging);
        let types: Vec<(TypeCode, u32)> = match r.accepts(request, epoch).and_then(|slot| r.slots.iter().find(|s| s.id == slot)) {
            Some(s) => match s.pending.as_ref().filter(|p| p.request == request).or(s.shown.as_ref().filter(|p| p.request == request)) {
                Some(res) => res.store.columns.iter().map(|c| (c.ty.code, c.ty.param)).collect(),
                None => Vec::new(),
            },
            None => Vec::new(),
        };
        if types.is_empty() {
            0
        } else {
            let slice = |off: u32, len: u32| -> &[u8] {
                if off == NONE {
                    &[]
                } else {
                    &bytes[off as usize..(off + len) as usize]
                }
            };
            let mut raw = Vec::with_capacity(ncols as usize);
            for c in 0..ncols as usize {
                let w = |k: usize| word(bytes, c * 12 + k);
                let index = w(0) as usize;
                let Some(&(code, param)) = types.get(index) else { continue };
                raw.push(RawColumn {
                    index,
                    code,
                    param,
                    rows: rows as usize,
                    data: slice(w(1), w(2)),
                    validity: if w(3) == NONE { None } else { Some((slice(w(3), w(4)), w(5) as usize)) },
                    bit_offset: w(5) as usize,
                    offsets: slice(w(6), w(7)),
                    dict: if w(8) == NONE { None } else { Some((slice(w(8), w(9)), slice(w(10), w(11)))) },
                });
            }
            r.batch(request, epoch, rows as usize, &raw)
        }
    };
    r.staging = staging;
    flags
}

#[no_mangle]
pub extern "C" fn tb_done(request: u32, epoch: u32) -> u32 {
    r().done(request, epoch)
}

/// Bitmask of available views for the slot's bound result.
#[no_mangle]
pub extern "C" fn tb_views(slot: u32) -> u32 {
    r().views(slot)
}

/// 1 when a frame has work (dirty slots or queued buffer ops).
#[no_mangle]
pub extern "C" fn tb_needs_frame() -> u32 {
    r().needs_frame() as u32
}

/// Build a frame. Returns the number of command words at `tb_words_ptr`.
#[no_mangle]
pub extern "C" fn tb_frame(urgent_only: u32) -> u32 {
    let r = r();
    r.clear_events();
    r.frame(urgent_only != 0).len() as u32
}
#[no_mangle]
pub extern "C" fn tb_words_ptr() -> u32 {
    r().words.as_ptr() as u32
}
/// The shim replayed the frame; drop its words.
#[no_mangle]
pub extern "C" fn tb_frame_done() {
    r().frame_done();
}

#[no_mangle]
pub extern "C" fn tb_events_ptr() -> u32 {
    r().events.as_ptr() as u32
}
/// Number of u32 words of events (6 per event).
#[no_mangle]
pub extern "C" fn tb_events_len() -> u32 {
    r().events.len() as u32
}
#[no_mangle]
pub extern "C" fn tb_strings_ptr() -> u32 {
    r().strings.as_ptr() as u32
}

// ───────────────────────── measurement kernels (render-bench only) ─────────────────────────

/// min/max of `n` f64 at the staging pointer: 0 = scalar, 1 = SIMD128. Returns max - min.
#[no_mangle]
pub extern "C" fn tb_bench_minmax(n: u32, simd: u32) -> f64 {
    let r = r();
    let bytes = staging_bytes(r);
    let values: &[f64] = crate::bench::as_f64(&bytes[..n as usize * 8]);
    let (lo, hi) = if simd != 0 { crate::bench::minmax_simd(values) } else { crate::bench::minmax_scalar(values) };
    hi - lo
}

/// f64 → relative f32 conversion of `n` values at the staging pointer into a reused buffer
/// (the per-row work ingest does). Returns the sum of outputs to defeat dead-code removal.
#[no_mangle]
pub extern "C" fn tb_bench_convert(n: u32) -> f64 {
    let r = r();
    let bytes = staging_bytes(r);
    let values: &[f64] = crate::bench::as_f64(&bytes[..n as usize * 8]);
    let origin = values.first().copied().unwrap_or(0.0);
    let mut out: Vec<f32> = Vec::with_capacity(values.len());
    out.extend(values.iter().map(|v| (v - origin) as f32));
    out.iter().map(|&v| v as f64).sum()
}
