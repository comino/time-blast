//! Turning raw model text into SQL, incrementally. Mirrors `src/inference-node/sql.ts`.
//!
//! [`SqlStream`] removes a leading `<think>…</think>` block and Markdown code fences and
//! holds back trailing whitespace, `;` and backticks until more text proves they are part of
//! the query. Every delta it emits is therefore final: the concatenated deltas are always a
//! prefix of [`SqlStream::finish`]. Real validation happens in the database node; [`check`]
//! only rejects what is obviously not one SELECT, to trigger the single repair attempt.

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
