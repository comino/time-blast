//! End to end against a real ClickHouse: the server on a loopback port, a raw `tb1`
//! WebSocket client, the vessels fixture in `time_blast_dev.telemetry`
//! (scripts/clickhouse-vessels.sh). Skips (passes with a note) when ClickHouse or the
//! fixture is not reachable.
//!
//!   TIME_BLAST_TEST_CLICKHOUSE_URL       default http://127.0.0.1:18123
//!   TIME_BLAST_TEST_CLICKHOUSE_DATABASE  default time_blast_dev
use std::{sync::Arc, time::Duration};

use fastwebsockets::{Frame as WsFrame, OpCode, Payload, Role, WebSocket};
use serde_json::{Value, json};
use tb_protocol::{Frame, Header, Kind, decode, stage};
use time_blast_database::{
    config::{ClickHouseConfig, Config, Limits},
    ipc::{self, HeaderType, Splitter},
    service::{App, serve_on},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

fn clickhouse_url() -> String {
    std::env::var("TIME_BLAST_TEST_CLICKHOUSE_URL").unwrap_or_else(|_| "http://127.0.0.1:18123".into())
}
fn database() -> String {
    std::env::var("TIME_BLAST_TEST_CLICKHOUSE_DATABASE").unwrap_or_else(|_| "time_blast_dev".into())
}

async fn clickhouse(sql: &str) -> Option<String> {
    let response = reqwest::Client::new()
        .post(format!("{}/?database={}", clickhouse_url(), database()))
        .body(sql.to_string())
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    Some(response.text().await.ok()?.trim().to_string())
}

async fn fixture_ready() -> bool {
    match clickhouse("SELECT count() FROM telemetry").await.as_deref() {
        Some("1209600") => true,
        other => {
            eprintln!("SKIP: ClickHouse fixture not reachable at {} ({other:?}); run scripts/clickhouse-vessels.sh", clickhouse_url());
            false
        }
    }
}

async fn start(limits: Limits) -> (String, Arc<App>) {
    let config = Config {
        bind: "127.0.0.1:0".parse().unwrap(),
        clickhouse: ClickHouseConfig {
            url: clickhouse_url(),
            database: database(),
            user: None,
            password: None,
            max_block_size: 8192,
            extra_settings: Vec::new(),
        },
        dataset_name: "vessels".into(),
        dataset_description: Some("Synthetic vessel telemetry".into()),
        allowed_origins: vec!["http://127.0.0.1:5173".into()],
        limits,
    };
    let app = App::new(config).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    tokio::spawn(serve_on(listener, app.clone()));
    (address, app)
}

struct Client {
    ws: WebSocket<TcpStream>,
}

impl Client {
    /// Raw HTTP upgrade (subprotocol tb1), then HELLO.
    async fn connect(address: &str, hello: Value) -> Client {
        let mut tcp = TcpStream::connect(address).await.unwrap();
        tcp.set_nodelay(true).unwrap();
        let request = format!(
            "GET /session HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: tb1\r\nOrigin: http://127.0.0.1:5173\r\n\r\n"
        );
        tcp.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        while !response.ends_with(b"\r\n\r\n") {
            let mut byte = [0u8; 1];
            tcp.read_exact(&mut byte).await.unwrap();
            response.push(byte[0]);
        }
        let head = String::from_utf8_lossy(&response).to_lowercase();
        assert!(head.starts_with("http/1.1 101"), "{head}");
        assert!(head.contains("sec-websocket-protocol: tb1"), "{head}");
        let mut ws = WebSocket::after_handshake(tcp, Role::Client);
        ws.set_auto_pong(true);
        let mut client = Client { ws };
        client.send(Frame::new(Header::new(Kind::Hello), hello.to_string())).await;
        client
    }

    async fn send(&mut self, frame: Frame) {
        self.ws.write_frame(WsFrame::new(true, OpCode::Binary, None, Payload::Owned(frame.encode()))).await.unwrap();
    }

    async fn exec(&mut self, epoch: u32, request: u32, context: u32, sql: &str) {
        self.send(Frame::new(Header { kind: Kind::Exec, flags: 0, epoch, request, revision: 40 + request, context }, sql)).await;
    }

    async fn cancel(&mut self, epoch: u32, request: u32) {
        self.send(Frame::new(Header { kind: Kind::Cancel, flags: 0, epoch, request, revision: 0, context: 0 }, Vec::new())).await;
    }

    /// Next tb1 frame, or None after `wait` without one.
    async fn next(&mut self, wait: Duration) -> Option<(Vec<u8>, Frame)> {
        loop {
            let frame = tokio::time::timeout(wait, self.ws.read_frame()).await.ok()?.unwrap();
            if frame.opcode == OpCode::Binary {
                let bytes = frame.payload.to_vec();
                let decoded = decode(&bytes).unwrap().to_owned();
                return Some((bytes, decoded));
            }
            assert!(matches!(frame.opcode, OpCode::Ping | OpCode::Pong), "unexpected {:?}", frame.opcode);
        }
    }

    /// Frames for `request` until its DONE or ERROR.
    async fn result(&mut self, request: u32) -> Vec<(Vec<u8>, Frame)> {
        let mut out = Vec::new();
        loop {
            let (bytes, frame) = self.next(Duration::from_secs(20)).await.expect("result within 20 s");
            assert_eq!(frame.header.request, request, "frames of other requests: {:?}", frame.header);
            let end = matches!(frame.header.kind, Kind::Done | Kind::Error);
            out.push((bytes, frame));
            if end {
                return out;
            }
        }
    }
}

fn error_code(frame: &Frame) -> String {
    assert_eq!(frame.header.kind, Kind::Error, "{:?}", frame.header);
    serde_json::from_slice::<Value>(&frame.payload).unwrap()["code"].as_str().unwrap().to_string()
}

fn done_counts(frame: &Frame) -> (u64, u64) {
    assert_eq!(frame.header.kind, Kind::Done);
    (u64::from_le_bytes(frame.payload[..8].try_into().unwrap()), u64::from_le_bytes(frame.payload[8..].try_into().unwrap()))
}

const AGGREGATE: &str = "SELECT date_trunc('minute', ts) AS t, vessel, avg(speed) AS speed FROM telemetry WHERE ts < '2026-09-08' GROUP BY ALL ORDER BY 1, 2";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_database_end_to_end() {
    if !fixture_ready().await {
        return;
    }
    let (address, _app) = start(Limits::default()).await;
    let mut c = Client::connect(&address, json!({"node": "coordinator", "name": "test", "version": 1, "context": 7})).await;

    // HELLO → READY, CONTEXT with the peer's context id.
    let (_, ready) = c.next(Duration::from_secs(10)).await.unwrap();
    assert_eq!(ready.header.kind, Kind::Ready);
    let (_, context) = c.next(Duration::from_secs(30)).await.unwrap();
    assert_eq!(context.header.kind, Kind::Context);
    assert_eq!(context.header.context, 7);
    let ctx: Value = serde_json::from_slice(&context.payload).unwrap();
    assert_eq!(ctx["id"], 7);
    assert_eq!(ctx["dialect"], "clickhouse");
    let telemetry = ctx["tables"].as_array().unwrap().iter().find(|t| t["name"] == "telemetry").unwrap();
    assert_eq!(telemetry["rows"], 1209600);
    let vessel = telemetry["columns"].as_array().unwrap().iter().find(|c| c["name"] == "vessel").unwrap();
    assert_eq!(vessel["values"], json!(["Atlas", "Aurora", "Kestrel", "Meridian", "Nomad", "Solstice"]));
    assert_eq!(telemetry["sample"].as_array().unwrap().len(), 3);

    // The 60,480-row aggregate: RESULT_SCHEMA, BATCH…, DONE; identities echoed; stamps.
    c.exec(1, 1, 7, AGGREGATE).await;
    let frames = c.result(1).await;
    let (_, schema) = &frames[0];
    assert_eq!(schema.header.kind, Kind::ResultSchema);
    assert_eq!((schema.header.epoch, schema.header.revision, schema.header.context), (1, 41, 7));
    assert_eq!(schema.stamps.iter().map(|s| s.stage).collect::<Vec<_>>(), [stage::EXEC_RECEIVED]);
    let batches: Vec<&Frame> = frames.iter().map(|(_, f)| f).filter(|f| f.header.kind == Kind::Batch).collect();
    assert!(!batches.is_empty());
    assert_eq!(batches[0].stamps.iter().map(|s| s.stage).collect::<Vec<_>>(), [stage::DB_FIRST_BATCH]);
    assert!(batches[1..].iter().all(|b| b.stamps.is_empty()));
    let (_, done) = frames.last().unwrap();
    let (rows, bytes) = done_counts(done);
    assert_eq!(rows, 60_480);
    assert_eq!(bytes, batches.iter().map(|b| b.payload.len() as u64).sum::<u64>());
    assert_eq!(done.stamps.iter().map(|s| s.stage).collect::<Vec<_>>(), [stage::DB_DONE]);
    // Payloads are whole IPC messages: they re-split to the same rows, and bodies stay 8-aligned
    // relative to the frame start.
    let mut stream: Vec<u8> = frames.iter().filter(|(_, f)| matches!(f.header.kind, Kind::ResultSchema | Kind::Batch)).flat_map(|(_, f)| f.payload.clone()).collect();
    stream.extend_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0]);
    let mut splitter = Splitter::new(usize::MAX);
    let mut input = &stream[..];
    let mut resplit_rows = 0;
    while !input.is_empty() {
        if let Some(ipc::Item::Message { info, .. }) = splitter.feed(&mut input, |_| Some(0)).unwrap() {
            resplit_rows += info.rows;
        }
    }
    assert_eq!(resplit_rows, 60_480);
    for (bytes, frame) in &frames {
        if matches!(frame.header.kind, Kind::ResultSchema | Kind::Batch) {
            let at = bytes.len() - frame.payload.len();
            let meta = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
            assert_eq!((at + 8 + meta) % 8, 0, "Arrow body 8-aligned in the frame");
        }
    }
    // date_trunc gives DateTime64(0): an Arrow Timestamp (tag 10), not UInt32.
    let info = ipc::parse_message(&schema.payload[8..]).unwrap();
    assert_eq!(info.header, HeaderType::Schema);
    assert_eq!(info.fields[0].tag, 10);

    // DateTime results (toStartOfInterval) are cast to DateTime64 → Arrow Timestamp.
    c.exec(1, 2, 7, "SELECT toStartOfInterval(ts, INTERVAL 1 hour) AS t, count() AS n FROM telemetry GROUP BY t ORDER BY t LIMIT 5").await;
    let frames = c.result(2).await;
    let info = ipc::parse_message(&frames[0].1.payload[8..]).unwrap();
    assert_eq!(info.fields[0].tag, 10, "DateTime arrives as Timestamp");
    assert_eq!(done_counts(&frames.last().unwrap().1).0, 5);
    // …and the cached decision skips DESCRIBE and the restart on repeat.
    c.exec(1, 3, 7, "SELECT toStartOfInterval(ts, INTERVAL 1 hour) AS t, count() AS n FROM telemetry GROUP BY t ORDER BY t LIMIT 5").await;
    let frames = c.result(3).await;
    assert_eq!(ipc::parse_message(&frames[0].1.payload[8..]).unwrap().fields[0].tag, 10);

    // Guard and ClickHouse errors map to protocol-v1 codes; reply carries EXEC_RECEIVED.
    for (request, sql, code) in [
        (10, "SELECT 1; DROP TABLE telemetry", "sql_rejected"),
        (11, "DROP TABLE telemetry", "sql_error"),
        (12, "SELECT * FROM url('http://127.0.0.1:18123/?query=SELECT+1', CSV)", "sql_rejected"),
        // A SETTINGS clause inside the wrapper does not lift the limits (readonly=1).
        (13, "SELECT * FROM telemetry SETTINGS max_result_rows = 0, result_overflow_mode = 'break'", "result_limit"),
        (14, "SELECT nonexistent FROM telemetry", "sql_error"),
        (15, "SELECT * FROM telemetry", "result_limit"),
        (16, "SELECT 1 FORMAT JSON", "sql_error"),
        (17, "   -- nothing", "sql_rejected"),
    ] {
        c.exec(1, request, 7, sql).await;
        let frames = c.result(request).await;
        let (_, last) = frames.last().unwrap();
        assert_eq!(error_code(last), code, "{sql}");
        assert_eq!(last.stamps.iter().map(|s| s.stage).collect::<Vec<_>>(), [stage::EXEC_RECEIVED]);
    }
    assert_eq!(clickhouse("SELECT count() FROM telemetry").await.as_deref(), Some("1209600"), "table intact");

    // Other context: dropped silently. Targeted CANCEL of a running query: no frames, query killed.
    c.exec(1, 20, 8, "SELECT 1").await;
    c.exec(1, 21, 7, "SELECT sum(number) FROM numbers(100000000000)").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let pattern = format!("tb-{}-%-21-%", std::process::id());
    let running = clickhouse(&format!("SELECT count() FROM system.processes WHERE query_id LIKE '{pattern}'")).await;
    assert_eq!(running.as_deref(), Some("1"), "query running before CANCEL");
    let t0 = std::time::Instant::now();
    c.cancel(1, 21).await;
    let mut gone_ms = None;
    for _ in 0..100 {
        if clickhouse(&format!("SELECT count() FROM system.processes WHERE query_id LIKE '{pattern}'")).await.as_deref() == Some("0") {
            gone_ms = Some(t0.elapsed().as_secs_f64() * 1000.0);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    eprintln!("CANCEL → query gone from system.processes: {gone_ms:?} ms (includes the polling query)");
    assert!(gone_ms.is_some(), "ClickHouse query stopped after CANCEL");
    // Full CANCEL raises the epoch: an older-epoch EXEC is dropped, the next one runs.
    c.cancel(5, 0).await;
    c.exec(4, 22, 7, "SELECT 1").await;
    c.exec(5, 23, 7, "SELECT 42 AS answer").await;
    let frames = c.result(23).await;
    assert_eq!(frames[0].1.header.epoch, 5);
    assert_eq!(done_counts(&frames.last().unwrap().1).0, 1);
    assert!(c.next(Duration::from_millis(300)).await.is_none(), "nothing for requests 20, 21, 22");

    // Closing the link cancels everything it started.
    c.exec(5, 30, 7, "SELECT sum(number) FROM numbers(100000000000)").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    drop(c);
    let pattern = format!("tb-{}-%-30-%", std::process::id());
    let mut stopped = false;
    for _ in 0..100 {
        if clickhouse(&format!("SELECT count() FROM system.processes WHERE query_id LIKE '{pattern}'")).await.as_deref() == Some("0") {
            stopped = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(stopped, "closing the link killed the query");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wall_clock_limit_and_queue_full() {
    if !fixture_ready().await {
        return;
    }
    let limits = Limits { time: Duration::from_millis(400), concurrency: 1, max_queued: 1, ..Limits::default() };
    let (address, _app) = start(limits).await;
    let mut c = Client::connect(&address, json!({"node": "coordinator"})).await;
    assert_eq!(c.next(Duration::from_secs(10)).await.unwrap().1.header.kind, Kind::Ready);
    assert_eq!(c.next(Duration::from_secs(30)).await.unwrap().1.header.context, 1, "default context id");
    c.exec(0, 1, 1, "SELECT sum(number) FROM numbers(100000000000)").await;
    c.exec(0, 2, 1, "SELECT 1").await;
    c.exec(0, 3, 1, "SELECT 2").await;
    let (_, full) = c.next(Duration::from_secs(5)).await.unwrap();
    assert_eq!(full.header.request, 3);
    assert_eq!(error_code(&full), "queue_full");
    let (_, timeout) = c.next(Duration::from_secs(5)).await.unwrap();
    assert_eq!(timeout.header.request, 1);
    assert_eq!(error_code(&timeout), "timeout");
    // Request 2 waited behind request 1; its deadline counts from receipt too.
    let frames = c.result(2).await;
    assert!(matches!(frames.last().unwrap().1.header.kind, Kind::Done | Kind::Error));
}

/// Latency sweep without a browser (`cargo test --release --test clickhouse -- --ignored
/// --nocapture latency_sweep`): EXEC → first BATCH / DONE at a Rust WebSocket client on
/// loopback, per `max_block_size` (env SWEEP_BLOCK_SIZES), warm (after 3 runs), n = 20.
/// Numbers in docs/batch-1/remote-database.md.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn latency_sweep() {
    if !fixture_ready().await {
        return;
    }
    let queries = [
        ("aggregate60k", AGGREGATE),
        ("scan158k", "SELECT ts, speed, lat, lon FROM telemetry WHERE vessel = 'Aurora' AND ts < TIMESTAMP '2026-09-12' ORDER BY ts"),
        ("tiny", "SELECT 42 AS answer"),
    ];
    let sizes: Vec<u32> = std::env::var("SWEEP_BLOCK_SIZES")
        .unwrap_or_else(|_| "2048,8192,65409".into())
        .split(',')
        .map(|s| s.trim().parse().unwrap())
        .collect();
    let q = |mut v: Vec<f64>, p: f64| {
        v.sort_by(f64::total_cmp);
        v[((p * v.len() as f64) as usize).min(v.len() - 1)]
    };
    let mut request = 0;
    for size in sizes {
        let config = Config {
            bind: "127.0.0.1:0".parse().unwrap(),
            clickhouse: ClickHouseConfig {
                url: clickhouse_url(),
                database: database(),
                user: None,
                password: None,
                max_block_size: size,
                extra_settings: Vec::new(),
            },
            dataset_name: "vessels".into(),
            dataset_description: None,
            allowed_origins: vec!["http://127.0.0.1:5173".into()],
            limits: Limits::default(),
        };
        let app = App::new(config).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        tokio::spawn(serve_on(listener, app.clone()));
        let mut c = Client::connect(&address, json!({"context": 1})).await;
        c.next(Duration::from_secs(10)).await.unwrap();
        c.next(Duration::from_secs(30)).await.unwrap();
        for (name, sql) in queries {
            let (mut first, mut done, mut server_first, mut batches) = (Vec::new(), Vec::new(), Vec::new(), 0);
            for i in 0..23 {
                request += 1;
                let t0 = std::time::Instant::now();
                c.exec(0, request, 1, sql).await;
                let mut first_at = None;
                let mut received = 0.0;
                let mut count = 0;
                loop {
                    let (_, f) = c.next(Duration::from_secs(30)).await.unwrap();
                    match f.header.kind {
                        Kind::ResultSchema => received = f.stamps[0].at,
                        Kind::Batch => {
                            count += 1;
                            if first_at.is_none() {
                                first_at = Some(t0.elapsed().as_secs_f64() * 1000.0);
                                if i >= 3 {
                                    server_first.push(f.stamps[0].at - received);
                                }
                            }
                        }
                        Kind::Done => break,
                        other => panic!("{other:?}"),
                    }
                }
                if i >= 3 {
                    first.push(first_at.unwrap());
                    done.push(t0.elapsed().as_secs_f64() * 1000.0);
                    batches = count;
                }
            }
            eprintln!(
                "max_block_size {size:>6} {name:<13} batches {batches:>3}  first p50 {:7.2} p95 {:7.2}  done p50 {:7.2} p95 {:7.2}  server first p50 {:7.2} ms",
                q(first.clone(), 0.5),
                q(first, 0.95),
                q(done.clone(), 0.5),
                q(done, 0.95),
                q(server_first, 0.5)
            );
        }
        app.shutdown.cancel();
    }
}
