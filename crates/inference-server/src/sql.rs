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
            if self.src[self.at..].starts_with("--") {
                self.at = self.src[self.at..]
                    .find('\n')
                    .map_or(self.bytes.len(), |n| self.at + n);
            } else if self.src[self.at..].starts_with("/*") {
                match self.src[self.at + 2..].find("*/") {
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
    fn plain_sql_streams_through_and_trailing_semicolon_is_dropped() {
        let (deltas, sql) = stream(&["SELECT", " 1", " AS x", ";", "\n"]);
        assert_eq!(sql, "SELECT 1 AS x");
        assert_eq!(deltas, sql);
    }

    #[test]
    fn fences_and_language_tags_are_stripped_while_streaming() {
        for chunks in [
            vec!["```", "sql\nSELECT ", "ts FROM t", "\n``", "`"],
            vec![
                "`",
                "``sql",
                "\n",
                "SELECT ts FROM t\n```\nThis query selects…",
            ],
            vec!["  ```\nSELECT ts FROM t;```"],
        ] {
            let (deltas, sql) = stream(&chunks);
            assert_eq!(sql, "SELECT ts FROM t", "{chunks:?}");
            assert_eq!(deltas, sql, "{chunks:?}");
        }
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

    #[test]
    fn prose_and_non_queries_never_stream() {
        for chunks in [
            vec!["Here", " is the query: SELECT 1"],
            vec!["DELETE FROM t"],
            vec!["I cannot", " answer that."],
        ] {
            let (deltas, _) = stream(&chunks);
            assert_eq!(deltas, "", "{chunks:?}");
        }
        let (deltas, sql) = stream(&["-- view: bar\n", "SEL", "ECT 1"]);
        assert_eq!(
            (deltas.as_str(), sql.as_str()),
            ("-- view: bar\nSELECT 1", "-- view: bar\nSELECT 1")
        );
    }

    #[test]
    fn think_block_is_removed() {
        let (deltas, sql) = stream(&["<think>\n\n</think>\n\n", "SELECT 2"]);
        assert_eq!((deltas.as_str(), sql.as_str()), ("SELECT 2", "SELECT 2"));
        let (_, sql) = stream(&["<thi", "nk>reasoning</think>SELECT 3"]);
        assert_eq!(sql, "SELECT 3");
    }

    #[test]
    fn check_accepts_one_select() {
        for ok in [
            "SELECT 1",
            "with a as (select 1) select * from a",
            "-- view: line\nSELECT ts, avg(speed) FROM t GROUP BY 1",
            "/* c */ SELECT ';' AS semi, \"a;b\" FROM t",
            "SELECT 1;  -- trailing",
            "FROM t SELECT *",
            "(SELECT 1) UNION ALL (SELECT 2)",
        ] {
            assert_eq!(check(ok), Ok(()), "{ok}");
        }
    }

    #[test]
    fn check_rejects_obviously_invalid_replies() {
        for (bad, why) in [
            ("", "no SQL"),
            ("   -- only a comment", "no SQL"),
            ("Here is the query: SELECT 1", "must start"),
            ("DELETE FROM t", "must start"),
            ("SELECT 1; DROP TABLE t", "more than one"),
            ("SELECT 'unterminated", "ended inside"),
            ("SELECT 1 /* open", "ended inside"),
        ] {
            let error = check(bad).unwrap_err();
            assert!(error.contains(why), "{bad}: {error}");
        }
    }
}
