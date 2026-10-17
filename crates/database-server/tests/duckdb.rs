//! DuckDB backend, end to end: a fixture database created in this test (writable connection,
//! then closed), served read-only by the server on a loopback port, queried by a raw `tb1`
//! WebSocket client. Covers the guard, limits, cancel/interrupt, epoch fencing, IPC framing
//! and alignment, result equality with a direct DuckDB query, and the DatasetContext (computed
//! and prebuilt). `cargo test --test duckdb -- --ignored --nocapture latency` prints server
//! latencies.
#![cfg(feature = "duckdb")]
use std::{
    ffi::CString,
    path::{Path, PathBuf},
    ptr,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

use arrow_array::RecordBatch;
use fastwebsockets::{Frame as WsFrame, OpCode, Payload, Role, WebSocket};
use libduckdb_sys as ffi;
use serde_json::{Value, json};
use tb_protocol::{Frame, Header, Kind, decode, stage};
use time_blast_database::{
    config::{BackendConfig, Config, DuckDbConfig, Limits},
    duck::{self, DuckDb, Statement},
    exec::Backend,
    service::{App, serve_on},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

/// Same generator shape as the browser's vessels fixture (src/engine/dataset.ts), smaller.
const FIXTURE: &[&str] = &[
    "CREATE TYPE mood AS ENUM ('calm', 'rough', 'storm')",
    "CREATE TABLE telemetry AS
     WITH grid AS (SELECT (i % 6)::INTEGER AS vessel, (i // 6) * 6000 AS elapsed_ms, (i // 6)::DOUBLE / 10.0 AS minute_index FROM range(600000) AS r(i))
     SELECT make_timestamp((1788220800000 + elapsed_ms) * 1000) AS ts,
            (['Aurora', 'Meridian', 'Kestrel', 'Solstice', 'Atlas', 'Nomad'])[vessel + 1] AS vessel,
            round(12.8 + vessel * 0.7 + 2.1 * sin(minute_index / 420 + vessel), 2)::DOUBLE AS speed,
            round(36.0 + vessel * 2.3 + minute_index / 14400, 5)::DOUBLE AS lat,
            (['calm', 'rough', 'storm'])[(vessel % 3) + 1]::mood AS sea
     FROM grid",
    "CREATE TABLE ports (name VARCHAR, country VARCHAR, opened DATE)",
    "INSERT INTO ports VALUES ('Halifax', 'CA', DATE '1749-06-21'), ('Lisbon', 'PT', DATE '1200-01-01'), ('Bergen', 'NO', NULL)",
];

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tb-duckdb-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Create a database file with a writable connection (the server only ever opens it read-only).
fn create(path: &Path, statements: &[&str]) {
    let _ = std::fs::remove_file(path);
    unsafe {
        let mut db: ffi::duckdb_database = ptr::null_mut();
        let c_path = CString::new(path.to_str().unwrap()).unwrap();
        assert_eq!(ffi::duckdb_open(c_path.as_ptr(), &mut db), ffi::DuckDBSuccess);
        let mut conn: ffi::duckdb_connection = ptr::null_mut();
        assert_eq!(ffi::duckdb_connect(db, &mut conn), ffi::DuckDBSuccess);
        for sql in statements {
            let mut result: ffi::duckdb_result = std::mem::zeroed();
            let c_sql = CString::new(*sql).unwrap();
            let state = ffi::duckdb_query(conn, c_sql.as_ptr(), &mut result);
            if state != ffi::DuckDBSuccess {
                let message = std::ffi::CStr::from_ptr(ffi::duckdb_result_error(&mut result)).to_string_lossy().into_owned();
                panic!("{sql}: {message}");
            }
            ffi::duckdb_destroy_result(&mut result);
        }
        ffi::duckdb_disconnect(&mut conn);
        ffi::duckdb_close(&mut db);
    }
}

fn fixture() -> PathBuf {
    static ONCE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        let path = scratch().join("fixture.duckdb");
        create(&path, FIXTURE);
        path
    })
    .clone()
}

fn duck_config(path: &Path) -> DuckDbConfig {
    DuckDbConfig {
        path: path.to_path_buf(),
        threads: 2,
        memory_limit: "512MB".into(),
        temp_directory: scratch().join("spill"),
        max_temp_size: "1GB".into(),
        max_queries: 4,
        batch_rows: 8192,
        context_timeout: Duration::from_secs(30),
    }
}

async fn start(path: &Path, limits: Limits) -> (String, Arc<App>) {
    let config = Config {
        bind: "127.0.0.1:0".parse().unwrap(),
        backend: BackendConfig::DuckDb(duck_config(path)),
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

fn duckdb_of(app: &App) -> Arc<DuckDb> {
    match &app.shared.backend {
        Backend::DuckDb(d) => d.clone(),
        _ => unreachable!(),
    }
}

struct Client {
    ws: WebSocket<TcpStream>,
}

impl Client {
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
        assert!(String::from_utf8_lossy(&response).to_lowercase().starts_with("http/1.1 101"));
        let mut ws = WebSocket::after_handshake(tcp, Role::Client);
        ws.set_auto_pong(true);
        ws.set_max_message_size(64 << 20);
        let mut client = Client { ws };
        client.send(Frame::new(Header::new(Kind::Hello), hello.to_string())).await;
        client
    }

    /// HELLO → READY + CONTEXT; returns the context JSON.
    async fn greet(address: &str, context: u32) -> (Client, Value) {
        let mut c = Client::connect(address, json!({"node": "coordinator", "context": context})).await;
        let (_, ready) = c.next(Duration::from_secs(10)).await.unwrap();
        assert_eq!(ready.header.kind, Kind::Ready);
        assert_eq!(serde_json::from_slice::<Value>(&ready.payload).unwrap()["dialect"], "duckdb");
        let (_, ctx) = c.next(Duration::from_secs(60)).await.unwrap();
        assert_eq!(ctx.header.kind, Kind::Context, "{}", String::from_utf8_lossy(&ctx.payload));
        assert_eq!(ctx.header.context, context);
        (c, serde_json::from_slice(&ctx.payload).unwrap())
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

    async fn result(&mut self, request: u32) -> Vec<(Vec<u8>, Frame)> {
        let mut out = Vec::new();
        loop {
            let (bytes, frame) = self.next(Duration::from_secs(30)).await.expect("result within 30 s");
            assert_eq!(frame.header.request, request, "frames of other requests: {:?}", frame.header);
            let end = matches!(frame.header.kind, Kind::Done | Kind::Error);
            out.push((bytes, frame));
            if end {
                return out;
            }
        }
    }
}

fn error_of(frame: &Frame) -> (String, String) {
    assert_eq!(frame.header.kind, Kind::Error, "{:?}", frame.header);
    let v: Value = serde_json::from_slice(&frame.payload).unwrap();
    (v["code"].as_str().unwrap().into(), v["message"].as_str().unwrap().into())
}

fn done_counts(frame: &Frame) -> (u64, u64) {
    assert_eq!(frame.header.kind, Kind::Done);
    (u64::from_le_bytes(frame.payload[..8].try_into().unwrap()), u64::from_le_bytes(frame.payload[8..].try_into().unwrap()))
}

/// RESULT_SCHEMA + BATCH payloads + end marker → batches, through arrow-rs's IPC reader.
fn decode_result(frames: &[(Vec<u8>, Frame)]) -> Vec<RecordBatch> {
    let mut stream: Vec<u8> = frames
        .iter()
        .filter(|(_, f)| matches!(f.header.kind, Kind::ResultSchema | Kind::Batch))
        .flat_map(|(_, f)| f.payload.clone())
        .collect();
    stream.extend_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0]);
    arrow_ipc::reader::StreamReader::try_new(std::io::Cursor::new(stream), None).unwrap().map(|b| b.unwrap()).collect()
}

fn same_values(a: &[RecordBatch], b: &[RecordBatch]) {
    let rows = |batches: &[RecordBatch]| duck::context::rows(batches);
    assert_eq!(rows(a), rows(b));
}

const AGGREGATE: &str = "SELECT date_trunc('minute', ts) AS t, vessel, avg(speed) AS speed FROM telemetry WHERE ts < TIMESTAMP '2026-09-04' GROUP BY ALL ORDER BY 1, 2";
const SCAN: &str = "SELECT ts, speed, lat FROM telemetry WHERE vessel = 'Aurora' ORDER BY ts";
const LONG: &str = "SELECT sum(hash(i)) FROM range(100000000000) t(i)";

#[test]
fn guard_by_duckdb_parser() {
    let duck = DuckDb::open(duck_config(&fixture())).unwrap();
    let conn = duck.checkout().unwrap();
    let check = |sql: &str| Statement::prepare(&conn, sql).map(|_| ()).map_err(|f| (f.code, f.message));
    for ok in [
        "SELECT 1",
        "SELECT 1;",
        "SELECT 1;;",
        "SELECT 1; -- trailing comment",
        "WITH x AS (SELECT 2 AS a) SELECT a FROM x",
        "FROM telemetry LIMIT 1",
        "VALUES (1), (2)",
        "DESCRIBE telemetry",
        "SUMMARIZE ports",
        "PIVOT ports ON country IN ('CA', 'PT') USING count(*)",
        "SELECT 'a;b' AS s, \"vessel\" FROM telemetry LIMIT 1",
        "SELECT $$x;y$$ AS s",
        "SELECT 1 UNION ALL SELECT 2",
        "-- view: line\nSELECT 1",
    ] {
        assert_eq!(check(ok), Ok(()), "{ok}");
    }
    for (sql, code) in [
        ("SELECT 1; SELECT 2", "sql_rejected"),
        // Without IN, DuckDB expands PIVOT into CREATE TYPE …; SELECT (two statements).
        ("PIVOT ports ON country USING count(*)", "sql_rejected"),
        ("SELECT 1; DROP TABLE telemetry", "sql_rejected"),
        ("", "sql_rejected"),
        ("  -- nothing", "sql_rejected"),
        (";", "sql_rejected"),
        ("DROP TABLE telemetry", "sql_rejected"),
        ("CREATE TABLE x AS SELECT 1", "sql_rejected"),
        ("INSERT INTO ports VALUES ('x', 'y', NULL)", "sql_rejected"),
        ("SET threads = 1", "sql_rejected"),
        ("SET enable_external_access = true", "sql_rejected"),
        ("PRAGMA enable_profiling", "sql_rejected"),
        ("ATTACH '/tmp/other.duckdb'", "sql_rejected"),
        ("COPY (SELECT 1) TO '/tmp/out.csv'", "sql_rejected"),
        ("INSTALL httpfs", "sql_rejected"),
        ("LOAD httpfs", "sql_rejected"),
        ("EXPLAIN SELECT 1", "sql_rejected"),
        ("CALL pragma_version()", "sql_rejected"),
        ("BEGIN TRANSACTION", "sql_rejected"),
        ("CHECKPOINT", "sql_rejected"),
        ("SELECT * FROM read_csv('/etc/passwd')", "sql_rejected"),
        // Replacement scans of file paths are off with external access: not a table.
        ("SELECT * FROM '/etc/passwd'", "sql_error"),
        // getenv exists only in the DuckDB CLI (and is off with external access there).
        ("SELECT getenv('HOME')", "sql_error"),
        ("SELECT * FROM read_text('/etc/hostname')", "sql_rejected"),
        ("SELECT $1", "sql_rejected"),
        ("SELECT nonexistent FROM telemetry", "sql_error"),
        ("SELEC 1", "sql_error"),
    ] {
        let got = check(sql);
        assert!(matches!(&got, Err((c, _)) if *c == code), "{sql}: {got:?}");
    }
    // Runtime errors surface from the stream (here after ~1 M rows), not as a silent end.
    let run = |sql: &str| -> Result<u64, time_blast_database::clickhouse::Failure> {
        let mut stream = Statement::prepare(&conn, sql)?.execute()?;
        let mut rows = 0;
        while let Some(batch) = stream.next()? {
            rows += batch.num_rows() as u64;
        }
        Ok(rows)
    };
    let failure = run("SELECT CASE WHEN i < 1000000 THEN i ELSE error('boom') END FROM range(2000000) t(i)").unwrap_err();
    assert_eq!(failure.code, "sql_error");
    assert!(failure.message.contains("boom"), "{}", failure.message);
    assert_eq!(run("SELECT i FROM range(5000) t(i)").unwrap(), 5000, "connection usable after an error");
    duck.checkin(conn);
}

#[test]
fn configuration_is_locked_and_read_only() {
    let duck = DuckDb::open(duck_config(&fixture())).unwrap();
    let rows = duck::context::rows(
        &duck
            .collect(
                "SELECT current_setting('access_mode'), current_setting('enable_external_access'), current_setting('lock_configuration'), current_setting('threads'), current_setting('autoload_known_extensions')",
                Instant::now() + Duration::from_secs(5),
            )
            .unwrap(),
    );
    assert_eq!(rows, vec![vec![json!("read_only"), json!(false), json!(true), json!(2), json!(false)]]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_duckdb_end_to_end() {
    let path = fixture();
    let (address, app) = start(&path, Limits::default()).await;
    let duck = duckdb_of(&app);
    let (mut c, ctx) = Client::greet(&address, 7).await;

    // DatasetContext like the browser's describe(): rows, types, min/max, values, sample.
    assert_eq!((ctx["id"].clone(), ctx["name"].clone(), ctx["dialect"].clone()), (json!(7), json!("vessels"), json!("duckdb")));
    assert_eq!(ctx["description"], "Synthetic vessel telemetry");
    let tables: Vec<&str> = ctx["tables"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(tables, ["ports", "telemetry"]);
    let telemetry = &ctx["tables"][1];
    assert_eq!(telemetry["rows"], json!(600000));
    let col = |name: &str| telemetry["columns"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap().clone();
    assert_eq!(col("ts")["type"], "TIMESTAMP");
    assert_eq!(col("ts")["min"], "2026-09-01 00:00:00");
    assert_eq!(col("vessel")["values"], json!(["Atlas", "Aurora", "Kestrel", "Meridian", "Nomad", "Solstice"]));
    assert_eq!(col("vessel")["distinct"], 6);
    assert_eq!(col("speed")["type"], "DOUBLE");
    assert!(col("speed")["min"].is_number());
    assert_eq!(col("sea")["values"], json!(["calm", "rough", "storm"]));
    assert_eq!(telemetry["sample"].as_array().unwrap().len(), 3);
    assert_eq!(ctx["tables"][0]["sample"][2], json!(["Bergen", "NO", null]));

    // Aggregate: RESULT_SCHEMA, BATCH…, DONE; identities, stamps, sizes, alignment, equality.
    c.exec(1, 1, 7, AGGREGATE).await;
    let frames = c.result(1).await;
    let (_, schema) = &frames[0];
    assert_eq!(schema.header.kind, Kind::ResultSchema);
    assert_eq!((schema.header.epoch, schema.header.revision, schema.header.context, schema.header.flags), (1, 41, 7, 0));
    assert_eq!(schema.stamps.iter().map(|s| s.stage).collect::<Vec<_>>(), [stage::EXEC_RECEIVED]);
    let batches: Vec<&Frame> = frames.iter().map(|(_, f)| f).filter(|f| f.header.kind == Kind::Batch).collect();
    assert_eq!(batches[0].stamps.iter().map(|s| s.stage).collect::<Vec<_>>(), [stage::DB_FIRST_BATCH]);
    assert!(batches[1..].iter().all(|b| b.stamps.is_empty()));
    let (_, done) = frames.last().unwrap();
    assert_eq!(done.stamps.iter().map(|s| s.stage).collect::<Vec<_>>(), [stage::DB_DONE]);
    let (rows, bytes) = done_counts(done);
    assert_eq!(rows, 4320 * 6);
    assert_eq!(bytes, batches.iter().map(|b| b.payload.len() as u64).sum::<u64>());
    for (raw, frame) in &frames {
        if matches!(frame.header.kind, Kind::ResultSchema | Kind::Batch) {
            let at = raw.len() - frame.payload.len();
            assert_eq!(at % 8, 0, "payload 8-aligned");
            assert_eq!(u32::from_le_bytes(raw[at..at + 4].try_into().unwrap()), 0xFFFF_FFFF, "encapsulated message");
            let meta = u32::from_le_bytes(raw[at + 4..at + 8].try_into().unwrap()) as usize;
            assert_eq!((at + 8 + meta) % 8, 0, "Arrow body 8-aligned in the frame");
            // Metadata version V5 (Message.version, flatbuffer field 0) as apache-arrow expects.
            let info = time_blast_database::ipc::parse_message(&frame.payload[8..8 + meta]).unwrap();
            assert!(!info.compressed);
        }
    }
    let decoded = decode_result(&frames);
    assert!(decoded[0].num_rows() <= 2048, "first batch is one DuckDB chunk");
    assert!(decoded.iter().all(|b| b.num_rows() <= 8192 + 2048));
    let schema_types: Vec<String> = decoded[0].schema().fields().iter().map(|f| f.data_type().to_string()).collect();
    assert_eq!(schema_types, ["Timestamp(Microsecond, None)", "Utf8", "Float64"]);
    same_values(&decoded, &duck.collect(AGGREGATE, Instant::now() + Duration::from_secs(30)).unwrap());

    // Scan (100,000 rows): streams; ENUM arrives as Utf8; empty result: schema + DONE.
    c.exec(1, 2, 7, SCAN).await;
    let frames = c.result(2).await;
    assert_eq!(done_counts(&frames.last().unwrap().1).0, 100_000);
    same_values(&decode_result(&frames), &duck.collect(SCAN, Instant::now() + Duration::from_secs(30)).unwrap());
    c.exec(1, 3, 7, "SELECT sea, count(*) AS n FROM telemetry GROUP BY sea ORDER BY sea").await;
    let frames = c.result(3).await;
    let decoded = decode_result(&frames);
    assert_eq!(decoded[0].schema().field(0).data_type(), &arrow_schema::DataType::Utf8);
    assert_eq!(duck::context::rows(&decoded), vec![vec![json!("calm"), json!(200000)], vec![json!("rough"), json!(200000)], vec![json!("storm"), json!(200000)]]);
    c.exec(1, 4, 7, "SELECT * FROM ports WHERE name = 'nowhere'").await;
    let frames = c.result(4).await;
    assert_eq!(frames.iter().map(|(_, f)| f.header.kind).collect::<Vec<_>>(), [Kind::ResultSchema, Kind::Done]);
    assert_eq!(done_counts(&frames[1].1), (0, 0));

    // Errors: guard and DuckDB errors map to protocol-v1 codes; the reply echoes the identity.
    for (request, sql, code) in [
        (10, "SELECT 1; DROP TABLE telemetry", "sql_rejected"),
        (11, "DROP TABLE telemetry", "sql_rejected"),
        (12, "SELECT * FROM read_csv('/etc/passwd')", "sql_rejected"),
        (13, "SELECT nonexistent FROM telemetry", "sql_error"),
        (14, "SELECT * FROM telemetry", "result_limit"),
        (15, "   -- nothing", "sql_rejected"),
        (16, "SELECT CASE WHEN i < 5000 THEN i ELSE error('boom') END FROM range(10000) t(i)", "sql_error"),
    ] {
        c.exec(1, request, 7, sql).await;
        let frames = c.result(request).await;
        let (_, last) = frames.last().unwrap();
        let (got, message) = error_of(last);
        assert_eq!(got, code, "{sql}: {message}");
        assert_eq!((last.header.epoch, last.header.revision, last.header.context), (1, 40 + request, 7));
        assert_eq!(last.stamps.iter().map(|s| s.stage).collect::<Vec<_>>(), [stage::EXEC_RECEIVED]);
    }
    assert_eq!(done_counts(&{
        c.exec(1, 17, 7, "SELECT count(*) FROM telemetry").await;
        c.result(17).await.pop().unwrap().1
    }).0, 1, "table intact");

    // Other context: dropped. Targeted CANCEL interrupts DuckDB; the request gets no frame.
    c.exec(1, 20, 8, "SELECT 1").await;
    c.exec(1, 21, 7, LONG).await;
    wait_running(&duck, 1).await;
    let t0 = Instant::now();
    c.cancel(1, 21).await;
    let stopped = wait_running(&duck, 0).await;
    eprintln!("CANCEL → DuckDB worker returned: {:.1} ms", (stopped - t0).as_secs_f64() * 1000.0);
    // Full CANCEL raises the epoch: an older-epoch EXEC is dropped, the next one runs.
    c.cancel(5, 0).await;
    c.exec(4, 22, 7, "SELECT 1").await;
    c.exec(5, 23, 7, "SELECT 42 AS answer").await;
    let frames = c.result(23).await;
    assert_eq!(frames[0].1.header.epoch, 5);
    assert_eq!(done_counts(&frames.last().unwrap().1).0, 1);
    // Full CANCEL while running: no frame, DuckDB stops.
    c.exec(5, 24, 7, LONG).await;
    wait_running(&duck, 1).await;
    c.cancel(6, 0).await;
    wait_running(&duck, 0).await;
    assert!(c.next(Duration::from_millis(300)).await.is_none(), "nothing for requests 20, 21, 22, 24");

    // Closing the link interrupts what it started.
    c.exec(6, 30, 7, LONG).await;
    wait_running(&duck, 1).await;
    let t0 = Instant::now();
    drop(c);
    let stopped = wait_running(&duck, 0).await;
    eprintln!("link closed → DuckDB worker returned: {:.1} ms", (stopped - t0).as_secs_f64() * 1000.0);
}

/// Wait until `n` DuckDB workers are running; returns when it happened.
async fn wait_running(duck: &DuckDb, n: usize) -> Instant {
    for _ in 0..1000 {
        if duck.running.load(Ordering::Acquire) == n {
            return Instant::now();
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    panic!("running never became {n} (is {})", duck.running.load(Ordering::Acquire));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timeout_interrupts_and_queue_full() {
    let limits = Limits { time: Duration::from_millis(400), concurrency: 1, max_queued: 1, ..Limits::default() };
    let (address, app) = start(&fixture(), limits).await;
    let duck = duckdb_of(&app);
    let (mut c, _) = Client::greet(&address, 1).await;
    let t0 = Instant::now();
    c.exec(0, 1, 1, LONG).await;
    c.exec(0, 2, 1, "SELECT 1").await;
    c.exec(0, 3, 1, "SELECT 2").await;
    let (_, full) = c.next(Duration::from_secs(5)).await.unwrap();
    assert_eq!((full.header.request, error_of(&full).0.as_str()), (3, "queue_full"));
    let (_, timeout) = c.next(Duration::from_secs(5)).await.unwrap();
    assert_eq!((timeout.header.request, error_of(&timeout).0.as_str()), (1, "timeout"));
    let elapsed = t0.elapsed();
    assert!(elapsed >= Duration::from_millis(390) && elapsed < Duration::from_secs(2), "{elapsed:?}");
    wait_running(&duck, 0).await;
    eprintln!("timeout 400 ms → DuckDB stopped after {:.0} ms", t0.elapsed().as_secs_f64() * 1000.0);
    // Request 2 waited behind request 1; its deadline counts from receipt too.
    let frames = c.result(2).await;
    assert!(matches!(frames.last().unwrap().1.header.kind, Kind::Done | Kind::Error));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn byte_limit_and_prebuilt_context() {
    // A file carrying a precomputed context (src/engine/datasets.ts PrebuiltMeta, format 1).
    let path = scratch().join("prebuilt.duckdb");
    let meta = json!({
        "format": 1, "duckdb": "v1.4.3", "rollups": [], "built": "test",
        "context": {"name": "stored", "dialect": "duckdb", "description": "Stored description",
                    "tables": [{"name": "t", "rows": 3, "columns": [{"name": "x", "type": "BIGINT", "min": 0, "max": 2}], "sample": [[0]]}]},
    });
    let insert = format!("CREATE TABLE \"__tb_rollup\".\"__tb_meta\" AS SELECT '{}' AS meta", meta.to_string().replace('\'', "''"));
    create(&path, &["CREATE TABLE t AS SELECT range AS x FROM range(3)", "CREATE SCHEMA \"__tb_rollup\"", &insert]);
    let limits = Limits { max_bytes: 4096, ..Limits::default() };
    let config = Config {
        bind: "127.0.0.1:0".parse().unwrap(),
        backend: BackendConfig::DuckDb(duck_config(&path)),
        dataset_name: "taxi".into(),
        dataset_description: None,
        allowed_origins: vec!["http://127.0.0.1:5173".into()],
        limits,
    };
    let app = App::new(config).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    tokio::spawn(serve_on(listener, app.clone()));
    let (mut c, ctx) = Client::greet(&address, 3).await;
    assert_eq!(ctx["id"], 3);
    assert_eq!(ctx["name"], "taxi", "configured name wins");
    assert_eq!(ctx["description"], "Stored description", "stored description when none is configured");
    assert_eq!(ctx["tables"][0]["columns"][0]["max"], 2);
    c.exec(0, 1, 3, "SELECT range AS x FROM range(100000)").await;
    let frames = c.result(1).await;
    assert_eq!(error_of(&frames.last().unwrap().1).0, "result_limit");
}

/// Server-side latency (EXEC receipt → first BATCH / DONE, server stamps) on the fixture or on
/// `TIME_BLAST_TEST_DUCKDB` (+ `TIME_BLAST_TEST_QUERIES`, `;;`-separated), cold then warm.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn latency() {
    let path = std::env::var("TIME_BLAST_TEST_DUCKDB").map(PathBuf::from).unwrap_or_else(|_| fixture());
    let queries: Vec<String> = std::env::var("TIME_BLAST_TEST_QUERIES")
        .map(|q| q.split(";;").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_else(|_| vec![AGGREGATE.into(), SCAN.into(), "SELECT vessel, avg(speed) FROM telemetry GROUP BY 1 ORDER BY 1".into(), "SELECT 42".into()]);
    let mut config = duck_config(&path);
    config.threads = std::env::var("TIME_BLAST_TEST_THREADS").ok().and_then(|t| t.parse().ok()).unwrap_or(4);
    config.memory_limit = std::env::var("TIME_BLAST_TEST_MEMORY").unwrap_or_else(|_| "2GB".into());
    if let Ok(rows) = std::env::var("TIME_BLAST_TEST_BATCH_ROWS") {
        config.batch_rows = rows.parse().unwrap();
    }
    let app = App::new(Config {
        bind: "127.0.0.1:0".parse().unwrap(),
        backend: BackendConfig::DuckDb(config),
        dataset_name: "bench".into(),
        dataset_description: None,
        allowed_origins: vec!["http://127.0.0.1:5173".into()],
        limits: Limits { max_rows: 10_000_000, max_bytes: 1 << 30, time: Duration::from_secs(120), ..Limits::default() },
    })
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    tokio::spawn(serve_on(listener, app.clone()));
    let (mut c, _) = Client::greet(&address, 1).await;
    let warm = 10;
    let mut request = 0;
    for sql in &queries {
        let (mut first, mut done) = (Vec::new(), Vec::new());
        let mut shape = (0, 0, 0);
        for run in 0..=warm {
            request += 1;
            c.exec(0, request, 1, sql).await;
            let frames = c.result(request).await;
            let stamp = |s: u16| frames.iter().flat_map(|(_, f)| f.stamps.iter()).find(|x| x.stage == s).map(|x| x.at);
            let received = stamp(stage::EXEC_RECEIVED).unwrap();
            let last = &frames.last().unwrap().1;
            if last.header.kind == Kind::Error {
                panic!("{sql}: {:?}", error_of(last));
            }
            let f = stamp(stage::DB_FIRST_BATCH).map_or(f64::NAN, |t| t - received);
            let d = stamp(stage::DB_DONE).unwrap() - received;
            let (rows, bytes) = done_counts(last);
            shape = (rows, bytes, frames.len() - 2);
            if run == 0 {
                eprintln!("cold  first {f:8.2} ms  done {d:8.2} ms  {sql}");
            } else {
                first.push(f);
                done.push(d);
            }
        }
        let p = |mut v: Vec<f64>, q: f64| {
            v.sort_by(f64::total_cmp);
            v[((q * v.len() as f64) as usize).min(v.len() - 1)]
        };
        eprintln!(
            "warm  first p50 {:7.2} max {:7.2}  done p50 {:7.2} max {:7.2} ms  rows {} bytes {} batches {}  (n={warm})",
            p(first.clone(), 0.5),
            p(first, 1.0),
            p(done.clone(), 0.5),
            p(done, 1.0),
            shape.0,
            shape.1,
            shape.2
        );
    }
}
