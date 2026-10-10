//! Slots, binding and fencing, result lifecycle, frame building and events.
//!
//! A slot shows at most one result (`shown`) and accumulates at most one newer bound result
//! (`pending`). The pending result replaces the shown one in the same frame that draws its
//! first point, so the canvas never flashes empty between results. Frames are built only for
//! dirty slots; `frame(true)` builds only slots with a first draw waiting (the synchronous
//! first-draw path), everything else is coalesced into one frame per animation frame.

use crate::axes::{layout, AxesOut};
use crate::gpu::{as_bytes, json_str, op, Gpu, GpuVec, PassRecorder, PipelineTable, Pool, Uniform, KIND_UNIFORM, KIND_VERTEX};
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
}
pub const EVENT_WORDS: usize = 6;

/// `batch` result flags.
pub const ACCEPTED: u32 = 1;
/// Buffers created per slot at attach (series vertex buffers + grid).
pub const PREWARM_VERTEX_BUFFERS: usize = 8;
pub const PREWARM_VERTEX_BYTES: u32 = 64 << 10;
pub const URGENT: u32 = 2;

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
        };
        let s = &mut self.slots[i];
        let mut gpu = Gpu { words: &mut self.words, next_id: &mut self.next_id, pool: &mut s.pool };
        result.select(s.hint, &self.pipes, &mut gpu, &s.params);
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
        let Some(r) = (if is_pending { s.pending.as_mut() } else { s.shown.as_mut().filter(|r| r.request == request) }) else { return 0 };
        let was_ready = r.ready();
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
        let Some(r) = s.result_mut(request) else { return 0 };
        let was_ready = r.ready();
        r.done = true;
        s.dirty = true;
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
            if s.pending.as_ref().map_or(false, |r| r.ready()) {
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
                let json = axes.to_json();
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
        assert_eq!(r.views(1), View::Line.bit() | View::Bar.bit() | View::Scatter.bit() | View::Table.bit());
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
}
