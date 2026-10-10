use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use fastwebsockets::{Frame, OpCode, Payload, upgrade};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    sync::{Semaphore, mpsc},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

use crate::{
    config::Config,
    plan::{
        DatasetContext, Draft, ErrorKind, InferenceDiagnostics, InferenceError, InferenceResponse,
    },
    provider::Provider,
};

const PROTOCOL: &str = "time-blast.inference.v1";
const MESSAGE_LIMIT: usize = 65_536;
const CACHE_LIMIT: usize = 64;

struct App {
    provider: Provider,
    model: String,
    origins: Vec<String>,
    sessions: Arc<Semaphore>,
    budget: Mutex<Budget>,
    shutdown: CancellationToken,
}

struct Budget {
    minute_start: Instant,
    day_start: Instant,
    minute: u32,
    day: u32,
    minute_limit: u32,
    day_limit: u32,
}
impl Budget {
    fn admit(&mut self, now: Instant) -> bool {
        if now.duration_since(self.minute_start) >= Duration::from_secs(60) {
            self.minute = 0;
            self.minute_start = now;
        }
        if now.duration_since(self.day_start) >= Duration::from_secs(86400) {
            self.day = 0;
            self.day_start = now;
        }
        if self.minute >= self.minute_limit || self.day >= self.day_limit {
            return false;
        }
        self.minute += 1;
        self.day += 1;
        true
    }
}

impl App {
    fn admit(&self) -> Result<(), InferenceError> {
        if !self.budget.lock().unwrap().admit(Instant::now()) {
            return Err(InferenceError::with_kind(
                ErrorKind::Busy,
                "Prototype generation budget reached. Try again later.",
            ));
        }
        Ok(())
    }
}

pub async fn serve(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let model = config.provider.model.clone();
    let state = Arc::new(App {
        provider: Provider::new(config.provider)?,
        model,
        origins: config.allowed_origins,
        sessions: Arc::new(Semaphore::new(64)),
        budget: Mutex::new(Budget {
            minute_start: Instant::now(),
            day_start: Instant::now(),
            minute: 0,
            day: 0,
            minute_limit: config.requests_per_minute,
            day_limit: config.requests_per_day,
        }),
        shutdown: CancellationToken::new(),
    });
    let app = Router::new()
        .route("/health", get(health))
        .route("/infer", post(infer))
        .route("/draft", post(draft))
        .route("/session", get(session_upgrade))
        .layer(DefaultBodyLimit::max(MESSAGE_LIMIT))
        .layer(middleware::from_fn_with_state(state.clone(), origin_guard))
        .with_state(state.clone());
    // A cheap HEAD can establish DNS/TCP/TLS before an interactive request. It
    // generates no tokens and establishes no guarantee about provider model warmth.
    let _ = state.provider.warm_connection().await;
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    eprintln!(
        "time-blast inference listening on {} · model {}",
        listener.local_addr()?,
        state.model
    );
    // Axum's listener adapter applies TCP_NODELAY to each accepted connection.
    use axum::serve::ListenerExt;
    let listener = listener.tap_io(|socket| {
        let _ = socket.set_nodelay(true);
    });
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            {
                let mut term =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("signal handler");
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            state.shutdown.cancel();
        })
        .await?;
    Ok(())
}

async fn origin_guard(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let origin = request.headers().get("origin").cloned();
    if let Some(value) = &origin {
        if !value
            .to_str()
            .is_ok_and(|s| app.origins.iter().any(|allowed| allowed == s))
        {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"message":"Browser origin is not allowed"})),
            )
                .into_response();
        }
    }
    let mut response = if request.method() == axum::http::Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert("access-control-allow-origin", origin);
        response
            .headers_mut()
            .insert("vary", HeaderValue::from_static("Origin"));
        response.headers_mut().insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET, POST, OPTIONS"),
        );
        response.headers_mut().insert(
            "access-control-allow-headers",
            HeaderValue::from_static("Content-Type"),
        );
    }
    response
}

async fn health(State(app): State<Arc<App>>) -> Json<Value> {
    Json(
        json!({"status":"ready","version":1,"model":app.model,"transport":"fastwebsockets",
        "providerWarmth":"unknown","maxSessions":64}),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HttpRequest {
    text: String,
    revision: u64,
    draft: Draft,
    context: DatasetContext,
    #[serde(default)]
    schema: Option<Value>,
    #[serde(default = "yes")]
    cache_plans: bool,
}

async fn infer(State(app): State<Arc<App>>, Json(request): Json<HttpRequest>) -> Response {
    if request.text != request.draft.text || request.revision != request.draft.revision {
        return http_error(InferenceError::new("Conflicting draft identity"));
    }
    // The service owns its schema. The compatibility field is never used as instructions.
    drop(request.schema);
    // HTTP compatibility has no session cache, regardless of this optional flag.
    let _ = request.cache_plans;
    if let Err(e) = request
        .context
        .validate()
        .and_then(|_| request.draft.validate(&request.context))
    {
        return http_error(InferenceError::new(e));
    }
    if let Err(e) = app.admit() {
        return http_error(e);
    }
    let token = app.shutdown.child_token();
    let _guard = token.clone().drop_guard();
    match app
        .provider
        .infer(&request.context, &request.draft, token)
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(e) => http_error(e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftRequest {
    r#type: String,
    draft: Draft,
    context_id: String,
}

async fn draft(Json(request): Json<DraftRequest>) -> Response {
    if request.r#type != "DRAFT"
        || request.context_id != request.draft.context_id
        || request.draft.validate_shape().is_err()
    {
        return http_error(InferenceError::new("Invalid draft"));
    }
    // Stateless HTTP compatibility only. WS retains the latest revision in its session.
    StatusCode::NO_CONTENT.into_response()
}

fn http_error(error: InferenceError) -> Response {
    let status = match error.kind {
        ErrorKind::InvalidRequest => StatusCode::BAD_REQUEST,
        ErrorKind::Busy => StatusCode::TOO_MANY_REQUESTS,
        ErrorKind::Canceled => StatusCode::REQUEST_TIMEOUT,
        ErrorKind::Timeout => StatusCode::GATEWAY_TIMEOUT,
        ErrorKind::Upstream => StatusCode::BAD_GATEWAY,
        ErrorKind::InvalidModel => StatusCode::UNPROCESSABLE_ENTITY,
    };
    (status, Json(error)).into_response()
}

async fn session_upgrade(State(app): State<Arc<App>>, mut request: Request) -> Response {
    if !protocol_offered(request.headers()) || !upgrade::is_upgrade_request(&request) {
        return (
            StatusCode::BAD_REQUEST,
            "Expected time-blast.inference.v1 WebSocket",
        )
            .into_response();
    }
    let Ok(permit) = app.sessions.clone().try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Session capacity reached").into_response();
    };
    match upgrade::upgrade(&mut request) {
        Ok((mut response, socket)) => {
            response
                .headers_mut()
                .insert("sec-websocket-protocol", HeaderValue::from_static(PROTOCOL));
            tokio::spawn(async move {
                let _permit = permit;
                run_session(app, socket).await;
            });
            response.map(Body::new)
        }
        Err(_) => (StatusCode::BAD_REQUEST, "Invalid WebSocket upgrade").into_response(),
    }
}

fn protocol_offered(headers: &HeaderMap) -> bool {
    headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|p| p.trim() == PROTOCOL))
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum ClientMessage {
    #[serde(rename = "HELLO")]
    Hello {
        version: u8,
        context: DatasetContext,
        #[serde(rename = "cachePlans", default = "yes")]
        cache_plans: bool,
    },
    #[serde(rename = "DRAFT")]
    Draft { draft: Draft },
    #[serde(rename = "INFER")]
    Infer {
        id: String,
        draft: Draft,
        #[serde(rename = "cachePlans", default = "yes")]
        cache_plans: bool,
    },
    #[serde(rename = "CANCEL")]
    Cancel { id: String },
    #[serde(rename = "CACHE_POLICY")]
    CachePolicy {
        #[serde(rename = "cachePlans")]
        cache_plans: bool,
    },
}
fn yes() -> bool {
    true
}

/// Raw frame parser limits an aggregate fragmented message *before* concatenating it.
/// fastwebsockets' per-frame size setting alone does not bound fragmented messages.
#[derive(Default)]
struct MessageAssembler {
    partial: Option<Vec<u8>>,
}
impl MessageAssembler {
    fn push(
        &mut self,
        opcode: OpCode,
        fin: bool,
        payload: &[u8],
    ) -> Result<Option<ClientMessage>, ()> {
        match opcode {
            OpCode::Text if self.partial.is_none() => {
                if payload.len() > MESSAGE_LIMIT {
                    return Err(());
                }
                if fin {
                    return serde_json::from_slice(payload).map(Some).map_err(|_| ());
                }
                self.partial = Some(payload.to_vec());
                Ok(None)
            }
            OpCode::Continuation => {
                let data = self.partial.as_mut().ok_or(())?;
                if data.len().saturating_add(payload.len()) > MESSAGE_LIMIT {
                    return Err(());
                }
                data.extend_from_slice(payload);
                if fin {
                    serde_json::from_slice(&self.partial.take().unwrap())
                        .map(Some)
                        .map_err(|_| ())
                } else {
                    Ok(None)
                }
            }
            OpCode::Ping | OpCode::Pong => Ok(None),
            _ => Err(()),
        }
    }
}

enum Outgoing {
    Json(Value),
    Control(OpCode, Vec<u8>),
}

fn send(tx: &mpsc::Sender<Outgoing>, value: Value) -> bool {
    tx.try_send(Outgoing::Json(value)).is_ok()
}
fn error_message(id: Option<&str>, error: InferenceError) -> Value {
    let mut value = serde_json::to_value(error).expect("finite error diagnostics");
    let object = value.as_object_mut().unwrap();
    object.insert("type".into(), json!("ERROR"));
    if let Some(id) = id {
        object.insert("id".into(), json!(id));
    }
    value
}

struct Cached {
    key: String,
    value: InferenceResponse,
    at: Instant,
}
#[derive(Default)]
struct PlanCache {
    entries: VecDeque<Cached>,
    enabled: bool,
    epoch: u64,
}
impl PlanCache {
    fn policy(&mut self, enabled: bool) {
        if self.enabled != enabled {
            self.entries.clear();
            self.epoch += 1;
            self.enabled = enabled;
        }
    }
    fn get(&mut self, key: &str) -> Option<InferenceResponse> {
        if !self.enabled {
            return None;
        }
        self.entries
            .retain(|e| e.at.elapsed() < Duration::from_secs(600));
        let index = self.entries.iter().position(|e| e.key == key)?;
        let entry = self.entries.remove(index)?;
        let mut value = entry.value.clone();
        value.tokens = None;
        value.diagnostics = InferenceDiagnostics {
            cache_hit: Some(true),
            ..Default::default()
        };
        self.entries.push_back(entry);
        Some(value)
    }
    fn put(&mut self, epoch: u64, key: String, value: InferenceResponse) {
        if !self.enabled || self.epoch != epoch {
            return;
        }
        self.entries.retain(|e| e.key != key);
        if self.entries.len() == CACHE_LIMIT {
            self.entries.pop_front();
        }
        self.entries.push_back(Cached {
            key,
            value,
            at: Instant::now(),
        });
    }
}

async fn run_session(app: Arc<App>, upgrade: upgrade::UpgradeFut) {
    let Ok(Ok(mut socket)) = tokio::time::timeout(Duration::from_secs(10), upgrade).await else {
        return;
    };
    socket.set_max_message_size(MESSAGE_LIMIT);
    let (mut reader, mut writer) = socket.split(tokio::io::split);
    // One small frame is written immediately; no application batch/flush timer.
    writer.set_writev(false);
    let cancel = app.shutdown.child_token();
    let _guard = cancel.clone().drop_guard();
    let (output, mut pending_output) = mpsc::channel::<Outgoing>(8);
    let writer_cancel = cancel.clone();
    let writer_task = tokio::spawn(async move {
        let _guard = writer_cancel.clone().drop_guard();
        loop {
            let next = tokio::select! { biased; _ = writer_cancel.cancelled() => break, msg = pending_output.recv() => msg };
            let Some(next) = next else {
                break;
            };
            let (opcode, bytes) = match next {
                Outgoing::Json(value) => (
                    OpCode::Text,
                    serde_json::to_vec(&value).expect("finite response"),
                ),
                Outgoing::Control(op, bytes) => (op, bytes),
            };
            if bytes.len() > MESSAGE_LIMIT {
                break;
            }
            let frame = Frame::new(true, opcode, None, Payload::Owned(bytes));
            if !matches!(
                tokio::time::timeout(Duration::from_secs(2), writer.write_frame(frame)).await,
                Ok(Ok(()))
            ) {
                break;
            }
        }
    });
    let (input, mut pending_input) = mpsc::channel(8);
    let reader_cancel = cancel.clone();
    let reader_output = output.clone();
    let connected_at = Instant::now();
    let last_pong = Arc::new(AtomicU64::new(0));
    let reader_pong = last_pong.clone();
    let reader_task = tokio::spawn(async move {
        let _guard = reader_cancel.clone().drop_guard();
        let mut assembler = MessageAssembler::default();
        let mut control = |frame: Frame<'_>| {
            let result = reader_output
                .try_send(Outgoing::Control(frame.opcode, frame.payload.to_vec()))
                .map_err(|_| std::io::Error::other("WebSocket send queue full"));
            async move { result }
        };
        loop {
            // This future is never canceled for normal messages/completions; only when
            // the entire connection is being discarded. Partial frame reads stay intact.
            let frame = tokio::select! { biased; _ = reader_cancel.cancelled() => break, f = reader.read_frame(&mut control) => f };
            let Ok(frame) = frame else {
                break;
            };
            if frame.opcode == OpCode::Close {
                break;
            }
            if frame.opcode == OpCode::Pong {
                reader_pong.store(connected_at.elapsed().as_secs(), Ordering::Relaxed);
            }
            match assembler.push(frame.opcode, frame.fin, &frame.payload) {
                Ok(Some(message)) => {
                    if input.try_send(message).is_err() {
                        break;
                    }
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }
    });

    let mut context: Option<DatasetContext> = None;
    let mut latest_draft: Option<Draft> = None;
    let mut cache = PlanCache::default();
    let mut seen = HashSet::new();
    let mut active = HashMap::new();
    let mut jobs: JoinSet<(
        String,
        u64,
        String,
        Result<InferenceResponse, InferenceError>,
    )> = JoinSet::new();
    let mut last_message = Instant::now();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
    heartbeat.tick().await;
    let hello_deadline = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(hello_deadline);

    loop {
        tokio::select! { biased;
            _ = cancel.cancelled() => break,
            _ = &mut hello_deadline, if context.is_none() => break,
            Some(completed) = jobs.join_next(), if !jobs.is_empty() => {
                let Ok((id, epoch, key, result)) = completed else { continue; };
                if active.remove(&id).is_none() { continue; }
                let message = match result {
                    Ok(value) => { cache.put(epoch, key, value.clone()); json!({"type":"RESULT","id":id,"result":value}) },
                    Err(error) => error_message(Some(&id), error),
                };
                if !send(&output, message) { break; }
            }
            message = pending_input.recv() => {
                let Some(message) = message else { break; };
                last_message = Instant::now();
                match message {
                    ClientMessage::Hello {version, context: ctx, cache_plans} => {
                        if context.is_some() || version != 1 || ctx.validate().is_err() {
                            send(&output, error_message(None, InferenceError::new("Invalid or repeated HELLO"))); break;
                        }
                        cache.policy(cache_plans); context = Some(ctx);
                        if !send(&output, json!({"type":"READY","version":1,"model":app.model})) { break; }
                    }
                    ClientMessage::Draft {draft} => {
                        let Some(ctx) = &context else { break; };
                        if draft.validate_shape().is_err() || draft.context_id != ctx.id { break; }
                        if latest_draft.as_ref().is_none_or(|old| draft.revision > old.revision) { latest_draft = Some(draft); }
                    }
                    ClientMessage::Cancel {id} => {
                        if let Some((token, handle)) = active.remove(&id) {
                            let token: CancellationToken = token; token.cancel();
                            let handle: tokio::task::AbortHandle = handle; handle.abort();
                        }
                    }
                    ClientMessage::CachePolicy {cache_plans} => {
                        if context.is_none() { break; }
                        cache.policy(cache_plans);
                    }
                    ClientMessage::Infer {id, draft, cache_plans} => {
                        let Some(ctx) = &context else { break; };
                        if id.is_empty() || id.len() > 80 || seen.contains(&id) || seen.len() >= 4096 { break; }
                        seen.insert(id.clone());
                        if let Err(error) = draft.validate(ctx) {
                            if !send(&output, error_message(Some(&id), InferenceError::new(error))) { break; }
                            continue;
                        }
                        cache.policy(cache_plans);
                        if let Some(value) = cache.get(&draft.text) {
                            if !send(&output, json!({"type":"RESULT","id":id,"result":value})) { break; }
                            continue;
                        }
                        let admission = if active.len() >= 2 { Err(InferenceError::with_kind(ErrorKind::Busy,"Session already has two active requests")) } else { app.admit() };
                        if let Err(error) = admission {
                            if !send(&output, error_message(Some(&id), error)) { break; }
                            continue;
                        }
                        let provider = app.provider.clone(); let ctx = ctx.clone();
                        let token = cancel.child_token(); let job_token = token.clone();
                        let job_id = id.clone(); let epoch = cache.epoch;
                        let handle = jobs.spawn(async move {
                            let result = provider.infer(&ctx, &draft, job_token).await;
                            (job_id, epoch, draft.text, result)
                        });
                        active.insert(id, (token, handle));
                    }
                }
            }
            _ = heartbeat.tick() => {
                if connected_at.elapsed().as_secs().saturating_sub(last_pong.load(Ordering::Relaxed)) >= 75
                    || last_message.elapsed() >= Duration::from_secs(600) { break; }
                if output.try_send(Outgoing::Control(OpCode::Ping, Vec::new())).is_err() { break; }
            }
        }
    }
    cancel.cancel();
    jobs.abort_all();
    reader_task.abort();
    writer_task.abort();
    let _ = reader_task.await;
    let _ = writer_task.await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragmented_messages_are_bounded_before_accumulation() {
        let mut assembler = MessageAssembler::default();
        assert!(
            assembler
                .push(OpCode::Text, false, &vec![b' '; 40000])
                .unwrap()
                .is_none()
        );
        assert!(
            assembler
                .push(OpCode::Continuation, true, &vec![b' '; 30000])
                .is_err()
        );
        assert_eq!(assembler.partial.as_ref().unwrap().len(), 40000);
    }
    #[test]
    fn fragmented_utf8_and_interleaved_control_frames() {
        let bytes = br#"{"type":"CANCEL","id":"one"}"#;
        let mut assembler = MessageAssembler::default();
        assert!(
            assembler
                .push(OpCode::Text, false, &bytes[..15])
                .unwrap()
                .is_none()
        );
        assert!(
            assembler
                .push(OpCode::Ping, true, b"ping")
                .unwrap()
                .is_none()
        );
        assert!(
            matches!(assembler.push(OpCode::Continuation,true,&bytes[15..]).unwrap(),Some(ClientMessage::Cancel{id}) if id=="one")
        );
        assert!(assembler.push(OpCode::Continuation, true, b"{}").is_err());
    }
    #[test]
    fn duplicate_fields_unknown_fields_and_binary_are_rejected() {
        let mut a = MessageAssembler::default();
        assert!(
            a.push(
                OpCode::Text,
                true,
                br#"{"type":"CANCEL","id":"a","id":"b"}"#
            )
            .is_err()
        );
        assert!(
            a.push(
                OpCode::Text,
                true,
                br#"{"type":"CANCEL","id":"a","sql":"bad"}"#
            )
            .is_err()
        );
        assert!(a.push(OpCode::Binary, true, b"{}").is_err());
    }
    #[test]
    fn generation_budget_resets_each_window_independently() {
        let start = Instant::now();
        let mut b = Budget {
            minute_start: start,
            day_start: start,
            minute: 0,
            day: 0,
            minute_limit: 1,
            day_limit: 2,
        };
        assert!(b.admit(start));
        assert!(!b.admit(start));
        assert!(b.admit(start + Duration::from_secs(60)));
        assert!(!b.admit(start + Duration::from_secs(120)));
        assert!(b.admit(start + Duration::from_secs(86400)));
    }
    fn result() -> InferenceResponse {
        serde_json::from_value(json!({"model":"fixture","tokens":40,
            "diagnostics":{"generationMs":8,"attempts":1},
            "plan":{"metric":"speed","aggregate":"avg","bucketMinutes":60,"windowHours":24,
                "splitByVessel":true,"vessel":null,"view":"line"}}))
        .unwrap()
    }
    #[test]
    fn cache_disable_clears_and_fences_inflight_insertions() {
        let mut cache = PlanCache::default();
        cache.policy(true);
        let epoch = cache.epoch;
        cache.put(epoch, "Average speed".into(), result());
        cache.policy(false);
        cache.policy(true);
        cache.put(epoch, "Average speed".into(), result());
        assert!(cache.get("Average speed").is_none());
        cache.put(cache.epoch, "Average speed".into(), result());
        let hit = cache.get("Average speed").unwrap();
        assert_eq!(hit.diagnostics.cache_hit, Some(true));
        assert!(hit.diagnostics.generation_ms.is_none());
        assert!(hit.tokens.is_none());
    }
    #[test]
    fn cache_is_exact_bounded_and_expires() {
        let mut cache = PlanCache::default();
        cache.policy(true);
        for i in 0..65 {
            cache.put(cache.epoch, format!("question{i}"), result());
        }
        assert_eq!(cache.entries.len(), 64);
        assert!(cache.get("question0").is_none());
        assert!(cache.get("question1 ").is_none());
        assert!(cache.get("question1").is_some());
        cache.entries.back_mut().unwrap().at = Instant::now() - Duration::from_secs(601);
        assert!(cache.get("question1").is_none());
    }
}
