//! HTTP surface: `GET /health` and the `tb1` WebSocket at `GET /session`.
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
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
    caption::CaptionCache,
    config::Config,
    infer::{Spent, SqlCache},
    provider::Provider,
    session,
};

pub const MAX_SESSIONS: usize = 64;

pub struct App {
    pub provider: Provider,
    pub model: String,
    pub origins: Vec<String>,
    pub sessions: Arc<Semaphore>,
    pub budget: Mutex<Budget>,
    pub totals: Mutex<Totals>,
    pub cache: SqlCache,
    pub session_concurrency: usize,
    /// Repair replies that would return raw rows of a large table (`TIME_BLAST_ROW_CHECK`).
    pub row_check: bool,
    /// DESCRIBE (captions), if enabled. Shares nothing with translation but the process.
    pub describe: Option<Describer>,
    pub shutdown: CancellationToken,
}

/// Caption resources: a separate provider client and slot pool, budget, totals and cache, so a
/// caption can never refuse, delay or cancel a translation (docs/plan-captions.md).
pub struct Describer {
    pub provider: Provider,
    pub model: String,
    pub budget: Mutex<Budget>,
    pub totals: Mutex<Totals>,
    pub cache: CaptionCache,
}

pub struct Budget {
    pub minute_start: Instant,
    pub day_start: Instant,
    pub minute: u32,
    pub day: u32,
    pub day_cost_usd: f64,
    pub minute_limit: u32,
    pub day_limit: u32,
    pub day_cost_limit_usd: f64,
}

impl Budget {
    pub fn new(minute_limit: u32, day_limit: u32, day_cost_limit_usd: f64) -> Self {
        let now = Instant::now();
        Budget {
            minute_start: now,
            day_start: now,
            minute: 0,
            day: 0,
            day_cost_usd: 0.0,
            minute_limit,
            day_limit,
            day_cost_limit_usd,
        }
    }

    pub fn admit(&mut self, now: Instant) -> Result<(), &'static str> {
        if now.duration_since(self.minute_start) >= Duration::from_secs(60) {
            self.minute = 0;
            self.minute_start = now;
        }
        if now.duration_since(self.day_start) >= Duration::from_secs(86400) {
            self.day = 0;
            self.day_cost_usd = 0.0;
            self.day_start = now;
        }
        if self.day_cost_usd >= self.day_cost_limit_usd {
            return Err("Daily inference spend budget reached.");
        }
        if self.minute >= self.minute_limit || self.day >= self.day_limit {
            return Err("Inference request budget reached. Try again later.");
        }
        self.minute += 1;
        self.day += 1;
        Ok(())
    }

    pub fn spend(&mut self, cost_usd: f64) {
        self.day_cost_usd += cost_usd;
    }
}

/// Process-wide counters for `/health`; cancelled requests' upstream cost is unknown.
#[derive(Default)]
pub struct Totals {
    pub requests: u64,
    pub cache_hits: u64,
    pub cancelled: u64,
    pub failed: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_tokens: u64,
    pub cost_usd: f64,
}

impl Totals {
    pub fn record(&mut self, spent: &Spent, ok: bool) {
        self.prompt_tokens += spent.prompt_tokens;
        self.completion_tokens += spent.completion_tokens;
        self.cached_tokens += spent.cached_tokens.unwrap_or(0);
        self.cost_usd += spent.cost_usd.unwrap_or(0.0);
        if !ok {
            self.failed += 1;
        }
    }
}

impl App {
    pub fn new(config: Config) -> Result<Arc<App>, String> {
        let model = config.provider.model.clone();
        let describe = match config.describe {
            None => None,
            Some(d) => Some(Describer {
                model: d.provider.model.clone(),
                provider: Provider::new(d.provider)?,
                budget: Mutex::new(Budget::new(d.requests_per_minute, d.requests_per_day, d.daily_budget_usd)),
                totals: Mutex::new(Totals::default()),
                cache: CaptionCache::new(d.cache_entries),
            }),
        };
        Ok(Arc::new(App {
            describe,
            provider: Provider::new(config.provider)?,
            model,
            origins: config.allowed_origins,
            sessions: Arc::new(Semaphore::new(MAX_SESSIONS)),
            budget: Mutex::new(Budget::new(
                config.requests_per_minute,
                config.requests_per_day,
                config.daily_budget_usd,
            )),
            totals: Mutex::new(Totals::default()),
            cache: SqlCache::new(config.cache_entries),
            session_concurrency: config.session_concurrency,
            row_check: config.row_check,
            shutdown: CancellationToken::new(),
        }))
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
    let app = App::new(config)?;
    // A cheap HEAD establishes DNS/TCP/TLS before the first interactive request.
    let _ = app.provider.warm_connection().await;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    eprintln!(
        "time-blast inference (tb1) listening on {} · model {}",
        listener.local_addr()?,
        app.model
    );
    use axum::serve::ListenerExt;
    let listener = listener.tap_io(|socket| {
        let _ = socket.set_nodelay(true);
    });
    let shutdown = app.shutdown.clone();
    axum::serve(listener, router(app))
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
            shutdown.cancel();
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
    let describe = app.describe.as_ref().map(|d| {
        let (totals, budget) = (d.totals.lock().unwrap(), d.budget.lock().unwrap());
        json!({"model": d.model, "requests": totals.requests, "cacheHits": totals.cache_hits,
            "cancelled": totals.cancelled, "failed": totals.failed, "costUsd": totals.cost_usd,
            "requestsToday": budget.day, "costTodayUsd": budget.day_cost_usd, "dailyBudgetUsd": budget.day_cost_limit_usd})
    });
    let totals = app.totals.lock().unwrap();
    let budget = app.budget.lock().unwrap();
    Json(json!({
        "describe": describe,
        "status": "ready",
        "protocol": tb_protocol::SUBPROTOCOL,
        "model": app.model,
        "maxSessions": MAX_SESSIONS,
        "activeSessions": MAX_SESSIONS - app.sessions.available_permits(),
        "totals": {
            "requests": totals.requests, "cacheHits": totals.cache_hits,
            "cancelled": totals.cancelled, "failed": totals.failed,
            "promptTokens": totals.prompt_tokens, "completionTokens": totals.completion_tokens,
            "cachedTokens": totals.cached_tokens, "costUsd": totals.cost_usd,
        },
        "budget": {
            "requestsToday": budget.day, "requestsPerDay": budget.day_limit,
            "requestsPerMinute": budget.minute_limit,
            "costTodayUsd": budget.day_cost_usd, "dailyBudgetUsd": budget.day_cost_limit_usd,
        },
    }))
}

async fn session_upgrade(State(app): State<Arc<App>>, mut request: Request) -> Response {
    if !protocol_offered(request.headers()) || !upgrade::is_upgrade_request(&request) {
        return (
            StatusCode::BAD_REQUEST,
            "Expected a WebSocket offering subprotocol tb1",
        )
            .into_response();
    }
    let Ok(permit) = app.sessions.clone().try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Session capacity reached").into_response();
    };
    match upgrade::upgrade(&mut request) {
        Ok((mut response, socket)) => {
            response.headers_mut().insert(
                "sec-websocket-protocol",
                HeaderValue::from_static(tb_protocol::SUBPROTOCOL),
            );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_resets_each_window_and_enforces_spend() {
        let start = Instant::now();
        let mut b = Budget::new(1, 2, 1.0);
        b.minute_start = start;
        b.day_start = start;
        assert!(b.admit(start).is_ok());
        assert!(b.admit(start).is_err());
        assert!(b.admit(start + Duration::from_secs(60)).is_ok());
        assert!(b.admit(start + Duration::from_secs(120)).is_err());
        b.spend(1.5);
        assert!(
            b.admit(start + Duration::from_secs(86400)).is_ok(),
            "spend resets daily"
        );
        b.spend(1.0);
        assert!(
            b.admit(start + Duration::from_secs(86460))
                .unwrap_err()
                .contains("spend")
        );
    }
}
