//! Just enough JSON for the coordinator: parse `CoordinatorConfig`, write `RESULT`.
//! No dependencies and no `core::fmt` / `str::parse::<f64>`, which keeps the Wasm small.

use crate::Policy;

/// The fields a `CONFIG` frame names. `None` = not present (leave unchanged).
#[derive(Debug, Default, PartialEq)]
pub(crate) struct ConfigPatch {
    pub live: Option<bool>,
    pub min_chars: Option<u32>,
    pub policy: Option<Policy>,
    /// `Some(None)` = explicit `null`.
    pub latency_dial_ms: Option<Option<f64>>,
    pub translation_cache: Option<bool>,
    pub speculate: Option<bool>,
    pub free_slots: Vec<u32>,
}

pub(crate) struct Bad;

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }
    fn peek(&mut self) -> Option<u8> {
        self.ws();
        self.s.get(self.i).copied()
    }
    fn eat(&mut self, byte: u8) -> Result<(), Bad> {
        if self.peek() == Some(byte) {
            self.i += 1;
            Ok(())
        } else {
            Err(Bad)
        }
    }
    fn word(&mut self, word: &[u8]) -> bool {
        self.ws();
        if self.s[self.i..].starts_with(word) {
            self.i += word.len();
            true
        } else {
            false
        }
    }
    /// Raw bytes between the quotes; escapes are skipped, not decoded (keys and enum
    /// values never contain them).
    fn string(&mut self) -> Result<&'a [u8], Bad> {
        self.eat(b'"')?;
        let start = self.i;
        while self.i < self.s.len() {
            match self.s[self.i] {
                b'"' => {
                    self.i += 1;
                    return Ok(&self.s[start..self.i - 1]);
                }
                b'\\' => self.i += 2,
                _ => self.i += 1,
            }
        }
        Err(Bad)
    }
    fn number(&mut self) -> Result<f64, Bad> {
        self.ws();
        let negative = self.s.get(self.i) == Some(&b'-');
        if negative {
            self.i += 1;
        }
        let mut value = 0.0f64;
        let mut digits = 0;
        while let Some(d @ b'0'..=b'9') = self.s.get(self.i).copied() {
            value = value * 10.0 + (d - b'0') as f64;
            self.i += 1;
            digits += 1;
        }
        if self.s.get(self.i) == Some(&b'.') {
            self.i += 1;
            let mut scale = 0.1;
            while let Some(d @ b'0'..=b'9') = self.s.get(self.i).copied() {
                value += (d - b'0') as f64 * scale;
                scale *= 0.1;
                self.i += 1;
                digits += 1;
            }
        }
        if digits == 0 {
            return Err(Bad);
        }
        if matches!(self.s.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            let negative_exp = match self.s.get(self.i) {
                Some(b'-') => { self.i += 1; true }
                Some(b'+') => { self.i += 1; false }
                _ => false,
            };
            let mut exp = 0i32;
            while let Some(d @ b'0'..=b'9') = self.s.get(self.i).copied() {
                exp = (exp * 10 + (d - b'0') as i32).min(400);
                self.i += 1;
            }
            let factor = (0..exp).fold(1.0f64, |f, _| f * 10.0);
            value = if negative_exp { value / factor } else { value * factor };
        }
        Ok(if negative { -value } else { value })
    }
    fn boolean(&mut self) -> Result<bool, Bad> {
        if self.word(b"true") {
            Ok(true)
        } else if self.word(b"false") {
            Ok(false)
        } else {
            Err(Bad)
        }
    }
    fn skip(&mut self, depth: u32) -> Result<(), Bad> {
        if depth > 32 {
            return Err(Bad);
        }
        match self.peek().ok_or(Bad)? {
            b'"' => self.string().map(|_| ()),
            b'{' => self.list(b'{', b'}', depth, true),
            b'[' => self.list(b'[', b']', depth, false),
            b't' | b'f' => self.boolean().map(|_| ()),
            b'n' if self.word(b"null") => Ok(()),
            _ => self.number().map(|_| ()),
        }
    }
    fn list(&mut self, open: u8, close: u8, depth: u32, keyed: bool) -> Result<(), Bad> {
        self.eat(open)?;
        if self.peek() == Some(close) {
            self.i += 1;
            return Ok(());
        }
        loop {
            if keyed {
                self.string()?;
                self.eat(b':')?;
            }
            self.skip(depth + 1)?;
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(c) if c == close => {
                    self.i += 1;
                    return Ok(());
                }
                _ => return Err(Bad),
            }
        }
    }
    fn slot(&mut self) -> Result<u32, Bad> {
        let n = self.number()?;
        if n >= 0.0 && n <= u32::MAX as f64 && n == (n as u32) as f64 {
            Ok(n as u32)
        } else {
            Err(Bad)
        }
    }
}

pub(crate) fn parse_config(input: &[u8]) -> Result<ConfigPatch, Bad> {
    let mut p = Parser { s: input, i: 0 };
    let mut patch = ConfigPatch::default();
    p.eat(b'{')?;
    if p.peek() == Some(b'}') {
        p.i += 1;
    } else {
        loop {
            let key = p.string()?;
            p.eat(b':')?;
            match key {
                b"live" => patch.live = Some(p.boolean()?),
                b"speculate" => patch.speculate = Some(p.boolean()?),
                b"translationCache" => patch.translation_cache = Some(p.boolean()?),
                b"minChars" => patch.min_chars = Some(p.slot()?),
                b"inferencePolicy" => {
                    patch.policy = Some(match p.string()? {
                        b"latest" => Policy::Latest,
                        b"restart" => Policy::Restart,
                        _ => return Err(Bad),
                    })
                }
                b"latencyDialMs" => {
                    patch.latency_dial_ms = Some(if p.word(b"null") {
                        None
                    } else {
                        let ms = p.number()?;
                        if !ms.is_finite() || ms < 0.0 {
                            return Err(Bad);
                        }
                        Some(ms)
                    })
                }
                b"freeSlots" => {
                    p.eat(b'[')?;
                    if p.peek() == Some(b']') {
                        p.i += 1;
                    } else {
                        loop {
                            patch.free_slots.push(p.slot()?);
                            match p.peek() {
                                Some(b',') => p.i += 1,
                                Some(b']') => {
                                    p.i += 1;
                                    break;
                                }
                                _ => return Err(Bad),
                            }
                        }
                    }
                }
                _ => p.skip(0)?,
            }
            match p.peek() {
                Some(b',') => p.i += 1,
                Some(b'}') => {
                    p.i += 1;
                    break;
                }
                _ => return Err(Bad),
            }
        }
    }
    if p.peek().is_some() {
        return Err(Bad);
    }
    Ok(patch)
}

pub(crate) fn push_u32(out: &mut Vec<u8>, mut value: u32) {
    let mut digits = [0u8; 10];
    let mut n = 0;
    loop {
        digits[n] = b'0' + (value % 10) as u8;
        n += 1;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    out.extend(digits[..n].iter().rev());
}

pub(crate) fn valid_object(input: &[u8]) -> bool {
    let mut p = Parser { s: input, i: 0 };
    p.peek() == Some(b'{') && p.skip(0).is_ok() && p.peek().is_none()
}

pub(crate) fn has_capability(input: &[u8], capability: &[u8]) -> bool {
    fn check(input: &[u8], capability: &[u8]) -> Result<bool, Bad> {
        let mut p = Parser { s: input, i: 0 }; let mut found = false;
        p.eat(b'{')?;
        while p.peek() != Some(b'}') {
            let key = p.string()?; p.eat(b':')?;
            if key == b"capabilities" {
                p.eat(b'[')?;
                while p.peek() != Some(b']') {
                    found |= p.string()? == capability;
                    if p.peek() != Some(b']') { p.eat(b',')?; }
                }
                p.eat(b']')?;
            } else { p.skip(0)?; }
            if p.peek() != Some(b'}') { p.eat(b',')?; }
        }
        p.eat(b'}')?; if p.peek().is_some() { return Err(Bad); } Ok(found)
    }
    check(input, capability).unwrap_or(false)
}

fn target_payload(slot: u32, generation: u32) -> Vec<u8> {
    let mut out = b"{\"slot\":".to_vec(); push_u32(&mut out, slot);
    out.extend_from_slice(b",\"generation\":"); push_u32(&mut out, generation); out
}
pub(crate) fn candidate_payload(slot: u32, generation: u32, sql: &[u8]) -> Vec<u8> {
    let mut out = target_payload(slot, generation); out.extend_from_slice(b",\"sql\":"); push_string(&mut out, sql); out.push(b'}'); out
}
pub(crate) fn execution_payload(slot: u32, generation: u32, status: &[u8]) -> Vec<u8> {
    let mut out = target_payload(slot, generation); out.extend_from_slice(b",\"status\":"); push_string(&mut out, status); out.push(b'}'); out
}

/// Append `bytes` (UTF-8) as a JSON string literal.
pub(crate) fn push_string(out: &mut Vec<u8>, bytes: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(b'"');
    let mut run = 0;
    for (i, &b) in bytes.iter().enumerate() {
        let escape: &[u8] = match b {
            b'"' => b"\\\"",
            b'\\' => b"\\\\",
            b'\n' => b"\\n",
            b'\r' => b"\\r",
            b'\t' => b"\\t",
            0..=0x1f => b"",
            _ => continue,
        };
        out.extend_from_slice(&bytes[run..i]);
        run = i + 1;
        if escape.is_empty() {
            out.extend_from_slice(&[b'\\', b'u', b'0', b'0', HEX[(b >> 4) as usize], HEX[(b & 15) as usize]]);
        } else {
            out.extend_from_slice(escape);
        }
    }
    out.extend_from_slice(&bytes[run..]);
    out.push(b'"');
}

const VIEWS: [&[u8]; 10] = [
    b"line", b"bar", b"scatter", b"table", b"heatmap", b"surface", b"map", b"density", b"tracks", b"seasons",
];

/// Question words that ask for each view in `VIEWS` (same order). A word matches where it
/// starts a word in the question ("tracks" matches "track", "heatmap" never matches "map").
const VIEW_WORDS: [&[&[u8]]; 10] = [
    &[b"line"],
    &[b"bar", b"histogram", b"column chart"],
    &[b"scatter", b"correlat"],
    &[b"table", b"tabular", b"list", b"rows"],
    &[b"heatmap", b"heat map", b"heat-map"],
    &[b"surface", b"3d", b"3-d"],
    &[b"map", b"location", b"where"],
    &[b"density", b"concentrat"],
    &[b"track", b"voyage", b"route", b"trajector", b"path"],
    &[b"season", b"wheel", b"calendar", b"cycle"],
];

/// Code of an automatic view choice in BIND (no hint, or a hint nobody asked for).
pub(crate) const AUTO_VIEW: u32 = 255;

/// The SQL's view hint, as an index into `VIEWS`, but only if the question asks for that
/// presentation. Models add hints unasked; an unasked hint must not override the automatic
/// choice made from the result's columns.
pub(crate) fn requested_view(question: &str, sql: &[u8]) -> Option<u32> {
    let hint = view_hint(sql)?;
    let index = VIEWS.iter().position(|v| *v == hint)?;
    let q = question.as_bytes();
    let asked = VIEW_WORDS[index].iter().any(|word| {
        (0..q.len()).any(|at| {
            (at == 0 || !q[at - 1].is_ascii_alphanumeric())
                && q.len() - at >= word.len()
                && q[at..at + word.len()].eq_ignore_ascii_case(word)
        })
    });
    asked.then_some(index as u32)
}

/// The view hint of the result-shape convention: a leading `-- view: <name>` comment.
pub(crate) fn view_hint(sql: &[u8]) -> Option<&'static [u8]> {
    let s = trim_start(sql).strip_prefix(b"--")?;
    let s = trim_start(s).strip_prefix(b"view")?;
    let s = trim_start(s).strip_prefix(b":")?;
    let s = trim_start(s);
    let end = s.iter().position(|b| !b.is_ascii_alphanumeric()).unwrap_or(s.len());
    let name = &s[..end];
    VIEWS.iter().copied().find(|v| v.eq_ignore_ascii_case(name))
}

fn trim_start(s: &[u8]) -> &[u8] {
    let start = s.iter().position(|b| !matches!(b, b' ' | b'\t' | b'\n' | b'\r')).unwrap_or(s.len());
    &s[start..]
}

/// `RESULT` payload: `{"slot", "sql", "columns": [], "view", "cached"}`.
pub(crate) fn result_payload(slot: u32, sql: &[u8], cached: bool, view: Option<u32>) -> Vec<u8> {
    let mut out = Vec::with_capacity(sql.len() + 64);
    out.extend_from_slice(b"{\"slot\":");
    push_u32(&mut out, slot);
    out.extend_from_slice(b",\"sql\":");
    push_string(&mut out, sql);
    out.extend_from_slice(b",\"columns\":[],\"view\":");
    match view {
        Some(view) => {
            out.push(b'"');
            out.extend_from_slice(VIEWS[view as usize]);
            out.push(b'"');
        }
        None => out.extend_from_slice(b"null"),
    }
    out.extend_from_slice(if cached { b",\"cached\":true}" } else { b",\"cached\":false}" });
    out
}
