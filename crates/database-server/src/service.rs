//! HTTP surface: `GET /health` and the `tb1` WebSocket at `GET /session`.
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use fastwebsockets::upgrade;
use serde_json::{Value, json};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::{
    clickhouse::{ClickHouse, Failure},
    config::{Config, Limits},
    exec::{CastCache, Shared},
    session,
};

pub const MAX_SESSIONS: usize = 64;
/// A DatasetContext older than this is recomputed for the next HELLO.
pub const CONTEXT_TTL: Duration = Duration::from_secs(300);

pub struct App {
    pub shared: Arc<Shared>,
    pub limits: Limits,
    pub origins: Vec<String>,
    pub sessions: Arc<Semaphore>,
    pub shutdown: CancellationToken,
    dataset_name: String,
    dataset_description: Option<String>,
    context: tokio::sync::Mutex<Option<(Instant, Value)>>,
}

impl App {
    pub fn new(config: Config) -> Result<Arc<App>, String> {
        let clickhouse = ClickHouse::new(config.clickhouse)?;
        Ok(Arc::new(App {
            shared: Arc::new(Shared { clickhouse, limits: config.limits.clone(), casts: CastCache::default(), totals: Default::default() }),
            limits: config.limits,
            origins: config.allowed_origins,
            sessions: Arc::new(Semaphore::new(MAX_SESSIONS)),
            shutdown: CancellationToken::new(),
            dataset_name: config.dataset_name,
            dataset_description: config.dataset_description,
            context: tokio::sync::Mutex::new(None),
        }))
    }

    /// The DatasetContext (id 0; each session sets its own), cached for CONTEXT_TTL.
    pub async fn context(&self) -> Result<Value, Failure> {
        let mut cached = self.context.lock().await;
        if let Some((at, value)) = cached.as_ref() {
            if at.elapsed() < CONTEXT_TTL {
                return Ok(value.clone());
            }
        }
        let value = self
            .shared
            .clickhouse
            .context(&self.dataset_name, self.dataset_description.as_deref())
            .await?;
        *cached = Some((Instant::now(), value.clone()));
        Ok(value)
    }
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/session", get(session_upgrade))
        .layer(middleware::from_fn_with_state(app.clone(), origin_guard))
        .with_state(app)
}

pub async fn serve(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let bind: SocketAddr = config.bind;
    let database = config.clickhouse.database.clone();
    let app = App::new(config)?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    // Warm the pooled connection and the context before the first session.
    match app.shared.clickhouse.version().await {
        Ok(version) => eprintln!("ClickHouse {version}, database {database}"),
        Err(failure) => eprintln!("ClickHouse not reachable yet: {}", failure.message),
    }
    if let Err(failure) = app.context().await {
        eprintln!("DatasetContext not available yet: {}", failure.message);
    }
    eprintln!("time-blast database (tb1, ClickHouse) listening on {}", listener.local_addr()?);
    Ok(serve_on(listener, app).await?)
}

/// Serve on a bound listener until shutdown (SIGINT/SIGTERM or `app.shutdown`).
pub async fn serve_on(listener: tokio::net::TcpListener, app: Arc<App>) -> std::io::Result<()> {
    use axum::serve::ListenerExt;
    let listener = listener.tap_io(|socket| {
        let _ = socket.set_nodelay(true);
    });
    let shutdown = app.shutdown.clone();
    axum::serve(listener, router(app))
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            {
                let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler");
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {}, _ = shutdown.cancelled() => {} }
            }
            #[cfg(not(unix))]
            {
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = shutdown.cancelled() => {} }
            }
            shutdown.cancel();
        })
        .await?;
    Ok(())
}

async fn origin_guard(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let origin = request.headers().get("origin").cloned();
    if let Some(value) = &origin {
        if !value.to_str().is_ok_and(|s| app.origins.iter().any(|allowed| allowed == s)) {
            return (StatusCode::FORBIDDEN, Json(json!({"message": "Browser origin is not allowed"}))).into_response();
        }
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    if let Some(origin) = origin {
        headers.insert("access-control-allow-origin", origin);
        headers.insert("vary", HeaderValue::from_static("Origin"));
    }
    response
}

async fn health(State(app): State<Arc<App>>) -> Json<Value> {
    let totals = app.shared.totals.lock().unwrap();
    Json(json!({
        "status": "ready",
        "protocol": tb_protocol::SUBPROTOCOL,
        "database": app.shared.clickhouse.database(),
        "maxSessions": MAX_SESSIONS,
        "activeSessions": MAX_SESSIONS - app.sessions.available_permits(),
        "totals": {
            "done": totals.done, "errors": totals.errors, "rows": totals.rows, "bytes": totals.bytes,
            "described": totals.described, "restarts": totals.restarts,
        },
        "limits": {
            "maxRows": app.limits.max_rows, "maxBytes": app.limits.max_bytes,
            "timeMs": app.limits.time.as_millis() as u64, "concurrency": app.limits.concurrency,
        },
    }))
}

async fn session_upgrade(State(app): State<Arc<App>>, mut request: Request) -> Response {
    if !protocol_offered(request.headers()) || !upgrade::is_upgrade_request(&request) {
        return (StatusCode::BAD_REQUEST, "Expected a WebSocket offering subprotocol tb1").into_response();
    }
    let Ok(permit) = app.sessions.clone().try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Session capacity reached").into_response();
    };
    match upgrade::upgrade(&mut request) {
        Ok((mut response, socket)) => {
            response
                .headers_mut()
                .insert("sec-websocket-protocol", HeaderValue::from_static(tb_protocol::SUBPROTOCOL));
            tokio::spawn(async move {
                let _permit = permit;
                session::run(app, socket).await;
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
        .is_some_and(|v| v.split(',').any(|p| p.trim() == tb_protocol::SUBPROTOCOL))
}
