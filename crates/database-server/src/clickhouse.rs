//! ClickHouse over its HTTP interface: model queries as streamed `ArrowStream`, the
//! DatasetContext (cold path), DESCRIBE for result types, and KILL QUERY for cancellation.
//!
//! One pooled reqwest client (HTTP/1.1 keep-alive, TCP_NODELAY, no compression: on loopback
//! compression costs CPU and saves nothing, measured in docs/batch-1/remote-database.md).
use std::{fmt::Write as _, time::Duration};

use serde_json::{Value, json};

use crate::config::{ClickHouseConfig, Limits};

#[derive(Clone)]
pub struct ClickHouse {
    http: reqwest::Client,
    config: ClickHouseConfig,
}

/// A ClickHouse failure mapped to a protocol-v1 database ERROR code.
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}

impl Failure {
    pub fn new(code: &'static str, message: impl Into<String>) -> Failure {
        Failure { code, message: message.into() }
    }
}

/// ClickHouse exception code → protocol-v1 ERROR code.
pub fn error_code(clickhouse_code: Option<u32>) -> &'static str {
    match clickhouse_code {
        Some(159 | 160) => "timeout",                  // TIMEOUT_EXCEEDED, TOO_SLOW
        Some(158 | 307 | 396) => "result_limit",       // TOO_MANY_ROWS, TOO_MANY_BYTES, TOO_MANY_ROWS_OR_BYTES
        Some(164 | 497 | 291) => "sql_rejected",       // READONLY, ACCESS_DENIED, DATABASE_ACCESS_DENIED
        Some(202) => "queue_full",                     // TOO_MANY_SIMULTANEOUS_QUERIES
        _ => "sql_error",
    }
}

/// `Code: 62. DB::Exception: …` → 62.
pub fn parse_code(text: &str) -> Option<u32> {
    let at = text.find("Code: ")? + 6;
    let digits: String = text[at..].chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// Text of a ClickHouse exception: a whole error body, or the `__exception__` block that
/// ClickHouse appends to a stream that already sent data (`__exception__\n<tag>\n<text>\n
/// <len> <tag>\n__exception__`).
pub fn exception_text(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let text = text.trim();
    let Some(body) = text.strip_prefix("__exception__") else {
        return text.to_string();
    };
    let mut lines = body.trim_start_matches(['\r', '\n']).lines();
    let tag = lines.next().unwrap_or("").trim();
    let rest: Vec<&str> = lines.collect();
    // Drop the trailer `<len> <tag>` and `__exception__` lines.
    let end = rest
        .iter()
        .rposition(|line| !tag.is_empty() && line.trim_end().ends_with(tag) && line.trim_start().starts_with(|c: char| c.is_ascii_digit()))
        .unwrap_or(rest.len());
    rest[..end].join("\n").trim().to_string()
}

impl ClickHouse {
    pub fn new(config: ClickHouseConfig) -> Result<ClickHouse, String> {
        let http = reqwest::Client::builder()
            .tcp_nodelay(true)
            .pool_idle_timeout(Duration::from_secs(25))
            .pool_max_idle_per_host(32)
            .connect_timeout(Duration::from_secs(3))
            .http1_only()
            .build()
            .map_err(|e| format!("HTTP client: {e}"))?;
        Ok(ClickHouse { http, config })
    }

    pub fn database(&self) -> &str {
        &self.config.database
    }

    fn request(&self, params: &[(&str, &str)], body: String) -> reqwest::RequestBuilder {
        let mut url = format!("{}/?database={}", self.config.url, self.config.database);
        for (name, value) in params {
            let _ = write!(url, "&{}={}", name, encode(value));
        }
        let mut request = self.http.post(url).body(body);
        if let Some(user) = &self.config.user {
            request = request.header("X-ClickHouse-User", user);
            request = request.header("X-ClickHouse-Key", self.config.password.as_deref().unwrap_or(""));
        }
        request
    }

    /// Settings for model SQL. `readonly=1` comes first: it forbids writes, table functions
    /// and any later change of these limits from inside the query (a `SETTINGS` clause).
    pub fn query_settings(&self, limits: &Limits, query_id: &str) -> Vec<(String, String)> {
        let mut s: Vec<(String, String)> = [
            ("readonly", "1".to_string()),
            ("query_id", query_id.to_string()),
            ("max_execution_time", limits.time.as_secs_f64().ceil().to_string()),
            ("timeout_overflow_mode", "throw".into()),
            // The relay counts rows and Arrow bytes exactly; ClickHouse's own limits are the
            // backstop that stops the work (they count rows and in-memory block bytes).
            ("max_result_rows", limits.max_rows.to_string()),
            ("max_result_bytes", (limits.max_bytes * 2).to_string()),
            ("result_overflow_mode", "throw".into()),
            ("max_block_size", self.config.max_block_size.to_string()),
            // Arrow IPC body compression would defeat viewing buffers in place.
            ("output_format_arrow_compression_method", "none".into()),
            // LowCardinality as plain Utf8: dictionaries would need DICTIONARY_BATCH frames.
            ("output_format_arrow_low_cardinality_as_dictionary", "0".into()),
            ("output_format_arrow_string_as_string", "1".into()),
            // Stream as blocks are produced.
            ("wait_end_of_query", "0".into()),
            ("send_progress_in_http_headers", "0".into()),
            // Closing the HTTP connection cancels the query (KILL QUERY also runs).
            ("cancel_http_readonly_queries_on_client_close", "1".into()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        s.extend(self.config.extra_settings.iter().cloned());
        s
    }

    /// Start a model query; returns once ClickHouse sends response headers (the first block
    /// or an early error). The body is then read chunk by chunk.
    pub async fn start(&self, sql: &str, settings: &[(String, String)]) -> Result<reqwest::Response, Failure> {
        let params: Vec<(&str, &str)> = settings.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let response = self
            .request(&params, format!("{sql}\nFORMAT ArrowStream"))
            .send()
            .await
            .map_err(|e| Failure::new("unavailable", format!("ClickHouse request failed: {e}")))?;
        if response.status().is_success() {
            return Ok(response);
        }
        Err(failure_from(response).await)
    }

    /// Result columns of a statement (`DESCRIBE TABLE (<sql>)`), without running it.
    pub async fn describe(&self, inner_sql: &str, query_id: &str) -> Result<Vec<(String, String)>, Failure> {
        let body = format!("DESCRIBE TABLE ({inner_sql}\n) FORMAT JSONCompactColumns");
        let response = self
            .request(&[("readonly", "1"), ("query_id", query_id), ("max_execution_time", "5")], body)
            .send()
            .await
            .map_err(|e| Failure::new("unavailable", e.to_string()))?;
        if !response.status().is_success() {
            return Err(failure_from(response).await);
        }
        let bytes = response.bytes().await.map_err(|e| Failure::new("unavailable", e.to_string()))?;
        let columns: Vec<Vec<Value>> = serde_json::from_slice(&bytes).map_err(|e| Failure::new("sql_error", e.to_string()))?;
        let names = columns.first().cloned().unwrap_or_default();
        let types = columns.get(1).cloned().unwrap_or_default();
        Ok(names
            .iter()
            .zip(&types)
            .map(|(n, t)| (n.as_str().unwrap_or("").to_string(), t.as_str().unwrap_or("").to_string()))
            .collect())
    }

    /// Stop a query by id. Best effort: the query may already be gone.
    pub async fn kill(&self, query_id: &str) {
        let body = format!("KILL QUERY WHERE query_id = '{}' ASYNC FORMAT Null", query_id.replace(['\'', '\\'], ""));
        let _ = tokio::time::timeout(Duration::from_secs(3), self.request(&[], body).send()).await;
    }

    /// Run a cold-path query and parse `JSONCompact` rows.
    async fn rows(&self, sql: &str) -> Result<Vec<Vec<Value>>, Failure> {
        let response = self
            .request(
                &[("readonly", "1"), ("output_format_json_quote_64bit_integers", "0"), ("output_format_json_quote_denormals", "0")],
                format!("{sql}\nFORMAT JSONCompact"),
            )
            .send()
            .await
            .map_err(|e| Failure::new("unavailable", format!("ClickHouse request failed: {e}")))?;
        if !response.status().is_success() {
            return Err(failure_from(response).await);
        }
        let bytes = response.bytes().await.map_err(|e| Failure::new("unavailable", e.to_string()))?;
        let body: Value = serde_json::from_slice(&bytes).map_err(|e| Failure::new("dataset", e.to_string()))?;
        Ok(serde_json::from_value(body["data"].clone()).unwrap_or_default())
    }

    pub async fn version(&self) -> Result<String, Failure> {
        let rows = self.rows("SELECT version()").await?;
        Ok(rows.first().and_then(|r| r.first()).and_then(Value::as_str).unwrap_or("").to_string())
    }

    /// protocol-v1 `DatasetContext` for every table of the database: columns from
    /// `system.columns`, then one statistics query and one sample query per table.
    pub async fn context(&self, name: &str, description: Option<&str>) -> Result<Value, Failure> {
        let columns = self
            .rows("SELECT table, name, type FROM system.columns WHERE database = currentDatabase() ORDER BY table, position")
            .await?;
        let mut tables: Vec<(String, Vec<(String, String)>)> = Vec::new();
        for row in columns {
            let [table, column, ty] = [0, 1, 2].map(|i| row.get(i).and_then(Value::as_str).unwrap_or("").to_string());
            match tables.last_mut() {
                Some((t, cols)) if *t == table => cols.push((column, ty)),
                _ => tables.push((table, vec![(column, ty)])),
            }
        }
        let mut out = Vec::new();
        for (table, columns) in &tables {
            let stats = self.rows(&statistics_sql(table, columns)).await?;
            let values = stats.into_iter().next().unwrap_or_default();
            let (rows, described) = apply_statistics(columns, &values);
            let sample = self.rows(&sample_sql(table, columns, 3)).await.unwrap_or_default();
            out.push(json!({"name": table, "rows": rows, "columns": described, "sample": sample}));
        }
        if out.is_empty() {
            return Err(Failure::new("dataset", format!("database {} has no tables", self.config.database)));
        }
        let mut context = json!({"id": 0, "name": name, "dialect": "clickhouse", "tables": out});
        if let Some(description) = description {
            context["description"] = json!(description);
        }
        Ok(context)
    }
}

async fn failure_from(response: reqwest::Response) -> Failure {
    let header_code = response
        .headers()
        .get("x-clickhouse-exception-code")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    let status = response.status();
    let body = response.bytes().await.unwrap_or_default();
    let text = exception_text(&body[..body.len().min(64 << 10)]);
    let code = header_code.or_else(|| parse_code(&text));
    let message = if text.is_empty() { format!("ClickHouse returned HTTP {status}") } else { text };
    Failure::new(error_code(code), message)
}

/// Percent-encode a URL query value.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

// ───────────────────────── statistics (cold path) ─────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColumnClass {
    Numeric,
    Temporal,
    Text,
    Boolean,
    Other,
}

/// `Nullable(LowCardinality(String))` → `String`.
pub fn base_type(ty: &str) -> &str {
    let mut t = ty.trim();
    loop {
        let stripped = ["Nullable(", "LowCardinality("]
            .iter()
            .find_map(|w| t.strip_prefix(w).and_then(|s| s.strip_suffix(')')));
        match stripped {
            Some(inner) => t = inner.trim(),
            None => return t,
        }
    }
}

pub fn classify(ty: &str) -> ColumnClass {
    let t = base_type(ty);
    let head = t.split('(').next().unwrap_or(t);
    match head {
        "Int8" | "Int16" | "Int32" | "Int64" | "Int128" | "Int256" | "UInt8" | "UInt16" | "UInt32" | "UInt64" | "UInt128"
        | "UInt256" | "Float32" | "Float64" | "BFloat16" | "Decimal" | "Decimal32" | "Decimal64" | "Decimal128"
        | "Decimal256" => ColumnClass::Numeric,
        "Date" | "Date32" | "DateTime" | "DateTime64" => ColumnClass::Temporal,
        "String" | "FixedString" | "Enum8" | "Enum16" | "Enum" => ColumnClass::Text,
        "Bool" | "Boolean" => ColumnClass::Boolean,
        _ => ColumnClass::Other,
    }
}

pub const MAX_LISTED_VALUES: usize = 32;

pub fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('\\', "\\\\").replace('`', "\\`"))
}

/// One pass: row count, min/max for numeric (Float64) and temporal (ClickHouse text)
/// columns, and for text `uniq` plus `groupUniqArray(33)`: ≤ 32 values is the exact value
/// set, 33 means "more than 32". Output columns are positional.
pub fn statistics_sql(table: &str, columns: &[(String, String)]) -> String {
    let mut parts = vec!["toFloat64(count())".to_string()];
    for (name, ty) in columns {
        let c = quote_ident(name);
        match classify(ty) {
            ColumnClass::Numeric => parts.extend([format!("toFloat64(min({c}))"), format!("toFloat64(max({c}))")]),
            ColumnClass::Temporal => parts.extend([format!("toString(min({c}))"), format!("toString(max({c}))")]),
            ColumnClass::Text => parts.extend([
                format!("toFloat64(uniq({c}))"),
                format!("groupUniqArray({})(toString({c}))", MAX_LISTED_VALUES + 1),
            ]),
            _ => {}
        }
    }
    format!("SELECT {} FROM {}", parts.join(", "), quote_ident(table))
}

pub fn sample_sql(table: &str, columns: &[(String, String)], rows: usize) -> String {
    let list: Vec<String> = columns
        .iter()
        .map(|(name, ty)| {
            let c = quote_ident(name);
            match classify(ty) {
                ColumnClass::Numeric => format!("toFloat64({c})"),
                ColumnClass::Boolean => c,
                _ => format!("toString({c})"),
            }
        })
        .collect();
    format!("SELECT {} FROM {} LIMIT {rows}", list.join(", "), quote_ident(table))
}

pub fn apply_statistics(columns: &[(String, String)], values: &[Value]) -> (Value, Vec<Value>) {
    let mut n = 1;
    let mut next = || {
        let v = values.get(n).cloned().unwrap_or(Value::Null);
        n += 1;
        v
    };
    let finite = |v: &Value| v.as_f64().filter(|x| x.is_finite());
    let described = columns
        .iter()
        .map(|(name, ty)| {
            let mut column = json!({"name": name, "type": ty});
            match classify(ty) {
                ColumnClass::Numeric => {
                    let (min, max) = (next(), next());
                    if let Some(min) = finite(&min) {
                        column["min"] = json!(min);
                    }
                    if let Some(max) = finite(&max) {
                        column["max"] = json!(max);
                    }
                }
                ColumnClass::Temporal => {
                    let (min, max) = (next(), next());
                    if min.is_string() {
                        column["min"] = min;
                    }
                    if max.is_string() {
                        column["max"] = max;
                    }
                }
                ColumnClass::Text => {
                    let approx = next();
                    let mut top: Vec<String> = next()
                        .as_array()
                        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                        .unwrap_or_default();
                    if top.len() <= MAX_LISTED_VALUES && !values.is_empty() {
                        top.sort();
                        column["distinct"] = json!(top.len());
                        column["values"] = json!(top);
                    } else if let Some(approx) = finite(&approx) {
                        column["distinct"] = json!(approx.max((MAX_LISTED_VALUES + 1) as f64));
                    }
                }
                _ => {}
            }
            column
        })
        .collect();
    let rows = values.first().and_then(Value::as_f64).unwrap_or(0.0);
    (json!(rows as u64), described)
}

/// A projection over the guarded query that gives ambiguous ClickHouse types an Arrow type
/// that keeps their meaning: `DateTime` → `DateTime64(0)` (Arrow Timestamp instead of
/// UInt32), `Enum`/`UUID`/`IP` → text, 128/256-bit integers → Float64. None if every column
/// maps cleanly (or names repeat, which a projection cannot address).
pub fn cast_projection(columns: &[(String, String)]) -> Option<String> {
    let mut changed = false;
    let mut seen = std::collections::HashSet::new();
    let mut list = Vec::with_capacity(columns.len());
    for (name, ty) in columns {
        if !seen.insert(name.as_str()) {
            return None;
        }
        let c = quote_ident(name);
        let base = base_type(ty);
        let head = base.split('(').next().unwrap_or(base);
        let expr = match head {
            "DateTime" => {
                // DateTime('Europe/Berlin') keeps its zone.
                let zone = base.strip_prefix("DateTime(").and_then(|s| s.strip_suffix(')'));
                match zone {
                    Some(zone) => format!("toDateTime64({c}, 0, {zone}) AS {c}"),
                    None => format!("toDateTime64({c}, 0) AS {c}"),
                }
            }
            "Enum8" | "Enum16" | "UUID" | "IPv4" | "IPv6" => format!("toString({c}) AS {c}"),
            "Int128" | "Int256" | "UInt128" | "UInt256" => format!("toFloat64({c}) AS {c}"),
            _ => {
                list.push(c);
                continue;
            }
        };
        changed = true;
        list.push(expr);
    }
    changed.then(|| list.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_clickhouse_codes() {
        assert_eq!(error_code(parse_code("Code: 62. DB::Exception: Syntax error")), "sql_error");
        assert_eq!(error_code(parse_code("Code: 396. DB::Exception: Limit for result exceeded")), "result_limit");
        assert_eq!(error_code(Some(159)), "timeout");
        assert_eq!(error_code(Some(164)), "sql_rejected");
        assert_eq!(error_code(None), "sql_error");
    }

    #[test]
    fn extracts_appended_exception_blocks() {
        let raw = b"__exception__\nqeyvnkjoelhafjvs\nCode: 396. DB::Exception: Limit for result exceeded. (TOO_MANY_ROWS_OR_BYTES)\n174 qeyvnkjoelhafjvs\n__exception__\n";
        assert_eq!(exception_text(raw), "Code: 396. DB::Exception: Limit for result exceeded. (TOO_MANY_ROWS_OR_BYTES)");
        assert_eq!(exception_text(b"Code: 47. DB::Exception: Unknown.\n"), "Code: 47. DB::Exception: Unknown.");
    }

    #[test]
    fn classifies_wrapped_types() {
        assert_eq!(base_type("Nullable(LowCardinality(String))"), "String");
        assert_eq!(classify("LowCardinality(String)"), ColumnClass::Text);
        assert_eq!(classify("DateTime64(6, 'UTC')"), ColumnClass::Temporal);
        assert_eq!(classify("Nullable(Decimal(18, 2))"), ColumnClass::Numeric);
        assert_eq!(classify("Array(String)"), ColumnClass::Other);
    }

    #[test]
    fn statistics_are_positional() {
        let columns = vec![("ts".to_string(), "DateTime64(6, 'UTC')".to_string()), ("vessel".into(), "LowCardinality(String)".into()), ("speed".into(), "Float64".into())];
        assert_eq!(
            statistics_sql("telemetry", &columns),
            "SELECT toFloat64(count()), toString(min(`ts`)), toString(max(`ts`)), toFloat64(uniq(`vessel`)), groupUniqArray(33)(toString(`vessel`)), toFloat64(min(`speed`)), toFloat64(max(`speed`)) FROM `telemetry`"
        );
        let values: Vec<Value> = serde_json::from_str(r#"[1209600, "2026-09-01 00:00:00.000000", "2026-09-14 23:59:54.000000", 6, ["Nomad","Aurora"], 0.5, 21.4]"#).unwrap();
        let (rows, described) = apply_statistics(&columns, &values);
        assert_eq!(rows, json!(1209600));
        assert_eq!(described[0]["min"], json!("2026-09-01 00:00:00.000000"));
        assert_eq!(described[1]["values"], json!(["Aurora", "Nomad"]));
        assert_eq!(described[1]["distinct"], json!(2));
        assert_eq!(described[2]["max"], json!(21.4));
    }

    #[test]
    fn casts_only_ambiguous_columns() {
        let cols = |list: &[(&str, &str)]| list.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>();
        assert_eq!(cast_projection(&cols(&[("t", "DateTime64(6, 'UTC')"), ("v", "Float64")])), None);
        assert_eq!(
            cast_projection(&cols(&[("t", "DateTime('UTC')"), ("vessel", "LowCardinality(String)"), ("e", "Nullable(Enum8('a' = 1))")])).as_deref(),
            Some("toDateTime64(`t`, 0, 'UTC') AS `t`, `vessel`, toString(`e`) AS `e`")
        );
        assert_eq!(cast_projection(&cols(&[("t", "DateTime")])).as_deref(), Some("toDateTime64(`t`, 0) AS `t`"));
        assert_eq!(cast_projection(&cols(&[("x", "DateTime"), ("x", "UInt8")])), None);
    }
}
