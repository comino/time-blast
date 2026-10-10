//! Environment configuration. Credentials stay in the server environment.
use std::{env, net::SocketAddr, time::Duration};

#[derive(Clone, Debug)]
pub struct Limits {
    /// Result rows streamed per request (browser node: 250,000).
    pub max_rows: u64,
    /// Arrow IPC bytes (sum of BATCH payloads) per request (browser node: 32 MiB).
    pub max_bytes: u64,
    /// EXEC receipt → DONE (browser node: 15 s).
    pub time: Duration,
    /// EXECs waiting beyond the running ones, per session (browser node: 16).
    pub max_queued: usize,
    /// EXECs running at once per session.
    pub concurrency: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_rows: 250_000,
            max_bytes: 32 << 20,
            time: Duration::from_secs(15),
            max_queued: 16,
            concurrency: 2,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ClickHouseConfig {
    /// HTTP interface base URL, e.g. `http://127.0.0.1:8123`.
    pub url: String,
    pub database: String,
    pub user: Option<String>,
    pub password: Option<String>,
    /// `max_block_size` for model queries (rows per ClickHouse block → per BATCH).
    pub max_block_size: u32,
    /// Extra `name=value` settings appended to every model query (measurement knob).
    pub extra_settings: Vec<(String, String)>,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: SocketAddr,
    pub clickhouse: ClickHouseConfig,
    /// DatasetContext `name` and `description`.
    pub dataset_name: String,
    pub dataset_description: Option<String>,
    pub allowed_origins: Vec<String>,
    pub limits: Limits,
}

/// Measured on the vessels fixture (docs/batch-1/remote-database.md, "Block size").
pub const DEFAULT_MAX_BLOCK_SIZE: u32 = 8192;

fn var(name: &str) -> Option<String> {
    env::var(name).ok().filter(|s| !s.trim().is_empty())
}

fn parse<T: std::str::FromStr>(name: &str, default: T) -> Result<T, String> {
    match var(name) {
        Some(value) => value.trim().parse().map_err(|_| format!("Invalid {name}")),
        None => Ok(default),
    }
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let url = var("TIME_BLAST_CLICKHOUSE_URL").unwrap_or_else(|| "http://127.0.0.1:8123".into());
        let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid TIME_BLAST_CLICKHOUSE_URL")?;
        if parsed.scheme() != "http" || parsed.query().is_some() || !parsed.username().is_empty() {
            return Err("TIME_BLAST_CLICKHOUSE_URL must be plain http without credentials or query (use TIME_BLAST_CLICKHOUSE_USER/PASSWORD)".into());
        }
        let database = var("TIME_BLAST_CLICKHOUSE_DATABASE").unwrap_or_else(|| "time_blast".into());
        if !database.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err("TIME_BLAST_CLICKHOUSE_DATABASE must be [A-Za-z0-9_]".into());
        }
        let extra_settings = var("TIME_BLAST_CLICKHOUSE_SETTINGS")
            .map(|s| {
                s.split('&')
                    .filter(|p| !p.is_empty())
                    .map(|pair| {
                        let (k, v) = pair.split_once('=').ok_or("TIME_BLAST_CLICKHOUSE_SETTINGS: name=value&…")?;
                        Ok((k.to_string(), v.to_string()))
                    })
                    .collect::<Result<Vec<_>, String>>()
            })
            .transpose()?
            .unwrap_or_default();
        let allowed_origins = var("TIME_BLAST_ALLOWED_ORIGINS")
            .unwrap_or_else(|| "http://127.0.0.1:5173,http://localhost:5173,https://time-blast.46-224-133-201.sslip.io".into())
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect::<Vec<_>>();
        if allowed_origins.iter().any(|s| s == "*" || reqwest::Url::parse(s).is_err()) {
            return Err("TIME_BLAST_ALLOWED_ORIGINS must list explicit browser origins".into());
        }
        let defaults = Limits::default();
        let limits = Limits {
            max_rows: parse("TIME_BLAST_DB_MAX_ROWS", defaults.max_rows)?,
            max_bytes: parse("TIME_BLAST_DB_MAX_BYTES", defaults.max_bytes)?,
            time: Duration::from_millis(parse("TIME_BLAST_DB_TIMEOUT_MS", defaults.time.as_millis() as u64)?),
            max_queued: parse("TIME_BLAST_DB_MAX_QUEUED", defaults.max_queued)?,
            concurrency: parse("TIME_BLAST_DB_SESSION_CONCURRENCY", defaults.concurrency)?.max(1),
        };
        Ok(Config {
            bind: parse("TIME_BLAST_DB_BIND", "127.0.0.1:8788".parse().unwrap())?,
            clickhouse: ClickHouseConfig {
                url: url.trim_end_matches('/').to_string(),
                database: database.clone(),
                user: var("TIME_BLAST_CLICKHOUSE_USER"),
                password: env::var("TIME_BLAST_CLICKHOUSE_PASSWORD").ok(),
                max_block_size: parse("TIME_BLAST_CLICKHOUSE_MAX_BLOCK_SIZE", DEFAULT_MAX_BLOCK_SIZE)?,
                extra_settings,
            },
            dataset_name: var("TIME_BLAST_DB_NAME").unwrap_or_else(|| database.clone()),
            dataset_description: var("TIME_BLAST_DB_DESCRIPTION"),
            allowed_origins,
            limits,
        })
    }
}
