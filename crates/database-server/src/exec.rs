//! One EXEC: guard → ClickHouse `ArrowStream` → RESULT_SCHEMA / BATCH frames → DONE.
//!
//! Each encapsulated IPC message is copied once, from the HTTP chunk into the frame buffer
//! that goes to the WebSocket; the tb1 header is written into space reserved in front of it.
//!
//! Result types: ClickHouse maps `DateTime` to Arrow UInt32 (and `Enum` to Int8/16, `UUID`
//! to FixedSizeBinary), which would draw a time axis as plain numbers. A `DESCRIBE` of the
//! statement runs **in parallel** with the query. If the result schema has no column of an
//! ambiguous Arrow type, it is forwarded at once and the DESCRIBE is dropped; otherwise the
//! DESCRIBE decides, and when a cast is needed the first query is killed and the statement
//! re-runs under a casting projection (`DateTime` → `DateTime64(0)`, Arrow Timestamp). The
//! decision is cached per SQL text.
use std::{
    collections::HashMap,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Instant,
};

use serde_json::json;
use tb_protocol::{Header, Kind, MAX_PAYLOAD, Stamp, encode_into, node, stage};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};

use crate::{
    clickhouse::{ClickHouse, Failure, cast_projection, exception_text, parse_code, error_code},
    config::Limits,
    guard::{self, Guard},
    ipc::{HeaderType, IpcError, Item, MessageInfo, Splitter, schema_is_ambiguous},
    now_ms,
};

/// A frame leaving a job: encoded bytes, and whether it is the request's last. `credit` is
/// held until the WebSocket writer has written the frame (or the frame is discarded).
pub struct Output {
    pub request: u32,
    pub bytes: Vec<u8>,
    pub last: bool,
    pub credit: Option<OwnedSemaphorePermit>,
}

/// Bytes of encoded frames a session may have queued for its socket. A browser that reads
/// slowly makes jobs wait here, which stops reading ClickHouse's response (TCP backpressure)
/// instead of buffering whole results in memory.
pub const SEND_WINDOW: usize = 8 << 20;

/// Where a job's frames go: the session loop, behind the session's send window.
#[derive(Clone)]
pub struct Outbox {
    pub tx: mpsc::UnboundedSender<Output>,
    pub window: Arc<Semaphore>,
}

impl Outbox {
    pub fn new(tx: mpsc::UnboundedSender<Output>) -> Outbox {
        Outbox { tx, window: Arc::new(Semaphore::new(SEND_WINDOW)) }
    }
    /// False once the session is gone.
    pub async fn send(&self, request: u32, bytes: Vec<u8>, last: bool) -> bool {
        let need = bytes.len().clamp(1, SEND_WINDOW) as u32;
        let Ok(credit) = self.window.clone().acquire_many_owned(need).await else { return false };
        self.tx.send(Output { request, bytes, last, credit: Some(credit) }).is_ok()
    }
}

pub struct ExecJob {
    /// Header of the EXEC; every reply echoes its epoch, request, revision and context.
    pub header: Header,
    pub sql: String,
    pub received_at: f64,
    pub received: Instant,
    /// ClickHouse query id prefix, unique per process and request.
    pub query_id: String,
}

/// SQL text → cast projection (None: no cast needed). Bounded; cleared when full.
#[derive(Default)]
pub struct CastCache {
    map: Mutex<HashMap<String, Option<String>>>,
}

impl CastCache {
    const MAX: usize = 1024;
    pub fn get(&self, sql: &str) -> Option<Option<String>> {
        self.map.lock().unwrap().get(sql).cloned()
    }
    pub fn put(&self, sql: &str, projection: Option<String>) {
        let mut map = self.map.lock().unwrap();
        if map.len() >= Self::MAX {
            map.clear();
        }
        map.insert(sql.to_string(), projection);
    }
}

/// Where model SQL runs.
pub enum Backend {
    ClickHouse(ClickHouse),
    #[cfg(feature = "duckdb")]
    DuckDb(Arc<crate::duck::DuckDb>),
}

impl Backend {
    /// DatasetContext / READY dialect.
    pub fn dialect(&self) -> &'static str {
        match self {
            Backend::ClickHouse(_) => "clickhouse",
            #[cfg(feature = "duckdb")]
            Backend::DuckDb(_) => "duckdb",
        }
    }
    pub fn name(&self) -> &'static str {
        self.dialect()
    }
}

pub struct Shared {
    pub backend: Backend,
    pub limits: Limits,
    pub casts: CastCache,
    pub totals: Mutex<Totals>,
}

/// Process-wide counters for `/health`.
#[derive(Default)]
pub struct Totals {
    pub done: u64,
    pub errors: u64,
    pub rows: u64,
    pub bytes: u64,
    pub described: u64,
    pub restarts: u64,
}

impl Shared {
    pub fn record(&self, stats: &Stats) {
        let mut t = self.totals.lock().unwrap();
        match stats.outcome {
            "done" => t.done += 1,
            "error" => t.errors += 1,
            _ => {}
        }
        t.rows += stats.rows;
        t.bytes += stats.bytes;
        t.described += stats.described as u64;
        t.restarts += stats.attempts.saturating_sub(1) as u64;
    }
}

#[derive(Debug, Default, Clone)]
pub struct Stats {
    pub outcome: &'static str,
    pub rows: u64,
    pub bytes: u64,
    pub batches: u32,
    /// Query attempts (2 when a cast projection re-ran the statement).
    pub attempts: u32,
    pub described: bool,
    pub first_batch_ms: Option<f64>,
    pub done_ms: Option<f64>,
}

/// Kills a ClickHouse query when dropped while armed (task aborted by CANCEL, link closed,
/// timeout or restart). Dropping the HTTP response also closes its connection, which
/// ClickHouse treats as a cancel (`cancel_http_readonly_queries_on_client_close`).
struct KillOnDrop {
    clickhouse: ClickHouse,
    query_id: String,
    armed: bool,
}

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let clickhouse = self.clickhouse.clone();
            let query_id = std::mem::take(&mut self.query_id);
            handle.spawn(async move { clickhouse.kill(&query_id).await });
        }
    }
}

pub(crate) const ONE_STAMP: usize = tb_protocol::HEADER_LEN + tb_protocol::STAMP_LEN;
pub(crate) const NO_STAMP: usize = tb_protocol::HEADER_LEN;

/// Write the tb1 header and stamps into the reserved front of `buf` (payload follows).
pub(crate) fn seal(buf: &mut [u8], header: &Header, stamps: &[Stamp]) {
    let prefix = tb_protocol::encoded_len(stamps.len(), 0);
    let mut head = Vec::with_capacity(prefix);
    encode_into(header, stamps, &[], &mut head);
    let payload_len = (buf.len() - prefix) as u32;
    head[4..8].copy_from_slice(&payload_len.to_le_bytes());
    buf[..prefix].copy_from_slice(&head);
}

pub(crate) fn frame(header: &Header, kind: Kind, stamps: &[Stamp], payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    encode_into(&Header { kind, flags: 0, ..*header }, stamps, payload, &mut out);
    out
}

pub(crate) fn stamp(stage: u16, at: f64) -> Stamp {
    Stamp { stage, node: node::DATABASE, at }
}

pub fn error_frame(header: &Header, received_at: f64, code: &str, message: &str) -> Vec<u8> {
    let body = json!({"code": code, "message": message}).to_string();
    frame(header, Kind::Error, &[stamp(stage::EXEC_RECEIVED, received_at)], body.as_bytes())
}

enum Step {
    Done,
    Restart(String),
    Fail(Failure),
}

type Describe = Pin<Box<dyn Future<Output = Result<Vec<(String, String)>, Failure>> + Send>>;

/// Run one EXEC to completion. Sends RESULT_SCHEMA, BATCH…, then DONE, or ERROR; the last
/// frame is marked `last`. A cancelled job is simply dropped (no frame).
pub async fn run(shared: Arc<Shared>, job: ExecJob, out: Outbox) -> Stats {
    let ch = match &shared.backend {
        Backend::ClickHouse(ch) => ch,
        #[cfg(feature = "duckdb")]
        Backend::DuckDb(duck) => return crate::duck::exec::run(duck.clone(), &shared.limits, job, out).await,
    };
    let deadline = tokio::time::Instant::from_std(job.received + shared.limits.time);
    let mut stats = Stats::default();
    let result = tokio::time::timeout_at(deadline, execute(&shared, ch, &job, &out, &mut stats)).await;
    let failure = match result {
        Ok(Ok(())) => None,
        Ok(Err(failure)) => Some(failure),
        Err(_) => Some(Failure::new("timeout", format!("Query exceeded {} ms", shared.limits.time.as_millis()))),
    };
    if let Some(Failure { code, message }) = failure {
        stats.outcome = "error";
        out.send(job.header.request, error_frame(&job.header, job.received_at, code, &message), true).await;
    }
    stats
}

async fn execute(shared: &Shared, ch: &ClickHouse, job: &ExecJob, out: &Outbox, stats: &mut Stats) -> Result<(), Failure> {
    let wrapped = match guard::guard(&job.sql) {
        Guard::Ok(sql) => sql,
        Guard::Rejected { code, message } => return Err(Failure::new(code, message)),
    };
    let inner = guard::inner(&wrapped);
    let mut sql = wrapped.clone();
    let mut describe: Option<Describe> = None;
    match shared.casts.get(&wrapped) {
        Some(Some(projection)) => sql = format!("SELECT {projection} FROM ({inner}\n)"),
        Some(None) => {}
        None => {
            let ch = ch.clone();
            let (inner, id) = (inner.to_string(), format!("{}-d", job.query_id));
            describe = Some(Box::pin(async move { ch.describe(&inner, &id).await }));
            stats.described = true;
        }
    }
    loop {
        stats.attempts += 1;
        match attempt(shared, ch, job, out, stats, &wrapped, &sql, &mut describe).await {
            Step::Done => return Ok(()),
            Step::Fail(failure) => return Err(failure),
            Step::Restart(projection) => {
                sql = format!("SELECT {projection} FROM ({inner}\n)");
                describe = None;
            }
        }
    }
}

/// Resolve a finished DESCRIBE: cache it and say whether to restart with a projection.
fn described(shared: &Shared, wrapped: &str, result: Result<Vec<(String, String)>, Failure>, can_restart: bool) -> Option<String> {
    let columns = result.ok()?;
    let projection = cast_projection(&columns);
    shared.casts.put(wrapped, projection.clone());
    projection.filter(|_| can_restart)
}

#[allow(clippy::too_many_arguments)]
async fn attempt(
    shared: &Shared,
    ch: &ClickHouse,
    job: &ExecJob,
    out: &Outbox,
    stats: &mut Stats,
    wrapped: &str,
    sql: &str,
    describe: &mut Option<Describe>,
) -> Step {
    let h = job.header;
    let query_id = format!("{}-{}", job.query_id, stats.attempts);
    let settings = ch.query_settings(&shared.limits, &query_id);
    let mut kill = KillOnDrop { clickhouse: ch.clone(), query_id: query_id.clone(), armed: true };
    // Restarting is only useful while nothing has been forwarded.
    let can_restart = stats.attempts == 1;

    let start = ch.start(sql, &settings);
    tokio::pin!(start);
    let response = loop {
        tokio::select! { biased;
            response = &mut start => break response,
            result = async { describe.as_mut().unwrap().await }, if describe.is_some() => {
                *describe = None;
                if let Some(projection) = described(shared, wrapped, result, can_restart) {
                    return Step::Restart(projection);
                }
            }
        }
    };
    let mut response = match response {
        Ok(response) => response,
        Err(failure) => {
            kill.armed = false; // ClickHouse already ended the query
            return Step::Fail(Failure { message: guard::unwrap_error(&failure.message), ..failure });
        }
    };

    let mut splitter = Splitter::new(MAX_PAYLOAD);
    let mut exception: Option<Vec<u8>> = None;
    let mut schema_sent = false;
    loop {
        let chunk = tokio::select! { biased;
            chunk = response.chunk() => chunk,
            result = async { describe.as_mut().unwrap().await }, if describe.is_some() => {
                *describe = None;
                if let Some(projection) = described(shared, wrapped, result, can_restart && !schema_sent) {
                    return Step::Restart(projection);
                }
                continue;
            }
        };
        let bytes = match chunk {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                kill.armed = false;
                if let Some(raw) = exception {
                    return Step::Fail(clickhouse_failure(&raw));
                }
                if let Err(error) = splitter.finish() {
                    return Step::Fail(Failure::new("sql_error", error.to_string()));
                }
                break;
            }
            Err(error) => {
                kill.armed = exception.is_none();
                return Step::Fail(match exception {
                    // ClickHouse closes the chunked body right after an exception block.
                    Some(raw) => clickhouse_failure(&raw),
                    None => Failure::new("unavailable", format!("ClickHouse stream failed: {error}")),
                });
            }
        };
        if let Some(raw) = exception.as_mut() {
            if raw.len() < 64 << 10 {
                raw.extend_from_slice(&bytes);
            }
            continue;
        }
        let mut input = &bytes[..];
        while !input.is_empty() {
            let first_batch = stats.batches == 0;
            let item = splitter.feed(&mut input, |info: &MessageInfo| match info.header {
                HeaderType::Schema => Some(ONE_STAMP),
                HeaderType::RecordBatch if info.rows > 0 => Some(if first_batch { ONE_STAMP } else { NO_STAMP }),
                _ => None,
            });
            match item {
                Ok(None) | Ok(Some(Item::End)) => {}
                Ok(Some(Item::Skipped(info))) => {
                    if !matches!(info.header, HeaderType::RecordBatch) {
                        return Step::Fail(Failure::new("sql_error", format!("unsupported Arrow IPC message {:?}", info.header)));
                    }
                }
                Ok(Some(Item::Message { info, mut buf, .. })) => match info.header {
                    HeaderType::Schema => {
                        if schema_is_ambiguous(&info.fields) {
                            if let Some(pending) = describe.take() {
                                if let Some(projection) = described(shared, wrapped, pending.await, can_restart) {
                                    return Step::Restart(projection);
                                }
                            }
                        } else if describe.take().is_some() {
                            // Unambiguous Arrow types: no DESCRIBE needed for this SQL again.
                            shared.casts.put(wrapped, None);
                        }
                        seal(&mut buf, &Header { kind: Kind::ResultSchema, flags: 0, ..h }, &[stamp(stage::EXEC_RECEIVED, job.received_at)]);
                        schema_sent = true;
                        if !out.send(h.request, buf, false).await {
                            return Step::Done;
                        }
                    }
                    HeaderType::RecordBatch => {
                        if info.compressed {
                            return Step::Fail(Failure::new("sql_error", "ClickHouse sent a compressed Arrow batch"));
                        }
                        stats.rows += info.rows;
                        stats.bytes += info.payload_len as u64;
                        if stats.rows > shared.limits.max_rows || stats.bytes > shared.limits.max_bytes {
                            return Step::Fail(Failure::new(
                                "result_limit",
                                format!("Result exceeds {} rows or {} bytes", shared.limits.max_rows, shared.limits.max_bytes),
                            ));
                        }
                        let stamps: &[Stamp] = if first_batch {
                            stats.first_batch_ms = Some(job.received.elapsed().as_secs_f64() * 1000.0);
                            &[stamp(stage::DB_FIRST_BATCH, now_ms())]
                        } else {
                            &[]
                        };
                        seal(&mut buf, &Header { kind: Kind::Batch, flags: 0, ..h }, stamps);
                        stats.batches += 1;
                        if !out.send(h.request, buf, false).await {
                            return Step::Done;
                        }
                    }
                    _ => unreachable!("reserve only accepts schemas and batches"),
                },
                Err(IpcError::NotIpc) => {
                    let mut raw = splitter.take_buffered();
                    raw.extend_from_slice(input);
                    exception = Some(raw);
                    break;
                }
                Err(IpcError::TooLarge(n)) => {
                    return Step::Fail(Failure::new("result_limit", format!("An Arrow batch of {n} bytes exceeds the frame limit")));
                }
                Err(error) => return Step::Fail(Failure::new("sql_error", error.to_string())),
            }
        }
    }
    if !schema_sent {
        return Step::Fail(Failure::new("sql_error", "ClickHouse returned no Arrow schema"));
    }
    let mut payload = [0u8; 16];
    payload[..8].copy_from_slice(&stats.rows.to_le_bytes());
    payload[8..].copy_from_slice(&stats.bytes.to_le_bytes());
    stats.done_ms = Some(job.received.elapsed().as_secs_f64() * 1000.0);
    stats.outcome = "done";
    out.send(h.request, frame(&h, Kind::Done, &[stamp(stage::DB_DONE, now_ms())], &payload), true).await;
    Step::Done
}

fn clickhouse_failure(raw: &[u8]) -> Failure {
    let text = exception_text(raw);
    Failure::new(error_code(parse_code(&text)), guard::unwrap_error(&text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tb_protocol::decode;

    #[test]
    fn sealed_prefix_decodes_as_the_frame_around_the_payload() {
        let header = Header { kind: Kind::Batch, flags: 0, epoch: 3, request: 9, revision: 4, context: 7 };
        let mut buf = vec![0u8; ONE_STAMP];
        buf.extend_from_slice(b"arrow-message-bytes");
        seal(&mut buf, &header, &[stamp(stage::DB_FIRST_BATCH, 1234.5)]);
        let frame = decode(&buf).unwrap();
        assert_eq!(frame.header, header);
        assert_eq!(frame.payload, b"arrow-message-bytes");
        assert_eq!(frame.stamps().next().unwrap(), Stamp { stage: stage::DB_FIRST_BATCH, node: node::DATABASE, at: 1234.5 });
        assert_eq!(tb_protocol::encoded_len(1, 0) % 8, 0, "payload starts 8-aligned");

        let mut bare = vec![0u8; NO_STAMP];
        bare.extend_from_slice(&[1, 2, 3]);
        seal(&mut bare, &header, &[]);
        assert_eq!(decode(&bare).unwrap().payload, [1, 2, 3]);
    }

    #[tokio::test]
    async fn send_window_holds_jobs_until_frames_are_written() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let out = Outbox::new(tx);
        assert!(out.send(1, vec![0; SEND_WINDOW - 10], false).await);
        let blocked = tokio::spawn({
            let out = out.clone();
            async move { out.send(1, vec![0; 100], true).await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!blocked.is_finished(), "window full: the job waits");
        let first = rx.recv().await.unwrap();
        drop(first); // written (or discarded): credit returns
        assert!(blocked.await.unwrap());
        assert!(rx.recv().await.unwrap().last);
    }

    #[test]
    fn error_frames_echo_the_exec_identity() {
        let header = Header { kind: Kind::Exec, flags: 1, epoch: 2, request: 5, revision: 6, context: 7 };
        let bytes = error_frame(&header, 10.0, "sql_rejected", "nope");
        let frame = decode(&bytes).unwrap();
        assert_eq!(frame.header.kind, Kind::Error);
        assert_eq!(frame.header.flags, 0);
        assert_eq!((frame.header.epoch, frame.header.request, frame.header.revision, frame.header.context), (2, 5, 6, 7));
        assert_eq!(frame.text().unwrap(), r#"{"code":"sql_rejected","message":"nope"}"#);
    }
}
