//! Arrow IPC stream → one encapsulated message at a time, without decoding or re-encoding
//! column data.
//!
//! ClickHouse's `ArrowStream` output is a sequence of encapsulated messages:
//! `0xFFFFFFFF` continuation marker, `i32` metadata length, a flatbuffer `Message`, then
//! `bodyLength` bytes of body (protocol-v1 RESULT_SCHEMA/BATCH payloads are exactly these
//! messages). The splitter reads only what it needs from the flatbuffer: header type,
//! `bodyLength`, the batch row count and compression, and for schemas the top-level field
//! types. Body bytes are copied once, from the HTTP chunk straight into the outgoing tb1
//! frame buffer, behind a header region the caller reserves. A full arrow-rs dependency
//! would parse (and allocate) far more than this needs.
//!
//! Alignment: the frame header is 24 + 16·n bytes, so the payload starts 8-aligned, and the
//! body follows `8 + metadata length` bytes into it. If a producer's metadata length were not
//! a multiple of 8 the splitter pads it (the IPC format allows padding inside the metadata
//! length) so Arrow buffers stay viewable in place on the receiving side.

use core::fmt;

pub const CONTINUATION: u32 = 0xFFFF_FFFF;
/// Largest flatbuffer metadata accepted (schemas with many columns are a few KiB).
pub const MAX_METADATA: usize = 1 << 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeaderType {
    Schema,
    DictionaryBatch,
    RecordBatch,
    Other(u8),
}

/// Arrow `Type` union tags (Schema.fbs) used to decide whether a schema needs a type check.
pub mod arrow_type {
    pub const INT: u8 = 2;
    pub const FIXED_SIZE_BINARY: u8 = 15;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FieldType {
    pub tag: u8,
    /// For `Int`: (bit width, signed).
    pub int: Option<(i32, bool)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageInfo {
    pub header: HeaderType,
    /// Record batch length (rows); 0 for other messages.
    pub rows: u64,
    pub body_len: usize,
    /// Encapsulated message length as forwarded: 8 + padded metadata + body.
    pub payload_len: usize,
    /// Record batch uses IPC body compression (cannot be viewed in place).
    pub compressed: bool,
    /// Schema: top-level field types.
    pub fields: Vec<FieldType>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum IpcError {
    /// The bytes at a message boundary are not an encapsulated message (e.g. ClickHouse
    /// appended an exception block). `take_buffered` returns what was already consumed.
    NotIpc,
    Malformed(&'static str),
    TooLarge(usize),
    Truncated,
}

impl fmt::Display for IpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IpcError::NotIpc => write!(f, "result stream is not Arrow IPC"),
            IpcError::Malformed(what) => write!(f, "malformed Arrow IPC message: {what}"),
            IpcError::TooLarge(n) => write!(f, "Arrow IPC message of {n} bytes exceeds the frame limit"),
            IpcError::Truncated => write!(f, "Arrow IPC stream ended inside a message"),
        }
    }
}

pub enum Item {
    /// A complete message. `buf[..prefix]` is the region the caller reserved (zeroed);
    /// `buf[prefix..]` is the encapsulated message.
    Message { info: MessageInfo, buf: Vec<u8>, prefix: usize },
    /// A message the caller chose to skip (its body was discarded).
    Skipped(MessageInfo),
    /// End-of-stream marker.
    End,
}

enum State {
    /// Reading the 8-byte prefix and the metadata into `head`.
    Head,
    /// Copying body bytes into `out` (or discarding them when `out` is None).
    Body { info: MessageInfo, out: Option<(Vec<u8>, usize)>, remaining: usize },
    Ended,
}

pub struct Splitter {
    head: Vec<u8>,
    state: State,
    max_payload: usize,
}

impl Splitter {
    /// `max_payload`: largest encapsulated message forwarded (the tb1 payload limit).
    pub fn new(max_payload: usize) -> Splitter {
        Splitter { head: Vec::with_capacity(512), state: State::Head, max_payload }
    }

    pub fn ended(&self) -> bool {
        matches!(self.state, State::Ended)
    }

    /// True between messages (a stream may end here only after the end marker, but an
    /// HTTP body that stops here without one lost nothing mid-message).
    pub fn at_boundary(&self) -> bool {
        matches!(self.state, State::Head) && self.head.is_empty()
    }

    /// Bytes consumed but not yet emitted (head of a message, or of a non-IPC tail).
    pub fn take_buffered(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.head)
    }

    /// Consume bytes from `input` until one item completes or `input` is empty. `reserve`
    /// decides, once a message's metadata is known, how many header bytes to reserve in front
    /// of it (`Some(prefix)`) or to skip it (`None`).
    pub fn feed(
        &mut self,
        input: &mut &[u8],
        mut reserve: impl FnMut(&MessageInfo) -> Option<usize>,
    ) -> Result<Option<Item>, IpcError> {
        loop {
            match &mut self.state {
                State::Ended => {
                    // Bytes after the end marker are ignored.
                    *input = &[];
                    return Ok(None);
                }
                State::Head => {
                    if !self.fill_head(input, 8) {
                        return Ok(None);
                    }
                    if u32_le(&self.head, 0) != CONTINUATION {
                        return Err(IpcError::NotIpc);
                    }
                    let meta_len = u32_le(&self.head, 4) as usize;
                    if meta_len == 0 {
                        self.head.clear();
                        self.state = State::Ended;
                        return Ok(Some(Item::End));
                    }
                    if meta_len > MAX_METADATA || meta_len > i32::MAX as usize {
                        return Err(IpcError::Malformed("metadata length"));
                    }
                    if !self.fill_head(input, 8 + meta_len) {
                        return Ok(None);
                    }
                    let mut info = parse_message(&self.head[8..8 + meta_len])?;
                    let pad = (8 - (8 + meta_len) % 8) % 8;
                    info.payload_len = 8 + meta_len + pad + info.body_len;
                    if info.payload_len > self.max_payload {
                        return Err(IpcError::TooLarge(info.payload_len));
                    }
                    let out = reserve(&info).map(|prefix| {
                        let mut buf = Vec::with_capacity(prefix + info.payload_len);
                        buf.resize(prefix, 0);
                        buf.extend_from_slice(&CONTINUATION.to_le_bytes());
                        buf.extend_from_slice(&((meta_len + pad) as u32).to_le_bytes());
                        buf.extend_from_slice(&self.head[8..8 + meta_len]);
                        buf.resize(buf.len() + pad, 0);
                        (buf, prefix)
                    });
                    self.head.clear();
                    let remaining = info.body_len;
                    self.state = State::Body { info, out, remaining };
                }
                State::Body { remaining, out, .. } => {
                    let take = (*remaining).min(input.len());
                    if let Some((buf, _)) = out.as_mut() {
                        buf.extend_from_slice(&input[..take]);
                    }
                    *input = &input[take..];
                    *remaining -= take;
                    if *remaining > 0 {
                        return Ok(None);
                    }
                    let State::Body { info, out, .. } = std::mem::replace(&mut self.state, State::Head) else {
                        unreachable!()
                    };
                    return Ok(Some(match out {
                        Some((buf, prefix)) => Item::Message { info, buf, prefix },
                        None => Item::Skipped(info),
                    }));
                }
            }
        }
    }

    /// Move bytes from `input` into `head` until it holds `want` bytes.
    fn fill_head(&mut self, input: &mut &[u8], want: usize) -> bool {
        if self.head.len() < want {
            let take = (want - self.head.len()).min(input.len());
            self.head.extend_from_slice(&input[..take]);
            *input = &input[take..];
        }
        self.head.len() >= want
    }

    /// Call when the byte source ends: an error unless the stream ended cleanly (end
    /// marker, or a boundary between messages).
    pub fn finish(&self) -> Result<(), IpcError> {
        match self.state {
            State::Ended => Ok(()),
            State::Head if self.head.is_empty() => Ok(()),
            _ => Err(IpcError::Truncated),
        }
    }
}

fn u32_le(buf: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(buf[at..at + 4].try_into().unwrap())
}

// ───────────────────────── minimal flatbuffer reader ─────────────────────────

/// A flatbuffer table: position of the table and of its vtable in `buf`.
#[derive(Clone, Copy)]
struct Table<'a> {
    buf: &'a [u8],
    pos: usize,
    vtable: usize,
    vtable_len: usize,
}

type Fb<T> = Result<T, IpcError>;
const BAD: IpcError = IpcError::Malformed("flatbuffer");

fn read<const N: usize>(buf: &[u8], at: usize) -> Fb<[u8; N]> {
    buf.get(at..at.checked_add(N).ok_or(BAD)?).and_then(|s| s.try_into().ok()).ok_or(BAD)
}
fn rd_u32(buf: &[u8], at: usize) -> Fb<u32> {
    Ok(u32::from_le_bytes(read(buf, at)?))
}
fn rd_i32(buf: &[u8], at: usize) -> Fb<i32> {
    Ok(i32::from_le_bytes(read(buf, at)?))
}
fn rd_u16(buf: &[u8], at: usize) -> Fb<u16> {
    Ok(u16::from_le_bytes(read(buf, at)?))
}
fn rd_i64(buf: &[u8], at: usize) -> Fb<i64> {
    Ok(i64::from_le_bytes(read(buf, at)?))
}

impl<'a> Table<'a> {
    fn at(buf: &'a [u8], pos: usize) -> Fb<Table<'a>> {
        let vtable = (pos as i64 - rd_i32(buf, pos)? as i64).try_into().map_err(|_| BAD)?;
        let vtable_len = rd_u16(buf, vtable)? as usize;
        if vtable_len < 4 || vtable + vtable_len > buf.len() {
            return Err(BAD);
        }
        Ok(Table { buf, pos, vtable, vtable_len })
    }
    fn root(buf: &'a [u8]) -> Fb<Table<'a>> {
        Table::at(buf, rd_u32(buf, 0)? as usize)
    }
    /// Absolute position of field `index`, or None if absent.
    fn field(&self, index: usize) -> Fb<Option<usize>> {
        let slot = 4 + 2 * index;
        if slot + 2 > self.vtable_len {
            return Ok(None);
        }
        let offset = rd_u16(self.buf, self.vtable + slot)? as usize;
        Ok((offset != 0).then_some(self.pos + offset))
    }
    fn u8(&self, index: usize, default: u8) -> Fb<u8> {
        Ok(match self.field(index)? {
            Some(at) => *self.buf.get(at).ok_or(BAD)?,
            None => default,
        })
    }
    fn i32(&self, index: usize, default: i32) -> Fb<i32> {
        self.field(index)?.map_or(Ok(default), |at| rd_i32(self.buf, at))
    }
    fn i64(&self, index: usize, default: i64) -> Fb<i64> {
        self.field(index)?.map_or(Ok(default), |at| rd_i64(self.buf, at))
    }
    /// Target position of an offset field (table, vector or string).
    fn target(&self, index: usize) -> Fb<Option<usize>> {
        match self.field(index)? {
            Some(at) => Ok(Some(at.checked_add(rd_u32(self.buf, at)? as usize).ok_or(BAD)?)),
            None => Ok(None),
        }
    }
    fn table(&self, index: usize) -> Fb<Option<Table<'a>>> {
        self.target(index)?.map(|at| Table::at(self.buf, at)).transpose()
    }
    /// Elements of a vector of tables.
    fn tables(&self, index: usize) -> Fb<Vec<Table<'a>>> {
        let Some(at) = self.target(index)? else { return Ok(Vec::new()) };
        let len = rd_u32(self.buf, at)? as usize;
        if len > 1 << 16 {
            return Err(BAD);
        }
        (0..len)
            .map(|i| {
                let slot = at + 4 + 4 * i;
                Table::at(self.buf, slot + rd_u32(self.buf, slot)? as usize)
            })
            .collect()
    }
}

/// Read what the relay needs from a flatbuffer `Message` (Message.fbs).
pub fn parse_message(meta: &[u8]) -> Result<MessageInfo, IpcError> {
    let message = Table::root(meta)?;
    // Message: 0 version, 1 header_type, 2 header, 3 bodyLength, 4 custom_metadata.
    let header = match message.u8(1, 0)? {
        1 => HeaderType::Schema,
        2 => HeaderType::DictionaryBatch,
        3 => HeaderType::RecordBatch,
        other => HeaderType::Other(other),
    };
    let body_len = message.i64(3, 0)?;
    if body_len < 0 {
        return Err(IpcError::Malformed("negative body length"));
    }
    let body_len = usize::try_from(body_len).map_err(|_| IpcError::TooLarge(usize::MAX))?;
    let mut info = MessageInfo {
        header,
        rows: 0,
        body_len,
        payload_len: 0,
        compressed: false,
        fields: Vec::new(),
    };
    let header_table = message.table(2)?;
    match (header, header_table) {
        (HeaderType::RecordBatch, Some(batch)) => {
            // RecordBatch: 0 length, 1 nodes, 2 buffers, 3 compression.
            info.rows = u64::try_from(batch.i64(0, 0)?).map_err(|_| IpcError::Malformed("row count"))?;
            info.compressed = batch.field(3)?.is_some();
        }
        (HeaderType::Schema, Some(schema)) => {
            // Schema: 0 endianness, 1 fields. Field: 2 type_type, 3 type. Int: 0 bitWidth, 1 is_signed.
            for field in schema.tables(1)? {
                let tag = field.u8(2, 0)?;
                let int = if tag == arrow_type::INT {
                    match field.table(3)? {
                        Some(t) => Some((t.i32(0, 0)?, t.u8(1, 0)? != 0)),
                        None => None,
                    }
                } else {
                    None
                };
                info.fields.push(FieldType { tag, int });
            }
        }
        (HeaderType::Schema | HeaderType::RecordBatch, None) => return Err(IpcError::Malformed("missing header")),
        _ => {}
    }
    Ok(info)
}

/// Whether a ClickHouse result schema may contain a column whose Arrow type loses meaning:
/// `DateTime` and `IPv4` arrive as UInt32, `Enum8/16` as Int8/Int16, `UUID`, `IPv6` and
/// 128/256-bit integers as FixedSizeBinary. Only then is the column list worth checking.
pub fn schema_is_ambiguous(fields: &[FieldType]) -> bool {
    fields.iter().any(|f| match (f.tag, f.int) {
        (arrow_type::FIXED_SIZE_BINARY, _) => true,
        (arrow_type::INT, Some((32, false))) => true,
        (arrow_type::INT, Some((8 | 16, true))) => true,
        _ => false,
    })
}

#[cfg(test)]
mod tests;
