//! Turning raw model text into SQL, incrementally. Mirrors `src/inference-node/sql.ts`.
//!
//! [`SqlStream`] removes a leading `<think>…</think>` block and Markdown code fences and
//! holds back trailing whitespace, `;` and backticks until more text proves they are part of
//! the query. Every delta it emits is therefore final: the concatenated deltas are always a
//! prefix of [`SqlStream::finish`]. Real validation happens in the database node; [`check`]
//! only rejects what is obviously not one SELECT, to trigger the single repair attempt.

use crate::prompt::js_number;

const FENCE: &str = "```";
const THINK_OPEN: &str = "<think>";
const THINK_CLOSE: &str = "</think>";

#[derive(Default)]
pub struct SqlStream {
    raw: String,
    emitted: usize,
    /// None until the first word shows whether this is a query at all.
    started: Option<bool>,
}

impl SqlStream {
    /// Feed raw model text; returns the newly certain SQL text, if any.
    pub fn push(&mut self, text: &str) -> Option<String> {
        self.raw.push_str(text);
        let body = extract(&self.raw, false)?;
        let ready = body.trim_end_matches(|c: char| c.is_whitespace() || c == ';' || c == '`');
        if self.started.is_none() {
            self.started = starts_like_query(ready);
        }
        // Prose ("Here is…") or a non-SELECT never streams; the repair attempt may.
        if self.started != Some(true) || ready.len() <= self.emitted {
            return None;
        }
        let delta = ready[self.emitted..].to_string();
        self.emitted = ready.len();
        Some(delta)
    }

    /// The complete SQL once the model has finished.
    pub fn finish(&self) -> String {
        let body = extract(&self.raw, true).unwrap_or("");
        body.trim_end_matches(|c: char| c.is_whitespace() || c == ';')
            .to_string()
    }
}

/// The SQL body of the raw text so far, or None while its start is still ambiguous.
fn extract(raw: &str, done: bool) -> Option<&str> {
    let mut text = raw.trim_start();
    if text.starts_with(THINK_OPEN) {
        let end = text.find(THINK_CLOSE)?;
        text = text[end + THINK_CLOSE.len()..].trim_start();
    } else if !done && !text.is_empty() && THINK_OPEN.starts_with(text) {
        return None;
    }
    let fenced = text.starts_with(FENCE);
    if fenced {
        // Skip the opening fence and its language tag, up to the first newline.
        let newline = match text.find('\n') {
            Some(at) => at,
            None if done => return Some(""),
            None => return None,
        };
        text = text[newline + 1..].trim_start();
    } else if !done && FENCE.starts_with(text) {
        return None; // "`" or "``" so far
    }
    if let Some(close) = text.find(FENCE) {
        text = &text[..close];
    }
    Some(text.trim_start())
}

/// Whether text that may still grow starts like a query: None while undecided.
fn starts_like_query(ready: &str) -> Option<bool> {
    let mut lexer = Lexer::new(ready);
    if !lexer.skip_trivia() || lexer.unterminated {
        return None;
    }
    let word = lexer.next_word()?;
    if lexer.at == ready.len() && word != "(" {
        return None; // "SEL" might become "SELECT"
    }
    Some(is_query_start(word))
}

fn is_query_start(word: &str) -> bool {
    matches!(
        word.to_ascii_uppercase().as_str(),
        "SELECT" | "WITH" | "FROM" | "("
    )
}

/// Reject replies that are obviously not one SELECT statement.
pub fn check(sql: &str) -> Result<(), String> {
    let mut lexer = Lexer::new(sql);
    let Some(first) = lexer.next_word() else {
        return Err("the reply contained no SQL".into());
    };
    if !is_query_start(first) {
        return Err(format!(
            "the reply must start with SELECT or WITH, not {:?}",
            first.chars().take(24).collect::<String>()
        ));
    }
    if lexer.rest_has_semicolon() {
        return Err("the reply contained more than one statement".into());
    }
    if lexer.unterminated {
        return Err("the reply ended inside a string, identifier or comment".into());
    }
    Ok(())
}

/// DuckDB date-part keywords: as a bare column alias (`flight_date day,`) they are a syntax error;
/// `AS day` works. Seen on the public datasets in every prompt version (docs/batch-3/generality.md).
const PART_KEYWORDS: &[&str] = &[
    "day", "days", "hour", "hours", "minute", "minutes", "month", "months", "second", "seconds",
    "week", "weeks", "year", "years",
];
/// Words after which a part keyword is not an alias (a column named `day`, `INTERVAL day`, …).
const NOT_ALIAS_AFTER: &[&str] = &[
    "all", "and", "as", "by", "case", "distinct", "else", "from", "group", "having", "in",
    "interval", "is", "join", "not", "on", "or", "order", "select", "then", "when", "where", "with",
];

/// A DuckDB part keyword used as a bare alias: after an expression (a word or `)`) and followed
/// by `,`, `FROM` or the end. Returns the repair reason. Quoted identifiers and literals are skipped.
pub fn keyword_alias(sql: &str) -> Option<String> {
    let mut lexer = Lexer::new(sql);
    let mut prev: Option<String> = None;
    let mut pending: Option<String> = None;
    while lexer.skip_trivia() {
        let byte = lexer.bytes[lexer.at];
        let token = if matches!(byte, b'\'' | b'"' | b'`') {
            lexer.skip_quoted(byte);
            None
        } else {
            lexer.next_word().map(|w| w.to_ascii_lowercase())
        };
        if let Some(word) = pending.take() {
            if matches!(token.as_deref(), Some(",") | Some("from")) {
                return Some(alias_reason(&word));
            }
        }
        if let Some(t) = token.as_deref() {
            let after_expression = match prev.as_deref() {
                Some(")") => true,
                Some(p) => {
                    p.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
                        && !NOT_ALIAS_AFTER.contains(&p)
                }
                None => false,
            };
            if after_expression && PART_KEYWORDS.contains(&t) {
                pending = Some(t.to_string());
            }
        }
        prev = token;
    }
    pending.map(|word| alias_reason(&word))
}

fn alias_reason(word: &str) -> String {
    format!("the bare alias {word} is a DuckDB keyword and does not parse; write AS {word}")
}

/// Most rows a translation may return (the prompt's row rule; the database enforces its own cap).
pub const MAX_RESULT_ROWS: f64 = 5000.0;

/// Aggregate functions (DuckDB and ClickHouse; ClickHouse `-If` variants are matched too).
const AGGREGATES: &[&str] = &[
    "any", "any_value", "anylast", "approx_count_distinct", "approx_quantile", "arg_max",
    "arg_min", "argmax", "argmin", "array_agg", "avg", "bool_and", "bool_or", "corr", "count",
    "covar_pop", "covar_samp", "entropy", "favg", "first", "fsum", "group_concat", "grouparray",
    "histogram", "kurtosis", "last", "list", "max", "max_by", "mean", "median", "min", "min_by",
    "mode", "percentile_cont", "percentile_disc", "product", "quantile", "quantile_cont",
    "quantile_disc", "regr_intercept", "regr_r2", "regr_slope", "skewness", "stddev",
    "stddev_pop", "stddev_samp", "string_agg", "sum", "topk", "uniq", "uniqexact", "var_pop",
    "var_samp", "variance",
];

/// Cheap pre-check before the SQL leaves the inference node: a query that reads a table with
/// more than [`MAX_RESULT_ROWS`] rows but has no GROUP BY, aggregate, DISTINCT, QUALIFY, sample,
/// LIMIT ≤ 5000 or equality filter on a time column returns raw rows, which the database
/// refuses (`result_limit`) or which bury the chart. Returns the repair reason.
///
/// `large_tables` and `time_columns` are lower-case names from the `DatasetContext`.
/// Deliberately conservative: anything that might aggregate passes.
pub fn raw_rows(sql: &str, large_tables: &[(String, f64)], time_columns: &[String]) -> Option<String> {
    let tokens = tokens(sql);
    let table = tokens
        .iter()
        .find_map(|t| large_tables.iter().find(|(name, _)| name == t))?;
    for (i, token) in tokens.iter().enumerate() {
        let next = tokens.get(i + 1).map(String::as_str);
        match token.as_str() {
            "group" if next == Some("by") => return None,
            "qualify" | "distinct" | "sample" | "tablesample" => return None,
            "limit" => {
                return match next.and_then(|n| n.parse::<f64>().ok()) {
                    Some(n) if n > MAX_RESULT_ROWS => Some(format!(
                        "its LIMIT {} exceeds {} rows",
                        js_number(n),
                        js_number(MAX_RESULT_ROWS)
                    )),
                    _ => None,
                };
            }
            "=" if i > 0 && time_columns.contains(&tokens[i - 1]) => return None,
            word if next == Some("(") && is_aggregate(word) && !windowed(&tokens, i + 1) => {
                return None;
            }
            _ => {}
        }
    }
    Some(format!(
        "it returns raw rows of {} ({} rows) without GROUP BY, an aggregate or LIMIT; aggregate it, for example GROUP BY a time bucket, or add LIMIT",
        table.0,
        js_number(table.1)
    ))
}

fn is_aggregate(word: &str) -> bool {
    AGGREGATES.contains(&word)
        || word
            .strip_suffix("if")
            .is_some_and(|base| AGGREGATES.contains(&base))
}

/// A window function inside an aggregate or inside another OVER clause, or an aggregate inside an
/// aggregate: DuckDB and ClickHouse reject all three when binding ("aggregate function calls
/// cannot contain window function calls", "window functions are not allowed in window
/// definitions"). A subquery starts a fresh level. Returns the repair reason.
pub fn nested_window(sql: &str) -> Option<String> {
    #[derive(Clone, Copy, PartialEq)]
    enum Level { Aggregate, Over, Subquery, Other }
    let tokens = tokens(sql);
    let mut stack: Vec<Level> = Vec::new();
    // The innermost aggregate or OVER enclosing the current token, up to the nearest subquery.
    let enclosing = |stack: &[Level]| {
        stack.iter().rev().copied().find(|l| *l != Level::Other).filter(|l| *l != Level::Subquery)
    };
    for (i, token) in tokens.iter().enumerate() {
        let call = tokens.get(i + 1).is_some_and(|t| t == "(") && is_aggregate(token) && !windowed(&tokens, i + 1);
        match token.as_str() {
            "(" => stack.push(match i.checked_sub(1).map(|p| tokens[p].as_str()) {
                Some("over") => Level::Over,
                Some(word) if is_aggregate(word) && !windowed(&tokens, i) => Level::Aggregate,
                _ => Level::Other,
            }),
            ")" => {
                stack.pop();
            }
            "select" => {
                if let Some(top) = stack.last_mut() {
                    *top = Level::Subquery;
                }
            }
            "over" => match enclosing(&stack) {
                Some(Level::Aggregate) => return Some("it puts a window function (OVER) inside an aggregate; compute the window in a subquery or CTE and aggregate its result in the outer query".into()),
                Some(_) => return Some("it puts a window function inside an OVER clause; compute the inner window in a subquery or CTE first".into()),
                None => {}
            },
            _ if call && enclosing(&stack) == Some(Level::Aggregate) => {
                return Some(format!("it nests the aggregate {token}() inside another aggregate; aggregate in a subquery or CTE first, then aggregate its result in the outer query"));
            }
            _ => {}
        }
    }
    None
}

/// Whether the call whose `(` is at `open` is followed by OVER (a window, not an aggregate).
fn windowed(tokens: &[String], open: usize) -> bool {
    let mut depth = 0usize;
    for (j, token) in tokens.iter().enumerate().skip(open) {
        match token.as_str() {
            "(" => depth += 1,
            ")" => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return tokens.get(j + 1).is_some_and(|t| t == "over");
                }
            }
            _ => {}
        }
    }
    false
}

/// Lower-case tokens outside comments: words, numbers, `(`, `)`, runs of `<>=!`, other single
/// characters; a string literal becomes `'`, a quoted identifier its lower-cased name.
fn tokens(sql: &str) -> Vec<String> {
    let mut lexer = Lexer::new(sql);
    let mut out = Vec::new();
    while lexer.skip_trivia() {
        let start = lexer.at;
        let byte = lexer.bytes[start];
        match byte {
            b'\'' => {
                lexer.skip_quoted(b'\'');
                out.push("'".into());
            }
            b'"' | b'`' => {
                lexer.skip_quoted(byte);
                let end = lexer.at.saturating_sub(1).max(start + 1);
                out.push(sql[start + 1..end].replace("\"\"", "\"").to_lowercase());
            }
            b'<' | b'>' | b'=' | b'!' => {
                while lexer.at < lexer.bytes.len() && b"<>=!".contains(&lexer.bytes[lexer.at]) {
                    lexer.at += 1;
                }
                out.push(sql[start..lexer.at].into());
            }
            b'0'..=b'9' => {
                while lexer.at < lexer.bytes.len()
                    && (lexer.bytes[lexer.at].is_ascii_digit() || lexer.bytes[lexer.at] == b'.')
                {
                    lexer.at += 1;
                }
                out.push(sql[start..lexer.at].into());
            }
            _ => {
                if let Some(word) = lexer.next_word() {
                    out.push(word.to_lowercase());
                }
            }
        }
    }
    out
}

/// Just enough lexing to skip comments, string literals and quoted identifiers.
struct Lexer<'a> {
    bytes: &'a [u8],
    src: &'a str,
    at: usize,
    unterminated: bool,
}

impl<'a> Lexer<'a> {
    fn new(src: &'a str) -> Self {
        Lexer {
            bytes: src.as_bytes(),
            src,
            at: 0,
            unterminated: false,
        }
    }

    /// Skip whitespace and comments; false at end of input.
    fn skip_trivia(&mut self) -> bool {
        loop {
            while self.at < self.bytes.len() && self.bytes[self.at].is_ascii_whitespace() {
                self.at += 1;
            }
            let rest = &self.bytes[self.at..];
            if rest.starts_with(b"--") {
                self.at = rest
                    .iter()
                    .position(|&b| b == b'\n')
                    .map_or(self.bytes.len(), |n| self.at + n);
            } else if rest.starts_with(b"/*") {
                match rest[2..].windows(2).position(|w| w == b"*/") {
                    Some(n) => self.at += n + 4,
                    None => {
                        self.unterminated = true;
                        self.at = self.bytes.len();
                    }
                }
            } else {
                return self.at < self.bytes.len();
            }
        }
    }

    fn next_word(&mut self) -> Option<&'a str> {
        if !self.skip_trivia() {
            return None;
        }
        let start = self.at;
        if self.bytes[start] == b'(' {
            self.at += 1;
            return Some("(");
        }
        while self.at < self.bytes.len()
            && (self.bytes[self.at].is_ascii_alphanumeric() || self.bytes[self.at] == b'_')
        {
            self.at += 1;
        }
        if self.at == start {
            // Not a word: return the next character for the error message.
            let len = self.src[start..].chars().next().map_or(1, char::len_utf8);
            self.at += len;
        }
        Some(&self.src[start..self.at])
    }

    /// True if a `;` outside literals/comments is followed by anything but trivia.
    fn rest_has_semicolon(&mut self) -> bool {
        while self.skip_trivia() {
            match self.bytes[self.at] {
                b'\'' | b'"' | b'`' => self.skip_quoted(self.bytes[self.at]),
                b';' => {
                    self.at += 1;
                    if self.skip_trivia() {
                        return true;
                    }
                }
                _ => self.at += 1,
            }
        }
        false
    }

    fn skip_quoted(&mut self, quote: u8) {
        self.at += 1;
        while self.at < self.bytes.len() {
            if self.bytes[self.at] == quote {
                if self.bytes.get(self.at + 1) == Some(&quote) {
                    self.at += 2;
                    continue;
                }
                self.at += 1;
                return;
            }
            if self.bytes[self.at] == b'\\' && quote == b'\'' {
                self.at += 1; // ClickHouse-style escapes; harmless for DuckDB
            }
            self.at += 1;
        }
        self.unterminated = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(chunks: &[&str]) -> (String, String) {
        let mut s = SqlStream::default();
        let mut deltas = String::new();
        for chunk in chunks {
            if let Some(delta) = s.push(chunk) {
                deltas.push_str(&delta);
            }
        }
        (deltas, s.finish())
    }

    #[test]
    fn deltas_are_always_a_prefix_of_the_final_sql() {
        let text = "```sql\n-- view: bar\nSELECT vessel, avg(\"speed\") AS v FROM telemetry GROUP BY 1 ORDER BY 1;\n```";
        // Every split into single characters must keep the prefix property.
        let mut s = SqlStream::default();
        let mut deltas = String::new();
        for c in text.chars() {
            if let Some(d) = s.push(&c.to_string()) {
                deltas.push_str(&d);
                assert!(s.finish().starts_with(&deltas));
            }
        }
        assert_eq!(deltas, s.finish());
        assert!(s.finish().starts_with("-- view: bar\nSELECT"));
    }

    /// Cases shared with tests/inference-node.test.ts so both twins behave identically.
    #[test]
    fn shared_cases_match() {
        let path = format!(
            "{}/tests/fixtures/sql-cases.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let cases: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for case in cases["stream"].as_array().unwrap() {
            let chunks: Vec<&str> = case["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c.as_str().unwrap())
                .collect();
            let (deltas, sql) = stream(&chunks);
            assert_eq!(deltas, case["deltas"].as_str().unwrap(), "{chunks:?}");
            assert_eq!(sql, case["sql"].as_str().unwrap(), "{chunks:?}");
        }
        for case in cases["rows"].as_array().unwrap() {
            let sql = case["sql"].as_str().unwrap();
            let large = [("telemetry".to_string(), 1209600.0)];
            let time = ["ts".to_string()];
            let got = raw_rows(sql, &large, &time);
            match case["error"].as_str() {
                None => assert_eq!(got, None, "{sql}"),
                Some(expected) => assert!(
                    got.as_deref().is_some_and(|g| g.contains(expected)),
                    "{sql}: {got:?}"
                ),
            }
        }
        for case in cases["alias"].as_array().unwrap() {
            let sql = case["sql"].as_str().unwrap();
            let got = keyword_alias(sql);
            match case["error"].as_str() {
                None => assert_eq!(got, None, "{sql}"),
                Some(expected) => assert!(
                    got.as_deref().is_some_and(|g| g.contains(expected)),
                    "{sql}: {got:?}"
                ),
            }
        }
        for case in cases["nested"].as_array().unwrap() {
            let sql = case["sql"].as_str().unwrap();
            let got = nested_window(sql);
            match case["error"].as_str() {
                None => assert_eq!(got, None, "{sql}"),
                Some(expected) => assert!(
                    got.as_deref().is_some_and(|g| g.contains(expected)),
                    "{sql}: {got:?}"
                ),
            }
        }
        for case in cases["check"].as_array().unwrap() {
            let sql = case["sql"].as_str().unwrap();
            match (check(sql), case["error"].as_str()) {
                (Ok(()), None) => {}
                (Err(error), Some(expected)) => assert!(error.contains(expected), "{sql}: {error}"),
                (got, expected) => panic!("{sql}: got {got:?}, expected {expected:?}"),
            }
        }
    }
}
