//! One EXEC on the DuckDB backend: guard → streaming execution → Arrow IPC encapsulated
//! messages → RESULT_SCHEMA / BATCH… / DONE (or ERROR), in the same frames and with the same
//! limits, stamps and identities as the ClickHouse path (src/exec.rs).
//!
//! DuckDB is blocking, so the query runs on a blocking worker thread that owns a pooled
//! connection. Frames go to the async side through a channel of two: the async side forwards
//! each one through the session's send window before taking the next, so a slow browser stops
//! DuckDB's fetch loop (backpressure) instead of buffering the result.
//!
//! - **First batch as early as possible:** the first non-empty DuckDB chunk (≤ 2,048 rows) is
//!   framed and sent on its own; later chunks are coalesced up to `batch_rows` rows (or 2 MiB)
//!   per BATCH, which keeps message count low for large results.
//! - **Cancel:** dropping the job (CANCEL, link closed) or the timeout marks the [`Control`]
//!   cancelled and interrupts the connection until the worker returns. A cancelled job sends
//!   nothing: the channel's receiver is gone with the job, and the session fences the rest.
//! - IPC: metadata V5, 8-byte alignment. The frame header (24 + 16·n bytes) is reserved in
//!   front of the message, so the payload and every Arrow buffer stay 8-aligned for viewing in
//!   place in the browser.
use std::sync::{Arc, atomic::Ordering};

use arrow_array::RecordBatch;
use arrow_ipc::{
    MetadataVersion,
    writer::{DictionaryTracker, EncodedData, IpcDataGenerator, IpcWriteOptions, write_message},
};
use arrow_schema::Schema;
use tb_protocol::{Header, Kind, MAX_PAYLOAD, Stamp, stage};
use tokio::sync::mpsc;

use super::{Control, DuckDb, Statement, cast_batch, undictionary};
use crate::{
    clickhouse::Failure,
    config::Limits,
    exec::{ExecJob, NO_STAMP, ONE_STAMP, Outbox, Stats, error_frame, frame, seal, stamp},
    now_ms,
};

/// Coalesced BATCH bodies stay below this (in-memory Arrow size), far under the 16 MiB frame.
pub const COALESCE_BYTES: usize = 2 << 20;

enum Msg {
    /// A RESULT_SCHEMA or BATCH frame.
    Frame(Vec<u8>),
    /// The final frame (DONE), with the worker's statistics.
    Done(Vec<u8>, Stats),
    Fail(Failure, Stats),
}

/// Marks the query cancelled (and interrupts it) unless the job completed.
struct CancelOnDrop {
    control: Arc<Control>,
    armed: bool,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.control.cancel();
        }
    }
}

pub async fn run(duck: Arc<DuckDb>, limits: &Limits, job: ExecJob, out: Outbox) -> Stats {
    let deadline = tokio::time::Instant::from_std(job.received + limits.time);
    let header = job.header;
    let received_at = job.received_at;
    let control = Arc::new(Control::default());
    let mut guard = CancelOnDrop { control: control.clone(), armed: true };
    let (tx, mut rx) = mpsc::channel::<Msg>(2);
    let limits_for_worker = limits.clone();

    let forwarded = tokio::time::timeout_at(deadline, async {
        // The permit lives on the worker thread, as long as DuckDB works on the query.
        let Ok(permit) = duck.queries.clone().acquire_owned().await else {
            return Err((Failure::new("unavailable", "database is shutting down"), Stats::default()));
        };
        let worker_duck = duck.clone();
        let worker_control = control.clone();
        duck.running.fetch_add(1, Ordering::AcqRel);
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            produce(&worker_duck, &limits_for_worker, job, &worker_control, tx);
            worker_control.finished.store(true, Ordering::Release);
            worker_duck.running.fetch_sub(1, Ordering::AcqRel);
        });
        while let Some(msg) = rx.recv().await {
            match msg {
                Msg::Frame(bytes) => {
                    if !out.send(header.request, bytes, false).await {
                        return Ok(Stats::default()); // session gone
                    }
                }
                Msg::Done(bytes, stats) => {
                    out.send(header.request, bytes, true).await;
                    return Ok(stats);
                }
                Msg::Fail(failure, stats) => return Err((failure, stats)),
            }
        }
        Err((Failure::new("sql_error", "query worker stopped"), Stats::default()))
    })
    .await;

    let (failure, mut stats) = match forwarded {
        Ok(Ok(stats)) => {
            guard.armed = false;
            return stats;
        }
        Ok(Err((failure, stats))) => {
            guard.armed = false;
            (failure, stats)
        }
        Err(_) => {
            control.cancel(); // stop DuckDB now; the guard would only do it on drop
            (Failure::new("timeout", format!("Query exceeded {} ms", limits.time.as_millis())), Stats::default())
        }
    };
    stats.outcome = "error";
    out.send(header.request, error_frame(&header, received_at, failure.code, &failure.message), true).await;
    stats
}

/// The worker: runs on a blocking thread until the result is complete, failed or cancelled.
fn produce(duck: &DuckDb, limits: &Limits, job: ExecJob, control: &Control, tx: mpsc::Sender<Msg>) {
    let mut stats = Stats { attempts: 1, ..Stats::default() };
    let conn = match duck.checkout() {
        Ok(conn) => conn,
        Err(failure) => {
            let _ = tx.blocking_send(Msg::Fail(failure, stats));
            return;
        }
    };
    control.attach(&conn);
    let result = if control.cancelled() {
        Err(None)
    } else {
        stream(duck, limits, &job, control, &conn, &tx, &mut stats)
    };
    control.detach();
    duck.checkin(conn);
    match result {
        Ok(done) => {
            let _ = tx.blocking_send(Msg::Done(done, stats));
        }
        // Cancelled (or the receiver is gone): nothing more leaves this request.
        Err(None) => {}
        Err(Some(_)) if control.cancelled() => {}
        Err(Some(failure)) => {
            let _ = tx.blocking_send(Msg::Fail(failure, stats));
        }
    }
}

/// `Err(None)`: cancelled or nobody is listening any more.
fn stream(
    duck: &DuckDb,
    limits: &Limits,
    job: &ExecJob,
    control: &Control,
    conn: &super::Conn,
    tx: &mpsc::Sender<Msg>,
    stats: &mut Stats,
) -> Result<Vec<u8>, Option<Failure>> {
    let h = job.header;
    let mut result = Statement::prepare(conn, &job.sql).map_err(Some)?.execute().map_err(Some)?;
    let source_schema = result.schema.clone();
    let cast = undictionary(&source_schema);
    let schema = cast.clone().unwrap_or(source_schema);
    let mut encoder = Encoder::new(&schema).map_err(Some)?;

    let schema_frame = encoder.schema(&Header { kind: Kind::ResultSchema, flags: 0, ..h }, job.received_at).map_err(Some)?;
    send(tx, control, Msg::Frame(schema_frame))?;

    let mut pending: Vec<RecordBatch> = Vec::new();
    let (mut pending_rows, mut pending_bytes) = (0usize, 0usize);
    let batch_rows = duck.config.batch_rows;
    loop {
        if control.cancelled() {
            return Err(None);
        }
        let next = result.next().map_err(Some)?;
        let end = next.is_none();
        if let Some(batch) = next {
            let batch = match &cast {
                Some(target) => cast_batch(&batch, target).map_err(Some)?,
                None => batch,
            };
            pending_rows += batch.num_rows();
            pending_bytes += batch.get_array_memory_size();
            pending.push(batch);
        }
        // The first batch goes out alone; later ones once enough rows (or bytes) are waiting.
        let flush = !pending.is_empty() && (stats.batches == 0 || end || pending_rows >= batch_rows || pending_bytes >= COALESCE_BYTES);
        if flush {
            let batch = if pending.len() == 1 {
                pending.pop().unwrap()
            } else {
                let joined = arrow_select::concat::concat_batches(&schema, &pending).map_err(|e| Some(Failure::new("sql_error", e.to_string())))?;
                pending.clear();
                joined
            };
            (pending_rows, pending_bytes) = (0, 0);
            stats.rows += batch.num_rows() as u64;
            if stats.rows > limits.max_rows {
                return Err(Some(limit(limits)));
            }
            let first = stats.batches == 0;
            let header = Header { kind: Kind::Batch, flags: 0, ..h };
            let bytes = encoder.batch(&header, &batch, first)?;
            stats.bytes += (bytes.len() - if first { ONE_STAMP } else { NO_STAMP }) as u64;
            if stats.bytes > limits.max_bytes {
                return Err(Some(limit(limits)));
            }
            if first {
                stats.first_batch_ms = Some(job.received.elapsed().as_secs_f64() * 1000.0);
            }
            stats.batches += 1;
            send(tx, control, Msg::Frame(bytes))?;
        }
        if end {
            break;
        }
    }
    let mut payload = [0u8; 16];
    payload[..8].copy_from_slice(&stats.rows.to_le_bytes());
    payload[8..].copy_from_slice(&stats.bytes.to_le_bytes());
    stats.done_ms = Some(job.received.elapsed().as_secs_f64() * 1000.0);
    stats.outcome = "done";
    Ok(frame(&h, Kind::Done, &[stamp(stage::DB_DONE, now_ms())], &payload))
}

fn limit(limits: &Limits) -> Failure {
    Failure::new("result_limit", format!("Result exceeds {} rows or {} bytes", limits.max_rows, limits.max_bytes))
}

fn send(tx: &mpsc::Sender<Msg>, control: &Control, msg: Msg) -> Result<(), Option<Failure>> {
    if control.cancelled() || tx.blocking_send(msg).is_err() {
        return Err(None);
    }
    Ok(())
}

/// Arrow IPC encapsulated messages written straight behind a reserved tb1 header.
pub struct Encoder {
    generator: IpcDataGenerator,
    tracker: DictionaryTracker,
    options: IpcWriteOptions,
    schema: Arc<Schema>,
}

impl Encoder {
    pub fn new(schema: &Arc<Schema>) -> Result<Encoder, Failure> {
        let options = IpcWriteOptions::try_new(8, false, MetadataVersion::V5).map_err(|e| Failure::new("sql_error", e.to_string()))?;
        Ok(Encoder { generator: IpcDataGenerator::default(), tracker: DictionaryTracker::new(false), options, schema: schema.clone() })
    }

    fn message(&self, prefix: usize, encoded: EncodedData) -> Result<Vec<u8>, Failure> {
        let size = prefix + 8 + encoded.ipc_message.len() + 8 + encoded.arrow_data.len();
        let mut buf = Vec::with_capacity(size);
        buf.resize(prefix, 0);
        write_message(&mut buf, encoded, &self.options).map_err(|e| Failure::new("sql_error", format!("Arrow IPC: {e}")))?;
        if buf.len() - prefix > MAX_PAYLOAD {
            return Err(Failure::new("result_limit", format!("An Arrow batch of {} bytes exceeds the frame limit", buf.len() - prefix)));
        }
        Ok(buf)
    }

    /// RESULT_SCHEMA frame (stamp EXEC_RECEIVED).
    pub fn schema(&mut self, header: &Header, received_at: f64) -> Result<Vec<u8>, Failure> {
        let encoded = self.generator.schema_to_bytes_with_dictionary_tracker(&self.schema, &mut self.tracker, &self.options);
        let mut buf = self.message(ONE_STAMP, encoded)?;
        seal(&mut buf, header, &[stamp(stage::EXEC_RECEIVED, received_at)]);
        Ok(buf)
    }

    /// BATCH frame; the first carries DB_FIRST_BATCH.
    pub fn batch(&mut self, header: &Header, batch: &RecordBatch, first: bool) -> Result<Vec<u8>, Option<Failure>> {
        let (dictionaries, encoded) = self
            .generator
            .encoded_batch(batch, &mut self.tracker, &self.options)
            .map_err(|e| Some(Failure::new("sql_error", format!("Arrow IPC: {e}"))))?;
        if !dictionaries.is_empty() {
            return Err(Some(Failure::new("sql_error", "Nested ENUM (dictionary) columns are not supported; cast them to VARCHAR")));
        }
        let mut buf = self.message(if first { ONE_STAMP } else { NO_STAMP }, encoded).map_err(Some)?;
        let stamps: &[Stamp] = if first { &[stamp(stage::DB_FIRST_BATCH, now_ms())] } else { &[] };
        seal(&mut buf, header, stamps);
        Ok(buf)
    }
}
