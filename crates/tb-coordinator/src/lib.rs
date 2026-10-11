//! Sans-IO coordinator for time-blast protocol v1. See `docs/protocol-v1.md`
//! ("Identities and fencing", "Coordinator behavior") and `docs/batch-1/coordinator.md`.
//!
//! The coordinator consumes `(link, frame, now)` and produces `(link, frame)` outputs plus
//! one timer deadline. It owns no I/O, no clock and no threads, so the same crate runs in
//! the browser engine worker (Wasm, see [`abi`]) and natively (a future remote coordinator).
//!
//! Core rules, in one place:
//! - Every non-composing `DRAFT` may start a translation; at most one is in flight.
//! - `latest` lets the in-flight translation finish, then translates the newest revision;
//!   `restart` cancels it. Committed work is never cancelled by speculative drafts, and a
//!   `COMMIT` cancels conflicting speculative work under either policy.
//! - Everything shown goes to the *live slot* (front of the pool). A completed speculative
//!   translation is shown only if its revision is newer than what the live slot is bound to.
//! - Request-scoped frames are fenced by epoch and by request: a frame for an unknown,
//!   cancelled or superseded request is dropped.

mod json;
pub mod abi;
#[cfg(test)]
mod tests;

use std::collections::VecDeque;

pub use tb_protocol::{Frame, FrameRef, Header, Kind, Stamp};
use tb_protocol::{flags, node, stage};

/// The coordinator's four links. Values are the Wasm ABI link numbers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum LinkId {
    Ui = 0,
    Inference = 1,
    Database = 2,
    Renderer = 3,
}

impl LinkId {
    pub fn from_u32(value: u32) -> Option<LinkId> {
        match value {
            0 => Some(LinkId::Ui),
            1 => Some(LinkId::Inference),
            2 => Some(LinkId::Database),
            3 => Some(LinkId::Renderer),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    /// Let the in-flight translation finish, then translate the newest revision.
    Latest,
    /// Cancel the in-flight (speculative) translation and start the newest at once.
    Restart,
}

/// `CoordinatorConfig` from protocol-v1. Slots live in the pool, not here.
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub live: bool,
    pub min_chars: u32,
    pub policy: Policy,
    pub latency_dial_ms: Option<f64>,
    pub translation_cache: bool,
    pub speculate: bool,
}

impl Default for Config {
    fn default() -> Config {
        Config { live: true, min_chars: 3, policy: Policy::Latest, latency_dial_ms: None, translation_cache: true, speculate: true }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputError {
    InvalidUtf8,
    InvalidConfig,
    InvalidPayload,
}

impl InputError {
    pub fn message(self) -> &'static str {
        match self {
            InputError::InvalidUtf8 => "text payload is not valid UTF-8",
            InputError::InvalidConfig => "CONFIG payload is not a valid CoordinatorConfig",
            InputError::InvalidPayload => "malformed payload",
        }
    }
}

/// Counters for tests and for reporting speculative resource cost.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub infer_sent: u32,
    pub exec_sent: u32,
    pub cache_hits: u32,
    pub sql_dedups: u32,
    /// QUERY frames executed (chart-as-query).
    pub queries: u32,
    pub text_adoptions: u32,
    pub inference_cancels: u32,
    pub database_cancels: u32,
    /// Request-scoped frames from an older epoch.
    pub dropped_epoch: u32,
    /// Frames for unknown, cancelled, superseded or already-answered requests.
    pub dropped_request: u32,
    /// DRAFT/COMMIT older than the newest revision.
    pub dropped_revision: u32,
    /// Frames on a link that may not send that kind.
    pub dropped_link: u32,
}

/// Bounded LRU of exact `(context, text) → SQL` translations.
pub const CACHE_CAPACITY: usize = 256;
/// Requests kept for late frames (DRAWN after DONE, TIMING); oldest idle ones go first.
pub const REQUEST_CAPACITY: usize = 64;
/// Stamps kept per request ledger (one per stage; 18 stages are defined).
const LEDGER_CAPACITY: usize = 32;

static READY_PAYLOAD: &[u8] = br#"{"node":"coordinator","name":"tb-coordinator","version":1}"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// INFER sent, waiting for SQL.
    Translating,
    /// Cache hit held back by the latency dial until `release_at`.
    Delayed,
    Translated,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Exec {
    Idle,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug)]
struct Request {
    id: u32,
    context: u32,
    /// The newest draft revision this request serves (raised by text adoption and dedup).
    revision: u32,
    text: Box<str>,
    committed: bool,
    phase: Phase,
    release_at: f64,
    sql: Vec<u8>,
    cached: bool,
    exec: Exec,
    /// Slot the request is bound to (live or kept).
    slot: Option<u32>,
    result_sent: bool,
    drawn: bool,
    ledger: Vec<Stamp>,
}

impl Request {
    fn usable(&self) -> bool {
        !matches!(self.phase, Phase::Failed | Phase::Cancelled) && self.exec != Exec::Failed
    }
}

#[derive(Debug, Default)]
struct Draft {
    revision: u32,
    context: u32,
    text: String,
    composing: bool,
    committed: bool,
    /// Set by a UI CANCEL: this revision must not be translated again.
    cancelled: bool,
    stamps: Vec<Stamp>,
}

struct CacheEntry {
    hash: u64,
    context: u32,
    text: Box<str>,
    sql: Box<[u8]>,
    used: u64,
}

#[derive(Default)]
struct Cache {
    clock: u64,
    entries: Vec<CacheEntry>,
}

fn fnv1a(context: u32, text: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for &b in context.to_le_bytes().iter().chain(text.as_bytes()) {
        hash = (hash ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

impl Cache {
    fn get(&mut self, context: u32, text: &str) -> Option<&[u8]> {
        let hash = fnv1a(context, text);
        self.clock += 1;
        let clock = self.clock;
        let entry = self.entries.iter_mut().find(|e| e.hash == hash && e.context == context && &*e.text == text)?;
        entry.used = clock;
        Some(&entry.sql)
    }
    fn put(&mut self, context: u32, text: &str, sql: &[u8]) {
        let hash = fnv1a(context, text);
        self.clock += 1;
        if let Some(entry) = self.entries.iter_mut().find(|e| e.hash == hash && e.context == context && &*e.text == text) {
            entry.sql = sql.into();
            entry.used = self.clock;
            return;
        }
        let entry = CacheEntry { hash, context, text: text.into(), sql: sql.into(), used: self.clock };
        if self.entries.len() < CACHE_CAPACITY {
            self.entries.push(entry);
        } else if let Some(oldest) = self.entries.iter_mut().min_by_key(|e| e.used) {
            *oldest = entry;
        }
    }
}

fn add_stamp(ledger: &mut Vec<Stamp>, stamp: Stamp) {
    if ledger.len() < LEDGER_CAPACITY && !ledger.iter().any(|s| s.stage == stamp.stage) {
        ledger.push(stamp);
    }
}

fn coord(stage: u16, at: f64) -> Stamp {
    Stamp { stage, node: node::COORDINATOR, at }
}

pub struct Coordinator {
    config: Config,
    epoch: u32,
    context: u32,
    context_payload: Vec<u8>,
    next_request: u32,
    draft: Option<Draft>,
    requests: Vec<Request>,
    /// The request whose translation was started last (covers the newest revision).
    head: Option<u32>,
    /// The one translation in flight (INFER sent or dial-delayed cache hit).
    in_flight: Option<u32>,
    /// Free slots; the front one is the live slot.
    pool: VecDeque<u32>,
    live_bound: Option<u32>,
    /// Last request that drew on the live slot (fallback target on error).
    live_drawn: Option<u32>,
    /// Committed requests with SQL, waiting for a slot.
    waiting: VecDeque<u32>,
    /// Newest completed speculative request with no slot to show in.
    pending_spec: Option<u32>,
    cache: Cache,
    outbox: Vec<(LinkId, Frame)>,
    stats: Stats,
}

impl Default for Coordinator {
    fn default() -> Coordinator {
        Coordinator::new()
    }
}

impl Coordinator {
    pub fn new() -> Coordinator {
        Coordinator {
            config: Config::default(),
            epoch: 0,
            context: 0,
            context_payload: Vec::new(),
            next_request: 1,
            draft: None,
            requests: Vec::new(),
            head: None,
            in_flight: None,
            pool: VecDeque::new(),
            live_bound: None,
            live_drawn: None,
            waiting: VecDeque::new(),
            pending_spec: None,
            cache: Cache::default(),
            outbox: Vec::new(),
            stats: Stats::default(),
        }
    }

    pub fn config(&self) -> &Config {
        &self.config
    }
    pub fn stats(&self) -> Stats {
        self.stats
    }
    pub fn epoch(&self) -> u32 {
        self.epoch
    }
    /// The live slot (front of the pool), if any.
    pub fn live_slot(&self) -> Option<u32> {
        self.pool.front().copied()
    }
    pub fn pool(&self) -> impl Iterator<Item = u32> + '_ {
        self.pool.iter().copied()
    }
    /// Requests currently tracked (bounded by [`REQUEST_CAPACITY`]).
    pub fn tracked_requests(&self) -> usize {
        self.requests.len()
    }

    /// Frames waiting to be sent, in order.
    pub fn outbox(&self) -> &[(LinkId, Frame)] {
        &self.outbox
    }
    pub fn drain(&mut self) -> std::vec::Drain<'_, (LinkId, Frame)> {
        self.outbox.drain(..)
    }
    pub fn clear_outbox(&mut self) {
        self.outbox.clear();
    }

    /// Earliest Unix ms at which [`Coordinator::tick`] must be called.
    pub fn next_deadline(&self) -> Option<f64> {
        let request = &self.requests[self.find(self.in_flight?)?];
        (request.phase == Phase::Delayed).then_some(request.release_at)
    }

    /// Advance timers: release a dial-delayed cache hit once its deadline has passed.
    pub fn tick(&mut self, now: f64) {
        if let Some(deadline) = self.next_deadline() {
            if now >= deadline {
                let id = self.in_flight.unwrap();
                self.release(id, now);
            }
        }
        self.gc();
    }

    /// Feed one frame received on `link`. `now` is Unix ms.
    pub fn input(&mut self, link: LinkId, frame: FrameRef<'_>, now: f64) -> Result<(), InputError> {
        use LinkId::*;
        let result = match (link, frame.header.kind) {
            (Ui, Kind::Draft) => self.on_draft(frame, now, false),
            (Ui, Kind::Commit) => self.on_draft(frame, now, true),
            (Ui, Kind::Config) => self.on_config(frame.payload, now),
            (Ui, Kind::Query) => self.on_query(frame, now),
            (Ui, Kind::Cancel) => {
                self.on_cancel(frame.header.epoch);
                Ok(())
            }
            (Database, Kind::Context) => {
                self.on_context(frame, now);
                Ok(())
            }
            (Inference, Kind::Ready) => {
                self.on_inference_ready(now);
                Ok(())
            }
            (_, Kind::Hello) => {
                self.emit(link, Header::new(Kind::Ready), Vec::new(), READY_PAYLOAD.to_vec());
                Ok(())
            }
            (Inference | Database | Renderer, Kind::Status) | (Inference, Kind::InferStats) => {
                self.outbox.push((Ui, frame.to_owned()));
                Ok(())
            }
            (Inference | Database | Renderer, Kind::Error) => {
                self.on_error(link, frame, now);
                Ok(())
            }
            (Inference, Kind::SqlDelta) => {
                self.on_sql_delta(frame, now);
                Ok(())
            }
            (Inference, Kind::Sql) => {
                self.on_sql(frame, now);
                Ok(())
            }
            (Database, Kind::ResultSchema | Kind::Batch | Kind::Done) => {
                self.on_database(frame);
                Ok(())
            }
            (Renderer, Kind::Drawn) => self.on_drawn(frame),
            _ => {
                self.stats.dropped_link += 1;
                Ok(())
            }
        };
        self.gc();
        result
    }

    // ───────────────────────── helpers ─────────────────────────

    fn find(&self, id: u32) -> Option<usize> {
        self.requests.iter().position(|r| r.id == id)
    }

    fn header(&self, kind: Kind, request: u32, revision: u32, context: u32) -> Header {
        Header { kind, flags: 0, epoch: self.epoch, request, revision, context }
    }

    fn emit(&mut self, link: LinkId, header: Header, stamps: Vec<Stamp>, payload: Vec<u8>) {
        self.outbox.push((link, Frame { header, stamps, payload }));
    }

    fn emit_slot(&mut self, link: LinkId, kind: Kind, request: u32, revision: u32, slot: u32) {
        let header = self.header(kind, request, revision, 0);
        self.emit(link, header, Vec::new(), slot.to_le_bytes().to_vec());
    }

    /// BIND payload: `u32 slot, u32 view` (view = index into the protocol's view list when the
    /// question asked for the SQL's hinted presentation, else AUTO_VIEW).
    fn emit_bind(&mut self, link: LinkId, i: usize, slot: u32) {
        let r = &self.requests[i];
        let view = json::requested_view(&r.text, &r.sql).unwrap_or(json::AUTO_VIEW);
        let header = self.header(Kind::Bind, r.id, r.revision, 0);
        let mut payload = slot.to_le_bytes().to_vec();
        payload.extend_from_slice(&view.to_le_bytes());
        self.emit(link, header, Vec::new(), payload);
    }

    fn emit_cancel(&mut self, link: LinkId, request: u32) {
        match link {
            LinkId::Inference => self.stats.inference_cancels += 1,
            LinkId::Database => self.stats.database_cancels += 1,
            _ => {}
        }
        let header = self.header(Kind::Cancel, request, 0, 0);
        self.emit(link, header, Vec::new(), Vec::new());
    }

    fn emit_timing(&mut self, i: usize) {
        let r = &self.requests[i];
        let header = self.header(Kind::Timing, r.id, r.revision, r.context);
        let stamps = r.ledger.clone();
        self.emit(LinkId::Ui, header, stamps, Vec::new());
    }

    /// Fence a request-scoped frame from inference, database or renderer.
    fn admit(&mut self, header: &Header) -> Option<usize> {
        if header.epoch < self.epoch {
            self.stats.dropped_epoch += 1;
            return None;
        }
        let found = if header.request == 0 { None } else { self.find(header.request) };
        if found.is_none() {
            self.stats.dropped_request += 1;
        }
        found
    }

    fn is_short(&self, text: &str) -> bool {
        text.trim().chars().count() < self.config.min_chars as usize
    }

    // ───────────────────────── UI → coordinator ─────────────────────────

    fn on_draft(&mut self, frame: FrameRef<'_>, now: f64, commit: bool) -> Result<(), InputError> {
        let header = frame.header;
        let text = frame.text().map_err(|_| InputError::InvalidUtf8)?;
        let composing = !commit && header.has(flags::COMPOSING);
        if let Some(draft) = &self.draft {
            let older = header.revision < draft.revision
                // Same revision: a COMMIT (Enter) or the end of an IME composition.
                || header.revision == draft.revision && !commit && !(draft.composing && !composing);
            if older {
                self.stats.dropped_revision += 1;
                return Ok(());
            }
        }
        let draft = self.draft.get_or_insert_with(Draft::default);
        draft.revision = header.revision;
        draft.context = header.context;
        draft.composing = composing;
        draft.committed = commit;
        draft.cancelled = false;
        draft.text.clear();
        draft.text.push_str(text);
        draft.stamps.clear();
        draft.stamps.extend(frame.stamps().take(LEDGER_CAPACITY - 4));
        draft.stamps.push(coord(stage::COORD_RECEIVED, now));
        if composing {
            return Ok(());
        }
        if !commit && self.is_short(text) {
            self.cancel_speculative();
            self.unbind_live(true);
            return Ok(());
        }
        self.pump(now);
        Ok(())
    }

    /// QUERY: execute explicit SQL for a slot (a chart manipulation; no translation). The live
    /// slot's request is replaced by one that answers the same question text and revision, so
    /// Enter keeps what is shown and the next keystroke replaces it as usual; a kept slot gets a
    /// committed request. The BIND is the 4-byte form: the slot keeps its chosen view.
    fn on_query(&mut self, frame: FrameRef<'_>, now: f64) -> Result<(), InputError> {
        let header = frame.header;
        if frame.payload.len() < 5 {
            return Err(InputError::InvalidPayload);
        }
        let slot = u32::from_le_bytes(frame.payload[..4].try_into().unwrap());
        let sql = std::str::from_utf8(&frame.payload[4..]).map_err(|_| InputError::InvalidUtf8)?;
        if sql.trim().is_empty() {
            return Err(InputError::InvalidPayload);
        }
        let live = self.pool.front() == Some(&slot);
        // A free slot that is not live shows nothing; a stale context answers old data.
        if header.epoch < self.epoch || header.context == 0 || header.context != self.context || (!live && self.pool.contains(&slot)) {
            self.stats.dropped_request += 1;
            return Ok(());
        }
        let bound = if live { self.live_bound.and_then(|id| self.find(id)) } else { None };
        let (text, revision) = match bound {
            Some(b) => (self.requests[b].text.clone(), self.requests[b].revision),
            None => (Box::<str>::from(""), header.revision),
        };
        let old = bound.map(|b| self.requests[b].id);
        if let Some(p) = self.requests.iter().position(|r| r.slot == Some(slot)) {
            self.supersede(p);
        }
        let id = self.next_request;
        self.next_request = self.next_request.checked_add(1).expect("request ids exhausted");
        let mut ledger: Vec<Stamp> = frame.stamps().take(LEDGER_CAPACITY - 4).collect();
        ledger.push(coord(stage::COORD_RECEIVED, now));
        ledger.push(coord(stage::EXEC_SENT, now));
        self.requests.push(Request {
            id,
            context: self.context,
            revision,
            text,
            committed: !live,
            phase: Phase::Translated,
            release_at: 0.0,
            sql: sql.as_bytes().to_vec(),
            cached: false,
            exec: Exec::Running,
            slot: Some(slot),
            result_sent: false,
            drawn: false,
            ledger,
        });
        if live {
            self.live_bound = Some(id);
            if self.head.is_none() || self.head == old {
                self.head = Some(id);
            }
        }
        self.stats.queries += 1;
        self.stats.exec_sent += 1;
        self.emit_slot(LinkId::Renderer, Kind::Bind, id, revision, slot);
        self.emit_slot(LinkId::Ui, Kind::Bind, id, revision, slot);
        // EXEC last: an in-process database may run the query synchronously.
        let header = self.header(Kind::Exec, id, revision, self.context);
        self.emit(LinkId::Database, header, vec![coord(stage::EXEC_SENT, now)], sql.as_bytes().to_vec());
        Ok(())
    }

    fn on_config(&mut self, payload: &[u8], now: f64) -> Result<(), InputError> {
        let patch = json::parse_config(payload).map_err(|_| InputError::InvalidConfig)?;
        let c = &mut self.config;
        if let Some(v) = patch.live {
            c.live = v;
        }
        if let Some(v) = patch.min_chars {
            c.min_chars = v;
        }
        if let Some(v) = patch.policy {
            c.policy = v;
        }
        if let Some(v) = patch.latency_dial_ms {
            c.latency_dial_ms = v;
        }
        if let Some(v) = patch.translation_cache {
            c.translation_cache = v;
            if !v {
                self.cache.entries.clear();
            }
        }
        if let Some(v) = patch.speculate {
            c.speculate = v;
        }
        if patch.live == Some(false) {
            self.cancel_speculative();
        }
        for slot in patch.free_slots {
            let in_use = self.pool.contains(&slot) || self.requests.iter().any(|r| r.slot == Some(slot) && r.committed);
            if !in_use {
                self.pool.push_back(slot);
            }
        }
        self.fill_slots(now);
        self.pump(now);
        Ok(())
    }

    fn on_cancel(&mut self, epoch: u32) {
        self.epoch = self.epoch.saturating_add(1).max(epoch);
        self.emit_cancel(LinkId::Inference, 0);
        self.emit_cancel(LinkId::Database, 0);
        self.unbind_live(false);
        self.requests.clear();
        self.head = None;
        self.in_flight = None;
        self.waiting.clear();
        self.pending_spec = None;
        if let Some(draft) = &mut self.draft {
            draft.cancelled = true;
        }
    }

    // ───────────────────────── database / inference / renderer → coordinator ─────────────────────────

    fn on_context(&mut self, frame: FrameRef<'_>, now: f64) {
        let id = frame.header.context;
        if id != self.context && self.context != 0 {
            // New data: everything in flight answers a question about the old dataset.
            if let Some(i) = self.in_flight.and_then(|id| self.find(id)) {
                self.cancel_translation(i);
            }
            self.unbind_live(true);
            self.waiting.clear();
            self.pending_spec = None;
        }
        self.context = id;
        self.context_payload.clear();
        self.context_payload.extend_from_slice(frame.payload);
        self.forward_context();
        self.pump(now);
    }

    fn forward_context(&mut self) {
        if self.context != 0 {
            let header = self.header(Kind::Context, 0, 0, self.context);
            let payload = self.context_payload.clone();
            self.emit(LinkId::Inference, header, Vec::new(), payload);
        }
    }

    fn on_inference_ready(&mut self, now: f64) {
        // A (re)connected inference node has lost whatever was in flight.
        if let Some(i) = self.in_flight.and_then(|id| self.find(id)) {
            if self.requests[i].phase == Phase::Translating {
                self.requests[i].phase = Phase::Cancelled;
                self.in_flight = None;
            }
        }
        self.forward_context();
        self.pump(now);
    }

    fn on_error(&mut self, link: LinkId, frame: FrameRef<'_>, now: f64) {
        if frame.header.request == 0 {
            self.outbox.push((LinkId::Ui, frame.to_owned()));
            return;
        }
        let Some(i) = self.admit(&frame.header) else { return };
        let id = self.requests[i].id;
        match link {
            LinkId::Inference => {
                if self.requests[i].phase != Phase::Translating {
                    self.stats.dropped_request += 1;
                    return;
                }
                self.requests[i].phase = Phase::Failed;
                if self.in_flight == Some(id) {
                    self.in_flight = None;
                }
                self.outbox.push((LinkId::Ui, frame.to_owned()));
                self.pump(now);
            }
            _ => {
                let r = &mut self.requests[i];
                if r.exec == Exec::Cancelled {
                    self.stats.dropped_request += 1;
                    return;
                }
                r.exec = Exec::Failed;
                self.outbox.push((LinkId::Ui, frame.to_owned()));
                if self.live_bound == Some(id) {
                    self.fall_back(i);
                }
            }
        }
    }

    /// The live slot's request failed. If the slot still shows a complete older result,
    /// rebind to it (the renderer kept its image); otherwise unbind.
    fn fall_back(&mut self, failed: usize) {
        let slot = self.requests[failed].slot.take().unwrap();
        let fallback = self.live_drawn.filter(|&p| p != self.requests[failed].id).and_then(|p| self.find(p)).filter(|&p| {
            let r = &self.requests[p];
            r.exec == Exec::Done && r.context == self.context
        });
        match fallback {
            Some(p) => {
                let id = self.requests[p].id;
                self.requests[p].slot = Some(slot);
                self.live_bound = Some(id);
                self.emit_bind(LinkId::Renderer, p, slot);
                self.emit_bind(LinkId::Ui, p, slot);
            }
            None => {
                let (id, revision) = (self.requests[failed].id, self.requests[failed].revision);
                self.live_bound = None;
                self.live_drawn = None;
                self.emit_slot(LinkId::Renderer, Kind::Unbind, id, revision, slot);
                self.emit_slot(LinkId::Ui, Kind::Unbind, id, revision, slot);
            }
        }
    }

    fn on_sql_delta(&mut self, frame: FrameRef<'_>, now: f64) {
        let Some(i) = self.admit(&frame.header) else { return };
        let r = &mut self.requests[i];
        if r.phase != Phase::Translating {
            self.stats.dropped_request += 1;
            return;
        }
        for stamp in frame.stamps() {
            add_stamp(&mut r.ledger, stamp);
        }
        add_stamp(&mut r.ledger, coord(stage::SQL_FIRST_DELTA, now));
    }

    fn on_sql(&mut self, frame: FrameRef<'_>, now: f64) {
        let Some(i) = self.admit(&frame.header) else { return };
        let r = &mut self.requests[i];
        if r.phase != Phase::Translating {
            self.stats.dropped_request += 1;
            return;
        }
        for stamp in frame.stamps() {
            add_stamp(&mut r.ledger, stamp);
        }
        r.sql.clear();
        r.sql.extend_from_slice(frame.payload);
        r.cached = frame.header.has(flags::CACHED);
        if self.config.translation_cache && !r.sql.is_empty() {
            self.cache.put(r.context, &r.text, &r.sql);
        }
        let id = r.id;
        self.release(id, now);
    }

    fn on_database(&mut self, frame: FrameRef<'_>) {
        let Some(i) = self.admit(&frame.header) else { return };
        let r = &mut self.requests[i];
        if matches!(r.exec, Exec::Cancelled | Exec::Idle) {
            self.stats.dropped_request += 1;
            return;
        }
        for stamp in frame.stamps() {
            add_stamp(&mut r.ledger, stamp);
        }
        match frame.header.kind {
            Kind::ResultSchema => {
                if let (Some(slot), false) = (r.slot, r.result_sent) {
                    r.result_sent = true;
                    let header = Header { kind: Kind::Result, flags: 0, epoch: self.epoch, request: r.id, revision: r.revision, context: r.context };
                    let payload = json::result_payload(slot, &r.sql, r.cached, json::requested_view(&r.text, &r.sql));
                    self.emit(LinkId::Ui, header, Vec::new(), payload);
                }
            }
            Kind::Done => {
                if r.exec == Exec::Running {
                    r.exec = Exec::Done;
                }
                if r.slot.is_some() {
                    self.emit_timing(i);
                }
            }
            _ => {}
        }
    }

    fn on_drawn(&mut self, frame: FrameRef<'_>) -> Result<(), InputError> {
        if frame.payload.len() < 4 {
            return Err(InputError::InvalidPayload);
        }
        let Some(i) = self.admit(&frame.header) else { return Ok(()) };
        let slot = u32::from_le_bytes(frame.payload[..4].try_into().unwrap());
        let r = &mut self.requests[i];
        if r.slot != Some(slot) {
            self.stats.dropped_request += 1;
            return Ok(());
        }
        for stamp in frame.stamps() {
            add_stamp(&mut r.ledger, stamp);
        }
        r.drawn = true;
        if self.live_bound == Some(r.id) {
            self.live_drawn = Some(r.id);
        }
        self.emit_timing(i);
        Ok(())
    }

    // ───────────────────────── translation ─────────────────────────

    /// Decide whether the newest draft needs a translation, and start it if allowed.
    fn pump(&mut self, now: f64) {
        let Some(d) = &self.draft else { return };
        if d.composing || d.cancelled || d.context == 0 || d.context != self.context {
            return;
        }
        if d.committed {
            if d.text.trim().is_empty() {
                return;
            }
        } else if !self.config.live || self.is_short(&d.text) {
            return;
        }
        let (revision, committed) = (d.revision, d.committed);
        if let Some(h) = self.head.and_then(|id| self.find(id)) {
            let r = &self.requests[h];
            let covers = r.revision >= revision;
            let same_text = r.context == self.context && *r.text == *d.text;
            if r.usable() && (covers || same_text) {
                if !covers {
                    self.adopt(h, revision);
                }
                if committed && !self.requests[h].committed {
                    self.promote(h, now);
                }
                return;
            }
            // Never retry a revision whose translation failed, unless Enter asks for it.
            let failed = matches!(r.phase, Phase::Failed) || r.exec == Exec::Failed;
            if failed && covers && !(committed && !r.committed) {
                return;
            }
        }
        // The live slot already shows exactly this text (typed back after a detour).
        if let Some(b) = self.live_bound.and_then(|id| self.find(id)) {
            let r = &self.requests[b];
            if r.usable() && r.context == self.context && *r.text == *self.draft.as_ref().unwrap().text {
                if let Some(f) = self.in_flight.and_then(|id| self.find(id)) {
                    // Its answer could only be older than what is shown.
                    if self.config.policy == Policy::Restart && !self.requests[f].committed {
                        self.cancel_translation(f);
                    }
                }
                self.head = Some(self.requests[b].id);
                if self.requests[b].revision < revision {
                    self.adopt(b, revision);
                }
                if committed && !self.requests[b].committed {
                    self.promote(b, now);
                }
                return;
            }
        }
        if let Some(f) = self.in_flight.and_then(|id| self.find(id)) {
            if self.requests[f].committed {
                return; // Committed work finishes; the newest draft follows it.
            }
            if !committed && self.config.policy == Policy::Latest {
                return;
            }
            self.cancel_translation(f);
        }
        self.start(now);
    }

    /// The head request already translates exactly this text: let it serve `revision`.
    fn adopt(&mut self, i: usize, revision: u32) {
        self.stats.text_adoptions += 1;
        let r = &mut self.requests[i];
        r.revision = revision;
        let (id, slot) = (r.id, r.slot);
        if let (Some(slot), true) = (slot, self.live_bound == Some(id)) {
            self.emit_slot(LinkId::Ui, Kind::Bind, id, revision, slot);
        }
    }

    /// Enter on text the head request already covers.
    fn promote(&mut self, i: usize, now: f64) {
        self.requests[i].committed = true;
        let id = self.requests[i].id;
        if self.requests[i].phase != Phase::Translated {
            return; // shown and kept when its SQL arrives
        }
        if self.live_bound == Some(id) {
            self.keep(i);
        } else if self.requests[i].slot.is_none() {
            if self.pending_spec == Some(id) {
                self.pending_spec = None;
            }
            self.show(i, now);
        }
    }

    fn start(&mut self, now: f64) {
        let d = self.draft.as_ref().unwrap();
        let id = self.next_request;
        self.next_request = self.next_request.checked_add(1).expect("request ids exhausted");
        let mut request = Request {
            id,
            context: d.context,
            revision: d.revision,
            text: d.text.as_str().into(),
            committed: d.committed,
            phase: Phase::Translating,
            release_at: 0.0,
            sql: Vec::new(),
            cached: false,
            exec: Exec::Idle,
            slot: None,
            result_sent: false,
            drawn: false,
            ledger: d.stamps.clone(),
        };
        let hit = if self.config.translation_cache { self.cache.get(d.context, &d.text) } else { None };
        self.head = Some(id);
        self.in_flight = Some(id);
        if let Some(sql) = hit {
            self.stats.cache_hits += 1;
            request.sql.extend_from_slice(sql);
            request.cached = true;
            request.ledger.push(coord(stage::CACHE_HIT, now));
            let dial = self.config.latency_dial_ms.filter(|&ms| ms > 0.0);
            if let Some(ms) = dial {
                request.phase = Phase::Delayed;
                request.release_at = now + ms;
            }
            self.requests.push(request);
            if dial.is_none() {
                self.release(id, now);
            }
        } else {
            self.stats.infer_sent += 1;
            request.ledger.push(coord(stage::INFER_SENT, now));
            let header = Header { kind: Kind::Infer, flags: 0, epoch: self.epoch, request: id, revision: request.revision, context: request.context };
            let stamps = request.ledger.clone();
            let payload = request.text.as_bytes().to_vec();
            self.requests.push(request);
            self.emit(LinkId::Inference, header, stamps, payload);
        }
    }

    fn cancel_translation(&mut self, i: usize) {
        let r = &mut self.requests[i];
        let (id, phase) = (r.id, r.phase);
        r.phase = Phase::Cancelled;
        if self.in_flight == Some(id) {
            self.in_flight = None;
        }
        if phase == Phase::Translating {
            self.emit_cancel(LinkId::Inference, id);
        }
    }

    /// Cancel speculative (uncommitted) translation and pending speculative display.
    fn cancel_speculative(&mut self) {
        if let Some(f) = self.in_flight.and_then(|id| self.find(id)) {
            if !self.requests[f].committed {
                self.cancel_translation(f);
            }
        }
        self.pending_spec = None;
    }

    /// The translation finished (SQL arrived, or a cache hit was released).
    fn release(&mut self, id: u32, now: f64) {
        let Some(i) = self.find(id) else { return };
        let r = &mut self.requests[i];
        r.phase = Phase::Translated;
        add_stamp(&mut r.ledger, coord(stage::SQL_RECEIVED, now));
        if self.in_flight == Some(id) {
            self.in_flight = None;
        }
        // Start the next translation before EXEC: the in-process database may block the
        // worker, and inference is the longer pole.
        self.pump(now);
        let Some(i) = self.find(id) else { return };
        let r = &self.requests[i];
        if r.phase != Phase::Translated || r.context != self.context || r.slot.is_some() {
            return;
        }
        // Speculative results are shown only if nothing newer is shown (or waiting to be).
        if r.committed || self.config.speculate && self.newer_than_shown(r.revision) {
            self.show(i, now);
        }
    }

    fn newer_than_shown(&self, revision: u32) -> bool {
        let shown = self.live_bound.or(self.pending_spec).and_then(|id| self.find(id));
        shown.is_none_or(|s| revision > self.requests[s].revision)
    }

    // ───────────────────────── slots ─────────────────────────

    /// Put request `i` (translated) into the live slot: dedup, or BIND + EXEC (+ KEEP).
    fn show(&mut self, i: usize, now: f64) {
        let id = self.requests[i].id;
        let Some(&slot) = self.pool.front() else {
            if self.requests[i].committed {
                self.waiting.push_back(id);
            } else {
                self.pending_spec = Some(id);
            }
            return;
        };
        if let Some(b) = self.live_bound.filter(|&b| b != id).and_then(|b| self.find(b)) {
            let (bound, new) = (&self.requests[b], &self.requests[i]);
            if bound.usable() && bound.context == new.context && bound.sql == new.sql {
                self.dedup(b, i);
                return;
            }
            self.supersede(b);
        }
        let r = &mut self.requests[i];
        r.slot = Some(slot);
        r.exec = Exec::Running;
        add_stamp(&mut r.ledger, coord(stage::EXEC_SENT, now));
        let (revision, context, committed) = (r.revision, r.context, r.committed);
        self.live_bound = Some(id);
        self.emit_bind(LinkId::Renderer, i, slot);
        self.emit_bind(LinkId::Ui, i, slot);
        if committed {
            self.keep(i);
        }
        // EXEC last: an in-process database may run the query synchronously.
        self.stats.exec_sent += 1;
        let r = &self.requests[i];
        let mut header = self.header(Kind::Exec, id, revision, context);
        if !committed {
            header.flags = flags::SPECULATIVE;
        }
        let payload = r.sql.clone();
        self.emit(LinkId::Database, header, vec![coord(stage::EXEC_SENT, now)], payload);
    }

    /// Byte-identical SQL to the live slot's request: rebind the revision, skip EXEC.
    fn dedup(&mut self, bound: usize, new: usize) {
        self.stats.sql_dedups += 1;
        let (new_id, revision, committed) = (self.requests[new].id, self.requests[new].revision, self.requests[new].committed);
        let b = &mut self.requests[bound];
        b.revision = b.revision.max(revision);
        b.committed |= committed;
        let (bound_id, bound_revision, slot) = (b.id, b.revision, b.slot.unwrap());
        if self.head == Some(new_id) {
            self.head = Some(bound_id);
        }
        // The new request's ledger ends at SQL_RECEIVED: its answer was already on screen.
        self.emit_timing(new);
        self.requests[new].phase = Phase::Cancelled;
        self.emit_slot(LinkId::Ui, Kind::Bind, bound_id, bound_revision, slot);
        if committed {
            self.keep(bound);
        }
    }

    fn supersede(&mut self, i: usize) {
        let r = &mut self.requests[i];
        r.slot = None;
        if r.exec == Exec::Running {
            r.exec = Exec::Cancelled;
            let id = r.id;
            self.emit_cancel(LinkId::Database, id);
        }
    }

    /// Committed result keeps the live slot; the next pool slot becomes live.
    fn keep(&mut self, i: usize) {
        let slot = self.pool.pop_front().expect("keep needs the live slot");
        let (id, revision) = (self.requests[i].id, self.requests[i].revision);
        self.live_bound = None;
        self.live_drawn = None;
        self.emit_slot(LinkId::Ui, Kind::Keep, id, revision, slot);
    }

    fn unbind_live(&mut self, cancel_exec: bool) {
        self.pending_spec = None;
        let Some(i) = self.live_bound.take().and_then(|id| self.find(id)) else {
            self.live_drawn = None;
            return;
        };
        self.live_drawn = None;
        let r = &mut self.requests[i];
        let (id, revision, slot) = (r.id, r.revision, r.slot.take().unwrap());
        if r.exec == Exec::Running {
            r.exec = Exec::Cancelled;
            if cancel_exec {
                self.emit_cancel(LinkId::Database, id);
            }
        }
        self.emit_slot(LinkId::Renderer, Kind::Unbind, id, revision, slot);
        self.emit_slot(LinkId::Ui, Kind::Unbind, id, revision, slot);
    }

    /// New slots arrived: show queued commits in order, then the newest speculative result.
    fn fill_slots(&mut self, now: f64) {
        while !self.pool.is_empty() {
            let Some(id) = self.waiting.pop_front() else { break };
            if let Some(i) = self.find(id) {
                if self.requests[i].phase == Phase::Translated && self.requests[i].slot.is_none() {
                    self.show(i, now);
                }
            }
        }
        if !self.pool.is_empty() && self.live_bound.is_none() {
            if let Some(i) = self.pending_spec.take().and_then(|id| self.find(id)) {
                self.show(i, now);
            }
        }
    }

    /// Forget requests nothing can refer to any more; keep at most [`REQUEST_CAPACITY`].
    fn gc(&mut self) {
        let pinned = [self.head, self.in_flight, self.live_bound, self.live_drawn, self.pending_spec];
        let waiting = &self.waiting;
        let hard = |r: &Request| pinned.contains(&Some(r.id)) || waiting.contains(&r.id);
        // A request in a kept slot stays until it has both finished and drawn.
        let soft = |r: &Request| r.slot.is_some() && !(r.drawn && matches!(r.exec, Exec::Done | Exec::Failed | Exec::Cancelled));
        self.requests.retain(|r| hard(r) || soft(r));
        while self.requests.len() > REQUEST_CAPACITY {
            match self.requests.iter().position(|r| !hard(r)) {
                Some(i) => {
                    self.requests.remove(i);
                }
                None => break,
            }
        }
    }
}
