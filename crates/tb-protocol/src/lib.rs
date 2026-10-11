//! Frame codec for time-blast protocol v1 (`tb1`). See `docs/protocol-v1.md`.
//!
//! Decoding borrows: a [`FrameRef`] points into the input buffer and copies nothing.
//! Encoding appends to a caller-owned `Vec<u8>` so hot paths can reuse one allocation.
#![forbid(unsafe_code)]

use core::fmt;

pub const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 24;
pub const STAMP_LEN: usize = 16;
pub const MAX_PAYLOAD: usize = 16 << 20;
pub const MAX_STAMPS: usize = 255;
/// WebSocket subprotocol name.
pub const SUBPROTOCOL: &str = "tb1";

/// Frame kinds. Values are wire constants; never renumber.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Kind {
    Hello = 0x01,
    Ready = 0x02,
    Context = 0x03,
    Status = 0x04,
    Error = 0x05,
    Config = 0x06,
    Draft = 0x10,
    Commit = 0x11,
    Cancel = 0x12,
    /// UI → coordinator: execute this SQL for a slot (chart-as-query; no translation).
    Query = 0x13,
    Infer = 0x18,
    SqlDelta = 0x19,
    Sql = 0x1A,
    InferStats = 0x1B,
    Exec = 0x20,
    ResultSchema = 0x21,
    Batch = 0x22,
    Done = 0x23,
    Bind = 0x30,
    Unbind = 0x31,
    Drawn = 0x32,
    Result = 0x33,
    Timing = 0x34,
    Keep = 0x35,
}

impl Kind {
    pub const ALL: [Kind; 24] = [
        Kind::Hello, Kind::Ready, Kind::Context, Kind::Status, Kind::Error, Kind::Config,
        Kind::Draft, Kind::Commit, Kind::Cancel, Kind::Query, Kind::Infer, Kind::SqlDelta, Kind::Sql,
        Kind::InferStats, Kind::Exec, Kind::ResultSchema, Kind::Batch, Kind::Done, Kind::Bind,
        Kind::Unbind, Kind::Drawn, Kind::Result, Kind::Timing, Kind::Keep,
    ];

    pub fn from_u8(value: u8) -> Option<Kind> {
        Kind::ALL.iter().copied().find(|kind| *kind as u8 == value)
    }

    pub fn name(self) -> &'static str {
        match self {
            Kind::Hello => "HELLO", Kind::Ready => "READY", Kind::Context => "CONTEXT",
            Kind::Status => "STATUS", Kind::Error => "ERROR", Kind::Config => "CONFIG",
            Kind::Draft => "DRAFT", Kind::Commit => "COMMIT", Kind::Cancel => "CANCEL", Kind::Query => "QUERY",
            Kind::Infer => "INFER", Kind::SqlDelta => "SQL_DELTA", Kind::Sql => "SQL",
            Kind::InferStats => "INFER_STATS", Kind::Exec => "EXEC",
            Kind::ResultSchema => "RESULT_SCHEMA", Kind::Batch => "BATCH", Kind::Done => "DONE",
            Kind::Bind => "BIND", Kind::Unbind => "UNBIND", Kind::Drawn => "DRAWN",
            Kind::Result => "RESULT", Kind::Timing => "TIMING", Kind::Keep => "KEEP",
        }
    }
}

/// Flag bits. Bits below 0x80 are kind-specific.
pub mod flags {
    /// DRAFT: IME composition in progress.
    pub const COMPOSING: u8 = 0x01;
    /// SQL: answered from the inference node's cache.
    pub const CACHED: u8 = 0x01;
    /// EXEC: speculative (lower priority than committed work).
    pub const SPECULATIVE: u8 = 0x01;
    /// SQL_DELTA: discard earlier deltas of this request (a repair restarted the SQL).
    pub const RESET: u8 = 0x02;
    /// DONE: the result was served from a pre-aggregated rollup.
    pub const ROLLUP: u8 = 0x01;
    /// DONE: the result was replayed from the database node's result cache.
    pub const RESULT_CACHE: u8 = 0x02;
    /// Payload deliberately omitted (e.g. BATCH copy sent to the coordinator).
    pub const HEADER_ONLY: u8 = 0x80;
}

/// Node ids used in stamps.
pub mod node {
    pub const UI: u16 = 1;
    pub const COORDINATOR: u16 = 2;
    pub const INFERENCE: u16 = 3;
    pub const DATABASE: u16 = 4;
    pub const RENDERER: u16 = 5;
    pub const PROVIDER: u16 = 6;
}

/// Trace stages. See the table in `docs/protocol-v1.md`.
pub mod stage {
    pub const KEY_INPUT: u16 = 1;
    pub const DRAFT_SENT: u16 = 2;
    pub const COORD_RECEIVED: u16 = 3;
    pub const INFER_SENT: u16 = 4;
    pub const INFER_RECEIVED: u16 = 5;
    pub const PROVIDER_REQUEST: u16 = 6;
    pub const FIRST_TOKEN: u16 = 7;
    pub const SQL_FIRST_DELTA: u16 = 8;
    pub const SQL_COMPLETE: u16 = 9;
    pub const SQL_RECEIVED: u16 = 10;
    pub const EXEC_SENT: u16 = 11;
    pub const EXEC_RECEIVED: u16 = 12;
    pub const DB_FIRST_BATCH: u16 = 13;
    pub const DB_DONE: u16 = 14;
    pub const RENDER_FIRST_BATCH: u16 = 15;
    pub const FIRST_DRAW_SUBMITTED: u16 = 16;
    pub const FIRST_PRESENTED: u16 = 17;
    pub const CACHE_HIT: u16 = 18;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stamp {
    pub stage: u16,
    pub node: u16,
    /// Unix epoch milliseconds.
    pub at: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub kind: Kind,
    pub flags: u8,
    pub epoch: u32,
    pub request: u32,
    pub revision: u32,
    pub context: u32,
}

impl Header {
    pub fn new(kind: Kind) -> Header {
        Header { kind, flags: 0, epoch: 0, request: 0, revision: 0, context: 0 }
    }
    pub fn has(&self, flag: u8) -> bool {
        self.flags & flag != 0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    Truncated,
    Version(u8),
    Kind(u8),
    PayloadTooLarge(usize),
    TrailingBytes,
    ReservedStamp,
    HeaderOnlyPayload,
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DecodeError::Truncated => write!(f, "truncated frame"),
            DecodeError::Version(v) => write!(f, "unsupported frame version {v}"),
            DecodeError::Kind(k) => write!(f, "unknown frame kind 0x{k:02x}"),
            DecodeError::PayloadTooLarge(n) => write!(f, "payload of {n} bytes exceeds limit"),
            DecodeError::TrailingBytes => write!(f, "bytes after payload"),
            DecodeError::ReservedStamp => write!(f, "nonzero reserved stamp field"),
            DecodeError::HeaderOnlyPayload => write!(f, "HEADER_ONLY frame carries a payload"),
        }
    }
}

impl std::error::Error for DecodeError {}

/// A decoded frame borrowing its input.
#[derive(Clone, Copy, Debug)]
pub struct FrameRef<'a> {
    pub header: Header,
    stamps: &'a [u8],
    pub payload: &'a [u8],
}

impl<'a> FrameRef<'a> {
    pub fn stamp_count(&self) -> usize {
        self.stamps.len() / STAMP_LEN
    }
    pub fn stamps(&self) -> impl Iterator<Item = Stamp> + 'a {
        self.stamps.chunks_exact(STAMP_LEN).map(read_stamp)
    }
    pub fn text(&self) -> Result<&'a str, core::str::Utf8Error> {
        core::str::from_utf8(self.payload)
    }
    pub fn to_owned(&self) -> Frame {
        Frame { header: self.header, stamps: self.stamps().collect(), payload: self.payload.to_vec() }
    }
}

fn read_stamp(raw: &[u8]) -> Stamp {
    Stamp {
        stage: u16::from_le_bytes([raw[0], raw[1]]),
        node: u16::from_le_bytes([raw[2], raw[3]]),
        at: f64::from_le_bytes(raw[8..16].try_into().unwrap()),
    }
}

/// Decode exactly one frame occupying all of `buf`.
pub fn decode(buf: &[u8]) -> Result<FrameRef<'_>, DecodeError> {
    let (frame, used) = decode_prefix(buf)?;
    if used != buf.len() {
        return Err(DecodeError::TrailingBytes);
    }
    Ok(frame)
}

/// Decode one frame from the start of `buf`; returns it and the bytes consumed.
pub fn decode_prefix(buf: &[u8]) -> Result<(FrameRef<'_>, usize), DecodeError> {
    if buf.len() < HEADER_LEN {
        return Err(DecodeError::Truncated);
    }
    if buf[0] != VERSION {
        return Err(DecodeError::Version(buf[0]));
    }
    let kind = Kind::from_u8(buf[1]).ok_or(DecodeError::Kind(buf[1]))?;
    let flags = buf[2];
    let stamps = buf[3] as usize;
    let len = u32_at(buf, 4) as usize;
    if len > MAX_PAYLOAD {
        return Err(DecodeError::PayloadTooLarge(len));
    }
    if flags & flags::HEADER_ONLY != 0 && len != 0 {
        return Err(DecodeError::HeaderOnlyPayload);
    }
    let stamps_end = HEADER_LEN + stamps * STAMP_LEN;
    let end = stamps_end + len;
    if buf.len() < end {
        return Err(DecodeError::Truncated);
    }
    let stamp_bytes = &buf[HEADER_LEN..stamps_end];
    if stamp_bytes.chunks_exact(STAMP_LEN).any(|s| s[4..8] != [0, 0, 0, 0]) {
        return Err(DecodeError::ReservedStamp);
    }
    let header = Header {
        kind,
        flags,
        epoch: u32_at(buf, 8),
        request: u32_at(buf, 12),
        revision: u32_at(buf, 16),
        context: u32_at(buf, 20),
    };
    Ok((FrameRef { header, stamps: stamp_bytes, payload: &buf[stamps_end..end] }, end))
}

fn u32_at(buf: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(buf[at..at + 4].try_into().unwrap())
}

pub fn encoded_len(stamps: usize, payload: usize) -> usize {
    HEADER_LEN + stamps * STAMP_LEN + payload
}

/// Append one encoded frame to `out`.
///
/// Panics if there are more than 255 stamps or the payload exceeds [`MAX_PAYLOAD`];
/// both are programming errors, not input errors.
pub fn encode_into(header: &Header, stamps: &[Stamp], payload: &[u8], out: &mut Vec<u8>) {
    assert!(stamps.len() <= MAX_STAMPS, "too many stamps");
    assert!(payload.len() <= MAX_PAYLOAD, "payload too large");
    assert!(header.flags & flags::HEADER_ONLY == 0 || payload.is_empty(), "HEADER_ONLY with payload");
    out.reserve(encoded_len(stamps.len(), payload.len()));
    out.push(VERSION);
    out.push(header.kind as u8);
    out.push(header.flags);
    out.push(stamps.len() as u8);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(&header.epoch.to_le_bytes());
    out.extend_from_slice(&header.request.to_le_bytes());
    out.extend_from_slice(&header.revision.to_le_bytes());
    out.extend_from_slice(&header.context.to_le_bytes());
    for stamp in stamps {
        out.extend_from_slice(&stamp.stage.to_le_bytes());
        out.extend_from_slice(&stamp.node.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&stamp.at.to_le_bytes());
    }
    out.extend_from_slice(payload);
}

/// An owned frame, for queues and state that outlive the input buffer.
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    pub header: Header,
    pub stamps: Vec<Stamp>,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(header: Header, payload: impl Into<Vec<u8>>) -> Frame {
        Frame { header, stamps: Vec::new(), payload: payload.into() }
    }
    pub fn stamp(mut self, stage: u16, node: u16, at: f64) -> Frame {
        self.stamps.push(Stamp { stage, node, at });
        self
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        encode_into(&self.header, &self.stamps, &self.payload, &mut out);
        out
    }
}

#[cfg(test)]
mod tests;
