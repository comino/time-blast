//! One `tb1` WebSocket session: HELLO → READY, CONTEXT storage, INFER jobs, CANCEL and
//! epoch fencing. Binary frames only, one tb1 frame per WebSocket message.
//!
//! All decisions live in [`Session`], which is synchronous and IO-free: it consumes decoded
//! frames and job outputs and returns frames to send. [`run`] wires it to the socket.
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use fastwebsockets::{Frame as WsFrame, OpCode, Payload, upgrade};
use serde_json::json;
use tb_protocol::{Frame, Header, Kind, decode};
use tokio::{
    sync::mpsc,
    task::{AbortHandle, JoinSet},
};

use crate::{
    infer::{self, Job, Outbox, Prepared, Spent, cached_frames, error_frame, now_ms},
    prompt::DatasetContext,
    service::App,
};

/// Largest accepted WebSocket message (a CONTEXT with samples is the biggest frame).
pub const MESSAGE_LIMIT: usize = 1 << 20;
pub const MAX_QUESTION_CHARS: usize = 4096;
pub const MAX_CONTEXTS: usize = 4;

/// What the socket loop must do after the session handled an input.
pub enum Action {
    Send(Frame),
    /// Start this job.
    Spawn(Job),
    /// Abort the job for this request (drops its upstream stream).
    Abort(u32),
    /// Protocol violation: send the frame (if any) and close.
    Close(Option<Frame>),
}

struct Active {
    epoch: u32,
}

pub struct Session {
    pub greeted: bool,
    pub epoch: u32,
    contexts: VecDeque<(u32, Arc<Prepared>)>,
    active: HashMap<u32, Active>,
    concurrency: usize,
    model: String,
}

impl Session {
    pub fn new(concurrency: usize, model: String) -> Self {
        Session {
            greeted: false,
            epoch: 0,
            contexts: VecDeque::new(),
            active: HashMap::new(),
            concurrency,
            model,
        }
    }

    /// Handle one frame from the peer. `admit` consults the process budget and the shared
    /// SQL cache; it returns Err(message) to refuse, Ok(Some(sql)) for a cache hit.
    pub fn input(
        &mut self,
        frame: &Frame,
        received_at: f64,
        mut admit: impl FnMut(&Arc<Prepared>, &str) -> Result<Option<Arc<str>>, String>,
    ) -> Vec<Action> {
        let h = frame.header;
        if !self.greeted {
            if h.kind != Kind::Hello {
                return vec![Action::Close(Some(protocol_error(
                    &h,
                    "The first frame must be HELLO.",
                )))];
            }
            self.greeted = true;
            let ready = json!({"node":"inference","name":"time-blast-inference","version":1,"model":self.model});
            return vec![Action::Send(Frame::new(
                Header::new(Kind::Ready),
                ready.to_string(),
            ))];
        }
        match h.kind {
            Kind::Hello => vec![Action::Close(Some(protocol_error(
                &h,
                "HELLO was already received.",
            )))],
            Kind::Context => self.context(frame),
            Kind::Cancel => self.cancel(h.epoch, h.request),
            Kind::Infer => self.infer(frame, received_at, &mut admit),
            // Frames meant for other nodes are ignored, not fatal.
            _ => Vec::new(),
        }
    }

    fn context(&mut self, frame: &Frame) -> Vec<Action> {
        let h = frame.header;
        let parsed = serde_json::from_slice::<DatasetContext>(&frame.payload)
            .map_err(|e| format!("Invalid DatasetContext: {e}"))
            .and_then(|c| c.validate().map(|_| c))
            .and_then(|c| match h.context {
                0 => Ok(c),
                id if id == c.id => Ok(c),
                _ => Err("CONTEXT header id differs from the payload id.".into()),
            });
        match parsed {
            Ok(context) => {
                let id = context.id;
                self.contexts.retain(|(existing, _)| *existing != id);
                self.contexts
                    .push_back((id, Arc::new(Prepared::new(context))));
                while self.contexts.len() > MAX_CONTEXTS {
                    self.contexts.pop_front();
                }
                Vec::new()
            }
            Err(message) => vec![Action::Send(error_frame(&h, "bad_context", &message))],
        }
    }

    /// request 0: cancel everything and adopt the new epoch. Otherwise cancel that request
    /// only; the epoch is unchanged.
    fn cancel(&mut self, epoch: u32, request: u32) -> Vec<Action> {
        if request == 0 {
            self.epoch = self.epoch.max(epoch);
            return self
                .active
                .drain()
                .map(|(id, _)| Action::Abort(id))
                .collect();
        }
        match self.active.remove(&request) {
            Some(_) => vec![Action::Abort(request)],
            None => Vec::new(),
        }
    }

    fn infer(
        &mut self,
        frame: &Frame,
        received_at: f64,
        admit: &mut impl FnMut(&Arc<Prepared>, &str) -> Result<Option<Arc<str>>, String>,
    ) -> Vec<Action> {
        let h = frame.header;
        if h.epoch < self.epoch {
            return Vec::new(); // stale: superseded by a CANCEL already seen
        }
        if h.request == 0 {
            return vec![Action::Send(error_frame(
                &h,
                "bad_request",
                "INFER needs a request id.",
            ))];
        }
        if self.active.contains_key(&h.request) {
            return vec![Action::Send(error_frame(
                &h,
                "bad_request",
                "Request id is already active.",
            ))];
        }
        let Some(prepared) = self
            .contexts
            .iter()
            .find(|(id, _)| *id == h.context)
            .map(|(_, p)| p.clone())
        else {
            return vec![Action::Send(error_frame(
                &h,
                "unknown_context",
                "No CONTEXT with this id.",
            ))];
        };
        let question = match std::str::from_utf8(&frame.payload) {
            Ok(q) if !q.trim().is_empty() && q.chars().count() <= MAX_QUESTION_CHARS => {
                q.to_string()
            }
            _ => {
                return vec![Action::Send(error_frame(
                    &h,
                    "bad_request",
                    "The question must be non-empty UTF-8 of at most 4096 characters.",
                ))];
            }
        };
        if self.active.len() >= self.concurrency {
            return vec![Action::Send(error_frame(
                &h,
                "busy",
                "Too many translations in flight on this session.",
            ))];
        }
        let job = Job {
            header: h,
            question,
            prepared,
            received_at,
            progress: Default::default(),
        };
        match admit(
            &job.prepared,
            crate::prompt::user_message(&job.question).as_str(),
        ) {
            Err(message) => vec![Action::Send(error_frame(&h, "budget", &message))],
            Ok(Some(sql)) => cached_frames(&job, &sql, &self.model)
                .into_iter()
                .map(Action::Send)
                .collect(),
            Ok(None) => {
                self.active.insert(h.request, Active { epoch: h.epoch });
                vec![Action::Spawn(job)]
            }
        }
    }

    /// A frame produced by a job. Returns it if it may still leave the process.
    pub fn job_output(&mut self, request: u32, frame: Frame, last: bool) -> Option<Frame> {
        let active = self.active.get(&request)?;
        if active.epoch < self.epoch {
            self.active.remove(&request);
            return None;
        }
        if last {
            self.active.remove(&request);
        }
        Some(frame)
    }
}

fn protocol_error(h: &Header, message: &str) -> Frame {
    error_frame(&Header { request: 0, ..*h }, "protocol", message)
}

/// Bounded assembly of fragmented binary messages, checked before concatenation.
#[derive(Default)]
pub struct Assembler {
    partial: Option<Vec<u8>>,
}

impl Assembler {
    /// Ok(Some(bytes)) for a complete binary message; Err for a protocol violation.
    pub fn push(
        &mut self,
        opcode: OpCode,
        fin: bool,
        payload: &[u8],
    ) -> Result<Option<Vec<u8>>, &'static str> {
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
    Frame(Vec<u8>),
    Control(OpCode, Vec<u8>),
    Close,
}

pub async fn run(app: Arc<App>, upgrade: upgrade::UpgradeFut) {
    let Ok(Ok(mut socket)) = tokio::time::timeout(Duration::from_secs(10), upgrade).await else {
        return;
    };
    socket.set_max_message_size(MESSAGE_LIMIT);
    let (mut reader, mut writer) = socket.split(tokio::io::split);
    // Each small frame is written immediately; no batching timer.
    writer.set_writev(false);
    let cancel = app.shutdown.child_token();
    let _guard = cancel.clone().drop_guard();

    let (output, mut pending_output) = mpsc::unbounded_channel::<Outgoing>();
    // The writer drains until every sender is gone, so a final ERROR/close still leaves.
    let writer_task = tokio::spawn(async move {
        loop {
            let (opcode, bytes, close) = match pending_output.recv().await {
                None => break,
                Some(Outgoing::Frame(bytes)) => (OpCode::Binary, bytes, false),
                Some(Outgoing::Control(op, bytes)) => (op, bytes, false),
                Some(Outgoing::Close) => (OpCode::Close, 1008u16.to_be_bytes().to_vec(), true),
            };
            let frame = WsFrame::new(true, opcode, None, Payload::Owned(bytes));
            if !matches!(
                tokio::time::timeout(Duration::from_secs(5), writer.write_frame(frame)).await,
                Ok(Ok(()))
            ) || close
            {
                break;
            }
        }
    });

    let (input, mut pending_input) = mpsc::channel::<Result<(Vec<u8>, f64), &'static str>>(64);
    let reader_cancel = cancel.clone();
    let reader_output = output.clone();
    let connected_at = Instant::now();
    let last_pong = Arc::new(AtomicU64::new(0));
    let reader_pong = last_pong.clone();
    // When the reader ends, its sender drops and the session loop sees the input close
    // after any queued messages (including a final protocol error).
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
                    if input.send(Ok((bytes, now_ms()))).await.is_err() {
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

    let mut session = Session::new(app.session_concurrency, app.model.clone());
    let (jobs_out, mut job_frames): (Outbox, _) = mpsc::unbounded_channel();
    let mut jobs: JoinSet<()> = JoinSet::new();
    let mut handles: HashMap<u32, (AbortHandle, Header, Arc<Mutex<Spent>>)> = HashMap::new();
    let mut last_message = Instant::now();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
    heartbeat.tick().await;
    let hello_deadline = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(hello_deadline);
    let send = |frame: &Frame| output.send(Outgoing::Frame(frame.encode())).is_ok();

    'session: loop {
        tokio::select! { biased;
            _ = cancel.cancelled() => break,
            _ = &mut hello_deadline, if !session.greeted => break,
            Some((request, frame, last)) = job_frames.recv() => {
                if last {
                    handles.remove(&request);
                }
                if let Some(frame) = session.job_output(request, frame, last) {
                    if !send(&frame) { break; }
                }
            }
            Some(_) = jobs.join_next(), if !jobs.is_empty() => {}
            message = pending_input.recv() => {
                let Some(message) = message else { break };
                last_message = Instant::now();
                let (bytes, received_at) = match message {
                    Ok(m) => m,
                    Err(reason) => {
                        let error = error_frame(&Header::new(Kind::Error), "protocol", reason);
                        send(&error);
                        let _ = output.send(Outgoing::Close);
                        break;
                    }
                };
                let frame = match decode(&bytes) {
                    Ok(frame) => frame.to_owned(),
                    Err(e) => {
                        send(&error_frame(&Header::new(Kind::Error), "protocol", &e.to_string()));
                        let _ = output.send(Outgoing::Close);
                        break;
                    }
                };
                let actions = session.input(&frame, received_at, |prepared, question| {
                    if let Some(sql) = app.cache.get(prepared.prefix_hash, question) {
                        app.totals.lock().unwrap().cache_hits += 1;
                        return Ok(Some(sql));
                    }
                    app.budget.lock().unwrap().admit(Instant::now()).map(|_| None).map_err(String::from)
                });
                for action in actions {
                    match action {
                        Action::Send(frame) => if !send(&frame) { break 'session },
                        Action::Close(frame) => {
                            if let Some(frame) = frame { send(&frame); }
                            let _ = output.send(Outgoing::Close);
                            break 'session;
                        }
                        Action::Abort(request) => {
                            if let Some((handle, header, progress)) = handles.remove(&request) {
                                let finished = handle.is_finished();
                                handle.abort();
                                // Speculation cost stays visible: report what is known.
                                let spent = progress.lock().unwrap().clone();
                                if !finished {
                                    // A finished job already recorded its own spend.
                                    app.budget.lock().unwrap().spend(spent.cost_usd.unwrap_or(0.0));
                                    let mut totals = app.totals.lock().unwrap();
                                    totals.cancelled += 1;
                                    totals.record(&spent, true);
                                }
                                if let Some(frame) = spent.cancelled_frame(&header, &app.model) {
                                    if !send(&frame) { break 'session }
                                }
                            }
                        }
                        Action::Spawn(job) => {
                            let request = job.header.request;
                            let header = job.header;
                            let progress = job.progress.clone();
                            let app = app.clone();
                            let out = jobs_out.clone();
                            app.totals.lock().unwrap().requests += 1;
                            let handle = jobs.spawn(async move {
                                let (spent, result) = infer::run(&app.provider, &app.cache, &job, &out).await;
                                app.budget.lock().unwrap().spend(spent.cost_usd.unwrap_or(0.0));
                                app.totals.lock().unwrap().record(&spent, result.is_ok());
                            });
                            handles.insert(request, (handle, header, progress));
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
    reader_task.abort();
    let _ = reader_task.await;
    drop(output);
    let _ = tokio::time::timeout(Duration::from_secs(1), writer_task).await;
}

#[cfg(test)]
mod tests;
