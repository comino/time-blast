//! Remote database node for time-blast: protocol v1 (`tb1`) over WebSocket in front of
//! DuckDB (in process, read-only file; the browser's dialect) or ClickHouse (HTTP). The browser
//! engine reaches it through the same `Link`/host routing as the in-browser DuckDB node; only
//! the transport differs (docs/batch-1/remote-database.md).
//!
//! DuckDB: EXEC → DuckDB's parser (one SELECT) → streaming chunks → Arrow C data → Arrow IPC
//! encapsulated messages → RESULT_SCHEMA / BATCH frames → DONE.
//! ClickHouse: EXEC → guard → HTTP `FORMAT ArrowStream` → split into encapsulated IPC
//! messages (no re-encoding) → RESULT_SCHEMA / BATCH frames → DONE.
pub mod clickhouse;
pub mod config;
#[cfg(feature = "duckdb")]
pub mod duck;
pub mod exec;
pub mod guard;
pub mod ipc;
pub mod service;
pub mod session;

use std::time::{SystemTime, UNIX_EPOCH};

/// Unix epoch milliseconds (protocol-v1 stamp clock).
pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}
