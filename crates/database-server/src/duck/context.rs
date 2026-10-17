//! protocol-v1 `DatasetContext` for the DuckDB backend, the same kind of context the browser's
//! DuckDB node builds (src/engine/database-node.ts `describe`, src/engine/dataset.ts):
//!
//! 1. A file built by scripts/build-datasets.mjs (or any file with the same layout) carries it
//!    precomputed: one row in `__tb_rollup.__tb_meta`, column `meta`, JSON `PrebuiltMeta` with
//!    `format: 1` and `context` (src/engine/datasets.ts). Used as is; name and description from
//!    the server config override the stored ones when set.
//! 2. Otherwise it is computed once, bounded by `context_timeout`: every table of schema `main`
//!    (alphabetical), its columns from `duckdb_columns()`, one statistics pass per table
//!    (port of `statisticsSql`/`applyStatistics`) and 3 sample rows (`sampleSql`). A table whose
//!    statistics do not finish in time keeps its column types and DuckDB's row count.
//!
//! The database is opened read-only, so the context never goes stale; the service caches it
//! for the life of the process.
use std::time::{Duration, Instant};

use arrow_array::{
    Array, ArrayRef, BooleanArray, Float64Array, Int64Array, LargeStringArray, ListArray, RecordBatch, StringArray,
    StringViewArray,
};
use arrow_schema::DataType;
use serde_json::{Map, Value, json};

use super::DuckDb;
use crate::clickhouse::Failure;

pub const META_SQL: &str = r#"SELECT meta FROM "__tb_rollup"."__tb_meta""#;
pub const PREBUILT_FORMAT: u64 = 1;
/// Low-cardinality text columns list their values when there are at most this many.
pub const MAX_LISTED_VALUES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnClass {
    Numeric,
    Temporal,
    Text,
    Boolean,
    Other,
}

/// `classify` of src/engine/dataset.ts.
pub fn classify(ty: &str) -> ColumnClass {
    let t = ty.to_ascii_uppercase();
    let word = |names: &[&str]| {
        names.iter().any(|n| t.starts_with(n) && !t[n.len()..].starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))
    };
    if word(&["TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT", "FLOAT", "REAL", "DOUBLE", "DECIMAL"]) {
        ColumnClass::Numeric
    } else if word(&["DATE", "TIME", "TIMESTAMP"]) {
        ColumnClass::Temporal
    } else if word(&["VARCHAR", "ENUM"]) {
        ColumnClass::Text
    } else if t == "BOOLEAN" {
        ColumnClass::Boolean
    } else {
        ColumnClass::Other
    }
}

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// `statisticsSql` of src/engine/dataset.ts: one pass, positional output columns s0, s1, …
pub fn statistics_sql(table: &str, columns: &[(String, String)]) -> String {
    let mut parts = vec!["count(*)::DOUBLE AS s0".to_string()];
    let mut n = 1;
    let mut next = || {
        n += 1;
        n - 1
    };
    for (name, ty) in columns {
        let c = quote_ident(name);
        match classify(ty) {
            ColumnClass::Numeric => {
                parts.push(format!("min({c})::DOUBLE AS s{}", next()));
                parts.push(format!("max({c})::DOUBLE AS s{}", next()));
            }
            ColumnClass::Temporal => {
                parts.push(format!("min({c})::VARCHAR AS s{}", next()));
                parts.push(format!("max({c})::VARCHAR AS s{}", next()));
            }
            ColumnClass::Text => {
                parts.push(format!("approx_count_distinct({c})::DOUBLE AS s{}", next()));
                parts.push(format!("approx_top_k({c}::VARCHAR, {}) AS s{}", MAX_LISTED_VALUES + 1, next()));
            }
            _ => {}
        }
    }
    format!("SELECT {} FROM {}", parts.join(", "), quote_ident(table))
}

/// `sampleSql` of src/engine/dataset.ts.
pub fn sample_sql(table: &str, columns: &[(String, String)], rows: usize) -> String {
    let list: Vec<String> = columns
        .iter()
        .map(|(name, ty)| {
            let c = quote_ident(name);
            match classify(ty) {
                ColumnClass::Numeric => format!("{c}::DOUBLE AS {c}"),
                ColumnClass::Boolean => c,
                _ => format!("{c}::VARCHAR AS {c}"),
            }
        })
        .collect();
    let list = if list.is_empty() { "*".to_string() } else { list.join(", ") };
    format!("SELECT {list} FROM {} LIMIT {rows}", quote_ident(table))
}

/// A number as JavaScript's JSON.stringify writes it (integral values without `.0`).
pub fn number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite())
}

/// JavaScript's default sort order (UTF-16 code units).
fn js_sort(values: &mut [String]) {
    values.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// `applyStatistics` of src/engine/dataset.ts: (rows, columns JSON).
pub fn apply_statistics(columns: &[(String, String)], values: &[Value]) -> (Value, Vec<Value>) {
    let mut n = 1;
    let mut take = || {
        n += 1;
        values.get(n - 1).cloned().unwrap_or(Value::Null)
    };
    let out = columns
        .iter()
        .map(|(name, ty)| {
            let mut column = Map::new();
            column.insert("name".into(), json!(name));
            column.insert("type".into(), json!(ty));
            match classify(ty) {
                ColumnClass::Numeric => {
                    let (min, max) = (take(), take());
                    if let Some(v) = finite(&min) {
                        column.insert("min".into(), number(v));
                    }
                    if let Some(v) = finite(&max) {
                        column.insert("max".into(), number(v));
                    }
                }
                ColumnClass::Temporal => {
                    let (min, max) = (take(), take());
                    if min.is_string() {
                        column.insert("min".into(), min);
                    }
                    if max.is_string() {
                        column.insert("max".into(), max);
                    }
                }
                ColumnClass::Text => {
                    let approx = finite(&take());
                    let top = take();
                    match top.as_array() {
                        Some(list) if list.len() <= MAX_LISTED_VALUES => {
                            let mut values: Vec<String> = list.iter().filter_map(|v| v.as_str().map(String::from)).collect();
                            js_sort(&mut values);
                            column.insert("distinct".into(), json!(list.len()));
                            column.insert("values".into(), json!(values));
                        }
                        _ => {
                            if let Some(approx) = approx {
                                column.insert("distinct".into(), number(approx.max((MAX_LISTED_VALUES + 1) as f64)));
                            }
                        }
                    }
                }
                _ => {}
            }
            Value::Object(column)
        })
        .collect();
    let rows = values.first().and_then(Value::as_f64).unwrap_or(0.0);
    (number(rows), out)
}

/// One cell as JSON (cold path; the statistics and sample SQL cast to DOUBLE, VARCHAR, BOOLEAN,
/// BIGINT or VARCHAR[]).
pub fn cell(array: &ArrayRef, row: usize) -> Value {
    if array.is_null(row) {
        return Value::Null;
    }
    let any = array.as_any();
    match array.data_type() {
        DataType::Float64 => number(any.downcast_ref::<Float64Array>().unwrap().value(row)),
        DataType::Int64 => number(any.downcast_ref::<Int64Array>().unwrap().value(row) as f64),
        DataType::Boolean => json!(any.downcast_ref::<BooleanArray>().unwrap().value(row)),
        DataType::Utf8 => json!(any.downcast_ref::<StringArray>().unwrap().value(row)),
        DataType::LargeUtf8 => json!(any.downcast_ref::<LargeStringArray>().unwrap().value(row)),
        DataType::Utf8View => json!(any.downcast_ref::<StringViewArray>().unwrap().value(row)),
        DataType::List(_) => {
            let list = any.downcast_ref::<ListArray>().unwrap().value(row);
            Value::Array((0..list.len()).map(|i| cell(&list, i)).collect())
        }
        _ => match arrow_cast::display::array_value_to_string(array, row) {
            Ok(text) => json!(text),
            Err(_) => Value::Null,
        },
    }
}

pub fn rows(batches: &[RecordBatch]) -> Vec<Vec<Value>> {
    let mut out = Vec::new();
    for batch in batches {
        for row in 0..batch.num_rows() {
            out.push(batch.columns().iter().map(|c| cell(c, row)).collect());
        }
    }
    out
}

/// The context: precomputed when the file carries one, computed otherwise.
pub fn context(duck: &DuckDb, name: &str, description: Option<&str>) -> Result<Value, Failure> {
    let started = Instant::now();
    let deadline = started + duck.config.context_timeout;
    if let Some(mut value) = prebuilt(duck) {
        value["name"] = json!(name);
        if let Some(description) = description {
            value["description"] = json!(description);
        }
        value["dialect"] = json!("duckdb");
        eprintln!("DatasetContext from {} ({:.1} ms)", META_SQL, started.elapsed().as_secs_f64() * 1000.0);
        return Ok(value);
    }
    let columns = rows(&duck.collect(
        "SELECT table_name, column_name, data_type FROM duckdb_columns() WHERE schema_name = 'main' AND database_name = current_database() ORDER BY table_name, column_index",
        deadline,
    )?);
    let counts = rows(&duck.collect(
        "SELECT table_name, estimated_size FROM duckdb_tables() WHERE schema_name = 'main' AND database_name = current_database()",
        deadline,
    )?);
    let mut tables: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for row in columns {
        let (Some(table), Some(column), Some(ty)) = (row[0].as_str(), row[1].as_str(), row[2].as_str()) else { continue };
        match tables.last_mut() {
            Some((t, cols)) if t == table => cols.push((column.into(), ty.into())),
            _ => tables.push((table.into(), vec![(column.into(), ty.into())])),
        }
    }
    let mut out = Vec::new();
    for (table, info) in &tables {
        let t0 = Instant::now();
        let statistics = duck.collect(&statistics_sql(table, info), deadline).map(|b| rows(&b));
        let (rows_value, described) = match statistics.as_ref().map(|r| r.first()) {
            Ok(Some(values)) => apply_statistics(info, values),
            other => {
                let reason = match other {
                    Err(f) => f.message.clone(),
                    _ => "no row".into(),
                };
                eprintln!("DatasetContext: statistics for {table} skipped: {reason}");
                let estimated = counts.iter().find(|r| r[0].as_str() == Some(table.as_str())).and_then(|r| r[1].as_f64()).unwrap_or(0.0);
                (number(estimated), info.iter().map(|(n, t)| json!({"name": n, "type": t})).collect())
            }
        };
        let sample = duck.collect(&sample_sql(table, info, 3), deadline.max(Instant::now() + Duration::from_secs(5))).map(|b| rows(&b)).unwrap_or_default();
        eprintln!("DatasetContext: {table} statistics {:.0} ms", t0.elapsed().as_secs_f64() * 1000.0);
        out.push(json!({"name": table, "rows": rows_value, "columns": described, "sample": sample}));
    }
    let mut value = json!({"id": 0, "name": name, "dialect": "duckdb", "tables": out});
    if let Some(description) = description {
        value["description"] = json!(description);
    }
    eprintln!("DatasetContext computed in {:.0} ms", started.elapsed().as_secs_f64() * 1000.0);
    Ok(value)
}

fn prebuilt(duck: &DuckDb) -> Option<Value> {
    let batches = duck.collect(META_SQL, Instant::now() + Duration::from_secs(10)).ok()?;
    let text = rows(&batches).first()?.first()?.as_str()?.to_string();
    let meta: Value = serde_json::from_str(&text).ok()?;
    if meta["format"].as_u64() != Some(PREBUILT_FORMAT) || !meta["context"]["tables"].is_array() {
        eprintln!("{META_SQL}: unknown format, computing the context");
        return None;
    }
    let mut context = meta["context"].clone();
    context["id"] = json!(0);
    Some(context)
}
