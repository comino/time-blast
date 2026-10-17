//! Slots, binding and fencing, result lifecycle, frame building and events.
//!
//! A slot shows at most one result (`shown`) and accumulates at most one newer bound result
//! (`pending`). The pending result replaces the shown one in the same frame that draws its
//! first point, so the canvas never flashes empty between results. Frames are built only for
//! dirty slots; `frame(true)` builds only slots with a first draw waiting (the synchronous
//! first-draw path), everything else is coalesced into one frame per animation frame.

use crate::axes::{layout, AxesOut};
use crate::gpu::{as_bytes, json_str, op, Gpu, GpuVec, PassRecorder, PipelineTable, Pool, Uniform, KIND_UNIFORM, KIND_VERTEX};
use crate::hit::{Query, Scales};
use crate::schema::{infer_roles, ColumnInfo, View};
use crate::store::{RawColumn, Store};
use crate::view::{available_views, choose_view, family_for, pipeline_table, DrawFrame, Family, REFINE};

/// Event kinds (wire values for the shim).
pub mod ev {
    /// [slot, request, chosen view, json] Views available for the bound result.
    pub const VIEWS: u32 = 1;
    /// [slot, request, 0, json] Axis ticks/plot/legend changed.
    pub const AXES: u32 = 2;
    /// [slot, request, points, -] First draw of `request` is in this frame's commands.
    pub const FIRST_DRAW: u32 = 3;
    /// [slot, request, points, -] Steady chart: `request` proved identical to the result on
    /// screen, which now stands for it. Nothing was redrawn; the image is already presented.
    pub const STEADY: u32 = 4;
}
pub const EVENT_WORDS: usize = 6;

/// `batch` result flags.
pub const ACCEPTED: u32 = 1;
/// Buffers created per slot at attach (series vertex buffers + grid).
pub const PREWARM_VERTEX_BUFFERS: usize = 8;
pub const PREWARM_VERTEX_BYTES: u32 = 64 << 10;
pub const URGENT: u32 = 2;
/// `batch`/`done` result flag: the request was adopted by the image on screen (an `ev::STEADY`
/// event is queued; no frame is needed).
pub const STEADY: u32 = 4;
/// AXES payload for a slot that shows no chart.
pub const NO_AXES: &str = "{\"x\":[],\"y\":[],\"plot\":{\"left\":0,\"top\":0,\"width\":0,\"height\":0},\"legend\":[]}";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Binding {
    pub request: u32,
    pub revision: u32,
    pub epoch: u32,
}

pub struct ResultState {
    pub request: u32,
    pub store: Store,
    pub available: Vec<View>,
    pub view: View,
    pub family: Option<Box<dyn Family>>,
    /// Rows already ingested by `family`.
    pub consumed: usize,
    pub done: bool,
    /// Steady charts: this pending result has so far been identical to the shown one, so it is
    /// neither ingested into its family nor drawn; it either proves identical at DONE (and is
    /// adopted without a redraw) or diverges (and catches up and draws as usual).
    pub hold: bool,
}

impl ResultState {
    fn ready(&self) -> bool {
        if self.done {
            return true;
        }
        match &self.family {
            Some(f) => f.points() > 0,
            None => self.store.rows > 0,
        }
    }
    fn points(&self) -> u32 {
        match &self.family {
            Some(f) => f.points(),
            None => self.store.rows as u32,
        }
    }
    fn release(&mut self, gpu: &mut Gpu) {
        if let Some(f) = &mut self.family {
            f.release(gpu);
        }
    }
    /// Pick the view for `hint` and (re)create the family when its geometry can't draw it.
    /// A new family receives the slot's view params (e.g. a rotation set before this result).
    fn select(&mut self, hint: Option<View>, pipes: &PipelineTable, gpu: &mut Gpu, params: &[(String, f64)]) -> bool {
        let view = choose_view(&self.available, hint);
        let changed = view != self.view;
        self.view = view;
        let keep = self.family.as_ref().map_or(false, |f| f.handles(view));
        if !keep {
            if let Some(f) = &mut self.family {
                f.release(gpu);
            }
            self.family = family_for(view, &self.store.roles).map(|def| (def.create)(&self.store.roles, view, pipes));
            if let Some(f) = &mut self.family {
                for (name, value) in params {
                    f.set_param(name, *value);
                }
            }
            self.consumed = 0;
            self.catch_up();
        }
        changed || !keep
    }
    fn catch_up(&mut self) {
        if let Some(f) = &mut self.family {
            if self.consumed < self.store.rows {
                f.ingest(&self.store, self.consumed, self.store.rows);
            }
        }
        self.consumed = self.store.rows;
    }
    fn views_json(&self) -> String {
        let mut s = String::from("{\"available\":[");
        for (i, v) in self.available.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&json_str(v.name()));
        }
        s.push_str("],\"chosen\":");
        s.push_str(&json_str(self.view.name()));
        s.push_str(",\"columns\":[");
        for (i, c) in self.store.columns.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&format!("{{\"name\":{},\"role\":{}}}", json_str(&c.name), json_str(self.store.roles.per_column[i].name())));
        }
        s.push_str("]}");
        s
    }
}

/// Steady charts: same column count, types and roles (names may differ: alias variants draw
/// the same pixels; names only reach DOM text).
fn same_schema(a: &Store, b: &Store) -> bool {
    a.columns.len() == b.columns.len() && a.columns.iter().zip(&b.columns).all(|(x, y)| x.ty == y.ty) && a.roles == b.roles
}

pub struct Slot {
    pub id: u32,
    pub css: [f32; 2],
    pub dpr: f32,
    pub hint: Option<View>,
    pub bound: Option<Binding>,
    pub pending: Option<ResultState>,
    pub shown: Option<ResultState>,
    pub dirty: bool,
    pub urgent: bool,
    pub clear: bool,
    uniform: GpuVec,
    grid: GpuVec,
    grid_data: Vec<[u32; 5]>,
    pass: PassRecorder,
    axes_json: String,
    pub params: Vec<(String, f64)>,
    pool: Pool,
    /// Scales of the last drawn frame, for hit-testing.
    pub scales: Option<Scales>,
    /// The bound result's views/choice changed outside a call that drains events (a data-aware
    /// choice during BATCH): post VIEWS with the next frame.
    views_dirty: bool,
}

impl Slot {
    fn new(id: u32) -> Slot {
        Slot {
            id,
            css: [0.0; 2],
            dpr: 1.0,
            hint: None,
            bound: None,
            pending: None,
            shown: None,
            dirty: false,
            urgent: false,
            clear: false,
            uniform: GpuVec::default(),
            grid: GpuVec::default(),
            grid_data: Vec::new(),
            pass: PassRecorder::default(),
            axes_json: String::new(),
            params: Vec::new(),
            pool: Pool::default(),
            scales: None,
            views_dirty: false,
        }
    }
    fn result_mut(&mut self, request: u32) -> Option<&mut ResultState> {
        if self.pending.as_ref().map_or(false, |r| r.request == request) {
            return self.pending.as_mut();
        }
        if self.shown.as_ref().map_or(false, |r| r.request == request) {
            return self.shown.as_mut();
        }
        None
    }
    /// The result belonging to the current binding (pending if any, else shown).
    pub fn current(&self) -> Option<&ResultState> {
        let req = self.bound?.request;
        self.pending.as_ref().filter(|r| r.request == req).or(self.shown.as_ref().filter(|r| r.request == req))
    }
}

pub struct Renderer {
    pub slots: Vec<Slot>,
    pub pipes: PipelineTable,
    next_id: u32,
    /// Command words: buffer ops queued between frames, then the frame.
    pub words: Vec<u32>,
    pub events: Vec<u32>,
    pub strings: Vec<u8>,
    pub staging: Vec<u64>,
    pub out: Vec<u8>,
    /// Keep the image when a new result for a slot is identical to the one shown.
    pub steady: bool,
    /// Results adopted by an identical image (diagnostics).
    pub steady_count: u32,
}

impl Default for Renderer {
    fn default() -> Self {
        Renderer::new()
    }
}

impl Renderer {
    pub fn new() -> Renderer {
        Renderer {
            slots: Vec::new(),
            pipes: pipeline_table(),
            next_id: 0,
            words: Vec::new(),
            events: Vec::new(),
            strings: Vec::new(),
            staging: Vec::new(),
            out: Vec::new(),
            steady: true,
            steady_count: 0,
        }
    }

    fn slot_index(&self, slot: u32) -> Option<usize> {
        self.slots.iter().position(|s| s.id == slot)
    }

    fn event(&mut self, kind: u32, slot: u32, request: u32, a: u32, text: &str) {
        let off = self.strings.len() as u32;
        self.strings.extend_from_slice(text.as_bytes());
        self.events.extend_from_slice(&[kind, slot, request, a, off, text.len() as u32]);
    }

    pub fn clear_events(&mut self) {
        self.events.clear();
        self.strings.clear();
    }

    pub fn attach(&mut self, slot: u32, width: f32, height: f32, dpr: f32) {
        let i = match self.slot_index(slot) {
            Some(i) => i,
            None => {
                self.slots.push(Slot::new(slot));
                let s = self.slots.last_mut().unwrap();
                // Pre-warm buffers off the hot path so the first draw creates no GPU objects.
                let mut gpu = Gpu { words: &mut self.words, next_id: &mut self.next_id, pool: &mut s.pool };
                gpu.words.extend_from_slice(&[op::CTX, slot]);
                let mut warm = Vec::new();
                for _ in 0..PREWARM_VERTEX_BUFFERS {
                    warm.push((gpu.buffer(KIND_VERTEX, PREWARM_VERTEX_BYTES), KIND_VERTEX));
                }
                warm.push((gpu.buffer(KIND_UNIFORM, 4096), KIND_UNIFORM));
                for ((id, capacity), kind) in warm {
                    gpu.recycle(id, capacity, kind);
                }
                self.slots.len() - 1
            }
        };
        self.resize_at(i, width, height, dpr);
    }

    pub fn resize(&mut self, slot: u32, width: f32, height: f32, dpr: f32) {
        if let Some(i) = self.slot_index(slot) {
            self.resize_at(i, width, height, dpr);
        }
    }

    fn resize_at(&mut self, i: usize, width: f32, height: f32, dpr: f32) {
        let s = &mut self.slots[i];
        s.css = [width.max(0.0), height.max(0.0)];
        s.dpr = if dpr > 0.0 { dpr } else { 1.0 };
        // A resized canvas loses its pixels: redraw whatever it shows.
        s.dirty = true;
        s.clear = s.shown.is_none();
        s.axes_json.clear();
    }

    pub fn detach(&mut self, slot: u32) {
        if let Some(i) = self.slot_index(slot) {
            let mut s = self.slots.remove(i);
            let mut pool = std::mem::take(&mut s.pool);
            let mut gpu = Gpu { words: &mut self.words, next_id: &mut self.next_id, pool: &mut pool };
            for r in [s.pending.as_mut(), s.shown.as_mut()].into_iter().flatten() {
                r.release(&mut gpu);
            }
            s.uniform.release(&mut gpu);
            s.grid.release(&mut gpu);
            pool.drain(&mut self.words);
        }
    }

    pub fn set_view(&mut self, slot: u32, hint: Option<View>) {
        let Some(i) = self.slot_index(slot) else { return };
        let s = &mut self.slots[i];
        s.hint = hint;
        let mut gpu = Gpu { words: &mut self.words, next_id: &mut self.next_id, pool: &mut s.pool };
        let mut changed = false;
        if let Some(p) = s.pending.as_mut().filter(|p| p.hold) {
            // A view change redraws anyway: stop holding and draw the new result.
            p.hold = false;
            p.catch_up();
            changed = true;
        }
        for r in [s.pending.as_mut(), s.shown.as_mut()].into_iter().flatten() {
            changed |= r.select(hint, &self.pipes, &mut gpu, &s.params);
        }
        if changed {
            s.dirty = true;
            s.axes_json.clear();
            let info = s.current().map(|r| (r.request, r.view as u32, r.views_json()));
            if let Some((req, view, json)) = info {
                self.event(ev::VIEWS, slot, req, view, &json);
            }
        }
    }

    pub fn set_param(&mut self, slot: u32, name: &str, value: f64) {
        let Some(i) = self.slot_index(slot) else { return };
        let s = &mut self.slots[i];
        match s.params.iter_mut().find(|(n, _)| n == name) {
            Some(p) => p.1 = value,
            None => s.params.push((name.to_string(), value)),
        }
        let mut redraw = false;
        for r in [s.pending.as_mut(), s.shown.as_mut()].into_iter().flatten() {
            if let Some(f) = &mut r.family {
                redraw |= f.set_param(name, value);
            }
        }
        if redraw {
            s.dirty = true;
        }
    }

    pub fn reset_params(&mut self, slot: u32) {
        let Some(i) = self.slot_index(slot) else { return };
        let s = &mut self.slots[i];
        s.params.clear();
        for r in [s.pending.as_mut(), s.shown.as_mut()].into_iter().flatten() {
            if let Some(f) = &mut r.family { if f.reset_params() { s.dirty = true; } }
        }
        s.axes_json.clear();
    }

    /// Invalidate the stream binding while keeping the last completed picture.
    /// Late batches cannot be accepted during a new target generation's inference.
    pub fn invalidate(&mut self, slot: u32) {
        let Some(i) = self.slot_index(slot) else { return };
        let s = &mut self.slots[i];
        s.bound = None;
        if let Some(mut pending) = s.pending.take() {
            let mut gpu = Gpu { words: &mut self.words, next_id: &mut self.next_id, pool: &mut s.pool };
            pending.release(&mut gpu);
        }
    }

    /// BIND: subsequent data for `request` goes to `slot`. The shown image stays until the
    /// new request draws its first point.
    pub fn bind(&mut self, slot: u32, binding: Binding) -> bool {
        let Some(i) = self.slot_index(slot) else { return false };
        let s = &mut self.slots[i];
        let mut gpu = Gpu { words: &mut self.words, next_id: &mut self.next_id, pool: &mut s.pool };
        if let Some(mut p) = s.pending.take() {
            if p.request == binding.request {
                s.pending = Some(p);
            } else {
                p.release(&mut gpu);
            }
        }
        s.bound = Some(binding);
        true
    }

    /// The view a new binding asks for (BIND's view field): becomes the slot's hint for the
    /// results that follow, without re-selecting the result still on screen.
    pub fn bind_view(&mut self, slot: u32, hint: Option<View>) {
        if let Some(i) = self.slot_index(slot) {
            self.slots[i].hint = hint;
        }
    }

    /// UNBIND: forget the request and clear the canvas. Stale unbinds are ignored.
    pub fn unbind(&mut self, slot: u32, request: u32) -> bool {
        let Some(i) = self.slot_index(slot) else { return false };
        let s = &mut self.slots[i];
        if s.bound.map_or(true, |b| b.request != request) {
            return false;
        }
        s.bound = None;
        let mut gpu = Gpu { words: &mut self.words, next_id: &mut self.next_id, pool: &mut s.pool };
        for r in [s.pending.take(), s.shown.take()].into_iter().flatten() {
            let mut r = r;
            r.release(&mut gpu);
        }
        s.clear = true;
        s.dirty = true;
        s.axes_json.clear();
        true
    }

    /// Fencing: the slot currently bound to `request`, if any. Frames created under an epoch
    /// older than the binding's are stale and rejected too.
    pub fn accepts(&self, request: u32, epoch: u32) -> Option<u32> {
        if request == 0 {
            return None;
        }
        self.slots.iter().find(|s| s.bound.map_or(false, |b| b.request == request && epoch >= b.epoch)).map(|s| s.id)
    }

    /// RESULT_SCHEMA: start a result for the bound request. Returns the columns the renderer
    /// needs from every batch, or None if the request is not bound (stale).
    pub fn schema(&mut self, request: u32, epoch: u32, columns: Vec<ColumnInfo>) -> Option<Vec<usize>> {
        let slot = self.accepts(request, epoch)?;
        let i = self.slot_index(slot)?;
        let roles = infer_roles(&columns);
        let needed = roles.needed();
        let available = available_views(&roles);
        let mut result = ResultState {
            request,
            store: Store::new(columns, roles),
            view: View::Table,
            available,
            family: None,
            consumed: 0,
            done: false,
            hold: false,
        };
        let s = &mut self.slots[i];
        let mut gpu = Gpu { words: &mut self.words, next_id: &mut self.next_id, pool: &mut s.pool };
        result.select(s.hint, &self.pipes, &mut gpu, &s.params);
        result.hold = self.steady && s.shown.as_ref().map_or(false, |sh| sh.request != request && sh.done && same_schema(&sh.store, &result.store));
        let json = result.views_json();
        let view = result.view as u32;
        if s.shown.as_ref().map_or(false, |r| r.request == request) {
            // Schema re-sent for the shown request (e.g. re-execution): restart in place.
            let mut old = s.shown.take().unwrap();
            old.release(&mut gpu);
        }
        if let Some(mut p) = s.pending.replace(result) {
            p.release(&mut gpu);
        }
        self.event(ev::VIEWS, slot, request, view, &json);
        Some(needed)
    }

    /// BATCH: append rows for `request`. Returns ACCEPTED (| URGENT when this batch made a
    /// pending result drawable: the caller should build a first-draw frame immediately).
    pub fn batch(&mut self, request: u32, epoch: u32, rows: usize, columns: &[RawColumn]) -> u32 {
        let Some(slot) = self.accepts(request, epoch) else { return 0 };
        let Some(i) = self.slot_index(slot) else { return 0 };
        let s = &mut self.slots[i];
        let is_pending = s.pending.as_ref().map_or(false, |r| r.request == request);
        let hint = s.hint;
        let mut gpu = Gpu { words: &mut self.words, next_id: &mut self.next_id, pool: &mut s.pool };
        let (r, shown) = if is_pending { (s.pending.as_mut(), s.shown.as_ref()) } else { (s.shown.as_mut().filter(|r| r.request == request), None) };
        let Some(r) = r else { return 0 };
        let was_ready = r.ready() && !r.hold;
        r.store.append(rows, columns);
        // Data-aware choice (e.g. many series → heatmap) before the first draw, never after.
        if is_pending && !was_ready && hint.is_none() {
            let mut available = r.available.clone();
            for refine in REFINE {
                refine(&r.store, &mut available);
            }
            if available != r.available {
                r.available = available;
                r.select(None, &self.pipes, &mut gpu, &s.params);
                s.views_dirty = true;
            }
        }
        if r.hold {
            let from = r.store.rows - rows;
            let same = shown.map_or(false, |sh| sh.view == r.view && r.store.same_rows(&sh.store, from, r.store.rows));
            if same {
                // Identical so far: the image on screen already shows these rows. Once it has
                // as many rows as the shown result, the image shows exactly what this result has
                // delivered (as a first draw at this batch would): adopt it now. Later rows, if
                // any, append to the adopted result and draw as usual.
                if shown.map_or(false, |sh| sh.store.rows == r.store.rows) {
                    return self.adopt(i);
                }
                return ACCEPTED;
            }
            r.hold = false;
        }
        r.catch_up();
        let mut flags = ACCEPTED;
        if is_pending && !was_ready && r.ready() {
            s.urgent = true;
            flags |= URGENT;
        }
        s.dirty = true;
        flags
    }

    /// DONE: the result is complete. An empty result still replaces the old image.
    pub fn done(&mut self, request: u32, epoch: u32) -> u32 {
        let Some(slot) = self.accepts(request, epoch) else { return 0 };
        let Some(i) = self.slot_index(slot) else { return 0 };
        let s = &mut self.slots[i];
        let is_pending = s.pending.as_ref().map_or(false, |r| r.request == request);
        let held = is_pending && s.pending.as_ref().map_or(false, |p| p.hold);
        if held {
            let same = match (s.pending.as_ref(), s.shown.as_ref()) {
                (Some(p), Some(sh)) => p.view == sh.view && p.store.rows == sh.store.rows,
                _ => false,
            };
            if same {
                return self.adopt(i);
            }
            let p = s.pending.as_mut().unwrap();
            p.hold = false;
            p.catch_up();
        }
        let Some(r) = s.result_mut(request) else { return 0 };
        // A held result was never drawn: it counts as not ready even after catching up.
        let was_ready = r.ready() && !held;
        r.done = true;
        // The shown result's image already has every row (each batch redrew it): DONE alone
        // changes nothing on screen.
        if is_pending {
            s.dirty = true;
        }
        if is_pending && !was_ready {
            s.urgent = true;
            return ACCEPTED | URGENT;
        }
        ACCEPTED
    }

    /// Available views for the slot's bound result (bitmask by `View as u8`).
    pub fn views(&self, slot: u32) -> u32 {
        self.slot_index(slot)
            .and_then(|i| self.slots[i].current())
            .map_or(0, |r| r.available.iter().fold(0, |m, v| m | v.bit()))
    }

    /// Steady chart: the pending result of slot `i` is identical to the one on screen. The shown
    /// result takes over its identity (request, column names) and keeps its geometry and GPU
    /// buffers; nothing is drawn. Legend text that comes from column names is refreshed and
    /// posted as AXES without a frame.
    fn adopt(&mut self, i: usize) -> u32 {
        let s = &mut self.slots[i];
        let mut gpu = Gpu { words: &mut self.words, next_id: &mut self.next_id, pool: &mut s.pool };
        let mut p = s.pending.take().unwrap();
        p.release(&mut gpu);
        let sh = s.shown.as_mut().unwrap();
        sh.request = p.request;
        sh.available = p.available;
        sh.store = p.store;
        sh.done = p.done;
        let relabeled = sh.family.as_mut().map_or(false, |f| f.relabel(&sh.store));
        let (request, points) = (sh.request, sh.points());
        if let Some(sc) = s.scales.as_mut() {
            sc.request = request;
        }
        let mut axes_event = None;
        if relabeled && sh.view != View::Table && s.css[0] >= 1.0 && s.css[1] >= 1.0 {
            if let Some(f) = sh.family.as_ref() {
                let model = f.axes(sh.view, &sh.store);
                let mut axes = layout(&model, s.css[0], s.css[1]);
                f.place_axes(sh.view, &mut axes);
                f.decorate(sh.view, &sh.store, &mut axes);
                let json = axes.to_json();
                if json != s.axes_json {
                    if let Some(sc) = s.scales.as_mut() {
                        sc.model = model;
                    }
                    s.axes_json = json.clone();
                    axes_event = Some(json);
                }
            }
        }
        let slot = s.id;
        self.steady_count += 1;
        if let Some(json) = axes_event {
            self.event(ev::AXES, slot, request, 0, &json);
        }
        self.event(ev::STEADY, slot, request, points, "");
        ACCEPTED | STEADY
    }

    /// Hit-test the result on screen in `slot`, which must be `request` (the result whose SQL
    /// the caller will transform). Returns the hit JSON (see `hit.rs`), or None.
    pub fn hit(&self, slot: u32, request: u32, query: Query) -> Option<String> {
        let s = &self.slots[self.slot_index(slot)?];
        let shown = s.shown.as_ref().filter(|r| r.request == request && r.done)?;
        let scales = s.scales.as_ref().filter(|sc| sc.request == request && sc.view == shown.view)?;
        crate::hit::hit(&shown.store, shown.family.as_deref(), scales, query)
    }

    pub fn needs_frame(&self) -> bool {
        self.slots.iter().any(|s| s.dirty) || !self.words.is_empty()
    }

    /// Build the command stream for dirty slots (only urgent ones when `urgent_only`).
    /// The returned words stay valid until the next call into the renderer.
    pub fn frame(&mut self, urgent_only: bool) -> &[u32] {
        let pipes = &self.pipes;
        let rule = pipes.index("rule");
        let mut events: Vec<(u32, u32, u32, u32, String)> = Vec::new();
        for s in &mut self.slots {
            if !s.dirty || (urgent_only && !s.urgent) {
                continue;
            }
            if s.css[0] < 1.0 || s.css[1] < 1.0 {
                continue;
            }
            let mut gpu = Gpu { words: &mut self.words, next_id: &mut self.next_id, pool: &mut s.pool };
            let mut first_draw = false;
            if s.pending.as_ref().map_or(false, |r| r.ready() && !r.hold) {
                if let Some(mut old) = s.shown.take() {
                    old.release(&mut gpu);
                }
                s.shown = s.pending.take();
                s.axes_json.clear();
                first_draw = true;
            }
            s.dirty = false;
            s.urgent = false;
            if std::mem::take(&mut s.views_dirty) {
                let req = s.bound.map(|b| b.request);
                if let Some(r) = s.pending.as_ref().filter(|r| Some(r.request) == req).or(s.shown.as_ref().filter(|r| Some(r.request) == req)) {
                    events.push((ev::VIEWS, s.id, r.request, r.view as u32, r.views_json()));
                }
            }
            let canvas = [(s.css[0] * s.dpr).round(), (s.css[1] * s.dpr).round()];
            gpu.words.extend_from_slice(&[op::CTX, s.id]);
            let Some(r) = s.shown.as_mut() else {
                if s.clear {
                    gpu.words.extend_from_slice(&[op::PASS, s.id, 0, 0, 0, 0, 0, op::END]);
                    s.clear = false;
                }
                continue;
            };
            s.clear = false;
            s.pass.reset();
            if let (Some(f), true) = (r.family.as_mut(), r.view != View::Table) {
                f.upload(r.view, &mut gpu);
                let model = f.axes(r.view, &r.store);
                let mut axes: AxesOut = layout(&model, s.css[0], s.css[1]);
                let grid = f.place_axes(r.view, &mut axes);
                f.decorate(r.view, &r.store, &mut axes);
                let json = axes.to_json();
                if s.scales.as_ref().map_or(true, |sc| sc.request != r.request || sc.view != r.view) || json != s.axes_json {
                    s.scales = Some(Scales { request: r.request, view: r.view, model: model.clone(), plot: axes.plot });
                }
                if json != s.axes_json || (s.grid.id == 0 && grid) {
                    axes.grid(s.dpr, &mut s.grid_data);
                    if !grid {
                        s.grid_data.clear();
                    }
                    s.grid.sync(&mut gpu, as_bytes(&s.grid_data), KIND_VERTEX, true);
                    events.push((ev::AXES, s.id, r.request, 0, json.clone()));
                    s.axes_json = json;
                }
                let plot = [axes.plot.left * s.dpr, axes.plot.top * s.dpr, axes.plot.width * s.dpr, axes.plot.height * s.dpr];
                if !s.grid_data.is_empty() {
                    s.pass.pipeline(rule);
                    s.pass.vertex_buffer(0, s.grid.id, 0);
                    s.pass.uniform(&Uniform { canvas: [canvas[0], canvas[1], s.dpr, 0.0], ..Default::default() });
                    s.pass.draw(4, s.grid_data.len() as u32);
                }
                // Clip marks to the plot, with room for line width and markers at the edges.
                let m = 5.0 * s.dpr;
                let x0 = (plot[0] - m).max(0.0).floor();
                let y0 = (plot[1] - m).max(0.0).floor();
                let x1 = (plot[0] + plot[2] + m).min(canvas[0]).ceil();
                let y1 = (plot[1] + plot[3] + m).min(canvas[1]).ceil();
                s.pass.scissor(x0 as u32, y0 as u32, (x1 - x0).max(0.0) as u32, (y1 - y0).max(0.0) as u32);
                f.draw(r.view, &mut DrawFrame { pass: &mut s.pass, plot, canvas, dpr: s.dpr, axes: &axes });
                if f.wants_frame() {
                    s.dirty = true;
                }
            } else if s.axes_json != NO_AXES {
                // No chart (table view): clear the DOM labels of the previous view.
                events.push((ev::AXES, s.id, r.request, 0, NO_AXES.to_string()));
                s.axes_json = NO_AXES.to_string();
            }
            s.uniform.sync(&mut gpu, &s.pass.uniforms, KIND_UNIFORM, true);
            gpu.words.extend_from_slice(&[op::PASS, s.id, s.uniform.id, 0, 0, 0, 0]);
            gpu.words.extend_from_slice(&s.pass.words);
            gpu.words.push(op::END);
            if first_draw {
                events.push((ev::FIRST_DRAW, s.id, r.request, r.points(), String::new()));
            }
        }
        for (kind, slot, request, a, text) in events {
            self.event(kind, slot, request, a, &text);
        }
        &self.words
    }

    /// Forget the last frame's words (call after the shim replayed them).
    pub fn frame_done(&mut self) {
        self.words.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{ColumnType, TypeCode};
    use crate::store::RawColumn;

    fn cols() -> Vec<ColumnInfo> {
        vec![
            ColumnInfo { name: "ts".into(), ty: ColumnType { code: TypeCode::Timestamp, param: 1 } },
            ColumnInfo { name: "v".into(), ty: ColumnType { code: TypeCode::F64, param: 0 } },
        ]
    }

    struct Batch {
        ts: Vec<u8>,
        v: Vec<u8>,
        rows: usize,
    }
    fn batch(points: &[(i64, f64)]) -> Batch {
        Batch {
            ts: points.iter().flat_map(|p| p.0.to_le_bytes()).collect(),
            v: points.iter().flat_map(|p| p.1.to_le_bytes()).collect(),
            rows: points.len(),
        }
    }
    fn raw(b: &Batch) -> Vec<RawColumn<'_>> {
        let c = |index, code, data| RawColumn { index, code, param: 1, rows: b.rows, data, validity: None, bit_offset: 0, offsets: &[], dict: None };
        vec![c(0, TypeCode::Timestamp, &b.ts[..]), c(1, TypeCode::F64, &b.v[..])]
    }
    fn events(r: &Renderer) -> Vec<[u32; 6]> {
        r.events.chunks(EVENT_WORDS).map(|c| c.try_into().unwrap()).collect()
    }
    fn bind(r: &mut Renderer, slot: u32, request: u32) {
        assert!(r.bind(slot, Binding { request, revision: request, epoch: 0 }));
    }
    fn count(words: &[u32], opcode: u32) -> usize {
        let mut i = 0;
        let mut n = 0;
        while i < words.len() {
            if words[i] == opcode {
                n += 1;
            }
            i += 1 + op::operands(words[i]);
        }
        n
    }

    #[test]
    fn fencing_drops_unbound_and_stale_requests() {
        let mut r = Renderer::new();
        r.attach(1, 300.0, 200.0, 1.0);
        assert_eq!(r.accepts(7, 0), None);
        assert_eq!(r.schema(7, 0, cols()), None, "schema before BIND is dropped");
        bind(&mut r, 1, 7);
        assert_eq!(r.accepts(7, 0), Some(1));
        assert_eq!(r.schema(7, 0, cols()), Some(vec![0, 1]));
        let b = batch(&[(1000, 1.0)]);
        assert_eq!(r.batch(7, 0, b.rows, &raw(&b)), ACCEPTED | URGENT);
        bind(&mut r, 1, 8);
        assert_eq!(r.accepts(7, 0), None);
        assert_eq!(r.batch(7, 0, b.rows, &raw(&b)), 0, "stale request batch ignored");
        assert!(!r.unbind(1, 7), "stale unbind ignored");
        assert!(r.slots[0].shown.is_none(), "not drawn yet");
        // Epoch fencing: a binding under epoch 5 rejects frames created under epoch 4.
        assert!(r.bind(1, Binding { request: 9, revision: 9, epoch: 5 }));
        assert_eq!(r.accepts(9, 4), None);
        assert_eq!(r.accepts(9, 5), Some(1));
        assert_eq!(r.schema(9, 4, cols()), None);
    }

    #[test]
    fn first_batch_is_urgent_and_draws_once() {
        let mut r = Renderer::new();
        r.attach(1, 300.0, 200.0, 2.0);
        bind(&mut r, 1, 3);
        r.schema(3, 0, cols());
        assert_eq!(events(&r)[0][0], ev::VIEWS);
        r.clear_events();
        let b = batch(&[(0, 1.0)]);
        assert_eq!(r.batch(3, 0, 1, &raw(&b)), ACCEPTED | URGENT);
        let words = r.frame(true).to_vec();
        r.frame_done();
        assert_eq!(count(&words, op::PASS), 1);
        assert!(count(&words, op::DRAW) >= 2, "grid + marker");
        let e = events(&r);
        assert!(e.iter().any(|e| e[0] == ev::FIRST_DRAW && e[1] == 1 && e[2] == 3 && e[3] == 1));
        assert!(e.iter().any(|e| e[0] == ev::AXES));
        r.clear_events();
        // Later batches are not urgent; they draw in the coalesced frame.
        let b2 = batch(&[(1000, 2.0), (2000, 3.0)]);
        assert_eq!(r.batch(3, 0, 2, &raw(&b2)), ACCEPTED);
        assert!(r.frame(true).is_empty());
        let words = r.frame(false).to_vec();
        r.frame_done();
        assert_eq!(count(&words, op::PASS), 1);
        assert!(!events(&r).iter().any(|e| e[0] == ev::FIRST_DRAW));
        // Nothing dirty: no frame.
        assert!(r.frame(false).is_empty());
    }

    #[test]
    fn keeps_previous_image_until_new_request_draws() {
        let mut r = Renderer::new();
        r.attach(1, 300.0, 200.0, 1.0);
        bind(&mut r, 1, 1);
        r.schema(1, 0, cols());
        let b = batch(&[(0, 1.0), (1000, 2.0)]);
        r.batch(1, 0, 2, &raw(&b));
        r.frame(false);
        r.frame_done();
        bind(&mut r, 1, 2);
        r.schema(2, 0, cols());
        // Resize while the new request has no data: the old result is redrawn, not cleared.
        r.resize(1, 320.0, 200.0, 1.0);
        let words = r.frame(false).to_vec();
        r.frame_done();
        assert_eq!(r.slots[0].shown.as_ref().unwrap().request, 1);
        assert!(count(&words, op::DRAW) >= 2);
        // Schema alone does not replace the image; the first batch does.
        let b2 = batch(&[(5000, 9.0)]);
        assert_eq!(r.batch(2, 0, 1, &raw(&b2)) & URGENT, URGENT);
        r.frame(true);
        r.frame_done();
        assert_eq!(r.slots[0].shown.as_ref().unwrap().request, 2);
        assert!(r.slots[0].pending.is_none());
    }

    #[test]
    fn empty_result_replaces_image_on_done_and_unbind_clears() {
        let mut r = Renderer::new();
        r.attach(1, 300.0, 200.0, 1.0);
        bind(&mut r, 1, 1);
        r.schema(1, 0, cols());
        let b = batch(&[(0, 1.0)]);
        r.batch(1, 0, 1, &raw(&b));
        r.frame(false);
        r.frame_done();
        bind(&mut r, 1, 2);
        r.schema(2, 0, cols());
        r.clear_events();
        assert_eq!(r.done(2, 0), ACCEPTED | URGENT);
        r.frame(true);
        r.frame_done();
        assert!(events(&r).iter().any(|e| e[0] == ev::FIRST_DRAW && e[2] == 2 && e[3] == 0));
        assert!(r.unbind(1, 2));
        let words = r.frame(false).to_vec();
        r.frame_done();
        assert_eq!(count(&words, op::PASS), 1);
        assert_eq!(count(&words, op::DRAW), 0, "cleared");
    }

    #[test]
    fn view_hint_switches_and_reports() {
        let mut r = Renderer::new();
        r.attach(1, 300.0, 200.0, 1.0);
        bind(&mut r, 1, 1);
        r.schema(1, 0, cols());
        let b = batch(&[(0, 1.0), (1000, 2.0)]);
        r.batch(1, 0, 2, &raw(&b));
        assert_eq!(r.views(1), View::Line.bit() | View::Bar.bit() | View::Scatter.bit() | View::Seasons.bit() | View::Table.bit());
        r.clear_events();
        r.set_view(1, Some(View::Bar));
        let e = events(&r);
        assert_eq!(e[0][0], ev::VIEWS);
        assert_eq!(e[0][3], View::Bar as u32);
        let json = std::str::from_utf8(&r.strings[e[0][4] as usize..(e[0][4] + e[0][5]) as usize]).unwrap();
        assert!(json.contains("\"chosen\":\"bar\""));
        assert!(json.contains("{\"name\":\"ts\",\"role\":\"time\"}"));
        r.set_view(1, Some(View::Table));
        let words = r.frame(false).to_vec();
        r.frame_done();
        assert_eq!(count(&words, op::DRAW), 0);
        let e = events(&r);
        let axes = e.iter().rev().find(|e| e[0] == ev::AXES).expect("table view clears the labels");
        assert_eq!(&r.strings[axes[4] as usize..(axes[4] + axes[5]) as usize], NO_AXES.as_bytes());
    }

    #[test]
    fn many_slots_draw_in_one_frame() {
        let mut r = Renderer::new();
        for slot in 1..=12 {
            r.attach(slot, 200.0, 100.0, 1.0);
            bind(&mut r, slot, 100 + slot);
            r.schema(100 + slot, 0, cols());
            let b = batch(&[(0, slot as f64), (1000, 1.0)]);
            r.batch(100 + slot, 0, 2, &raw(&b));
        }
        let words = r.frame(false).to_vec();
        assert_eq!(count(&words, op::PASS), 12);
        assert_eq!(count(&words, op::CTX), 24, "12 pre-warm sections + 12 frames");
    }

    #[test]
    fn first_draw_creates_no_buffers_after_prewarm() {
        let mut r = Renderer::new();
        r.attach(1, 300.0, 200.0, 1.0);
        let warm = r.frame(false).to_vec();
        r.frame_done();
        assert_eq!(count(&warm, op::BUF_CREATE), PREWARM_VERTEX_BUFFERS + 1);
        for request in 1..=3 {
            bind(&mut r, 1, request);
            r.schema(request, 0, cols());
            let b = batch(&[(0, 1.0), (1000, 2.0)]);
            assert_eq!(r.batch(request, 0, 2, &raw(&b)) & URGENT, URGENT);
            let words = r.frame(true).to_vec();
            r.frame_done();
            assert_eq!(count(&words, op::BUF_CREATE), 0, "request {request}");
            assert_eq!(count(&words, op::BUF_DESTROY), 0, "request {request}");
        }
    }

    fn named(value: &str) -> Vec<ColumnInfo> {
        vec![
            ColumnInfo { name: "ts".into(), ty: ColumnType { code: TypeCode::Timestamp, param: 1 } },
            ColumnInfo { name: value.into(), ty: ColumnType { code: TypeCode::F64, param: 0 } },
        ]
    }
    fn show(r: &mut Renderer, request: u32, columns: Vec<ColumnInfo>, points: &[(i64, f64)]) -> u32 {
        bind(r, 1, request);
        r.schema(request, 0, columns);
        let b = batch(points);
        let flags = r.batch(request, 0, b.rows, &raw(&b));
        let done = r.done(request, 0);
        flags | done
    }
    fn string_of(r: &Renderer, e: &[u32; 6]) -> String {
        String::from_utf8(r.strings[e[4] as usize..(e[4] + e[5]) as usize].to_vec()).unwrap()
    }

    #[test]
    fn steady_identical_result_keeps_the_image() {
        let mut r = Renderer::new();
        r.attach(1, 300.0, 200.0, 1.0);
        let pts = [(0, 1.0), (1000, 2.0), (2000, f64::NAN)];
        show(&mut r, 1, cols(), &pts);
        r.frame(false);
        r.frame_done();
        r.clear_events();
        bind(&mut r, 1, 2);
        r.schema(2, 0, cols());
        let b = batch(&pts);
        assert_eq!(r.batch(2, 0, b.rows, &raw(&b)), ACCEPTED | STEADY, "identical batch: adopted, nothing to draw");
        let e = events(&r);
        assert!(e.iter().any(|e| e[0] == ev::STEADY && e[1] == 1 && e[2] == 2 && e[3] == 2), "{e:?}");
        assert!(!e.iter().any(|e| e[0] == ev::AXES), "same names: no text change");
        assert_eq!(r.slots[0].shown.as_ref().unwrap().request, 2);
        assert!(r.slots[0].pending.is_none());
        assert!(r.frame(true).is_empty());
        assert_eq!(r.done(2, 0), ACCEPTED);
        assert!(r.frame(false).is_empty(), "no redraw");
        assert_eq!(r.steady_count, 1);
        // The adopted result is hit-testable as request 2.
        assert!(r.hit(1, 2, Query::Range { x0: 0.0, x1: 300.0 }).is_some());
        assert!(r.hit(1, 1, Query::Range { x0: 0.0, x1: 300.0 }).is_none(), "old request is gone");
    }

    #[test]
    fn steady_alias_variant_refreshes_legend_text_only() {
        let mut r = Renderer::new();
        r.attach(1, 300.0, 200.0, 1.0);
        let pts = [(0, 1.0), (1000, 2.0)];
        show(&mut r, 1, named("speed"), &pts);
        r.frame(false);
        r.frame_done();
        r.clear_events();
        bind(&mut r, 1, 2);
        r.schema(2, 0, named("avg_speed"));
        r.clear_events();
        let b = batch(&pts);
        assert_eq!(r.batch(2, 0, b.rows, &raw(&b)), ACCEPTED | STEADY);
        let e = events(&r);
        r.done(2, 0);
        let axes = e.iter().find(|e| e[0] == ev::AXES).expect("legend text refreshed");
        assert!(string_of(&r, axes).contains("avg_speed"));
        assert!(r.frame(false).is_empty(), "text only, no redraw");
    }

    #[test]
    fn steady_breaks_on_different_or_shorter_data() {
        let mut r = Renderer::new();
        r.attach(1, 300.0, 200.0, 1.0);
        show(&mut r, 1, cols(), &[(0, 1.0), (1000, 2.0)]);
        r.frame(false);
        r.frame_done();
        // Different value: draws as usual.
        bind(&mut r, 1, 2);
        r.schema(2, 0, cols());
        let b = batch(&[(0, 1.0), (1000, 2.5)]);
        assert_eq!(r.batch(2, 0, b.rows, &raw(&b)), ACCEPTED | URGENT);
        r.frame(true);
        r.frame_done();
        assert!(events(&r).iter().any(|e| e[0] == ev::FIRST_DRAW && e[2] == 2));
        assert_eq!(r.done(2, 0), ACCEPTED);
        r.frame(false);
        r.frame_done();
        // A prefix of the shown rows: held until DONE, then drawn.
        bind(&mut r, 1, 3);
        r.schema(3, 0, cols());
        let b = batch(&[(0, 1.0)]);
        assert_eq!(r.batch(3, 0, b.rows, &raw(&b)), ACCEPTED);
        assert_eq!(r.done(3, 0), ACCEPTED | URGENT);
        r.frame(true);
        r.frame_done();
        assert!(events(&r).iter().any(|e| e[0] == ev::FIRST_DRAW && e[2] == 3 && e[3] == 1));
        // Steady off: identical data draws.
        r.steady = false;
        bind(&mut r, 1, 4);
        r.schema(4, 0, cols());
        let b = batch(&[(0, 1.0)]);
        assert_eq!(r.batch(4, 0, b.rows, &raw(&b)), ACCEPTED | URGENT);
    }

    #[test]
    fn hit_maps_pointer_to_rows_series_and_legend() {
        let mut r = Renderer::new();
        r.attach(1, 400.0, 220.0, 1.0);
        let columns = vec![
            ColumnInfo { name: "hour".into(), ty: ColumnType { code: TypeCode::Timestamp, param: 2 } },
            ColumnInfo { name: "vessel".into(), ty: ColumnType { code: TypeCode::Utf8, param: 0 } },
            ColumnInfo { name: "speed".into(), ty: ColumnType { code: TypeCode::F64, param: 0 } },
        ];
        bind(&mut r, 1, 5);
        r.schema(5, 0, columns);
        let h = 3_600_000_000i64;
        let ts: Vec<u8> = [0, 0, h, h, 2 * h, 2 * h].iter().flat_map(|v: &i64| v.to_le_bytes()).collect();
        let v: Vec<u8> = [1.0f64, 10.0, 2.0, 11.0, 3.0, 12.0].iter().flat_map(|v| v.to_le_bytes()).collect();
        let offsets: Vec<u8> = [0i32, 1, 2, 3, 4, 5, 6].iter().flat_map(|v| v.to_le_bytes()).collect();
        let raw = vec![
            RawColumn { index: 0, code: TypeCode::Timestamp, param: 2, rows: 6, data: &ts, validity: None, bit_offset: 0, offsets: &[], dict: None },
            RawColumn { index: 1, code: TypeCode::Utf8, param: 0, rows: 6, data: b"ABABAB", validity: None, bit_offset: 0, offsets: &offsets, dict: None },
            RawColumn { index: 2, code: TypeCode::F64, param: 0, rows: 6, data: &v, validity: None, bit_offset: 0, offsets: &[], dict: None },
        ];
        r.batch(5, 0, 6, &raw);
        assert!(r.hit(1, 5, Query::Point { x: 100.0, y: 100.0 }).is_none(), "not done yet");
        r.done(5, 0);
        r.frame(false);
        r.frame_done();
        let sc = r.slots[0].scales.clone().unwrap();
        // Click exactly on B's middle point.
        let (px, py) = (crate::hit::x_to_px(&sc, h as f64).unwrap() as f32, crate::hit::y_to_px(&sc, 11.0).unwrap() as f32);
        let j = r.hit(1, 5, Query::Point { x: px + 3.0, y: py - 2.0 }).unwrap();
        assert!(j.contains(&format!("\"x\":{{\"column\":0,\"name\":\"hour\",\"type\":\"timestamp\",\"value\":{h}}}")), "{j}");
        assert!(j.contains("\"series\":{\"column\":1,\"name\":\"vessel\",\"type\":\"text\",\"label\":\"B\",\"null\":false}"), "{j}");
        // Far from any point: nothing.
        let empty_y = crate::hit::y_to_px(&sc, 6.5).unwrap() as f32;
        assert!(r.hit(1, 5, Query::Point { x: px, y: empty_y }).is_none());
        // Brush over the first two hours.
        let (a, b) = (crate::hit::x_to_px(&sc, -1000.0).unwrap() as f32, crate::hit::x_to_px(&sc, h as f64 + 1000.0).unwrap() as f32);
        let j = r.hit(1, 5, Query::Range { x0: b, x1: a }).unwrap();
        assert!(j.contains(&format!("\"lo\":0,\"hi\":{h},\"count\":4")), "{j}");
        // Legend entry 1 is series B.
        let j = r.hit(1, 5, Query::Legend { index: 1 }).unwrap();
        assert!(j.contains("\"label\":\"B\""), "{j}");
        assert!(r.hit(1, 5, Query::Legend { index: 7 }).is_none());
        // Bars: a click anywhere in a bar's column picks its x.
        r.set_view(1, Some(View::Bar));
        r.frame(false);
        r.frame_done();
        let sc = r.slots[0].scales.clone().unwrap();
        let px = crate::hit::x_to_px(&sc, 2.0 * h as f64).unwrap() as f32 - 4.0;
        let j = r.hit(1, 5, Query::Point { x: px, y: 150.0 }).unwrap();
        assert!(j.contains(&format!("\"value\":{}", 2 * h)), "{j}");
    }
}
