//! End-to-end tests: a real tb1 WebSocket client against the real router, with a scripted
//! fake OpenAI-compatible upstream.
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    extract::State,
    http::header,
    response::{IntoResponse, Response},
    routing::post,
};
use fastwebsockets::{Frame as WsFrame, OpCode, Payload, Role, WebSocket};
use serde_json::{Value, json};
use tb_protocol::{Frame, Header, Kind, flags, node, stage};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

use crate::{
    config::Config,
    provider::ProviderConfig,
    service::{App, router},
};

// ───────────── fake upstream ─────────────

#[derive(Clone)]
struct Reply {
    chunks: Vec<(Duration, String)>,
}

fn sse(value: Value) -> String {
    format!("data: {value}\n\n")
}

impl Reply {
    /// A streamed completion: content split into the given pieces, then usage.
    fn content(pieces: &[&str]) -> Reply {
        let mut chunks: Vec<(Duration, String)> = pieces
            .iter()
            .map(|p| (Duration::ZERO, sse(json!({"model":"fake/model-1","choices":[{"index":0,"delta":{"content":p}}]}))))
            .collect();
        chunks.push((
            Duration::ZERO,
            sse(json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})),
        ));
        chunks.push((
            Duration::ZERO,
            sse(
                json!({"choices":[],"usage":{"prompt_tokens":900,"completion_tokens":20,
                "prompt_tokens_details":{"cached_tokens":768},"cost":0.000098}}),
            ),
        ));
        chunks.push((Duration::ZERO, "data: [DONE]\n\n".into()));
        Reply { chunks }
    }
    /// Endless slow stream of SQL-ish content; never finishes on its own.
    fn slow() -> Reply {
        let mut chunks = vec![(
            Duration::ZERO,
            sse(json!({"choices":[{"index":0,"delta":{"content":"SELECT ts"}}]})),
        )];
        for _ in 0..200 {
            chunks.push((
                Duration::from_millis(50),
                sse(json!({"choices":[{"index":0,"delta":{"content":", 1"}}]})),
            ));
        }
        Reply { chunks }
    }
}

struct Upstream {
    replies: Mutex<VecDeque<Reply>>,
    requests: Mutex<Vec<Value>>,
    dropped: AtomicUsize,
}

struct DropFlag(Arc<Upstream>);
impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.dropped.fetch_add(1, Ordering::SeqCst);
    }
}

async fn upstream_handler(State(state): State<Arc<Upstream>>, Json(body): Json<Value>) -> Response {
    state.requests.lock().unwrap().push(body);
    let Some(reply) = state.replies.lock().unwrap().pop_front() else {
        return axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let flag = DropFlag(state.clone());
    let stream = futures_util::stream::unfold(
        (reply.chunks.into_iter(), flag),
        |(mut it, flag)| async move {
            let (delay, text) = it.next()?;
            tokio::time::sleep(delay).await;
            Some((Ok::<_, std::convert::Infallible>(text), (it, flag)))
        },
    );
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        axum::body::Body::from_stream(stream),
    )
        .into_response()
}

struct Harness {
    upstream: Arc<Upstream>,
    addr: std::net::SocketAddr,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.tasks.iter().for_each(|t| t.abort());
    }
}

async fn harness(replies: Vec<Reply>) -> Harness {
    harness_with(replies, |_| {}).await
}

async fn harness_with(replies: Vec<Reply>, tweak: impl FnOnce(&mut Config)) -> Harness {
    let upstream = Arc::new(Upstream {
        replies: Mutex::new(replies.into()),
        requests: Mutex::new(Vec::new()),
        dropped: AtomicUsize::new(0),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let state = upstream.clone();
    let up = tokio::spawn(async move {
        let app = Router::new()
            .route("/v1/chat/completions", post(upstream_handler))
            .with_state(state);
        axum::serve(listener, app).await.unwrap();
    });
    let mut config = Config {
        bind: "127.0.0.1:0".parse().unwrap(),
        provider: ProviderConfig {
            endpoint,
            model: "fake/model".into(),
            api_key: None,
            openrouter: false,
            reasoning_effort: None,
            temperature: Some(0.0),
            max_tokens: 512,
            timeout: Duration::from_secs(5),
            max_concurrent: 8,
            extra: Default::default(),
        },
        allowed_origins: vec!["http://localhost:5173".into()],
        requests_per_minute: 1000,
        requests_per_day: 1000,
        daily_budget_usd: 1.0,
        session_concurrency: 2,
        cache_entries: 64,
        row_check: true,
        describe: None,
    };
    tweak(&mut config);
    let app = App::new(config).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router(app)).await.unwrap() });
    Harness {
        upstream,
        addr,
        tasks: vec![up, server],
    }
}

// ───────────── minimal tb1 client ─────────────

struct Client {
    ws: WebSocket<TcpStream>,
}

async fn handshake(addr: std::net::SocketAddr, origin: Option<&str>) -> Result<TcpStream, String> {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let origin = origin
        .map(|o| format!("Origin: {o}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "GET /session HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Protocol: tb1\r\n{origin}\r\n"
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut byte = [0u8; 1];
        if stream.read(&mut byte).await.unwrap() == 0 {
            break;
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_string();
    if !head.starts_with("HTTP/1.1 101") {
        return Err(head);
    }
    assert!(
        head.to_ascii_lowercase()
            .contains("sec-websocket-protocol: tb1"),
        "{head}"
    );
    Ok(stream)
}

impl Client {
    async fn connect(addr: std::net::SocketAddr) -> Client {
        let stream = handshake(addr, Some("http://localhost:5173"))
            .await
            .unwrap();
        Client {
            ws: WebSocket::after_handshake(stream, Role::Client),
        }
    }
    async fn send(&mut self, frame: Frame) {
        self.ws
            .write_frame(WsFrame::binary(Payload::Owned(frame.encode())))
            .await
            .unwrap();
    }
    async fn recv(&mut self) -> Option<Frame> {
        let frame = tokio::time::timeout(Duration::from_secs(5), self.ws.read_frame())
            .await
            .ok()?
            .ok()?;
        match frame.opcode {
            OpCode::Binary => Some(tb_protocol::decode(&frame.payload).unwrap().to_owned()),
            _ => None,
        }
    }
    /// Receive frames until one of `kind` for `request` arrives.
    async fn until(&mut self, kind: Kind, request: u32) -> Vec<Frame> {
        let mut seen = Vec::new();
        loop {
            let frame = self
                .recv()
                .await
                .unwrap_or_else(|| panic!("no {kind:?} for {request}; saw {seen:?}"));
            let done = frame.header.kind == kind && frame.header.request == request;
            seen.push(frame);
            if done {
                return seen;
            }
        }
    }
    async fn greet(&mut self) {
        self.send(hello()).await;
        let ready = self.recv().await.unwrap();
        assert_eq!(ready.header.kind, Kind::Ready);
        let mut ready: Value = serde_json::from_slice(&ready.payload).unwrap();
        let capabilities = ready.as_object_mut().unwrap().remove("capabilities").unwrap();
        assert_eq!(
            ready,
            json!({"node":"inference","name":"time-blast-inference","version":1,"model":"fake/model"})
        );
        assert_eq!(capabilities[0], json!("edit-context-v1"));
        self.send(context()).await;
    }
}

fn hello() -> Frame {
    Frame::new(
        Header::new(Kind::Hello),
        json!({"node":"coordinator","name":"test","version":1}).to_string(),
    )
}
fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!(
        "{}/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}
fn context() -> Frame {
    Frame::new(
        Header {
            context: 1,
            ..Header::new(Kind::Context)
        },
        fixture("vessels-context.json"),
    )
}
fn infer(request: u32, epoch: u32, text: &str) -> Frame {
    Frame::new(
        Header {
            request,
            epoch,
            revision: request * 10,
            context: 1,
            ..Header::new(Kind::Infer)
        },
        text,
    )
}
fn cancel(request: u32, epoch: u32) -> Frame {
    Frame::new(
        Header {
            request,
            epoch,
            ..Header::new(Kind::Cancel)
        },
        Vec::new(),
    )
}
fn text(frame: &Frame) -> String {
    String::from_utf8(frame.payload.clone()).unwrap()
}
fn stages(frame: &Frame) -> Vec<(u16, u16)> {
    frame.stamps.iter().map(|s| (s.stage, s.node)).collect()
}
fn of(frames: &[Frame], kind: Kind) -> Vec<&Frame> {
    frames.iter().filter(|f| f.header.kind == kind).collect()
}

// ───────────── tests ─────────────

#[tokio::test]
async fn infer_streams_deltas_then_sql_then_stats_with_stamps() {
    let h = harness(vec![Reply::content(&[
        "```sql\nSELECT ",
        "vessel, avg(speed)",
        " AS speed FROM telemetry",
        " GROUP BY 1 ORDER BY 1;\n```",
    ])])
    .await;
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.send(infer(7, 0, "  average speed per vessel ")).await;
    let frames = c.until(Kind::InferStats, 7).await;
    let sql = "SELECT vessel, avg(speed) AS speed FROM telemetry GROUP BY 1 ORDER BY 1";

    let deltas = of(&frames, Kind::SqlDelta);
    assert!(deltas.len() >= 2);
    assert_eq!(deltas.iter().map(|f| text(f)).collect::<String>(), sql);
    use node::*;
    use stage::*;
    assert_eq!(
        stages(deltas[0]),
        [
            (INFER_RECEIVED, INFERENCE),
            (PROVIDER_REQUEST, INFERENCE),
            (FIRST_TOKEN, PROVIDER),
            (SQL_FIRST_DELTA, INFERENCE)
        ]
    );
    assert!(deltas[1..].iter().all(|f| f.stamps.is_empty()));
    let final_sql = of(&frames, Kind::Sql)[0];
    assert_eq!(text(final_sql), sql);
    assert_eq!(final_sql.header.flags, 0);
    assert_eq!(
        stages(final_sql),
        [
            (INFER_RECEIVED, INFERENCE),
            (PROVIDER_REQUEST, INFERENCE),
            (FIRST_TOKEN, PROVIDER),
            (SQL_FIRST_DELTA, INFERENCE),
            (SQL_COMPLETE, INFERENCE)
        ]
    );
    let at: Vec<f64> = final_sql.stamps.iter().map(|s| s.at).collect();
    assert!(
        at.windows(2).all(|w| w[0] <= w[1]),
        "stamps are monotonic: {at:?}"
    );
    for f in &frames {
        assert_eq!(
            (
                f.header.request,
                f.header.revision,
                f.header.context,
                f.header.epoch
            ),
            (7, 70, 1, 0)
        );
    }
    let stats: Value = serde_json::from_slice(&frames.last().unwrap().payload).unwrap();
    assert_eq!(
        stats,
        json!({"model":"fake/model-1","promptTokens":900,"completionTokens":20,"cachedTokens":768,"costUsd":0.000098,"attempts":1})
    );

    let requests = h.upstream.requests.lock().unwrap();
    let body = &requests[0];
    assert_eq!(
        body["messages"][0],
        json!({"role":"system","content":fixture("vessels-prompt.txt")})
    );
    assert_eq!(
        body["messages"][1],
        json!({"role":"user","content":"average speed per vessel"})
    );
    assert_eq!(body["messages"].as_array().unwrap().len(), 2);
    assert_eq!(
        (
            body["stream"].clone(),
            body["temperature"].clone(),
            body["max_tokens"].clone()
        ),
        (json!(true), json!(0.0), json!(512))
    );
}

#[tokio::test]
async fn one_repair_attempt_after_prose_and_deltas_come_from_the_repair() {
    let h = harness(vec![
        Reply::content(&["Here is the query you asked for: SELECT 1"]),
        Reply::content(&["SELECT max(wind) AS wind", " FROM telemetry"]),
    ])
    .await;
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.send(infer(1, 0, "max wind")).await;
    let frames = c.until(Kind::InferStats, 1).await;
    let deltas: String = of(&frames, Kind::SqlDelta)
        .iter()
        .map(|f| text(f))
        .collect();
    assert_eq!(deltas, "SELECT max(wind) AS wind FROM telemetry");
    assert_eq!(text(of(&frames, Kind::Sql)[0]), deltas);
    let stats: Value = serde_json::from_slice(&frames.last().unwrap().payload).unwrap();
    assert_eq!(
        (stats["attempts"].clone(), stats["promptTokens"].clone()),
        (json!(2), json!(1800))
    );
    let requests = h.upstream.requests.lock().unwrap();
    let messages = requests[1]["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[2]["role"], "assistant");
    assert!(
        messages[3]["content"]
            .as_str()
            .unwrap()
            .starts_with("That reply was rejected: the reply must start with SELECT")
    );
}

#[tokio::test]
async fn raw_rows_of_a_large_table_get_one_repair_and_the_sql_frame_is_authoritative() {
    let raw = "SELECT ts, wind FROM telemetry ORDER BY ts";
    let fixed = "SELECT time_bucket(INTERVAL '1 hour', ts) AS t, avg(wind) AS w FROM telemetry GROUP BY t ORDER BY t";
    let h = harness(vec![Reply::content(&[raw]), Reply::content(&[fixed])]).await;
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.send(infer(1, 0, "wind")).await;
    let frames = c.until(Kind::InferStats, 1).await;
    // Attempt 1 streamed before the check could run; the SQL frame carries the repair.
    let deltas: String = of(&frames, Kind::SqlDelta)
        .iter()
        .map(|f| text(f))
        .collect();
    assert_eq!(deltas, raw);
    assert_eq!(text(of(&frames, Kind::Sql)[0]), fixed);
    let stats: Value = serde_json::from_slice(&frames.last().unwrap().payload).unwrap();
    assert_eq!(stats["attempts"], json!(2));
    let requests = h.upstream.requests.lock().unwrap();
    let repair = requests[1]["messages"][3]["content"].as_str().unwrap();
    assert!(
        repair.starts_with("That reply was rejected: it returns raw rows of telemetry (1209600 rows)"),
        "{repair}"
    );
}

#[tokio::test]
async fn raw_rows_on_the_repair_or_with_the_check_off_are_returned_as_is() {
    let raw = "SELECT ts, wind FROM telemetry";
    let h = harness(vec![Reply::content(&[raw]), Reply::content(&[raw])]).await;
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.send(infer(1, 0, "wind")).await;
    let frames = c.until(Kind::InferStats, 1).await;
    assert_eq!(text(of(&frames, Kind::Sql)[0]), raw);
    assert!(of(&frames, Kind::Error).is_empty());

    let h = harness_with(vec![Reply::content(&[raw])], |c| c.row_check = false).await;
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.send(infer(1, 0, "wind")).await;
    let frames = c.until(Kind::InferStats, 1).await;
    assert_eq!(text(of(&frames, Kind::Sql)[0]), raw);
    assert_eq!(h.upstream.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn second_invalid_reply_is_an_error_with_stats() {
    let h = harness(vec![
        Reply::content(&["SELECT 1; DROP TABLE t"]),
        Reply::content(&["DELETE FROM telemetry"]),
    ])
    .await;
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.send(infer(3, 0, "drop it")).await;
    let frames = c.until(Kind::InferStats, 3).await;
    assert!(of(&frames, Kind::Sql).is_empty());
    let error: Value = serde_json::from_slice(&of(&frames, Kind::Error)[0].payload).unwrap();
    assert_eq!(error["code"], "invalid_sql");
    // Attempt 1 streamed (it started like a query); attempt 2 therefore streamed nothing.
    let deltas: String = of(&frames, Kind::SqlDelta)
        .iter()
        .map(|f| text(f))
        .collect();
    assert_eq!(deltas, "SELECT 1; DROP TABLE t");
    assert_eq!(h.upstream.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn cancel_aborts_the_upstream_stream_and_silences_the_request() {
    let h = harness(vec![Reply::slow(), Reply::content(&["SELECT 2"])]).await;
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.send(infer(1, 0, "slow one")).await;
    let first = c.recv().await.unwrap();
    assert_eq!(
        (first.header.kind, first.header.request),
        (Kind::SqlDelta, 1)
    );
    c.send(cancel(1, 1)).await;
    // The upstream body is dropped promptly (its next write fails once the client is gone).
    tokio::time::timeout(Duration::from_secs(2), async {
        while h.upstream.dropped.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("upstream stream was not dropped after CANCEL");
    // A targeted CANCEL keeps the epoch: an INFER at epoch 0 is still current.
    c.send(infer(2, 0, "fast one")).await;
    let frames = c.until(Kind::InferStats, 2).await;
    // The only frame of request 1 after CANCEL is its INFER_STATS, flagged cancelled.
    let (one, two): (Vec<&Frame>, Vec<&Frame>) = frames.iter().partition(|f| f.header.request == 1);
    assert_eq!(one.len(), 1, "{one:?}");
    assert_eq!(one[0].header.kind, Kind::InferStats);
    assert_eq!(one[0].header.epoch, 0, "replies echo the INFER's epoch");
    let stats: Value = serde_json::from_slice(&one[0].payload).unwrap();
    assert_eq!(
        stats,
        json!({"model":"fake/model","promptTokens":0,"completionTokens":0,"attempts":1,"cancelled":true})
    );
    assert!(two.iter().any(|f| f.header.kind == Kind::Sql));
}

#[tokio::test]
async fn stale_epochs_are_dropped_and_cancel_all_fences_older_requests() {
    let h = harness(vec![Reply::slow(), Reply::content(&["SELECT 3"])]).await;
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.send(infer(1, 4, "slow one")).await;
    assert_eq!(c.recv().await.unwrap().header.request, 1);
    // Request 0 = cancel everything; epoch 5 fences anything older.
    c.send(cancel(0, 5)).await;
    c.send(infer(2, 4, "stale: created before the cancel"))
        .await;
    c.send(infer(3, 5, "current")).await;
    let frames = c.until(Kind::InferStats, 3).await;
    let stray: Vec<_> = frames.iter().filter(|f| f.header.request != 3).collect();
    assert!(
        stray
            .iter()
            .all(|f| f.header.request == 1 && f.header.kind == Kind::InferStats),
        "only the cancelled request's INFER_STATS may precede: {stray:?}"
    );
    assert_eq!(
        h.upstream.requests.lock().unwrap().len(),
        2,
        "the stale INFER never reached the provider"
    );
}

#[tokio::test]
async fn per_session_concurrency_is_bounded() {
    let h = harness(vec![Reply::slow(), Reply::slow()]).await;
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.send(infer(1, 0, "a")).await;
    c.send(infer(2, 0, "b")).await;
    c.send(infer(3, 0, "c")).await;
    let frames = c.until(Kind::Error, 3).await;
    let error: Value = serde_json::from_slice(&frames.last().unwrap().payload).unwrap();
    assert_eq!(error["code"], "busy");
}

#[tokio::test]
async fn repeated_question_is_served_from_the_cache() {
    let h = harness(vec![Reply::content(&[
        "SELECT avg(wind) AS wind FROM telemetry",
    ])])
    .await;
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.send(infer(1, 0, "mean wind")).await;
    c.until(Kind::InferStats, 1).await;
    // A second session with the same context content hits the same cache entry.
    let mut c2 = Client::connect(h.addr).await;
    c2.greet().await;
    c2.send(infer(2, 0, "mean wind ")).await;
    let frames = c2.until(Kind::InferStats, 2).await;
    let sql = of(&frames, Kind::Sql)[0];
    assert_eq!(sql.header.flags, flags::CACHED);
    assert_eq!(text(sql), "SELECT avg(wind) AS wind FROM telemetry");
    let stats: Value = serde_json::from_slice(&frames.last().unwrap().payload).unwrap();
    assert_eq!(stats["attempts"], 0);
    assert_eq!(h.upstream.requests.lock().unwrap().len(), 1);
}

fn edit_context(slot: u32, generation: u32, raw: &str) -> Frame {
    Frame::new(Header { request: slot, revision: generation, context: 1, ..Header::new(Kind::EditContext) }, raw)
}
fn edit_infer(request: u32, slot: u32, generation: u32, change: &str) -> Frame {
    let mut payload = slot.to_le_bytes().to_vec(); payload.extend_from_slice(&generation.to_le_bytes()); payload.extend_from_slice(change.as_bytes());
    Frame::new(Header { request, revision: request, context: 1, ..Header::new(Kind::EditInfer) }, payload)
}

#[tokio::test]
async fn prepared_edits_survive_repair_and_cache_by_definition_instead_of_handle() {
    let h = harness(vec![Reply::content(&["Here is a query: SELECT 1"]), Reply::content(&["SELECT 1"]), Reply::content(&["SELECT 2"])]).await;
    let mut c = Client::connect(h.addr).await; c.greet().await;
    let raw = fixture("edit-base.json").trim().to_string();
    c.send(edit_context(90, 3, &raw)).await;
    c.send(edit_infer(1, 90, 3, "weekly instead")).await;
    let out = c.until(Kind::InferStats, 1).await;
    assert_eq!(text(of(&out, Kind::Sql)[0]), "SELECT 1");
    {
        let requests = h.upstream.requests.lock().unwrap();
        let messages = requests[1]["messages"].as_array().unwrap();
        assert_eq!(messages[0]["content"], fixture("vessels-prompt.txt") + &crate::prompt::edit_prompt(&raw));
        assert_eq!(messages[1]["content"], "weekly instead");
        assert!(messages[3]["content"].as_str().unwrap().contains("preserving the chart definition and revision mode above"));
    }
    c.send(edit_context(91, 1, &raw.replace("Aurora", "Calypso"))).await;
    c.send(edit_infer(2, 91, 1, "weekly instead")).await;
    let out = c.until(Kind::InferStats, 2).await;
    assert_eq!(text(of(&out, Kind::Sql)[0]), "SELECT 2");
    let mut c2 = Client::connect(h.addr).await; c2.greet().await;
    c2.send(edit_context(92, 7, &raw)).await;
    c2.send(edit_infer(3, 92, 7, "weekly instead")).await;
    let out = c2.until(Kind::InferStats, 3).await;
    assert_eq!(of(&out, Kind::Sql)[0].header.flags, flags::CACHED);
    assert_eq!(text(of(&out, Kind::Sql)[0]), "SELECT 1");
    assert_eq!(h.upstream.requests.lock().unwrap().len(), 3);
    c.send(edit_context(90, 3, &raw.replace("Aurora", "Calypso"))).await;
    let error = c.recv().await.unwrap();
    assert_eq!(error.header.request, 0);
    assert!(text(&error).contains("bad_edit_context"));
    c.send(edit_infer(4, 90, 2, "weekly instead")).await;
    assert!(text(&c.recv().await.unwrap()).contains("unknown_edit_context"));
}

#[tokio::test]
async fn protocol_errors_close_or_report() {
    let h = harness(vec![]).await;
    // First frame must be HELLO.
    let mut c = Client::connect(h.addr).await;
    c.send(infer(1, 0, "x")).await;
    let error = c.recv().await.unwrap();
    assert_eq!(error.header.kind, Kind::Error);
    assert!(text(&error).contains("\"protocol\""));
    // Text messages are a protocol error.
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.ws.write_frame(WsFrame::text(Payload::Owned(b"{}".to_vec())))
        .await
        .unwrap();
    assert!(text(&c.recv().await.unwrap()).contains("text messages"));
    // Unknown context and empty questions are per-request errors; the session survives.
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.send(Frame::new(
        Header {
            request: 1,
            context: 9,
            ..Header::new(Kind::Infer)
        },
        "q",
    ))
    .await;
    assert!(text(&c.recv().await.unwrap()).contains("unknown_context"));
    c.send(infer(2, 0, "   ")).await;
    assert!(text(&c.recv().await.unwrap()).contains("bad_request"));
    c.send(Frame::new(
        Header {
            context: 2,
            ..Header::new(Kind::Context)
        },
        fixture("vessels-context.json"),
    ))
    .await;
    assert!(text(&c.recv().await.unwrap()).contains("bad_context"));
}

#[tokio::test]
async fn budget_refusal_and_origin_checks() {
    let h = harness_with(vec![Reply::content(&["SELECT 1"])], |c| {
        c.requests_per_minute = 1
    })
    .await;
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.send(infer(1, 0, "one")).await;
    c.until(Kind::InferStats, 1).await;
    c.send(infer(2, 0, "two")).await;
    assert!(text(&c.recv().await.unwrap()).contains("budget"));
    let refused = handshake(h.addr, Some("https://evil.example"))
        .await
        .unwrap_err();
    assert!(refused.starts_with("HTTP/1.1 403"), "{refused}");
}

// ───────────── DESCRIBE (captions) ─────────────

fn describe_config(endpoint: &str, rpm: u32) -> crate::config::DescribeConfig {
    crate::config::DescribeConfig {
        provider: ProviderConfig {
            endpoint: endpoint.into(),
            model: "fake/captioner".into(),
            api_key: None,
            openrouter: false,
            reasoning_effort: None,
            temperature: Some(0.0),
            max_tokens: 600,
            timeout: Duration::from_secs(5),
            max_concurrent: 2,
            extra: Default::default(),
        },
        requests_per_minute: rpm,
        requests_per_day: 1000,
        daily_budget_usd: 1.0,
        cache_entries: 16,
    }
}
async fn caption_harness(replies: Vec<Reply>, rpm: u32, tweak: impl FnOnce(&mut Config)) -> Harness {
    harness_with(replies, |c| {
        c.describe = Some(describe_config(&c.provider.endpoint.clone(), rpm));
        tweak(c);
    })
    .await
}
fn describe(request: u32, sql: &str) -> Frame {
    Frame::new(
        Header { request, ..Header::new(Kind::Describe) },
        json!({"v":1,"sql":sql,"question":"q","dialect":"duckdb","tables":[]}).to_string(),
    )
}
impl Client {
    /// HELLO → READY on a caption link: READY advertises describe-v1. No CONTEXT is needed.
    async fn greet_captions(&mut self) {
        self.send(hello()).await;
        let ready: Value = serde_json::from_slice(&self.recv().await.unwrap().payload).unwrap();
        assert_eq!(ready["capabilities"], json!(["edit-context-v1", "describe-v1"]));
    }
}

#[tokio::test]
async fn describe_returns_a_bounded_caption_from_the_caption_model() {
    let h = caption_harness(vec![Reply::content(&["TITLE: Flights per", " airline.\nEXPLAIN: Number of flights for each airline."])], 10, |_| {}).await;
    let mut c = Client::connect(h.addr).await;
    c.greet_captions().await;
    c.send(Frame::new(Header { request: 5, ..Header::new(Kind::Describe) }, fixture("caption-create.json").trim().to_string())).await;
    let frames = c.until(Kind::Description, 5).await;
    let d = frames.last().unwrap();
    let body: Value = serde_json::from_slice(&d.payload).unwrap();
    assert_eq!((body["title"].clone(), body["explanation"].clone()), (json!("Flights per airline"), json!("Number of flights for each airline.")));
    assert_eq!((body["model"].clone(), body["cached"].clone(), d.header.flags), (json!("fake/model-1"), json!(false), 0));
    use node::*;
    use stage::*;
    assert_eq!(stages(d), [(INFER_RECEIVED, INFERENCE), (PROVIDER_REQUEST, INFERENCE), (FIRST_TOKEN, PROVIDER), (DESCRIPTION_COMPLETE, INFERENCE)]);
    let requests = h.upstream.requests.lock().unwrap();
    assert_eq!(requests[0]["model"], json!("fake/captioner"));
    assert_eq!(requests[0]["max_tokens"], json!(600));
    assert_eq!(requests[0]["messages"][0], json!({"role":"system","content":fixture("caption-system.txt")}));
    assert_eq!(requests[0]["messages"][1], json!({"role":"user","content":fixture("caption-create-user.txt")}));
}

#[tokio::test]
async fn identical_describe_is_answered_from_the_caption_cache() {
    let h = caption_harness(vec![Reply::content(&["TITLE: One\nEXPLAIN: The number one."])], 10, |_| {}).await;
    let mut c = Client::connect(h.addr).await;
    c.greet_captions().await;
    c.send(describe(1, "SELECT 1")).await;
    c.until(Kind::Description, 1).await;
    c.send(describe(2, "SELECT 1")).await;
    let cached = c.until(Kind::Description, 2).await.pop().unwrap();
    assert_eq!(cached.header.flags, flags::CACHED);
    let body: Value = serde_json::from_slice(&cached.payload).unwrap();
    assert_eq!((body["title"].clone(), body["model"].clone(), body["cached"].clone()), (json!("One"), json!("fake/captioner"), json!(true)));
    assert_eq!(h.upstream.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn translations_neither_cancel_nor_wait_for_a_caption() {
    // Session concurrency 1: a caption in flight must not make a translation busy, and
    // cancelling translations by id must not touch the caption.
    let h = caption_harness(vec![Reply::slow(), Reply::content(&["SELECT 1"]), Reply::content(&["SELECT 2"])], 10, |c| c.session_concurrency = 1).await;
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.send(describe(100, "SELECT 1")).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    c.send(infer(1, 0, "first")).await;
    let first = c.until(Kind::InferStats, 1).await;
    assert!(of(&first, Kind::Error).is_empty(), "{first:?}");
    c.send(cancel(1, 0)).await;
    c.send(infer(2, 0, "second")).await;
    let second = c.until(Kind::InferStats, 2).await;
    assert!(of(&second, Kind::Error).is_empty() && !of(&second, Kind::Sql).is_empty());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(h.upstream.dropped.load(Ordering::SeqCst), 2, "only the finished translations' streams closed");
    // Cancel-all still stops the caption (its upstream stream is dropped).
    c.send(cancel(0, 1)).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(h.upstream.dropped.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn cancelling_a_caption_by_id_leaves_translations_running() {
    let h = caption_harness(vec![Reply::slow(), Reply::content(&["SELECT 1"])], 10, |_| {}).await;
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.send(describe(100, "SELECT 1")).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    c.send(cancel(100, 0)).await;
    c.send(infer(1, 0, "first")).await;
    let frames = c.until(Kind::InferStats, 1).await;
    assert!(!of(&frames, Kind::Sql).is_empty());
    assert!(frames.iter().all(|f| f.header.request != 100), "a cancelled caption sends nothing: {frames:?}");
}

#[tokio::test]
async fn caption_budget_and_concurrency_are_separate_from_translation() {
    // Caption quota 1/min: the second caption is refused; translation admission is untouched.
    let h = caption_harness(vec![Reply::content(&["TITLE: A\nEXPLAIN: B."]), Reply::content(&["SELECT 1"])], 1, |c| c.requests_per_minute = 1).await;
    let mut c = Client::connect(h.addr).await;
    c.greet().await;
    c.send(describe(100, "SELECT 1")).await;
    c.until(Kind::Description, 100).await;
    c.send(describe(101, "SELECT 2")).await;
    let refused = c.until(Kind::Error, 101).await.pop().unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&refused.payload).unwrap()["code"], json!("budget"));
    c.send(infer(1, 0, "first")).await;
    let frames = c.until(Kind::InferStats, 1).await;
    assert!(!of(&frames, Kind::Sql).is_empty(), "translation admitted under its own quota: {frames:?}");
}

#[tokio::test]
async fn one_caption_in_flight_per_session_and_disabled_nodes_refuse() {
    let h = caption_harness(vec![Reply::slow()], 10, |_| {}).await;
    let mut c = Client::connect(h.addr).await;
    c.greet_captions().await;
    c.send(describe(1, "SELECT 1")).await;
    c.send(describe(2, "SELECT 2")).await;
    let busy = c.until(Kind::Error, 2).await.pop().unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&busy.payload).unwrap()["code"], json!("busy"));
    c.send(Frame::new(Header { request: 3, ..Header::new(Kind::Describe) }, r#"{"v":1}"#)).await;
    let bad = c.until(Kind::Error, 3).await.pop().unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&bad.payload).unwrap()["code"], json!("bad_request"));

    let off = harness(vec![]).await;
    let mut c = Client::connect(off.addr).await;
    c.greet().await;
    c.send(describe(1, "SELECT 1")).await;
    let refused = c.until(Kind::Error, 1).await.pop().unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&refused.payload).unwrap()["code"], json!("unsupported"));
}
