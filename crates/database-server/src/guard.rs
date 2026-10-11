//! Single read-only statement guard for model-written ClickHouse SQL, the counterpart of the
//! browser's `src/engine/sql-guard.ts`:
//!
//! 1. A lexer that knows ClickHouse's strings (`'…'` with `\` escapes and `''`), quoted
//!    identifiers (`"…"`, `` `…` ``), heredocs (`$tag$…$tag$`) and comments (`--`, `#!`,
//!    `# `, nested `/* */`) finds `;` tokens. Anything but more `;` after the first one →
//!    `multiple_statements`; nothing but comments → `empty`.
//! 2. The statement runs as `SELECT * FROM (<sql>\n)`. Only queries parse inside a
//!    subquery, so DDL, DML, SET, SYSTEM, KILL, … and a `FORMAT` or `INTO OUTFILE` clause
//!    (which would break the Arrow stream) fail at parse time. The newline keeps a trailing
//!    `-- comment` from swallowing the `)`.
//!
//! Defence in depth around it (src/clickhouse.rs): every query runs with `readonly=1`
//! (no writes, no setting changes — a `SETTINGS` clause that changes a limit is refused, and
//! table functions such as `url()` are refused), and ClickHouse's HTTP interface executes
//! exactly one statement per request. Restricting which databases a query may read needs a
//! dedicated ClickHouse user (docs/batch-1/remote-database.md).

#[derive(Debug, PartialEq, Eq)]
pub enum Guard {
    Ok(String),
    Rejected { code: &'static str, message: &'static str },
}

/// Prefix of the wrapper; error positions are reported relative to the model's SQL.
pub const WRAP_PREFIX: &str = "SELECT * FROM (";

/// Find the first `;` outside strings, identifiers and comments, and whether anything but
/// `;`, whitespace and comments follows it. Returns (statement end, has_statement, trailing).
fn scan(sql: &str) -> (usize, bool, bool) {
    let b = sql.as_bytes();
    let mut i = 0;
    let mut end: Option<usize> = None;
    let mut has_statement = false;
    let mut trailing = false;
    let token = |end: &Option<usize>, has: &mut bool, trailing: &mut bool| {
        if end.is_some() {
            *trailing = true;
        } else {
            *has = true;
        }
    };
    while i < b.len() {
        let c = b[i];
        match c {
            b' ' | b'\t' | b'\n' | b'\r' | b'\x0b' | b'\x0c' => i += 1,
            b'-' if b.get(i + 1) == Some(&b'-') => i = line_end(b, i),
            b'#' if matches!(b.get(i + 1), Some(b'!' | b' ')) => i = line_end(b, i),
            b'/' if b.get(i + 1) == Some(&b'*') => {
                let mut depth = 0usize;
                while i < b.len() {
                    if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
                        depth += 1;
                        i += 2;
                    } else if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
                        depth -= 1;
                        i += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            b';' => {
                if end.is_none() {
                    end = Some(i);
                }
                i += 1;
            }
            b'\'' | b'"' | b'`' => {
                token(&end, &mut has_statement, &mut trailing);
                i = quoted_end(b, i, c);
            }
            b'$' => {
                token(&end, &mut has_statement, &mut trailing);
                i = heredoc_end(sql, i);
            }
            _ => {
                token(&end, &mut has_statement, &mut trailing);
                i += 1;
            }
        }
    }
    (end.unwrap_or(sql.len()), has_statement, trailing)
}

fn line_end(b: &[u8], from: usize) -> usize {
    b[from..].iter().position(|&c| c == b'\n').map_or(b.len(), |p| from + p + 1)
}

/// End of a `'…'`, `"…"` or `` `…` `` literal: backslash escapes and doubled quotes.
fn quoted_end(b: &[u8], from: usize, quote: u8) -> usize {
    let mut i = from + 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            c if c == quote => {
                if b.get(i + 1) == Some(&quote) {
                    i += 2;
                } else {
                    return i + 1;
                }
            }
            _ => i += 1,
        }
    }
    b.len()
}

/// `$tag$ … $tag$` (tag may be empty); a lone `$` is an ordinary character.
fn heredoc_end(sql: &str, from: usize) -> usize {
    let b = sql.as_bytes();
    let tag_len = b[from + 1..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'_').count();
    let open_end = from + 1 + tag_len;
    if b.get(open_end) != Some(&b'$') {
        return from + 1;
    }
    let delimiter = &sql[from..=open_end];
    match sql[open_end + 1..].find(delimiter) {
        Some(p) => open_end + 1 + p + delimiter.len(),
        None => b.len(),
    }
}

pub fn guard(sql: &str) -> Guard {
    let (end, has_statement, trailing) = scan(sql);
    if trailing {
        return Guard::Rejected { code: "sql_rejected", message: "Only one SQL statement may be executed" };
    }
    if !has_statement {
        return Guard::Rejected { code: "sql_rejected", message: "The SQL text contains no statement" };
    }
    Guard::Ok(format!("{WRAP_PREFIX}{}\n)", &sql[..end]))
}

/// The model's statement inside a guarded query (for DESCRIBE).
pub fn inner(wrapped: &str) -> &str {
    &wrapped[WRAP_PREFIX.len()..wrapped.len() - 2]
}

/// ClickHouse error text refers to the wrapped statement: shift `position N` and
/// `(line 1, col N)` back to the model's SQL, drop the wrapper where it is echoed and the
/// server version suffix.
pub fn unwrap_error(message: &str) -> String {
    let text = shift_numbers(&shift_numbers(message.trim_end(), "position "), "(line 1, col ");
    let text = match text.rfind(" (version ") {
        Some(at) if text.ends_with(')') => &text[..at],
        _ => &text[..],
    };
    text.replace(WRAP_PREFIX, "")
}

fn shift_numbers(text: &str, marker: &str) -> String {
    let shift = WRAP_PREFIX.len();
    let mut out = String::with_capacity(text.len());
    let mut tail = text;
    while let Some(at) = tail.find(marker) {
        let (head, after) = tail.split_at(at + marker.len());
        out.push_str(head);
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        match after[..digits].parse::<usize>() {
            Ok(n) if n > shift => out.push_str(&(n - shift).to_string()),
            _ => out.push_str(&after[..digits]),
        }
        tail = &after[digits..];
    }
    out.push_str(tail);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(sql: &str) -> String {
        match guard(sql) {
            Guard::Ok(wrapped) => wrapped,
            other => panic!("{sql:?} rejected: {other:?}"),
        }
    }
    fn rejected(sql: &str) -> &'static str {
        match guard(sql) {
            Guard::Rejected { message, .. } => message,
            Guard::Ok(w) => panic!("{sql:?} accepted as {w:?}"),
        }
    }

    #[test]
    fn wraps_one_statement_and_strips_trailing_semicolons() {
        assert_eq!(ok("SELECT 1"), "SELECT * FROM (SELECT 1\n)");
        assert_eq!(ok("SELECT 1;"), "SELECT * FROM (SELECT 1\n)");
        assert_eq!(ok("-- view: line\nselect ';' as x; -- done\n ;"), "SELECT * FROM (-- view: line\nselect ';' as x\n)");
        assert_eq!(inner(&ok("SELECT 1 -- c")), "SELECT 1 -- c");
    }

    #[test]
    fn semicolons_inside_literals_and_comments_do_not_split() {
        for sql in [
            "select 'a;b', \"c;d\", `e;f` from t",
            "select 'it''s; fine', 'esc\\'; still' from t",
            "select $$a;b$$, $tag$ ; $$ ; $tag$ from t",
            "select 1 /* ; /* nested ; */ ; */ from t",
            "select 1 # ; comment\n from t",
            "select 1 #! ; comment\n from t",
            "select 1 -- ; comment\n from t",
            "select $1, a$b from t",
        ] {
            assert!(!ok(sql).contains(";\n)"), "{sql}");
        }
    }

    #[test]
    fn rejects_multiple_statements_and_empty_input() {
        assert_eq!(rejected("select 1; drop table telemetry"), "Only one SQL statement may be executed");
        assert_eq!(rejected("select 1) ; drop table x; select * from (select 1"), "Only one SQL statement may be executed");
        assert_eq!(rejected("select ';'; 'x'"), "Only one SQL statement may be executed");
        assert_eq!(rejected("  -- nothing\n"), "The SQL text contains no statement");
        assert_eq!(rejected(" ; ;"), "The SQL text contains no statement");
        assert_eq!(rejected("/* only */"), "The SQL text contains no statement");
    }

    #[test]
    fn error_positions_refer_to_the_model_sql() {
        let message = "Code: 62. DB::Exception: Syntax error: failed at position 32 (JSON) (line 1, col 32): JSON\n). Expected one of: token. (SYNTAX_ERROR) (version 26.8.21.10 (official build))";
        assert_eq!(
            unwrap_error(message),
            "Code: 62. DB::Exception: Syntax error: failed at position 17 (JSON) (line 1, col 17): JSON\n). Expected one of: token. (SYNTAX_ERROR)"
        );
        assert_eq!(unwrap_error("Unknown identifier in scope SELECT * FROM (SELECT x\n)"), "Unknown identifier in scope SELECT x\n)");
        assert_eq!(unwrap_error("failed at position 3"), "failed at position 3");
    }
}

