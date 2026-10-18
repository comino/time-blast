//! DESCRIBE → DESCRIPTION: a title and a short explanation for one saved chart revision
//! (docs/plan-captions.md). Rust twin of `src/inference-node/caption.ts`: the system prompt and
//! user message are byte-identical, checked against `tests/fixtures/caption-*`.
//!
//! Captions are isolated from translation: their own provider client and upstream slots, their
//! own budget and cache, and per-session bookkeeping outside the translation map and epochs.
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

use serde::Deserialize;
use serde_json::json;
use tb_protocol::{Frame, Header, Kind, flags, node, stage};

use crate::{
    infer::{Outbox, Spent, error_frame, now_ms},
    provider::{Provider, ProviderError, error},
};

pub const CAPABILITY: &str = "describe-v1";
pub const PROMPT_VERSION: u32 = 1;
/// Largest DESCRIBE payload in bytes; the client falls back to the question above it.
pub const MAX_PAYLOAD: usize = 16384;
pub const MAX_TITLE_CHARS: usize = 80;
pub const MAX_EXPLANATION_CHARS: usize = 320;
const MAX_TABLES: usize = 16;
const MAX_COLUMNS: usize = 128;
const MAX_FIELD_CHARS: usize = 2048;

pub const SYSTEM: &str = "You write the caption of a chart. The chart shows the result of one SQL query.\n\
Describe what the SQL computes, not what the user asked: when they differ, the SQL is right.\n\
Reply with exactly two lines and nothing else:\n\
TITLE: <chart title, at most 8 words, no final period>\n\
EXPLAIN: <one or two plain sentences, at most 40 words: what is measured, how it is grouped or bucketed, which filters and time range apply, and a limit if there is one>\n\
Use the words a person would use. Use column or table names only when they are the clearest word. Never mention SQL, queries, tables, columns or records as such.\n\
Say what the chart includes. Do not list what it leaves out (no filter, no limit) or how rows are sorted unless the order is the point.\n\
When a previous title is given, keep its wording for what did not change and change only what the SQL changed.";

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub v: u32,
    pub sql: String,
    pub question: String,
    pub dialect: String,
    pub tables: Vec<Table>,
    #[serde(rename = "previousTitle")]
    pub previous_title: Option<String>,
    pub change: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Table {
    pub name: String,
    pub columns: Vec<(String, String)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Caption {
    pub title: String,
    pub explanation: String,
}

/// Parse and check a DESCRIBE payload. Mirrors `validateCaptionRequest` in caption.ts.
pub fn validate(payload: &[u8]) -> Result<Request, String> {
    if payload.len() > MAX_PAYLOAD {
        return Err(format!("DESCRIBE payload exceeds {MAX_PAYLOAD} bytes"));
    }
    let r: Request = serde_json::from_slice(payload).map_err(|e| format!("Invalid DESCRIBE payload: {e}"))?;
    if r.v != 1 {
        return Err("Unsupported DESCRIBE version".into());
    }
    if r.sql.trim().is_empty() {
        return Err("DESCRIBE needs SQL".into());
    }
    if r.dialect != "duckdb" && r.dialect != "clickhouse" {
        return Err("Unknown dialect".into());
    }
    for (name, value) in [("previousTitle", &r.previous_title), ("change", &r.change)] {
        if value.as_ref().is_some_and(|v| v.chars().count() > MAX_FIELD_CHARS) {
            return Err(format!("Invalid {name}"));
        }
    }
    if r.question.chars().count() > MAX_FIELD_CHARS * 8 {
        return Err("Question too long".into());
    }
    if r.tables.len() > MAX_TABLES || r.tables.iter().any(|t| t.columns.len() > MAX_COLUMNS) {
        return Err("Too many tables or columns".into());
    }
    Ok(r)
}

/// JavaScript's `String.prototype.trim` set (WhiteSpace + LineTerminator), so both twins trim
/// identically (Rust's `trim` differs on U+FEFF and U+0085).
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn trim(text: &str) -> &str {
    text.trim_matches(js_space)
}
fn clean(text: &str) -> String {
    text.chars()
        .map(|c| if matches!(c, '\0'..='\u{8}' | '\u{b}'..='\u{1f}' | '\u{7f}') { ' ' } else { c })
        .collect()
}

/// The user message. Mirrors `captionUserMessage` in caption.ts.
pub fn user_message(r: &Request) -> String {
    let dialect = if r.dialect == "clickhouse" { "ClickHouse" } else { "DuckDB" };
    let mut lines = vec![format!("Dialect: {dialect}"), "Columns:".to_string()];
    for t in &r.tables {
        let columns: Vec<String> = t.columns.iter().map(|(n, ty)| format!("{} {}", clean(n), clean(ty))).collect();
        lines.push(format!("{}({})", clean(&t.name), columns.join(", ")));
    }
    if !trim(&r.question).is_empty() {
        lines.push(format!("Question: {}", clean(trim(&r.question))));
    }
    if let Some(title) = r.previous_title.as_deref().map(trim).filter(|t| !t.is_empty()) {
        lines.push(format!("Previous title: {}", clean(title)));
    }
    if let Some(change) = r.change.as_deref().map(trim).filter(|t| !t.is_empty()) {
        lines.push(format!("Latest change: {}", clean(change)));
    }
    lines.push("SQL:".into());
    lines.push(trim(&r.sql).to_string());
    lines.join("\n")
}

/// Cut to `max` characters at a word boundary, with an ellipsis.
fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max - 1).collect();
    let space = head.rfind(' ').map(|byte| head[..byte].chars().count());
    let kept = match space {
        Some(chars) if chars > max / 2 => head.chars().take(chars).collect::<String>(),
        _ => head,
    };
    format!("{}…", kept.trim_end_matches(js_space))
}

fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if js_space(c) {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(c);
        }
    }
    out
}

/// Parse the model's two lines. Mirrors `parseCaption` in caption.ts.
pub fn parse_reply(reply: &str) -> Option<Caption> {
    let (mut title, mut explanation) = (String::new(), String::new());
    for line in reply.split('\n') {
        let t = trim(trim(line).trim_matches('*'));
        let Some(colon) = t.find(':') else { continue };
        let key = trim(&t[..colon]);
        let is_title = key.eq_ignore_ascii_case("TITLE");
        if !is_title && !key.eq_ignore_ascii_case("EXPLAIN") {
            continue;
        }
        let value = collapse(&clean(t[colon + 1..].trim_start_matches(|c: char| c == '*' || js_space(c))));
        if is_title && title.is_empty() {
            let v = value.trim_start_matches(['"', '\'', '“']).trim_end_matches(['"', '\'', '”']);
            title = trim(v.strip_suffix('.').unwrap_or(v)).to_string();
        } else if !is_title && explanation.is_empty() {
            explanation = value;
        }
    }
    if title.is_empty() || explanation.is_empty() {
        return None;
    }
    Some(Caption { title: cut(&title, MAX_TITLE_CHARS), explanation: cut(&explanation, MAX_EXPLANATION_CHARS) })
}

/// Process-wide exact payload → caption cache. The payload is every semantic input, so an
/// identical request (undo/redo, reload, a second tab) is not paid twice. Bounded by entries
/// (each key ≤ MAX_PAYLOAD bytes).
pub struct CaptionCache {
    entries: Mutex<(HashMap<Vec<u8>, Arc<Caption>>, VecDeque<Vec<u8>>)>,
    capacity: usize,
}

impl CaptionCache {
    pub fn new(capacity: usize) -> Self {
        CaptionCache { entries: Mutex::new((HashMap::new(), VecDeque::new())), capacity }
    }
    pub fn get(&self, payload: &[u8]) -> Option<Arc<Caption>> {
        self.entries.lock().unwrap().0.get(payload).cloned()
    }
    pub fn put(&self, payload: &[u8], caption: Caption) {
        if self.capacity == 0 {
            return;
        }
        let mut guard = self.entries.lock().unwrap();
        let (map, order) = &mut *guard;
        if map.insert(payload.to_vec(), Arc::new(caption)).is_none() {
            order.push_back(payload.to_vec());
            while order.len() > self.capacity {
                if let Some(old) = order.pop_front() {
                    map.remove(&old);
                }
            }
        }
    }
}

pub struct Job {
    pub header: Header,
    pub payload: Vec<u8>,
    pub request: Request,
    pub received_at: f64,
    pub progress: Arc<Mutex<Spent>>,
}

fn description(base: &Header, caption: &Caption, model: &str, cached: bool, spent: Option<&Spent>) -> Frame {
    let mut body = json!({"title": caption.title, "explanation": caption.explanation, "model": model, "cached": cached});
    if let Some(spent) = spent {
        body["usage"] = spent.stats_json(model);
    }
    let mut header = Header { kind: Kind::Description, flags: 0, ..*base };
    if cached {
        header.flags = flags::CACHED;
    }
    Frame::new(header, body.to_string())
}

/// Answer from the caption cache.
pub fn cached_frame(base: &Header, caption: &Caption, model: &str, received_at: f64) -> Frame {
    description(base, caption, model, true, None)
        .stamp(stage::INFER_RECEIVED, node::INFERENCE, received_at)
        .stamp(stage::DESCRIPTION_COMPLETE, node::INFERENCE, now_ms())
}

/// Run one caption to completion: DESCRIPTION, or ERROR. Returns what was spent.
pub async fn run(provider: &Provider, cache: &CaptionCache, job: &Job, out: &Outbox) -> (Spent, Result<(), ProviderError>) {
    let mut spent = Spent::default();
    let result = tokio::time::timeout(provider.config().timeout, describe(provider, cache, job, out, &mut spent))
        .await
        .unwrap_or_else(|_| Err(error("timeout", "Caption exceeded its deadline.")));
    if let Err(e) = &result {
        let _ = out.send((job.header.request, error_frame(&job.header, e.code, &e.message), true));
    }
    (spent, result)
}

async fn describe(provider: &Provider, cache: &CaptionCache, job: &Job, out: &Outbox, spent: &mut Spent) -> Result<(), ProviderError> {
    let _slot = provider.slot()?;
    let messages = [json!({"role": "system", "content": SYSTEM}), json!({"role": "user", "content": user_message(&job.request)})];
    let requested = now_ms();
    let mut first_token = None;
    spent.attempts = 1;
    *job.progress.lock().unwrap() = spent.clone();
    let completion = provider
        .stream(&messages, |_| {
            first_token.get_or_insert_with(now_ms);
        })
        .await?;
    spent.add(&completion.usage);
    spent.model = completion.model.clone();
    *job.progress.lock().unwrap() = spent.clone();
    if completion.refused || completion.tool_call {
        return Err(error("invalid_caption", "The model did not write a caption."));
    }
    let caption = parse_reply(&completion.content)
        .ok_or_else(|| error("invalid_caption", "The caption reply had no TITLE and EXPLAIN lines."))?;
    cache.put(&job.payload, caption.clone());
    let model = spent.model.clone().unwrap_or_else(|| provider.config().model.clone());
    let mut frame = description(&job.header, &caption, &model, false, Some(spent))
        .stamp(stage::INFER_RECEIVED, node::INFERENCE, job.received_at)
        .stamp(stage::PROVIDER_REQUEST, node::INFERENCE, requested);
    if let Some(at) = first_token {
        frame = frame.stamp(stage::FIRST_TOKEN, node::PROVIDER, at);
    }
    let _ = out.send((job.header.request, frame.stamp(stage::DESCRIPTION_COMPLETE, node::INFERENCE, now_ms()), true));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }
    fn check_golden(name: &str, actual: &str) {
        let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        if std::env::var_os("UPDATE_GOLDEN").is_some() {
            std::fs::write(&path, actual).unwrap();
        }
        assert_eq!(actual, fixture(name), "regenerate with UPDATE_GOLDEN=1 and update caption.ts");
    }

    #[test]
    fn prompt_matches_golden() {
        check_golden("caption-system.txt", SYSTEM);
        for case in ["create", "refine"] {
            let raw = fixture(&format!("caption-{case}.json"));
            let request = validate(raw.trim().as_bytes()).unwrap();
            check_golden(&format!("caption-{case}-user.txt"), &user_message(&request));
        }
    }

    #[test]
    fn validation_rejects_bad_payloads() {
        let ok = r#"{"v":1,"sql":"SELECT 1","question":"","dialect":"duckdb","tables":[]}"#;
        assert!(validate(ok.as_bytes()).is_ok());
        for bad in [
            r#"{"v":2,"sql":"SELECT 1","question":"","dialect":"duckdb","tables":[]}"#,
            r#"{"v":1,"sql":"  ","question":"","dialect":"duckdb","tables":[]}"#,
            r#"{"v":1,"sql":"SELECT 1","question":"","dialect":"oracle","tables":[]}"#,
            r#"{"v":1,"sql":"SELECT 1","question":"","dialect":"duckdb","tables":[],"extra":1}"#,
            r#"{"v":1,"sql":"SELECT 1","question":"","dialect":"duckdb","tables":[{"name":"t","columns":[["a"]]}]}"#,
        ] {
            assert!(validate(bad.as_bytes()).is_err(), "{bad}");
        }
        let big = format!(r#"{{"v":1,"sql":"{}","question":"","dialect":"duckdb","tables":[]}}"#, "x".repeat(MAX_PAYLOAD));
        assert!(validate(big.as_bytes()).is_err());
    }

    #[test]
    fn parses_two_lines_and_bounds_them() {
        let c = parse_reply("TITLE: \"Daily max temperature in Berlin.\"\nEXPLAIN:  Highest   reading per day.\n").unwrap();
        assert_eq!(c, Caption { title: "Daily max temperature in Berlin".into(), explanation: "Highest reading per day.".into() });
        let c = parse_reply("**TITLE:** Delays\n**EXPLAIN:** Average delay.").unwrap();
        assert_eq!(c.title, "Delays");
        assert!(parse_reply("TITLE: only a title").is_none());
        assert!(parse_reply("My TITLE: x\nEXPLAIN: y").is_none());
        let long = parse_reply(&format!("TITLE: {}\nEXPLAIN: x", "word ".repeat(40))).unwrap();
        assert!(long.title.chars().count() <= MAX_TITLE_CHARS && long.title.ends_with('…'));
    }
}
