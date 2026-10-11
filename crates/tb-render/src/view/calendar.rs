//! Seasons: the seasonal wheel. Every returned (time, value) bucket becomes an annular cell.
//!
//! - **Angle** = position inside a calendar cycle, 12 o'clock = cycle start, clockwise.
//! - **Radius** = which cycle (one concentric ring per year / ISO week / day, oldest inside).
//! - **Colour** = value on a sequential colormap; the domain lives in uniforms, so streaming
//!   rows that widen it touch no geometry.
//! - **Series** = small multiples: one wheel per series, sharing the colour domain and the
//!   ring range. Ring offsets would give the radius two meanings (cycle and series) at once;
//!   separate wheels keep radius = cycle everywhere and stay directly comparable.
//!
//! The cycle comes from the data's span and bucket size (`choose_cycle`): under 2 days with
//! sub-6 h buckets a 24 h clock, under 60 days with buckets of at most a day a weekly wheel
//! (ISO weeks, Monday 00:00 UTC at the top), else a yearly wheel. It only ever widens as rows
//! stream in, and a change rebuilds the cells from the stored rows (at most twice per result).
//!
//! All calendar math is exact UTC integer arithmetic on i64 µs (`Cycle::locate`); only the
//! final in-cycle fraction becomes a float. Nothing is aggregated or interpolated: dates the
//! result does not contain stay empty (a faint track), so short data never looks like an
//! annual pattern. The caption states the cycle and the span actually covered.

use super::{DrawFrame, Family, FamilyDef};
use crate::axes::{AxesOut, AxisModel, Rect};
use crate::gpu::{Attr, BufferLayout, Format, Gpu, GpuVec, PipelineDesc, PipelineTable, Uniform, KIND_VERTEX};
use crate::scale::{civil_from_days, days_from_civil, format_number, linear_ticks, Domain, US_PER_DAY, US_PER_HOUR};
use crate::schema::{Roles, View, XKind};
use crate::store::{Store, XValues, NULL_TIME};

pub static DEF: FamilyDef = FamilyDef { name: "calendar", applicable, create, pipelines: &[&CELL, &RAMP] };

/// Rank far behind line/bar/scatter (10..12): offered whenever applicable, never automatic.
pub const RANK: u8 = 90;
/// More series than this are not drawn (the caption says how many were left out).
pub const MAX_WHEELS: usize = 12;

fn applicable(roles: &Roles, out: &mut Vec<(View, u8)>) {
    if matches!(roles.x, Some((_, XKind::Time))) && roles.value.is_some() {
        out.push((View::Seasons, RANK));
    }
}

fn create(roles: &Roles, _view: View, pipes: &PipelineTable) -> Box<dyn Family> {
    Box::new(Calendar::new(roles, pipes))
}

// ───────────────────────── calendar math ─────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Cycle {
    Day,
    Week,
    Year,
}

pub const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
pub const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

impl Cycle {
    /// `(cycle index, cycle start µs, cycle length µs)` for instant `t` (µs since epoch, UTC).
    /// Day index = days since epoch; week index counts ISO weeks (Monday start) from the week
    /// of 1970-01-01; year index = the calendar year.
    pub fn locate(self, t: i64) -> (i64, i64, i64) {
        let days = t.div_euclid(US_PER_DAY);
        match self {
            Cycle::Day => (days, days * US_PER_DAY, US_PER_DAY),
            Cycle::Week => {
                // 1970-01-01 was a Thursday: Monday-based week = floor((days + 3) / 7).
                let w = (days + 3).div_euclid(7);
                (w, (w * 7 - 3) * US_PER_DAY, 7 * US_PER_DAY)
            }
            Cycle::Year => {
                let (y, _, _) = civil_from_days(days);
                let (start, end) = year_bounds(y);
                (y, start, end - start)
            }
        }
    }

    /// Start (µs) of cycle `index`.
    pub fn start(self, index: i64) -> i64 {
        match self {
            Cycle::Day => index * US_PER_DAY,
            Cycle::Week => (index * 7 - 3) * US_PER_DAY,
            Cycle::Year => year_bounds(index).0,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Cycle::Day => "24 h clock",
            Cycle::Week => "Weekly wheel",
            Cycle::Year => "Yearly wheel",
        }
    }

    fn ring_unit(self) -> &'static str {
        match self {
            Cycle::Day => "day",
            Cycle::Week => "week",
            Cycle::Year => "year",
        }
    }

    fn top(self) -> &'static str {
        match self {
            Cycle::Day => "00:00",
            Cycle::Week => "Mon 00:00",
            Cycle::Year => "Jan 1",
        }
    }

    /// Ring label for cycle `index`.
    pub fn ring_label(self, index: i64) -> String {
        match self {
            Cycle::Year => index.to_string(),
            _ => {
                let (_, m, d) = civil_from_days(self.start(index).div_euclid(US_PER_DAY));
                format!("{} {}", MONTHS[m as usize - 1], d)
            }
        }
    }

    /// Guide boundaries inside cycle `index` as `(fraction of cycle, label at the middle of
    /// the section that starts there)`: months, weekdays, or every 3 hours.
    pub fn sections(self, index: i64) -> Vec<(f64, f64, &'static str)> {
        const HOURS: [&str; 8] = ["00", "03", "06", "09", "12", "15", "18", "21"];
        match self {
            Cycle::Day => (0..8).map(|h| (h as f64 / 8.0, h as f64 / 8.0, HOURS[h])).collect(),
            Cycle::Week => (0..7).map(|d| (d as f64 / 7.0, (d as f64 + 0.5) / 7.0, WEEKDAYS[d])).collect(),
            Cycle::Year => {
                let (start, end) = year_bounds(index);
                let len = (end - start) as f64;
                (1..=12u32)
                    .map(|m| {
                        let a = days_from_civil(index, m, 1) * US_PER_DAY - start;
                        let b = if m == 12 { end - start } else { days_from_civil(index, m + 1, 1) * US_PER_DAY - start };
                        (a as f64 / len, (a + b) as f64 * 0.5 / len, MONTHS[m as usize - 1])
                    })
                    .collect()
            }
        }
    }
}

/// `[Jan 1 of y, Jan 1 of y + 1)` in µs.
pub fn year_bounds(y: i64) -> (i64, i64) {
    (days_from_civil(y, 1, 1) * US_PER_DAY, days_from_civil(y + 1, 1, 1) * US_PER_DAY)
}

/// The cycle for data spanning `span` µs with buckets `bucket` µs apart (0 = unknown yet).
pub fn choose_cycle(span: i64, bucket: i64) -> Cycle {
    if span < 2 * US_PER_DAY && bucket < 6 * US_PER_HOUR {
        Cycle::Day
    } else if span < 60 * US_PER_DAY && bucket <= US_PER_DAY {
        Cycle::Week
    } else {
        Cycle::Year
    }
}

/// Cache of the current cycle's bounds: consecutive rows almost always share a cycle, so the
/// civil-date conversion runs once per cycle, not once per row.
#[derive(Clone, Copy)]
struct Locator {
    cycle: Cycle,
    index: i64,
    start: i64,
    len: i64,
}

impl Locator {
    fn new(cycle: Cycle) -> Locator {
        Locator { cycle, index: 0, start: 0, len: 0 }
    }
    /// `(cycle index, fraction of the cycle in [0, 1))`.
    #[inline]
    fn at(&mut self, t: i64) -> (i64, f64) {
        let off = t - self.start;
        if self.len == 0 || off < 0 || off >= self.len {
            let (index, start, len) = self.cycle.locate(t);
            *self = Locator { cycle: self.cycle, index, start, len };
        }
        (self.index, (t - self.start) as f64 / self.len as f64)
    }
}

// ───────────────────────── family ─────────────────────────

#[derive(Default)]
struct Wheel {
    /// Instance data: `[fraction of cycle, ring (cycle index − origin), value − value origin]`.
    cells: Vec<[f32; 3]>,
    gpu: GpuVec,
    rewrite: bool,
    /// Last drawable instant of this series in arrival order (bucket estimate).
    last_t: i64,
}

pub struct Calendar {
    cycle: Cycle,
    loc: Locator,
    /// Store series id → wheel index (`u32::MAX` = beyond `MAX_WHEELS`, dropped).
    series_map: Vec<u32>,
    wheels: Vec<Wheel>,
    labels: Vec<String>,
    dropped_series: usize,
    /// Cycle index that ring 0 stands for.
    ring_origin: Option<i64>,
    ring_lo: i64,
    ring_hi: i64,
    value_origin: Option<f64>,
    value: Domain,
    t_lo: i64,
    t_hi: i64,
    /// Smallest positive gap between consecutive instants of one series (0 = unknown).
    bucket: i64,
    points: u32,
    /// Ring tracks then section spokes, rebuilt when the ring range or cycle changes.
    guides: Vec<[f32; 3]>,
    guides_key: (Cycle, i64, i64),
    guides_gpu: GpuVec,
    pipes: [u32; 2],
}

impl Calendar {
    pub fn new(_roles: &Roles, pipes: &PipelineTable) -> Calendar {
        Calendar {
            cycle: Cycle::Day,
            loc: Locator::new(Cycle::Day),
            series_map: Vec::new(),
            wheels: Vec::new(),
            labels: Vec::new(),
            dropped_series: 0,
            ring_origin: None,
            ring_lo: 0,
            ring_hi: -1,
            value_origin: None,
            value: Domain::EMPTY,
            t_lo: i64::MAX,
            t_hi: i64::MIN,
            bucket: 0,
            points: 0,
            guides: Vec::new(),
            guides_key: (Cycle::Day, 0, -1),
            guides_gpu: GpuVec::default(),
            pipes: [pipes.index("calendar.cell"), pipes.index("calendar.ramp")],
        }
    }

    pub fn cycle(&self) -> Cycle {
        self.cycle
    }

    fn wheel_for(&mut self, store: &Store, i: usize) -> Option<usize> {
        let Some(ids) = &store.series else {
            if self.wheels.is_empty() {
                self.wheels.push(Wheel { last_t: NULL_TIME, ..Default::default() });
                self.labels.push(store.roles.value.map(|v| store.columns[v].name.clone()).unwrap_or_default());
            }
            return Some(0);
        };
        let id = ids[i] as usize;
        if self.series_map.len() <= id {
            self.series_map.resize(id + 1, u32::MAX - 1);
        }
        if self.series_map[id] == u32::MAX - 1 {
            if self.wheels.len() < MAX_WHEELS {
                self.series_map[id] = self.wheels.len() as u32;
                self.wheels.push(Wheel { last_t: NULL_TIME, ..Default::default() });
                self.labels.push(store.series_labels.labels.get(id).cloned().unwrap_or_default());
            } else {
                self.series_map[id] = u32::MAX;
                self.dropped_series += 1;
            }
        }
        match self.series_map[id] {
            u32::MAX => None,
            w => Some(w as usize),
        }
    }

    /// Place rows `from..to` (span/bucket statistics are already up to date).
    fn place(&mut self, store: &Store, times: &[i64], values: &[f64], from: usize, to: usize) {
        for i in from..to {
            let (t, v) = (times[i], values[i]);
            if t == NULL_TIME || v.is_nan() {
                continue;
            }
            let Some(w) = self.wheel_for(store, i) else { continue };
            let (index, frac) = self.loc.at(t);
            let origin = *self.ring_origin.get_or_insert(index);
            let vo = *self.value_origin.get_or_insert(v);
            self.ring_lo = if self.points == 0 { index } else { self.ring_lo.min(index) };
            self.ring_hi = if self.points == 0 { index } else { self.ring_hi.max(index) };
            self.value.include(v);
            self.points += 1;
            self.wheels[w].cells.push([frac as f32, (index - origin) as f32, (v - vo) as f32]);
        }
    }

    /// Ring range in instance units (relative to the origin) for uniforms.
    fn ring_range(&self) -> (f32, f32) {
        let origin = self.ring_origin.unwrap_or(0);
        ((self.ring_lo - origin) as f32, (self.ring_hi - self.ring_lo + 1).max(1) as f32)
    }

    /// Bucket width as a fraction of the cycle (0 = unknown: cells get a minimum pixel width).
    fn width_frac(&self) -> f32 {
        if self.bucket <= 0 {
            return 0.0;
        }
        let len = self.cycle.locate(self.t_hi.max(0)).2;
        (self.bucket as f64 / len as f64).min(1.0) as f32
    }

    fn rebuild_guides(&mut self) -> bool {
        let key = (self.cycle, self.ring_lo, self.ring_hi);
        if key == self.guides_key && !self.guides.is_empty() {
            return false;
        }
        self.guides_key = key;
        self.guides.clear();
        let origin = self.ring_origin.unwrap_or(0);
        for index in self.ring_lo..=self.ring_hi {
            self.guides.push([0.0, (index - origin) as f32, 0.0]);
        }
        for (start, _, _) in self.cycle.sections(self.ring_hi) {
            self.guides.push([start as f32, (self.ring_lo - origin) as f32, 0.0]);
        }
        true
    }

    fn caption(&self, narrow: bool) -> String {
        let span = if self.t_hi > self.t_lo { self.t_hi - self.t_lo } else { 0 };
        let covered = if span >= 2 * US_PER_DAY {
            format!("{} d", (span + US_PER_DAY / 2) / US_PER_DAY)
        } else {
            format!("{} h", (span + US_PER_HOUR / 2) / US_PER_HOUR)
        };
        let dropped = if self.dropped_series > 0 { format!(" · +{} series not shown", self.dropped_series) } else { String::new() };
        if narrow {
            format!("{} · UTC · ring = {} · {} of data{}", self.cycle.name(), self.cycle.ring_unit(), covered, dropped)
        } else {
            format!(
                "{} · UTC · {} at top, clockwise · ring = {} · {} of data, empty = not in result{}",
                self.cycle.name(),
                self.cycle.top(),
                self.cycle.ring_unit(),
                covered,
                dropped
            )
        }
    }
}

/// Layout constants in CSS px.
const HEADER: f32 = 20.0;
const MARGIN: f32 = 15.0;
const TITLE: f32 = 13.0;
const INNER: f32 = 0.22;
const RAMP_W: f32 = 72.0;

/// Wheels for `n` series inside `plot` (CSS px): `[cx, cy, outer radius, cell top]`, picking
/// the grid with the largest radius.
pub fn wheel_layout(plot: Rect, n: usize) -> Vec<[f32; 4]> {
    let n = n.max(1);
    let title = if n > 1 { TITLE } else { 0.0 };
    let area_h = (plot.height - HEADER).max(1.0);
    let mut best = (1usize, f32::MIN);
    for cols in 1..=n {
        let rows = (n + cols - 1) / cols;
        let w = plot.width / cols as f32;
        let h = area_h / rows as f32;
        let r = w.min(h - title) * 0.5 - MARGIN;
        if r > best.1 {
            best = (cols, r);
        }
    }
    let cols = best.0;
    let rows = (n + cols - 1) / cols;
    let (w, h) = (plot.width / cols as f32, area_h / rows as f32);
    let r = best.1.max(4.0);
    (0..n)
        .map(|k| {
            let (col, row) = ((k % cols) as f32, (k / cols) as f32);
            let top = plot.top + HEADER + row * h;
            [plot.left + (col + 0.5) * w, top + title + (h - title) * 0.5, r, top]
        })
        .collect()
}

fn ramp_rect(plot: Rect) -> [f32; 4] {
    let x1 = plot.left + plot.width - 40.0;
    [x1 - RAMP_W, plot.top + 3.0, RAMP_W, 6.0]
}

impl Family for Calendar {
    fn handles(&self, view: View) -> bool {
        view == View::Seasons
    }

    fn ingest(&mut self, store: &Store, from: usize, to: usize) {
        let (Some(XValues::Time(times)), Some(values)) = (&store.x, store.value.as_deref()) else { return };
        // Span and bucket over the new rows first, so the cycle is right before placing them.
        for i in from..to {
            let (t, v) = (times[i], values[i]);
            if t == NULL_TIME || v.is_nan() {
                continue;
            }
            self.t_lo = self.t_lo.min(t);
            self.t_hi = self.t_hi.max(t);
            if let Some(w) = self.wheel_for(store, i) {
                let last = std::mem::replace(&mut self.wheels[w].last_t, t);
                let gap = if last == NULL_TIME { 0 } else { (t - last).abs() };
                if gap > 0 && (self.bucket == 0 || gap < self.bucket) {
                    self.bucket = gap;
                }
            }
        }
        let wanted = choose_cycle(self.t_hi.saturating_sub(self.t_lo).max(0), self.bucket).max(self.cycle);
        if wanted != self.cycle {
            // Re-place everything under the wider cycle.
            self.cycle = wanted;
            self.loc = Locator::new(wanted);
            self.ring_origin = None;
            self.points = 0;
            for w in &mut self.wheels {
                w.cells.clear();
                w.rewrite = true;
            }
            self.place(store, times, values, 0, to);
        } else {
            self.place(store, times, values, from, to);
        }
    }

    fn points(&self) -> u32 {
        self.points
    }

    fn upload(&mut self, _view: View, gpu: &mut Gpu) {
        for w in &mut self.wheels {
            let rewrite = std::mem::take(&mut w.rewrite);
            w.gpu.sync(gpu, crate::gpu::as_bytes(&w.cells), KIND_VERTEX, rewrite);
        }
        if self.points > 0 {
            let changed = self.rebuild_guides();
            self.guides_gpu.sync(gpu, crate::gpu::as_bytes(&self.guides), KIND_VERTEX, changed);
        }
    }

    fn axes(&self, _view: View, _store: &Store) -> AxisModel {
        // No cartesian axes: everything is placed by `decorate` around the wheels.
        AxisModel::none()
    }

    fn decorate(&self, _view: View, _store: &Store, axes: &mut AxesOut) {
        let plot = axes.plot;
        let out = &mut axes.labels;
        out.push((plot.left + 2.0, plot.top + 6.0, self.caption(plot.width < 560.0), 0.0));
        if self.points == 0 {
            return;
        }
        let ramp = ramp_rect(plot);
        let (lo, hi) = (self.value.lo, self.value.hi);
        let step = linear_ticks(Domain::new(lo.min(hi), hi.max(lo)), 4).1;
        let mid_y = ramp[1] + ramp[3] * 0.5;
        out.push((ramp[0] - 4.0, mid_y, format_number(lo, step), 1.0));
        out.push((ramp[0] + ramp[2] + 4.0, mid_y, format_number(hi, step), 0.0));
        let wheels = wheel_layout(plot, self.wheels.len());
        let rings = (self.ring_hi - self.ring_lo + 1).max(1);
        let sections = self.cycle.sections(self.ring_hi);
        for (k, &[cx, cy, r, top]) in wheels.iter().enumerate() {
            if wheels.len() > 1 {
                out.push((cx, top + TITLE * 0.5, self.labels[k].clone(), 0.5));
            }
            if r >= 34.0 || k == 0 {
                let stride = if r < 60.0 && sections.len() > 8 { 3 } else { 1 };
                for (_, mid, label) in sections.iter().step_by(stride) {
                    let a = *mid as f32 * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
                    out.push((cx + a.cos() * (r + 8.0), cy + a.sin() * (r + 8.0), label.to_string(), 0.5));
                }
            }
            if k == 0 {
                // Ring labels along the 12 o'clock spoke, thinned to ~11 px apart; newest kept.
                let inner = r * INNER;
                let thick = (r - inner) / rings as f32;
                let every = ((11.0 / thick.max(0.1)).ceil() as i64).max(1);
                for index in (self.ring_lo..=self.ring_hi).rev().step_by(every as usize) {
                    let ring = (index - self.ring_lo) as f32;
                    out.push((cx + 3.0, cy - inner - (ring + 0.46) * thick, self.cycle.ring_label(index), 0.0));
                }
            }
        }
    }

    fn draw(&mut self, _view: View, f: &mut DrawFrame) {
        if self.points == 0 {
            return;
        }
        let [cell, ramp] = self.pipes;
        let dpr = f.dpr;
        let (ring_lo, ring_count) = self.ring_range();
        let vo = self.value_origin.unwrap_or(0.0);
        let (vlo, vhi) = ((self.value.lo - vo) as f32, (self.value.hi - vo) as f32);
        let canvas = [f.canvas[0], f.canvas[1], dpr, 0.0];
        let width = self.width_frac();
        let n_tracks = (self.ring_hi - self.ring_lo + 1).max(0) as u32;
        let n_spokes = self.guides.len() as u32 - n_tracks.min(self.guides.len() as u32);
        for (k, [cx, cy, r, _]) in wheel_layout(f.axes.plot, self.wheels.len()).into_iter().enumerate() {
            let (outer, inner) = (r * dpr, r * INNER * dpr);
            let base = Uniform { domain: [ring_lo, ring_count, vlo, vhi], plot: [cx * dpr, cy * dpr, inner, outer], canvas, ..Default::default() };
            // Faint full-circle track per ring: unobserved dates stay visibly empty.
            f.pass.pipeline(cell);
            f.pass.vertex_buffer(0, self.guides_gpu.id, 0);
            f.pass.uniform(&Uniform { color: [0.07, 0.09, 0.10, 0.16], a: [1.0, 0.0, 0.92, 96.0], b: [1.0, 0.0, 1.0, 0.0], ..base });
            f.pass.draw(2 * 97, n_tracks);
            f.pass.vertex_buffer(0, self.guides_gpu.id, n_tracks * 12);
            f.pass.uniform(&Uniform { color: [0.16, 0.19, 0.21, 0.32], a: [0.0, 0.0, 1.0, 1.0], b: [1.0, 1.0, 1.0, 1.0 * dpr], ..base });
            f.pass.draw(4, n_spokes);
            let w = &self.wheels[k];
            let n = w.cells.len() as u32;
            if n == 0 {
                continue;
            }
            // Segments so each cell's arc deviates < ~1 px from a true annulus sector.
            let arc = width * std::f32::consts::TAU * outer;
            let segments = (arc / 6.0).ceil().clamp(1.0, 64.0);
            let min_px = if width == 0.0 { 3.0 * dpr } else { 1.0 * dpr };
            f.pass.vertex_buffer(0, w.gpu.id, 0);
            f.pass.uniform(&Uniform { a: [width, 0.0, 0.92, segments], b: [0.0, 0.0, 1.0, min_px], ..base });
            f.pass.draw(2 * (segments as u32 + 1), n);
        }
        let [x, y, w, h] = ramp_rect(f.axes.plot);
        f.pass.pipeline(ramp);
        f.pass.uniform(&Uniform { plot: [x * dpr, y * dpr, w * dpr, h * dpr], canvas, ..Default::default() });
        f.pass.draw(4, 1);
    }

    fn release(&mut self, gpu: &mut Gpu) {
        for w in &mut self.wheels {
            w.gpu.release(gpu);
        }
        self.guides_gpu.release(gpu);
    }
}

// ───────────────────────── pipelines ─────────────────────────

/// Sequential colormap (dark blue → teal → green → yellow → orange), lightness increasing,
/// readable on the dark card. Identical stops in WGSL and GLSL.
macro_rules! cmap_wgsl {
    () => {
        r#"
fn cmap(t0: f32) -> vec3f {
  var stops = array<vec3f, 5>(vec3f(0.20, 0.30, 0.62), vec3f(0.16, 0.52, 0.66), vec3f(0.30, 0.71, 0.53), vec3f(0.80, 0.81, 0.35), vec3f(1.00, 0.62, 0.32));
  let t = clamp(t0, 0.0, 1.0) * 4.0;
  let i = min(floor(t), 3.0);
  let k = u32(i);
  return mix(stops[k], stops[k + 1u], t - i);
}
"#
    };
}
macro_rules! cmap_glsl {
    () => {
        r#"
const vec3 STOPS[5] = vec3[5](vec3(0.20, 0.30, 0.62), vec3(0.16, 0.52, 0.66), vec3(0.30, 0.71, 0.53), vec3(0.80, 0.81, 0.35), vec3(1.00, 0.62, 0.32));
vec3 cmap(float t0) {
  float t = clamp(t0, 0.0, 1.0) * 4.0;
  float i = min(floor(t), 3.0);
  int k = int(i);
  return mix(STOPS[k], STOPS[k + 1], t - i);
}
"#
    };
}

/// Annular cells as triangle strips (`2 × (segments + 1)` vertices per instance).
/// Uniform: domain = [ring_lo, ring_count, value_lo, value_hi]; plot = [cx, cy, r_inner,
/// r_outer] px; a = [width (fraction of cycle), band0, band1 (fraction of ring), segments];
/// b = [flat colour?, full radius?, alpha, min width px]; color = flat colour (premultiplied).
pub static CELL: PipelineDesc = PipelineDesc {
    name: "calendar.cell",
    strip: true,
    buffers: &[BufferLayout {
        stride: 12,
        instance: true,
        attrs: &[Attr { location: 0, format: Format::Float32x2, offset: 0 }, Attr { location: 1, format: Format::Float32, offset: 8 }],
    }],
    wgsl: concat!(
        cmap_wgsl!(),
        r#"
struct CellOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) color: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) p: vec2f, @location(1) v: f32) -> CellOut {
  var o: CellOut;
  let count = max(u.domain.y, 1.0);
  let ring = p.y - u.domain.x;
  if (ring < -0.5 || ring > count - 0.5) { o.pos = OUTSIDE; o.color = vec4f(0.0); return o; }
  let thick = (u.plot.w - u.plot.z) / count;
  var r0 = u.plot.z + (ring + u.a.y) * thick;
  var r1 = u.plot.z + (ring + u.a.z) * thick;
  if (u.b.y > 0.5) { r0 = u.plot.z; r1 = u.plot.w; }
  let tau = 6.2831853;
  let w = max(u.a.x * tau, u.b.w / max((r0 + r1) * 0.5, 1.0));
  let a0 = (p.x + u.a.x * 0.5) * tau - w * 0.5 - 1.5707963;
  let ang = a0 + w * f32(vi / 2u) / u.a.w;
  let r = select(r0, r1, (vi & 1u) == 1u);
  o.pos = to_clip(u.plot.xy + vec2f(cos(ang), sin(ang)) * r);
  if (u.b.x > 0.5) {
    o.color = u.color;
  } else {
    let span = u.domain.w - u.domain.z;
    var t = 0.5;
    if (span > 0.0) { t = (v - u.domain.z) / span; }
    o.color = vec4f(cmap(t) * u.b.z, u.b.z);
  }
  return o;
}
@fragment fn fs(i: CellOut) -> @location(0) vec4f { return i.color; }
"#
    ),
    vert: concat!(
        cmap_glsl!(),
        r#"
layout(location = 0) in vec2 p;
layout(location = 1) in float v;
flat out vec4 color;
void main() {
  float count = max(u.domain.y, 1.0);
  float ring = p.y - u.domain.x;
  if (ring < -0.5 || ring > count - 0.5) { gl_Position = OUTSIDE; color = vec4(0.0); return; }
  float thick = (u.plot.w - u.plot.z) / count;
  float r0 = u.plot.z + (ring + u.a.y) * thick;
  float r1 = u.plot.z + (ring + u.a.z) * thick;
  if (u.b.y > 0.5) { r0 = u.plot.z; r1 = u.plot.w; }
  float tau = 6.2831853;
  float w = max(u.a.x * tau, u.b.w / max((r0 + r1) * 0.5, 1.0));
  float a0 = (p.x + u.a.x * 0.5) * tau - w * 0.5 - 1.5707963;
  float ang = a0 + w * float(gl_VertexID / 2) / u.a.w;
  float r = (gl_VertexID % 2) == 1 ? r1 : r0;
  gl_Position = to_clip(u.plot.xy + vec2(cos(ang), sin(ang)) * r);
  if (u.b.x > 0.5) {
    color = u.color;
  } else {
    float span = u.domain.w - u.domain.z;
    float t = span > 0.0 ? (v - u.domain.z) / span : 0.5;
    color = vec4(cmap(t) * u.b.z, u.b.z);
  }
}
"#
    ),
    frag: r#"
flat in vec4 color;
void main() { frag = color; }
"#,
};

/// The colour ramp legend: one rectangle at `plot` = [x, y, w, h] px, no vertex buffers.
pub static RAMP: PipelineDesc = PipelineDesc {
    name: "calendar.ramp",
    strip: true,
    buffers: &[],
    wgsl: concat!(
        cmap_wgsl!(),
        r#"
struct RampOut { @builtin(position) pos: vec4f, @location(0) t: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> RampOut {
  var corners = CORNERS;
  let k = corners[vi];
  var o: RampOut;
  o.t = k.x * 0.5 + 0.5;
  o.pos = to_clip(u.plot.xy + (k * 0.5 + 0.5) * u.plot.zw);
  return o;
}
@fragment fn fs(i: RampOut) -> @location(0) vec4f { return vec4f(cmap(i.t), 1.0); }
"#
    ),
    vert: r#"
out float t;
void main() {
  vec2 k = CORNERS[gl_VertexID];
  t = k.x * 0.5 + 0.5;
  gl_Position = to_clip(u.plot.xy + (k * 0.5 + 0.5) * u.plot.zw);
}
"#,
    frag: concat!(
        cmap_glsl!(),
        r#"
in float t;
void main() { frag = vec4(cmap(t), 1.0); }
"#
    ),
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scale::US_PER_MINUTE;
    use crate::schema::{infer_roles, ColumnInfo, ColumnType, TypeCode};
    use crate::store::RawColumn;
    use crate::view::{available_views, choose_view, pipeline_table};

    fn day(y: i64, m: u32, d: u32) -> i64 {
        days_from_civil(y, m, d) * US_PER_DAY
    }

    #[test]
    fn year_cycle_is_exact_including_leap_years() {
        // 2024 is a leap year (366 days), 2023 and 2100 are not, 2000 is.
        for (y, days) in [(2023, 365), (2024, 366), (2000, 366), (2100, 365), (1969, 365), (1600, 366)] {
            let (start, end) = year_bounds(y);
            assert_eq!(end - start, days * US_PER_DAY, "{y}");
            assert_eq!(Cycle::Year.locate(start), (y, start, end - start));
            assert_eq!(Cycle::Year.locate(end - 1).0, y, "last µs of {y}");
            assert_eq!(Cycle::Year.locate(end).0, y + 1);
        }
        // Feb 29 2024 noon: day-of-year 59.5 of 366.
        let t = day(2024, 2, 29) + 12 * US_PER_HOUR;
        let mut loc = Locator::new(Cycle::Year);
        let (y, frac) = loc.at(t);
        assert_eq!(y, 2024);
        assert_eq!(frac, 59.5 / 366.0);
        // Mar 1 is day 60 in a leap year, day 59 otherwise.
        assert_eq!(loc.at(day(2024, 3, 1)).1, 60.0 / 366.0);
        assert_eq!(loc.at(day(2023, 3, 1)), (2023, 59.0 / 365.0));
        // Negative instants (before 1970) floor correctly.
        assert_eq!(Cycle::Year.locate(-1).0, 1969);
        assert_eq!(Cycle::Day.locate(-1), (-1, -US_PER_DAY, US_PER_DAY));
    }

    #[test]
    fn week_cycle_starts_monday_utc() {
        // 1970-01-01 (Thursday) belongs to the week starting Monday 1969-12-29.
        assert_eq!(Cycle::Week.locate(0), (0, day(1969, 12, 29), 7 * US_PER_DAY));
        // 2026-10-05 is a Monday, 2026-10-11 a Sunday.
        let monday = day(2026, 10, 5);
        let (w, start, _) = Cycle::Week.locate(monday);
        assert_eq!(start, monday);
        assert_eq!(Cycle::Week.locate(day(2026, 10, 11) + 23 * US_PER_HOUR).0, w);
        assert_eq!(Cycle::Week.locate(day(2026, 10, 12)).0, w + 1);
        assert_eq!(Cycle::Week.locate(monday - 1).0, w - 1);
        assert_eq!(Cycle::Week.start(w), monday);
        assert_eq!(Cycle::Week.ring_label(w), "Oct 5");
        // Wednesday noon = (2.5 / 7) of the week.
        let mut loc = Locator::new(Cycle::Week);
        assert_eq!(loc.at(monday + 2 * US_PER_DAY + 12 * US_PER_HOUR), (w, 2.5 / 7.0));
    }

    #[test]
    fn far_dates_have_no_float_drift() {
        // Microsecond resolution in year 9999 and at the day boundary.
        let t = day(9999, 12, 31) + US_PER_DAY - 1;
        assert_eq!(Cycle::Day.locate(t).1, day(9999, 12, 31));
        let (index, start, len) = Cycle::Year.locate(t);
        assert_eq!((index, t - start), (9999, len - 1));
        let mut loc = Locator::new(Cycle::Day);
        let (_, frac) = loc.at(day(2026, 10, 10) + 6 * US_PER_HOUR);
        assert_eq!(frac, 0.25);
    }

    #[test]
    fn month_sections_follow_leap_years() {
        let s = Cycle::Year.sections(2024);
        assert_eq!(s.len(), 12);
        assert_eq!(s[0].0, 0.0);
        assert_eq!(s[2].0, 60.0 / 366.0, "March starts on day 60 in 2024");
        assert_eq!(Cycle::Year.sections(2023)[2].0, 59.0 / 365.0);
        assert_eq!(s[11].2, "Dec");
        assert_eq!(Cycle::Week.sections(0)[6].2, "Sun");
        assert_eq!(Cycle::Day.sections(0)[4], (0.5, 0.5, "12"));
    }

    #[test]
    fn cycle_choice_from_span_and_bucket() {
        let h = US_PER_HOUR;
        let d = US_PER_DAY;
        assert_eq!(choose_cycle(0, 0), Cycle::Day, "one point: start small, widen later");
        assert_eq!(choose_cycle(36 * h, US_PER_MINUTE), Cycle::Day);
        assert_eq!(choose_cycle(36 * h, 12 * h), Cycle::Week, "twice-daily buckets don't fill a clock");
        assert_eq!(choose_cycle(2 * d, h), Cycle::Week);
        assert_eq!(choose_cycle(14 * d, US_PER_MINUTE), Cycle::Week);
        assert_eq!(choose_cycle(59 * d, d), Cycle::Week);
        assert_eq!(choose_cycle(59 * d, 7 * d), Cycle::Year, "weekly buckets on a weekly wheel say nothing");
        assert_eq!(choose_cycle(60 * d, h), Cycle::Year);
        assert_eq!(choose_cycle(3650 * d, d), Cycle::Year);
    }

    fn col(name: &str, code: TypeCode) -> ColumnInfo {
        ColumnInfo { name: name.into(), ty: ColumnType { code, param: 2 } }
    }

    #[test]
    fn applicable_for_time_and_value_but_never_automatic() {
        let roles = |c: &[ColumnInfo]| infer_roles(c);
        let time = roles(&[col("ts", TypeCode::Timestamp), col("v", TypeCode::F64)]);
        let views = available_views(&time);
        assert!(views.contains(&View::Seasons));
        let at = |v| views.iter().position(|&x| x == v).unwrap();
        assert!(at(View::Seasons) > at(View::Scatter), "ranked after line, bar and scatter");
        assert_eq!(choose_view(&views, None), View::Line);
        assert_eq!(choose_view(&views, Some(View::Seasons)), View::Seasons, "the hint picks it");
        let dated = roles(&[col("day", TypeCode::Date32), col("region", TypeCode::Utf8), col("n", TypeCode::I64)]);
        assert!(available_views(&dated).contains(&View::Seasons));
        for cols in [
            vec![col("name", TypeCode::Utf8), col("v", TypeCode::F64)],
            vec![col("a", TypeCode::F64), col("b", TypeCode::F64)],
            vec![col("ts", TypeCode::Timestamp), col("name", TypeCode::Utf8)],
        ] {
            assert!(!available_views(&roles(&cols)).contains(&View::Seasons), "{cols:?}");
        }
    }

    /// A store with `ts` (µs), optional series and value columns.
    fn store(rows: &[(i64, &str, Option<f64>)], series: bool) -> Store {
        let mut cols = vec![col("ts", TypeCode::Timestamp)];
        if series {
            cols.push(col("s", TypeCode::Utf8));
        }
        cols.push(col("v", TypeCode::F64));
        let roles = infer_roles(&cols);
        let mut store = Store::new(cols, roles);
        append(&mut store, rows, series);
        store
    }
    fn append(store: &mut Store, rows: &[(i64, &str, Option<f64>)], series: bool) {
        let n = rows.len();
        let ts: Vec<u8> = rows.iter().flat_map(|r| r.0.to_le_bytes()).collect();
        let v: Vec<u8> = rows.iter().flat_map(|r| r.2.unwrap_or(0.0).to_le_bytes()).collect();
        let mut bits = vec![0u8; (n + 7) / 8];
        for (i, r) in rows.iter().enumerate() {
            if r.2.is_some() {
                bits[i / 8] |= 1 << (i % 8);
            }
        }
        let text: String = rows.iter().map(|r| r.1).collect();
        let mut offsets = vec![0i32];
        for r in rows {
            offsets.push(offsets.last().unwrap() + r.1.len() as i32);
        }
        let off: Vec<u8> = offsets.iter().flat_map(|o| o.to_le_bytes()).collect();
        let base = |index, code, data| RawColumn { index, code, param: 2, rows: n, data, validity: None, bit_offset: 0, offsets: &[], dict: None };
        let mut cols = vec![base(0, TypeCode::Timestamp, &ts[..])];
        if series {
            let mut s = base(1, TypeCode::Utf8, text.as_bytes());
            s.offsets = &off;
            cols.push(s);
        }
        let mut vc = base(if series { 2 } else { 1 }, TypeCode::F64, &v[..]);
        vc.validity = Some((&bits, 0));
        cols.push(vc);
        store.append(n, &cols);
    }

    #[test]
    fn first_row_is_drawable_and_nulls_stay_empty() {
        let t0 = day(2026, 10, 1);
        let s = store(&[(t0, "", Some(4.0)), (t0 + US_PER_MINUTE, "", None), (NULL_TIME, "", Some(1.0))], false);
        let pipes = pipeline_table();
        let mut c = Calendar::new(&s.roles, &pipes);
        c.ingest(&s, 0, 1);
        assert_eq!(c.points(), 1, "first point drawable from the first row");
        c.ingest(&s, 1, 3);
        assert_eq!(c.points(), 1, "null value and null time are not drawn");
        assert_eq!(c.wheels[0].cells, vec![[0.0, 0.0, 0.0]]);
        assert_eq!(c.labels, ["v"]);
    }

    #[test]
    fn streaming_widens_cycle_and_rebuilds() {
        // 14 days × hourly in two batches: the first batch alone (one day) is a 24 h clock.
        let t0 = day(2026, 9, 28); // a Monday
        let rows: Vec<(i64, &str, Option<f64>)> = (0..14 * 24).map(|h| (t0 + h * US_PER_HOUR, "", Some(h as f64))).collect();
        let mut s = store(&rows[..24], false);
        let pipes = pipeline_table();
        let mut c = Calendar::new(&s.roles, &pipes);
        c.ingest(&s, 0, 24);
        assert_eq!(c.cycle(), Cycle::Day);
        assert_eq!(c.bucket, US_PER_HOUR);
        assert_eq!(c.wheels[0].cells[6], [0.25, 0.0, 6.0]);
        append(&mut s, &rows[24..], false);
        c.ingest(&s, 24, s.rows);
        assert_eq!(c.cycle(), Cycle::Week);
        assert_eq!(c.points(), 14 * 24);
        assert_eq!(c.wheels[0].cells.len(), 14 * 24, "re-placed, not duplicated");
        assert!(c.wheels[0].rewrite);
        assert_eq!((c.ring_lo, c.ring_hi - c.ring_lo + 1), (Cycle::Week.locate(t0).0, 2), "two weekly rings");
        // Wednesday 12:00 of the second week.
        let k = (7 + 2) * 24 + 12;
        assert_eq!(c.wheels[0].cells[k as usize], [(2.5 / 7.0) as f32, 1.0, k as f32]);
        assert_eq!(c.width_frac(), (1.0 / (7.0 * 24.0)) as f32);
        // The cycle never narrows again.
        append(&mut s, &[(t0 + 30 * US_PER_MINUTE, "", Some(0.0))], false);
        c.ingest(&s, s.rows - 1, s.rows);
        assert_eq!(c.cycle(), Cycle::Week);
    }

    #[test]
    fn series_become_small_multiples_with_shared_domain() {
        let t0 = day(2020, 1, 1);
        let mut rows = Vec::new();
        for d in 0..400i64 {
            rows.push((t0 + d * US_PER_DAY, "a", Some(d as f64)));
            rows.push((t0 + d * US_PER_DAY, "b", Some(-(d as f64))));
        }
        let s = store(&rows, true);
        let pipes = pipeline_table();
        let mut c = Calendar::new(&s.roles, &pipes);
        c.ingest(&s, 0, s.rows);
        assert_eq!(c.cycle(), Cycle::Year);
        assert_eq!(c.labels, ["a", "b"]);
        assert_eq!((c.wheels[0].cells.len(), c.wheels[1].cells.len()), (400, 400));
        assert_eq!(c.value, Domain::new(-399.0, 399.0));
        assert_eq!((c.ring_lo, c.ring_hi), (2020, 2021));
        // 2020-12-31 is day 365 of the leap year 2020; 2021-01-01 starts ring 1.
        assert_eq!(c.wheels[0].cells[365], [(365.0 / 366.0) as f32, 0.0, 365.0]);
        assert_eq!(c.wheels[0].cells[366], [0.0, 1.0, 366.0]);
        let layout = wheel_layout(Rect { left: 0.0, top: 0.0, width: 600.0, height: 300.0 }, 2);
        assert!(layout[0][1] == layout[1][1] && layout[0][0] < layout[1][0], "side by side on a wide card: {layout:?}");
    }

    #[test]
    fn too_many_series_are_capped_and_reported() {
        let names: Vec<String> = (0..MAX_WHEELS + 3).map(|i| format!("s{i}")).collect();
        let rows: Vec<(i64, &str, Option<f64>)> = names.iter().map(|n| (0, n.as_str(), Some(1.0))).collect();
        let s = store(&rows, true);
        let pipes = pipeline_table();
        let mut c = Calendar::new(&s.roles, &pipes);
        c.ingest(&s, 0, s.rows);
        assert_eq!(c.wheels.len(), MAX_WHEELS);
        assert_eq!(c.points() as usize, MAX_WHEELS);
        assert!(c.caption(false).contains("+3 series not shown"));
    }

    #[test]
    fn draw_and_labels() {
        let t0 = day(2026, 10, 5);
        let rows: Vec<(i64, &str, Option<f64>)> = (0..14 * 1440).map(|m| (t0 + m * US_PER_MINUTE, "", Some((m % 1440) as f64))).collect();
        let s = store(&rows, false);
        let pipes = pipeline_table();
        let mut c = Calendar::new(&s.roles, &pipes);
        c.ingest(&s, 0, s.rows);
        assert_eq!(c.cycle(), Cycle::Week);
        let (mut words, mut next) = (Vec::new(), 0);
        c.upload(View::Seasons, &mut Gpu { words: &mut words, next_id: &mut next, pool: &mut crate::gpu::Pool::default() });
        let mut axes = crate::axes::layout(&c.axes(View::Seasons, &s), 640.0, 360.0);
        c.decorate(View::Seasons, &s, &mut axes);
        let texts: Vec<&str> = axes.labels.iter().map(|l| l.2.as_str()).collect();
        assert!(texts[0].starts_with("Weekly wheel · UTC · Mon 00:00 at top"), "{texts:?}");
        assert!(texts[0].contains("14 d of data"), "{texts:?}");
        for w in WEEKDAYS {
            assert!(texts.contains(&w), "{w} in {texts:?}");
        }
        assert!(texts.contains(&"Oct 5") && texts.contains(&"Oct 12"), "{texts:?}");
        assert!(texts.contains(&"0") && texts.contains(&"1439"), "ramp ends {texts:?}");
        let json = axes.to_json();
        assert!(json.contains("\"labels\":[{\"x\":"), "{json}");
        let mut pass = crate::gpu::PassRecorder::default();
        c.draw(View::Seasons, &mut DrawFrame { pass: &mut pass, plot: [0.0; 4], canvas: [640.0, 360.0], dpr: 1.0, axes: &axes });
        use crate::gpu::op;
        let find = |seq: &[u32]| pass.words.windows(seq.len()).any(|x| x == seq);
        assert!(find(&[op::DRAW, 194, 2]), "two ring tracks");
        assert!(find(&[op::DRAW, 4, 7]), "seven weekday spokes");
        assert!(find(&[op::DRAW, 4, 20_160]), "one instance per minute bucket: {:?}", pass.words);
        assert!(find(&[op::PIPE, pipes.index("calendar.ramp")]));
    }
}
