//! Raw C-ABI exports for the Wasm build (no wasm-bindgen). JS loader: `src/engine/coordinator.ts`.
//!
//! Protocol per call:
//! 1. JS writes one encoded frame into memory from `tb_alloc` and calls `tb_coord_input`
//!    (0 = ok, nonzero = error; message via `tb_last_error_ptr`/`_len`).
//! 2. `tb_coord_flush` encodes the outbox into one reusable buffer and returns the frame
//!    count. `tb_coord_out_index` points at `count × [link, offset, len]` (u32) and
//!    `tb_coord_out_bytes` at the encoded frames. Both stay valid until the next call
//!    into the handle.
//!
//! Pointers and lengths are `usize` (= u32 on wasm32). The functions also build natively,
//! which is how they are tested.

use crate::{Coordinator, InputError, LinkId};
use core::sync::atomic::{AtomicUsize, Ordering};
use tb_protocol::DecodeError;

pub const OK: i32 = 0;
pub const ERR_DECODE: i32 = 1;
pub const ERR_LINK: i32 = 2;
pub const ERR_UTF8: i32 = 3;
pub const ERR_CONFIG: i32 = 4;
pub const ERR_PAYLOAD: i32 = 5;
pub const ERR_HANDLE: i32 = 6;

pub struct Handle {
    core: Coordinator,
    bytes: Vec<u8>,
    index: Vec<u32>,
}

static ERROR_PTR: AtomicUsize = AtomicUsize::new(0);
static ERROR_LEN: AtomicUsize = AtomicUsize::new(0);

fn fail(code: i32, message: &'static str) -> i32 {
    ERROR_PTR.store(message.as_ptr() as usize, Ordering::Relaxed);
    ERROR_LEN.store(message.len(), Ordering::Relaxed);
    code
}

fn decode_message(error: DecodeError) -> &'static str {
    match error {
        DecodeError::Truncated => "truncated frame",
        DecodeError::Version(_) => "unsupported frame version",
        DecodeError::Kind(_) => "unknown frame kind",
        DecodeError::PayloadTooLarge(_) => "payload exceeds limit",
        DecodeError::TrailingBytes => "bytes after payload",
        DecodeError::ReservedStamp => "nonzero reserved stamp field",
        DecodeError::HeaderOnlyPayload => "HEADER_ONLY frame carries a payload",
    }
}

#[no_mangle]
pub extern "C" fn tb_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buffer.as_mut_ptr();
    core::mem::forget(buffer);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from one `tb_alloc(len)` call.
#[no_mangle]
pub unsafe extern "C" fn tb_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
    }
}

#[no_mangle]
pub extern "C" fn tb_coord_new() -> *mut Handle {
    Box::into_raw(Box::new(Handle { core: Coordinator::new(), bytes: Vec::with_capacity(4096), index: Vec::with_capacity(48) }))
}

/// # Safety
/// `handle` from `tb_coord_new`, not yet freed.
#[no_mangle]
pub unsafe extern "C" fn tb_coord_free(handle: *mut Handle) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

/// # Safety
/// `handle` live; `ptr..ptr+len` readable.
#[no_mangle]
pub unsafe extern "C" fn tb_coord_input(handle: *mut Handle, link: u32, ptr: *const u8, len: usize, now: f64) -> i32 {
    let Some(handle) = handle.as_mut() else { return fail(ERR_HANDLE, "null coordinator handle") };
    let Some(link) = LinkId::from_u32(link) else { return fail(ERR_LINK, "unknown link id") };
    let bytes = if len == 0 { &[][..] } else { core::slice::from_raw_parts(ptr, len) };
    let frame = match tb_protocol::decode(bytes) {
        Ok(frame) => frame,
        Err(error) => return fail(ERR_DECODE, decode_message(error)),
    };
    match handle.core.input(link, frame, now) {
        Ok(()) => OK,
        Err(error) => fail(
            match error {
                InputError::InvalidUtf8 => ERR_UTF8,
                InputError::InvalidConfig => ERR_CONFIG,
                InputError::InvalidPayload => ERR_PAYLOAD,
            },
            error.message(),
        ),
    }
}

/// # Safety
/// `handle` live.
#[no_mangle]
pub unsafe extern "C" fn tb_coord_tick(handle: *mut Handle, now: f64) {
    if let Some(handle) = handle.as_mut() {
        handle.core.tick(now);
    }
}

/// NaN = no deadline.
///
/// # Safety
/// `handle` live.
#[no_mangle]
pub unsafe extern "C" fn tb_coord_next_deadline(handle: *const Handle) -> f64 {
    handle.as_ref().and_then(|h| h.core.next_deadline()).unwrap_or(f64::NAN)
}

/// Encode and clear the outbox; returns the number of frames.
///
/// # Safety
/// `handle` live.
#[no_mangle]
pub unsafe extern "C" fn tb_coord_flush(handle: *mut Handle) -> u32 {
    let Some(h) = handle.as_mut() else { return 0 };
    h.bytes.clear();
    h.index.clear();
    for (link, frame) in h.core.drain() {
        let offset = h.bytes.len();
        tb_protocol::encode_into(&frame.header, &frame.stamps, &frame.payload, &mut h.bytes);
        h.index.extend_from_slice(&[link as u32, offset as u32, (h.bytes.len() - offset) as u32]);
    }
    (h.index.len() / 3) as u32
}

/// # Safety
/// `handle` live.
#[no_mangle]
pub unsafe extern "C" fn tb_coord_out_index(handle: *const Handle) -> *const u32 {
    handle.as_ref().map_or(core::ptr::null(), |h| h.index.as_ptr())
}

/// # Safety
/// `handle` live.
#[no_mangle]
pub unsafe extern "C" fn tb_coord_out_bytes(handle: *const Handle) -> *const u8 {
    handle.as_ref().map_or(core::ptr::null(), |h| h.bytes.as_ptr())
}

#[no_mangle]
pub extern "C" fn tb_last_error_ptr() -> *const u8 {
    ERROR_PTR.load(Ordering::Relaxed) as *const u8
}

#[no_mangle]
pub extern "C" fn tb_last_error_len() -> usize {
    ERROR_LEN.load(Ordering::Relaxed)
}
