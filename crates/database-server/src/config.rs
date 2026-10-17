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

/// The DuckDB backend: one database file, opened read-only in this process.
#[derive(Clone, Debug)]
pub struct DuckDbConfig {
    pub path: std::path::PathBuf,
    /// DuckDB worker threads (database-wide).
    pub threads: usize,
    /// DuckDB `memory_limit` (database-wide), e.g. `1GB`.
    pub memory_limit: String,
    /// Spill directory for sorts/joins/aggregates beyond `memory_limit`.
    pub temp_directory: std::path::PathBuf,
    /// DuckDB `max_temp_directory_size`.
    pub max_temp_size: String,
    /// Model queries running at once in the process (all sessions).
    pub max_queries: usize,
    /// Rows per BATCH after the first: DuckDB produces 2,048-row chunks; later chunks are
    /// coalesced up to this many rows (the first goes out alone, as early as possible).
    pub batch_rows: usize,
    /// Bound on computing the DatasetContext when the file carries no precomputed one.
    pub context_timeout: Duration,
}

#[derive(Clone, Debug)]
pub enum BackendConfig {
    ClickHouse(ClickHouseConfig),
    DuckDb(DuckDbConfig),
}

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: SocketAddr,
    pub backend: BackendConfig,
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

fn duckdb_from_env() -> Result<DuckDbConfig, String> {
    let path: std::path::PathBuf = var("TIME_BLAST_DUCKDB_PATH").ok_or("TIME_BLAST_DUCKDB_PATH is required for the duckdb backend")?.into();
    let threads = std::thread::available_parallelism().map_or(2, |n| n.get());
    let size = |name: &str, default: &str| -> Result<String, String> {
        let value = var(name).unwrap_or_else(|| default.into());
        // Passed to DuckDB as a setting value: digits, a unit, nothing else.
        if value.is_empty() || !value.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == ' ') {
            return Err(format!("Invalid {name}"));
        }
        Ok(value)
    };
    Ok(DuckDbConfig {
        path,
        threads: parse("TIME_BLAST_DUCKDB_THREADS", threads)?.max(1),
        memory_limit: size("TIME_BLAST_DUCKDB_MEMORY_LIMIT", "1GB")?,
        temp_directory: var("TIME_BLAST_DUCKDB_TEMP_DIR")
            .map(Into::into)
            .unwrap_or_else(|| env::temp_dir().join("time-blast-duckdb")),
        max_temp_size: size("TIME_BLAST_DUCKDB_MAX_TEMP_SIZE", "4GB")?,
        max_queries: parse("TIME_BLAST_DUCKDB_MAX_QUERIES", 4usize)?.max(1),
        batch_rows: parse("TIME_BLAST_DUCKDB_BATCH_ROWS", DEFAULT_DUCKDB_BATCH_ROWS)?.max(1),
        context_timeout: Duration::from_millis(parse("TIME_BLAST_DUCKDB_CONTEXT_TIMEOUT_MS", 120_000u64)?),
    })
}

/// Rows per BATCH after the first on the DuckDB backend (see DuckDbConfig::batch_rows).
pub const DEFAULT_DUCKDB_BATCH_ROWS: usize = 8192;

impl Config {
    pub fn from_env() -> Result<Self, String> {
        // TIME_BLAST_DB_BACKEND=duckdb|clickhouse; without it, a configured DuckDB file wins.
        let backend = var("TIME_BLAST_DB_BACKEND")
            .unwrap_or_else(|| if var("TIME_BLAST_DUCKDB_PATH").is_some() { "duckdb".into() } else { "clickhouse".into() });
        let duckdb = match backend.trim() {
            "duckdb" => Some(duckdb_from_env()?),
            "clickhouse" => None,
            _ => return Err("TIME_BLAST_DB_BACKEND must be duckdb or clickhouse".into()),
        };
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
        let default_name = match &duckdb {
            Some(d) => d.path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "duckdb".into()),
            None => database.clone(),
        };
        let backend = match duckdb {
            Some(d) => BackendConfig::DuckDb(d),
            None => BackendConfig::ClickHouse(ClickHouseConfig {
                url: url.trim_end_matches('/').to_string(),
                database,
                user: var("TIME_BLAST_CLICKHOUSE_USER"),
                password: env::var("TIME_BLAST_CLICKHOUSE_PASSWORD").ok(),
                max_block_size: parse("TIME_BLAST_CLICKHOUSE_MAX_BLOCK_SIZE", DEFAULT_MAX_BLOCK_SIZE)?,
                extra_settings,
            }),
        };
        Ok(Config {
            bind: parse("TIME_BLAST_DB_BIND", "127.0.0.1:8788".parse().unwrap())?,
            backend,
            dataset_name: var("TIME_BLAST_DB_NAME").unwrap_or(default_name),
            dataset_description: var("TIME_BLAST_DB_DESCRIPTION"),
            allowed_origins,
            limits,
        })
    }
}
