//! NL→SQL prompt. The system message is a pure function of the `DatasetContext`, so it is
//! byte-identical across every request of a session and forms a provider-cacheable prefix;
//! the question comes last as the only user message.
//!
//! `src/inference-node/prompt.ts` is the TypeScript twin. Both are checked against the
//! golden files in `tests/fixtures/`; change them together.
use serde::Deserialize;
use serde_json::Value;

/// protocol-v1 `DatasetContext`. Unknown fields are ignored for forward compatibility.
#[derive(Debug, Clone, Deserialize)]
pub struct DatasetContext {
    pub id: u32,
    pub name: String,
    pub dialect: String,
    #[serde(default)]
    pub description: Option<String>,
    pub tables: Vec<Table>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Table {
    pub name: String,
    pub rows: Value,
    pub columns: Vec<Column>,
    #[serde(default)]
    pub sample: Option<Vec<Vec<Value>>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Column {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(default)]
    pub min: Option<Value>,
    #[serde(default)]
    pub max: Option<Value>,
    #[serde(default)]
    pub distinct: Option<Value>,
    #[serde(default)]
    pub values: Option<Vec<Value>>,
}

pub const MAX_SAMPLE_ROWS: usize = 5;
pub const MAX_CELL_CHARS: usize = 64;
pub const MAX_VALUES: usize = 32;
pub const VIEWS: &str =
    "line, bar, scatter, table, heatmap, surface, map, density, tracks, seasons";

impl DatasetContext {
    pub fn validate(&self) -> Result<(), String> {
        if self.tables.is_empty() || self.tables.len() > 64 {
            return Err("context must list 1..64 tables".into());
        }
        if self.tables.iter().map(|t| t.columns.len()).sum::<usize>() > 1024 {
            return Err("context lists more than 1024 columns".into());
        }
        if !matches!(self.dialect.as_str(), "duckdb" | "clickhouse") {
            return Err("unsupported dialect".into());
        }
        Ok(())
    }
}

pub fn dialect_name(dialect: &str) -> &'static str {
    match dialect {
        "clickhouse" => "ClickHouse",
        _ => "DuckDB",
    }
}

fn bucket_example(dialect: &str) -> &'static str {
    match dialect {
        "clickhouse" => "toStartOfInterval(ts, INTERVAL 1 hour)",
        _ => "time_bucket(INTERVAL '1 hour', ts)",
    }
}

/// The stable, cacheable system message.
pub fn system_prompt(context: &DatasetContext) -> String {
    let dialect = dialect_name(&context.dialect);
    let mut out = String::with_capacity(4096);
    out.push_str(&format!(
        "You translate a question about the dataset below into exactly one {dialect} SQL query.\n\
\n\
Output:\n\
- Reply with the SQL only: one read-only SELECT statement. No prose, no markdown, no code fences, no trailing semicolon.\n\
- Write compact SQL without indentation. Prefer the simplest query; use WITH only when it is needed.\n\
- Use only the tables and columns listed below, spelled exactly as listed. Give every computed column a short alias that is not the name of a column.\n\
- The question is typed live and may be unfinished. Answer the most plausible complete question. Never ask for clarification.\n\
\n\
Result shape (the chart is chosen from column order and types):\n\
- Columns in this order: the x axis first (a time or a category), then optionally one text column that splits the result into series, then the numeric values with the main value last.\n\
- Name latitude and longitude columns lat and lon.\n\
- ORDER BY the x column, then the series column.\n\
- Return at most about 5000 rows. A query on a table with more than 5000 rows fails without GROUP BY or LIMIT, also for a map, tracks or a scatter plot: aggregate (GROUP BY a time bucket such as {bucket}, and the series if the question compares them) or use LIMIT.\n\
- Keep times as timestamps: bucket them with a function such as {bucket}, never format them as text.\n\
- Write no comments. Exception: if the question contains a presentation word (chart, plot, bar, line, scatter, map, table, heatmap, ...), start with the line -- view: <name>, name exactly one of {VIEWS}. Most questions contain none; then the reply starts with SELECT or WITH.\n\
\n\
Time:\n",
        bucket = bucket_example(&context.dialect),
    ));
    match latest_timestamp(context) {
        Some((table, column, ty, max)) => {
            out.push_str(&format!(
                "- \"Now\" is the latest timestamp in the data, not today's date: {}.{} = {}. Relative times such as \"last 7 days\" or \"today\" count back from it.\n",
                ident(table),
                ident(column),
                literal(max)
            ));
            out.push_str(&format!(
                "- Write a relative window as {}. Use {dialect} functions only (no SQLite DATETIME() or strftime).\n",
                window_example(&context.dialect, column, ty, max)
            ));
        }
        None => out.push_str(
            "- Relative times such as \"last 7 days\" count back from the latest timestamp in the data (its max()), not from today's date.\n",
        ),
    }
    out.push_str(&format!("\nDataset: {}", clean(&context.name)));
    if let Some(description) = context
        .description
        .as_deref()
        .filter(|d| !d.trim().is_empty())
    {
        out.push_str(&format!(" ({})", clean(description)));
    }
    out.push('\n');
    for table in &context.tables {
        out.push_str(&format!(
            "\nTable {}: {} rows\n",
            ident(&table.name),
            literal(&table.rows)
        ));
        for column in &table.columns {
            out.push_str(&format!("  {} {}", ident(&column.name), clean(&column.ty)));
            if let (Some(min), Some(max)) = (&column.min, &column.max) {
                out.push_str(&format!(", range {} to {}", literal(min), literal(max)));
            }
            match (&column.distinct, &column.values) {
                (_, Some(values)) if !values.is_empty() => {
                    let shown: Vec<String> = values.iter().take(MAX_VALUES).map(literal).collect();
                    out.push_str(&format!(", values {}", shown.join(", ")));
                }
                (Some(distinct), _) => out.push_str(&format!(", {} distinct", literal(distinct))),
                _ => {}
            }
            out.push('\n');
        }
        if let Some(sample) = table.sample.as_ref().filter(|s| !s.is_empty()) {
            out.push_str("  Sample rows:\n");
            for row in sample.iter().take(MAX_SAMPLE_ROWS) {
                let cells: Vec<String> = row.iter().map(literal).collect();
                out.push_str(&format!("  ({})\n", cells.join(", ")));
            }
        }
    }
    out
}

/// The question, last and alone so the prefix above stays cacheable.
pub fn user_message(question: &str) -> String {
    question.trim().to_string()
}

/// One repair turn after an obviously invalid reply.
pub fn repair_message(context: &DatasetContext, reason: &str) -> String {
    format!(
        "That reply was rejected: {reason}. Reply with only one {} SELECT statement for my original question.",
        dialect_name(&context.dialect)
    )
}

/// First TIMESTAMP/DATE column (in table order) that has a max statistic.
fn latest_timestamp(context: &DatasetContext) -> Option<(&str, &str, &str, &Value)> {
    context.tables.iter().find_map(|table| {
        table.columns.iter().find_map(|column| {
            let ty = column.ty.to_ascii_uppercase();
            let temporal = ty.starts_with("TIMESTAMP") || ty.starts_with("DATE");
            match (&column.max, temporal) {
                (Some(max), true) => Some((
                    table.name.as_str(),
                    column.name.as_str(),
                    column.ty.as_str(),
                    max,
                )),
                _ => None,
            }
        })
    })
}

/// `ts >= TIMESTAMP '…' - INTERVAL '7 days'` in the dataset's dialect, from the latest value.
fn window_example(dialect: &str, column: &str, ty: &str, max: &Value) -> String {
    let date = !ty.to_ascii_uppercase().starts_with("TIMESTAMP");
    match dialect {
        "clickhouse" => format!(
            "{} >= {}({}) - INTERVAL 7 DAY",
            ident(column),
            if date { "toDate" } else { "toDateTime" },
            literal(max)
        ),
        _ => format!(
            "{} >= {} {} - INTERVAL '7 days'",
            ident(column),
            if date { "DATE" } else { "TIMESTAMP" },
            literal(max)
        ),
    }
}

fn is_plain_ident(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Identifiers that are not plain ASCII words are shown double-quoted, as SQL needs them.
pub fn ident(name: &str) -> String {
    if is_plain_ident(name) {
        name.to_string()
    } else {
        format!("\"{}\"", clean(name).replace('"', "\"\""))
    }
}

/// Control characters become spaces so the context cannot inject structure.
fn clean(text: &str) -> String {
    text.chars()
        .map(|c| if (c as u32) < 0x20 { ' ' } else { c })
        .collect()
}

/// A JSON value rendered as a SQL-ish literal. Mirrors `literal` in prompt.ts.
pub fn literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => {
            let mut text: String = clean(s).chars().take(MAX_CELL_CHARS).collect();
            if s.chars().count() > MAX_CELL_CHARS {
                text.push('…');
            }
            format!("'{}'", text.replace('\'', "''"))
        }
        Value::Array(items) => {
            format!(
                "[{}]",
                items.iter().map(literal).collect::<Vec<_>>().join(", ")
            )
        }
        Value::Object(_) => "{…}".into(),
    }
}

/// ECMAScript `Number.prototype.toString()` for finite doubles, so Rust and JS render the
/// same JSON number identically (12.0 → "12", 1e21 → "1e+21", 1e-7 → "1e-7").
pub fn js_number(x: f64) -> String {
    if !x.is_finite() {
        return "NULL".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x < 0.0 {
        return format!("-{}", js_number(-x));
    }
    // Rust's `{:e}` prints the shortest round-tripping digits, like ECMAScript.
    let sci = format!("{x:e}");
    let (mantissa, exponent) = sci.split_once('e').expect("exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().expect("exponent") + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!(
            "{}/tests/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn check_golden(context: &str, golden: &str) {
        let context: DatasetContext = serde_json::from_str(&fixture(context)).unwrap();
        context.validate().unwrap();
        let prompt = system_prompt(&context);
        let path = format!("{}/tests/fixtures/{golden}", env!("CARGO_MANIFEST_DIR"));
        if std::env::var_os("UPDATE_GOLDEN").is_some() {
            std::fs::write(&path, &prompt).unwrap();
        }
        assert_eq!(
            prompt,
            fixture(golden),
            "regenerate with UPDATE_GOLDEN=1 and update prompt.ts"
        );
    }

    #[test]
    fn vessel_prompt_matches_golden() {
        check_golden("vessels-context.json", "vessels-prompt.txt");
    }

    #[test]
    fn edge_prompt_matches_golden() {
        check_golden("edge-context.json", "edge-prompt.txt");
    }

    #[test]
    fn numbers_render_like_ecmascript() {
        for (x, s) in [
            (0.0, "0"),
            (-0.0, "0"),
            (12.0, "12"),
            (21.4, "21.4"),
            (-59.5, "-59.5"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (5e-324, "5e-324"),
            (1.5e300, "1.5e+300"),
            (0.1 + 0.2, "0.30000000000000004"),
            (123456789012.0, "123456789012"),
            (1209600.0, "1209600"),
        ] {
            assert_eq!(js_number(x), s, "{x}");
        }
    }

    #[test]
    fn question_is_last_and_alone() {
        assert_eq!(
            user_message("  avg speed per vessel \n"),
            "avg speed per vessel"
        );
        let context: DatasetContext =
            serde_json::from_str(&fixture("vessels-context.json")).unwrap();
        assert!(repair_message(&context, "empty reply").contains("DuckDB SELECT"));
    }

    #[test]
    fn identifiers_are_quoted_only_when_needed() {
        assert_eq!(ident("wave_height"), "wave_height");
        assert_eq!(ident("Mixed Case"), "\"Mixed Case\"");
        assert_eq!(ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(ident("1x"), "\"1x\"");
    }
}
