//! One `tb1` WebSocket session of the database node: HELLO → READY + CONTEXT, EXEC jobs,
//! CANCEL and epoch fencing. Mirrors the browser node (`src/engine/database-node.ts`):
//!
//! - EXEC with an epoch below the session's, or for another context, is dropped silently.
//! - CANCEL request 0 cancels everything and adopts the new epoch; request ≠ 0 cancels that
//!   request only. **A cancelled request gets no frame at all** (no DONE, no ERROR): frames a
//!   job produced before it was aborted are discarded here.
//! - Up to `concurrency` EXECs run at once (FIFO beyond that, at most `max_queued` waiting;
//!   more → ERROR `queue_full`). Every reply echoes the EXEC's epoch/request/revision/context.
//! - Closing the link cancels everything it started (each job's ClickHouse query is killed).
//!
//! Decisions live in [`Session`] (synchronous, IO-free); [`run`] wires it to the socket.
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use fastwebsockets::{Frame as WsFrame, OpCode, Payload, upgrade};
use serde_json::{Value, json};
use tb_protocol::{Frame, Header, Kind, decode};
use tokio::{
    sync::{Semaphore, mpsc},
    task::{AbortHandle, JoinSet},
};

use crate::{
    config::Limits,
    exec::{self, ExecJob, Outbox, Output, error_frame},
    now_ms,
    service::App,
};

/// Largest accepted WebSocket message (EXEC carries only SQL text).
pub const MESSAGE_LIMIT: usize = 1 << 20;
pub const MAX_SQL_BYTES: usize = 256 << 10;
/// Context id used when HELLO does not name one.
pub const DEFAULT_CONTEXT: u32 = 1;

static QUERY_SEQ: AtomicU64 = AtomicU64::new(0);

pub enum Action {
    Send(Vec<u8>),
    /// Send READY then CONTEXT (computed by the service) with this id.
    Greet(u32),
    Spawn(ExecJob),
    Abort(u32),
    /// Protocol violation: send the frame (if any) and close.
    Close(Option<Vec<u8>>),
}

pub struct Session {
    pub greeted: bool,
    pub epoch: u32,
    pub context: u32,
    /// Active (running or waiting) requests → their EXEC epoch.
    active: HashMap<u32, u32>,
    limits: Limits,
    session_tag: u64,
}

impl Session {
    pub fn new(limits: Limits) -> Session {
        Session {
            greeted: false,
            epoch: 0,
            context: 0,
            active: HashMap::new(),
            limits,
            session_tag: QUERY_SEQ.fetch_add(1, Ordering::Relaxed),
        }
    }

    pub fn input(&mut self, frame: &Frame, received_at: f64, received: Instant) -> Vec<Action> {
        let h = frame.header;
        if !self.greeted {
            if h.kind != Kind::Hello {
                return vec![Action::Close(Some(protocol_error("The first frame must be HELLO.")))];
            }
            self.greeted = true;
            // HELLO may name the context id the peer will use for this dataset.
            let hello: Value = serde_json::from_slice(&frame.payload).unwrap_or(Value::Null);
            self.context = hello
                .get("context")
                .and_then(Value::as_u64)
                .and_then(|id| u32::try_from(id).ok())
                .filter(|id| *id != 0)
                .unwrap_or(DEFAULT_CONTEXT);
            return vec![Action::Greet(self.context)];
        }
        match h.kind {
            Kind::Hello => vec![Action::Close(Some(protocol_error("HELLO was already received.")))],
            Kind::Cancel => self.cancel(h.epoch, h.request),
            Kind::Exec => self.exec(frame, received_at, received),
            // Frames meant for other nodes are ignored, not fatal.
            _ => Vec::new(),
        }
    }

    fn cancel(&mut self, epoch: u32, request: u32) -> Vec<Action> {
        if request == 0 {
            self.epoch = self.epoch.max(epoch);
            return self.active.drain().map(|(id, _)| Action::Abort(id)).collect();
        }
        match self.active.remove(&request) {
            Some(_) => vec![Action::Abort(request)],
            None => Vec::new(),
        }
    }

    fn exec(&mut self, frame: &Frame, received_at: f64, received: Instant) -> Vec<Action> {
        let h = frame.header;
        if h.epoch < self.epoch || h.context != self.context {
            return Vec::new(); // stale or for another dataset: dropped like the browser node
        }
        let reject = |code: &str, message: &str| vec![Action::Send(error_frame(&h, received_at, code, message))];
        if self.active.contains_key(&h.request) {
            return reject("sql_rejected", "Request id is already active.");
        }
        if self.active.len() >= self.limits.concurrency + self.limits.max_queued {
            return reject("queue_full", &format!("More than {} queries are waiting", self.limits.max_queued));
        }
        let sql = match std::str::from_utf8(&frame.payload) {
            Ok(sql) if sql.len() <= MAX_SQL_BYTES => sql.to_string(),
            _ => return reject("sql_rejected", "SQL must be UTF-8 of at most 256 KiB."),
        };
        self.active.insert(h.request, h.epoch);
        vec![Action::Spawn(ExecJob {
            header: h,
            sql,
            received_at,
            received,
            query_id: format!("tb-{}-{}-{}", std::process::id(), self.session_tag, h.request),
        })]
    }

    /// A frame produced by a job. Returns it if it may still leave the process.
    pub fn job_output(&mut self, request: u32, last: bool) -> bool {
        let Some(&epoch) = self.active.get(&request) else { return false };
        if epoch < self.epoch {
            self.active.remove(&request);
            return false;
        }
        if last {
            self.active.remove(&request);
        }
        true
    }

    pub fn active(&self) -> usize {
        self.active.len()
    }
}

fn protocol_error(message: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let body = json!({"code": "protocol", "message": message}).to_string();
    tb_protocol::encode_into(&Header::new(Kind::Error), &[], body.as_bytes(), &mut out);
    out
}

/// Bounded assembly of fragmented binary messages.
#[derive(Default)]
pub struct Assembler {
    partial: Option<Vec<u8>>,
}

impl Assembler {
    pub fn push(&mut self, opcode: OpCode, fin: bool, payload: &[u8]) -> Result<Option<Vec<u8>>, &'static str> {
        match opcode {
            OpCode::Binary if self.partial.is_none() => {
                if payload.len() > MESSAGE_LIMIT {
                    return Err("message too large");
                }
                if fin {
                    return Ok(Some(payload.to_vec()));
                }
                self.partial = Some(payload.to_vec());
                Ok(None)
            }
            OpCode::Continuation => {
                let data = self.partial.as_mut().ok_or("unexpected continuation")?;
                if data.len().saturating_add(payload.len()) > MESSAGE_LIMIT {
                    return Err("message too large");
                }
                data.extend_from_slice(payload);
                Ok(if fin { self.partial.take() } else { None })
            }
            OpCode::Ping | OpCode::Pong => Ok(None),
            OpCode::Text => Err("text messages are not part of tb1"),
            _ => Err("unexpected opcode"),
        }
    }
}

enum Outgoing {
    /// An encoded frame; a job's frames carry their send-window credit until written.
    Frame(Vec<u8>, Option<tokio::sync::OwnedSemaphorePermit>),
    Control(OpCode, Vec<u8>),
    Close,
}

pub async fn run(app: Arc<App>, upgrade: upgrade::UpgradeFut) {
    let Ok(Ok(mut socket)) = tokio::time::timeout(Duration::from_secs(10), upgrade).await else {
        return;
    };
    socket.set_max_message_size(MESSAGE_LIMIT);
    let (mut reader, mut writer) = socket.split(tokio::io::split);
    // Every frame is written as soon as it exists; BATCH frames are large single writes.
    writer.set_writev(false);
    let cancel = app.shutdown.child_token();
    let _guard = cancel.clone().drop_guard();

    let (output, mut pending_output) = mpsc::unbounded_channel::<Outgoing>();
    let writer_task = tokio::spawn(async move {
        while let Some(next) = pending_output.recv().await {
            let (opcode, bytes, close) = match next {
                Outgoing::Frame(bytes, credit) => {
                    let frame = WsFrame::new(true, OpCode::Binary, None, Payload::Owned(bytes));
                    let written = tokio::time::timeout(Duration::from_secs(10), writer.write_frame(frame)).await;
                    drop(credit);
                    if !matches!(written, Ok(Ok(()))) {
                        break;
                    }
                    continue;
                }
                Outgoing::Control(op, bytes) => (op, bytes, false),
                Outgoing::Close => (OpCode::Close, 1008u16.to_be_bytes().to_vec(), true),
            };
            let frame = WsFrame::new(true, opcode, None, Payload::Owned(bytes));
            if !matches!(tokio::time::timeout(Duration::from_secs(10), writer.write_frame(frame)).await, Ok(Ok(()))) || close {
                break;
            }
        }
    });

    let (input, mut pending_input) = mpsc::channel::<Result<(Vec<u8>, f64, Instant), &'static str>>(64);
    let reader_cancel = cancel.clone();
    let reader_output = output.clone();
    let connected_at = Instant::now();
    let last_pong = Arc::new(AtomicU64::new(0));
    let reader_pong = last_pong.clone();
    let reader_task = tokio::spawn(async move {
        let mut assembler = Assembler::default();
        let mut control = |frame: WsFrame<'_>| {
            let result = reader_output
                .send(Outgoing::Control(frame.opcode, frame.payload.to_vec()))
                .map_err(|_| std::io::Error::other("WebSocket writer closed"));
            async move { result }
        };
        loop {
            let frame = tokio::select! { biased; _ = reader_cancel.cancelled() => break, f = reader.read_frame(&mut control) => f };
            let Ok(frame) = frame else { break };
            if frame.opcode == OpCode::Close {
                break;
            }
            if frame.opcode == OpCode::Pong {
                reader_pong.store(connected_at.elapsed().as_secs(), Ordering::Relaxed);
            }
            match assembler.push(frame.opcode, frame.fin, &frame.payload) {
                Ok(Some(bytes)) => {
                    // Receipt time is taken here, before the session loop's queue.
                    if input.send(Ok((bytes, now_ms(), Instant::now()))).await.is_err() {
                        break;
                    }
                }
                Ok(None) => {}
                Err(reason) => {
                    let _ = input.send(Err(reason)).await;
                    break;
                }
            }
        }
    });

    let limits = app.limits.clone();
    let mut session = Session::new(limits.clone());
    let permits = Arc::new(Semaphore::new(limits.concurrency));
    let (jobs_tx, mut job_frames) = mpsc::unbounded_channel::<Output>();
    let jobs_out = Outbox::new(jobs_tx);
    let mut jobs: JoinSet<()> = JoinSet::new();
    let mut handles: HashMap<u32, AbortHandle> = HashMap::new();
    let mut last_message = Instant::now();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
    heartbeat.tick().await;
    let hello_deadline = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(hello_deadline);
    let send = |bytes: Vec<u8>| output.send(Outgoing::Frame(bytes, None)).is_ok();

    'session: loop {
        tokio::select! { biased;
            _ = cancel.cancelled() => break,
            _ = &mut hello_deadline, if !session.greeted => break,
            Some(Output { request, bytes, last, credit }) = job_frames.recv() => {
                if last {
                    handles.remove(&request);
                }
                // A discarded frame (cancelled request) drops its credit here.
                if session.job_output(request, last) && output.send(Outgoing::Frame(bytes, credit)).is_err() {
                    break;
                }
            }
            Some(_) = jobs.join_next(), if !jobs.is_empty() => {}
            message = pending_input.recv() => {
                let Some(message) = message else { break };
                last_message = Instant::now();
                let (bytes, received_at, received) = match message {
                    Ok(m) => m,
                    Err(reason) => {
                        send(protocol_error(reason));
                        let _ = output.send(Outgoing::Close);
                        break;
                    }
                };
                let frame = match decode(&bytes) {
                    Ok(frame) => frame.to_owned(),
                    Err(e) => {
                        send(protocol_error(&e.to_string()));
                        let _ = output.send(Outgoing::Close);
                        break;
                    }
                };
                for action in session.input(&frame, received_at, received) {
                    match action {
                        Action::Send(bytes) => if !send(bytes) { break 'session },
                        Action::Close(bytes) => {
                            if let Some(bytes) = bytes { send(bytes); }
                            let _ = output.send(Outgoing::Close);
                            break 'session;
                        }
                        Action::Greet(context) => {
                            let ready = json!({"node": "database", "name": "time-blast-database", "version": 1, "dialect": "clickhouse"});
                            if !send(Frame::new(Header::new(Kind::Ready), ready.to_string()).encode()) { break 'session }
                            match app.context().await {
                                Ok(mut value) => {
                                    value["id"] = json!(context);
                                    let header = Header { context, ..Header::new(Kind::Context) };
                                    if !send(Frame::new(header, value.to_string()).encode()) { break 'session }
                                }
                                Err(failure) => {
                                    let body = json!({"code": "dataset", "message": failure.message}).to_string();
                                    if !send(Frame::new(Header::new(Kind::Error), body).encode()) { break 'session }
                                }
                            }
                        }
                        Action::Abort(request) => {
                            // Dropping the job's future kills its ClickHouse query.
                            if let Some(handle) = handles.remove(&request) { handle.abort(); }
                        }
                        Action::Spawn(job) => {
                            let request = job.header.request;
                            let shared = app.shared.clone();
                            let out = jobs_out.clone();
                            let permits = permits.clone();
                            let handle = jobs.spawn(async move {
                                let Ok(_permit) = permits.acquire_owned().await else { return };
                                let stats = exec::run(shared.clone(), job, out).await;
                                shared.record(&stats);
                            });
                            handles.insert(request, handle);
                        }
                    }
                }
            }
            _ = heartbeat.tick() => {
                if connected_at.elapsed().as_secs().saturating_sub(last_pong.load(Ordering::Relaxed)) >= 75
                    || last_message.elapsed() >= Duration::from_secs(1800) { break; }
                if output.send(Outgoing::Control(OpCode::Ping, Vec::new())).is_err() { break; }
            }
        }
    }
    // Closing the link cancels everything it started.
    cancel.cancel();
    jobs.abort_all();
    while jobs.join_next().await.is_some() {}
    reader_task.abort();
    let _ = reader_task.await;
    drop(output);
    let _ = tokio::time::timeout(Duration::from_secs(1), writer_task).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(kind: Kind, epoch: u32, request: u32, context: u32, payload: &str) -> Frame {
        Frame::new(Header { kind, flags: 0, epoch, request, revision: 1, context }, payload)
    }
    fn greet(session: &mut Session, hello: &str) -> u32 {
        match session.input(&frame(Kind::Hello, 0, 0, 0, hello), 0.0, Instant::now()).as_slice() {
            [Action::Greet(id)] => *id,
            _ => panic!("expected Greet"),
        }
    }
    fn exec(session: &mut Session, epoch: u32, request: u32, context: u32) -> Vec<Action> {
        session.input(&frame(Kind::Exec, epoch, request, context, "SELECT 1"), 1.0, Instant::now())
    }
    fn error_code(actions: &[Action]) -> String {
        match actions {
            [Action::Send(bytes)] => {
                let f = decode(bytes).unwrap();
                assert_eq!(f.header.kind, Kind::Error);
                serde_json::from_slice::<Value>(f.payload).unwrap()["code"].as_str().unwrap().to_string()
            }
            _ => panic!("expected one ERROR"),
        }
    }

    #[test]
    fn hello_first_and_context_id_from_hello() {
        let mut s = Session::new(Limits::default());
        assert!(matches!(exec(&mut s, 0, 1, 1).as_slice(), [Action::Close(Some(_))]));
        let mut s = Session::new(Limits::default());
        assert_eq!(greet(&mut s, r#"{"node":"coordinator","context":7}"#), 7);
        assert!(matches!(s.input(&frame(Kind::Hello, 0, 0, 0, "{}"), 0.0, Instant::now()).as_slice(), [Action::Close(Some(_))]));
        let mut s = Session::new(Limits::default());
        assert_eq!(greet(&mut s, "{}"), DEFAULT_CONTEXT);
    }

    #[test]
    fn drops_stale_epochs_and_other_contexts() {
        let mut s = Session::new(Limits::default());
        greet(&mut s, r#"{"context":7}"#);
        assert!(exec(&mut s, 0, 1, 8).is_empty(), "other context");
        s.input(&frame(Kind::Cancel, 5, 0, 0, ""), 0.0, Instant::now());
        assert!(exec(&mut s, 4, 2, 7).is_empty(), "stale epoch");
        assert!(matches!(exec(&mut s, 5, 3, 7).as_slice(), [Action::Spawn(job)] if job.header.request == 3 && job.header.epoch == 5));
    }

    #[test]
    fn full_cancel_aborts_all_and_fences_outputs() {
        let mut s = Session::new(Limits::default());
        greet(&mut s, r#"{"context":7}"#);
        exec(&mut s, 1, 1, 7);
        exec(&mut s, 1, 2, 7);
        let mut aborted: Vec<u32> = s
            .input(&frame(Kind::Cancel, 2, 0, 0, ""), 0.0, Instant::now())
            .into_iter()
            .filter_map(|a| if let Action::Abort(r) = a { Some(r) } else { None })
            .collect();
        aborted.sort();
        assert_eq!(aborted, [1, 2]);
        assert_eq!(s.epoch, 2);
        assert!(!s.job_output(1, false), "a cancelled request emits nothing");
        assert!(!s.job_output(2, true));
    }

    #[test]
    fn targeted_cancel_keeps_the_epoch_and_other_requests() {
        let mut s = Session::new(Limits::default());
        greet(&mut s, r#"{"context":7}"#);
        exec(&mut s, 1, 1, 7);
        exec(&mut s, 1, 2, 7);
        assert!(matches!(s.input(&frame(Kind::Cancel, 1, 1, 0, ""), 0.0, Instant::now()).as_slice(), [Action::Abort(1)]));
        assert_eq!(s.epoch, 0);
        assert!(!s.job_output(1, false));
        assert!(s.job_output(2, false));
        assert!(s.job_output(2, true));
        assert!(!s.job_output(2, false), "nothing after the last frame");
        assert_eq!(s.active(), 0);
    }

    #[test]
    fn queue_limit_and_duplicate_requests() {
        let limits = Limits { concurrency: 1, max_queued: 1, ..Limits::default() };
        let mut s = Session::new(limits);
        greet(&mut s, r#"{"context":7}"#);
        assert!(matches!(exec(&mut s, 0, 1, 7).as_slice(), [Action::Spawn(_)]));
        assert_eq!(error_code(&exec(&mut s, 0, 1, 7)), "sql_rejected");
        assert!(matches!(exec(&mut s, 0, 2, 7).as_slice(), [Action::Spawn(_)]));
        assert_eq!(error_code(&exec(&mut s, 0, 3, 7)), "queue_full");
    }
}
