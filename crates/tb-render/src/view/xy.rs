//! Line, bar and scatter: one point buffer per series, shared by all three views.
//!
//! Points are `[x, y]` f32 relative to per-result origins (time: ms since the first
//! timestamp; numbers: minus the first value), so f32 keeps precision for epoch timestamps.
//! Domain changes only touch uniforms; appends upload only the new tail. A null y is stored
//! as `MISSING`, which breaks lines (never drawn as zero).
//!
//! - line: instanced capsule segments (point i → i+1 read from the same buffer bound twice
//!   at offsets 0 and 8) with SDF antialiasing; round joins and caps fall out of the capsule.
//! - scatter: instanced SDF discs.
//! - bar: instanced rectangles from a baseline, grouped side by side per series.

use super::{DrawFrame, Family, FamilyDef};
use crate::axes::{palette_rgba, AxisModel, AxisScale};
use crate::gpu::{Attr, BufferLayout, Format, Gpu, GpuVec, PipelineDesc, PipelineTable, Uniform, KIND_VERTEX};
use crate::scale::{nice_domain, Domain};
use crate::schema::{Roles, View, XKind};
use crate::store::{Store, XValues, NULL_TIME};

/// Null y (or x) in vertex data. Shaders treat |v| ≥ 1e37 as missing.
pub const MISSING: f32 = f32::MAX;

pub static DEF: FamilyDef = FamilyDef { name: "xy", applicable, create, pipelines: &[&LINE, &POINT, &BAR] };

fn applicable(roles: &Roles, out: &mut Vec<(View, u8)>) {
    let Some((_, kind)) = roles.x else { return };
    if roles.value.is_none() {
        return;
    }
    let order: [View; 3] = match kind {
        XKind::Time => [View::Line, View::Bar, View::Scatter],
        XKind::Category | XKind::Numeric { integer: true } => [View::Bar, View::Line, View::Scatter],
        XKind::Numeric { integer: false } => [View::Scatter, View::Line, View::Bar],
    };
    for (i, v) in order.into_iter().enumerate() {
        out.push((v, 10 + i as u8));
    }
}

fn create(roles: &Roles, view: View, pipes: &PipelineTable) -> Box<dyn Family> {
    Box::new(Xy::new(roles, view, pipes))
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum XMode {
    Time,
    Num,
    Cat,
}

/// Where a point's x and y come from.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Source {
    /// x column; y = value; series from the series column (or one series).
    Long,
    /// x column; one series per measure plus the value column (wide results).
    Wide,
    /// x = measure[k], y = value (scatter of two measures).
    MeasureX(usize),
}

#[derive(Default)]
struct Series {
    pts: Vec<[f32; 2]>,
    gpu: GpuVec,
    sorted: bool,
    rewrite: bool,
    last_x: f32,
}

pub struct Xy {
    mode: XMode,
    source: Source,
    integer_x: bool,
    /// Store series id → local series index.
    series_map: Vec<u32>,
    series: Vec<Series>,
    labels: Vec<String>,
    x_origin: Option<f64>,
    y_origin: Option<f64>,
    /// Extent of drawable points: x relative, y absolute.
    x_ext: Domain,
    y_ext: Domain,
    /// Smallest positive x gap within a series (relative units): bar width.
    min_dx: f64,
    points: u32,
    /// Distinct x categories seen (category mode).
    cats: usize,
    pipes: [u32; 3],
}

impl Xy {
    pub fn new(roles: &Roles, view: View, pipes: &PipelineTable) -> Xy {
        let (x_kind, integer_x) = match roles.x {
            Some((_, XKind::Time)) => (XMode::Time, false),
            Some((_, XKind::Category)) => (XMode::Cat, false),
            Some((_, XKind::Numeric { integer })) => (XMode::Num, integer),
            None => (XMode::Num, false),
        };
        let (mode, source) = if view == View::Scatter && !roles.measures.is_empty() && x_kind != XMode::Num {
            (XMode::Num, Source::MeasureX(0))
        } else if view != View::Scatter && roles.series.is_none() && !roles.measures.is_empty() {
            (x_kind, Source::Wide)
        } else {
            (x_kind, Source::Long)
        };
        Xy {
            mode,
            source,
            integer_x: integer_x && source != Source::MeasureX(0),
            series_map: Vec::new(),
            series: Vec::new(),
            labels: Vec::new(),
            x_origin: None,
            y_origin: None,
            x_ext: Domain::EMPTY,
            y_ext: Domain::EMPTY,
            min_dx: f64::INFINITY,
            points: 0,
            cats: 0,
            pipes: [pipes.index("xy.line"), pipes.index("xy.point"), pipes.index("xy.bar")],
        }
    }

    fn local_series(&mut self, store_id: u32, store: &Store) -> usize {
        let i = store_id as usize;
        if self.series_map.len() <= i {
            self.series_map.resize(i + 1, u32::MAX);
        }
        if self.series_map[i] == u32::MAX {
            self.series_map[i] = self.series.len() as u32;
            self.series.push(Series { sorted: true, ..Default::default() });
            self.labels.push(store.series_labels.labels.get(i).cloned().unwrap_or_default());
        }
        self.series_map[i] as usize
    }

    fn ensure_series(&mut self, n: usize) {
        while self.series.len() < n {
            self.series.push(Series { sorted: true, ..Default::default() });
        }
    }

    #[inline]
    fn push(&mut self, s: usize, x: f64, y: f64) {
        let xo = *self.x_origin.get_or_insert(x);
        let rx = x - xo;
        let fy = if y.is_nan() {
            MISSING
        } else {
            let yo = *self.y_origin.get_or_insert(y);
            self.x_ext.include(rx);
            self.y_ext.include(y);
            self.points += 1;
            (y - yo) as f32
        };
        let series = &mut self.series[s];
        let fx = rx as f32;
        if let Some(_) = series.pts.last() {
            let dx = (fx - series.last_x) as f64;
            if dx < 0.0 {
                series.sorted = false;
            } else if dx > 0.0 && dx < self.min_dx {
                self.min_dx = dx;
            }
        }
        series.last_x = fx;
        series.pts.push([fx, fy]);
    }

    /// x display domain (relative units) for `view`.
    fn x_display(&self, view: View) -> Domain {
        if self.mode == XMode::Cat {
            return Domain::new(-0.5 - self.x_origin.unwrap_or(0.0), self.cats.max(1) as f64 - 0.5 - self.x_origin.unwrap_or(0.0));
        }
        let ext = self.x_ext;
        if ext.is_empty() {
            return Domain::new(0.0, 1.0);
        }
        let gap = if self.min_dx.is_finite() { self.min_dx } else if self.mode == XMode::Time { 3_600_000.0 } else { 1.0 };
        if view == View::Bar {
            return Domain::new(ext.lo - gap * 0.5, ext.hi + gap * 0.5);
        }
        if self.mode == XMode::Time {
            if ext.span() == 0.0 {
                return Domain::new(ext.lo - gap, ext.hi + gap);
            }
            return ext;
        }
        let xo = self.x_origin.unwrap_or(0.0);
        let abs = nice_domain(Domain::new(ext.lo + xo, ext.hi + xo), 5);
        Domain::new(abs.lo - xo, abs.hi - xo)
    }

    /// y display domain (absolute) for `view`: nice, and including zero for bars.
    fn y_display(&self, view: View) -> Domain {
        let mut ext = self.y_ext;
        if ext.is_empty() {
            return Domain::new(0.0, 1.0);
        }
        if view == View::Bar {
            ext.include(0.0);
        }
        nice_domain(ext, 5)
    }

}

impl Family for Xy {
    fn handles(&self, view: View) -> bool {
        match self.source {
            Source::MeasureX(_) => view == View::Scatter,
            Source::Wide => matches!(view, View::Line | View::Bar),
            Source::Long => matches!(view, View::Line | View::Bar | View::Scatter),
        }
    }

    fn ingest(&mut self, store: &Store, from: usize, to: usize) {
        self.cats = store.x_labels.len();
        let value = store.value.as_deref();
        let x_at = |i: usize| -> f64 {
            match &store.x {
                Some(XValues::Time(v)) => {
                    if v[i] == NULL_TIME {
                        f64::NAN
                    } else {
                        v[i] as f64 / 1000.0
                    }
                }
                Some(XValues::Num(v)) => v[i],
                Some(XValues::Cat(v)) => v[i] as f64,
                None => i as f64,
            }
        };
        match self.source {
            Source::Long => {
                if store.series.is_none() {
                    self.ensure_series(1);
                    if self.labels.is_empty() {
                        let name = store.roles.value.map(|v| store.columns[v].name.clone()).unwrap_or_default();
                        self.labels.push(name);
                    }
                }
                for i in from..to {
                    let x = x_at(i);
                    if x.is_nan() {
                        continue;
                    }
                    let s = match &store.series {
                        Some(ids) => self.local_series(ids[i], store),
                        None => 0,
                    };
                    self.push(s, x, value.map_or(f64::NAN, |v| v[i]));
                }
            }
            Source::Wide => {
                let n = store.measures.len() + 1;
                self.ensure_series(n);
                if self.labels.is_empty() {
                    for &m in &store.roles.measures {
                        self.labels.push(store.columns[m].name.clone());
                    }
                    self.labels.push(store.roles.value.map(|v| store.columns[v].name.clone()).unwrap_or_default());
                }
                for i in from..to {
                    let x = x_at(i);
                    if x.is_nan() {
                        continue;
                    }
                    for k in 0..n - 1 {
                        self.push(k, x, store.measures[k][i]);
                    }
                    self.push(n - 1, x, value.map_or(f64::NAN, |v| v[i]));
                }
            }
            Source::MeasureX(k) => {
                if store.series.is_none() {
                    self.ensure_series(1);
                    if self.labels.is_empty() {
                        self.labels.push(store.roles.value.map(|v| store.columns[v].name.clone()).unwrap_or_default());
                    }
                }
                for i in from..to {
                    let x = store.measures[k][i];
                    if x.is_nan() {
                        continue;
                    }
                    let s = match &store.series {
                        Some(ids) => self.local_series(ids[i], store),
                        None => 0,
                    };
                    self.push(s, x, value.map_or(f64::NAN, |v| v[i]));
                }
            }
        }
    }

    fn points(&self) -> u32 {
        self.points
    }

    fn upload(&mut self, view: View, gpu: &mut Gpu) {
        for s in &mut self.series {
            if view == View::Line && !s.sorted {
                s.pts.sort_by(|a, b| a[0].total_cmp(&b[0]));
                s.sorted = true;
                s.rewrite = true;
                s.last_x = s.pts.last().map_or(0.0, |p| p[0]);
            }
            let rewrite = std::mem::take(&mut s.rewrite);
            s.gpu.sync(gpu, crate::gpu::as_bytes(&s.pts), KIND_VERTEX, rewrite);
        }
    }

    fn axes(&self, view: View, store: &Store) -> AxisModel {
        let xd = self.x_display(view);
        let xo = self.x_origin.unwrap_or(0.0);
        let x = match self.mode {
            XMode::Time => AxisScale::Time { lo: ((xd.lo + xo) * 1000.0).floor() as i64, hi: ((xd.hi + xo) * 1000.0).ceil() as i64 },
            XMode::Num => AxisScale::Linear(Domain::new(xd.lo + xo, xd.hi + xo)),
            XMode::Cat => AxisScale::Category { labels: store.x_labels.labels.clone(), domain: Domain::new(xd.lo + xo, xd.hi + xo) },
        };
        let _ = self.integer_x;
        let legend = self.labels.iter().enumerate().map(|(i, l)| (l.clone(), i)).collect();
        AxisModel { x, y: AxisScale::Linear(self.y_display(view)), legend }
    }

    fn draw(&mut self, view: View, f: &mut DrawFrame) {
        let xd = self.x_display(view);
        let yd = self.y_display(view);
        let yo = self.y_origin.unwrap_or(0.0);
        let base = Uniform {
            domain: [xd.lo as f32, xd.hi as f32, (yd.lo - yo) as f32, (yd.hi - yo) as f32],
            plot: f.plot,
            canvas: [f.canvas[0], f.canvas[1], f.dpr, 0.0],
            ..Default::default()
        };
        let dpr = f.dpr;
        let [line, point, bar] = self.pipes;
        let n_series = self.series.len().max(1);
        match view {
            View::Line => {
                let width = 1.7 * dpr;
                for (i, s) in self.series.iter().enumerate() {
                    let n = s.pts.len() as u32;
                    if n >= 2 {
                        f.pass.pipeline(line);
                        f.pass.vertex_buffer(0, s.gpu.id, 0);
                        f.pass.vertex_buffer(1, s.gpu.id, 8);
                        f.pass.uniform(&Uniform { color: palette_rgba(i, 1.0), a: [width, 0.0, 0.0, 0.0], ..base });
                        f.pass.draw(4, n - 1);
                    }
                }
                // Markers: every point when sparse, otherwise the newest point per series.
                for (i, s) in self.series.iter().enumerate() {
                    let n = s.pts.len() as u32;
                    if n == 0 {
                        continue;
                    }
                    f.pass.pipeline(point);
                    let sparse = (n as f32) * 9.0 * dpr < f.plot[2];
                    if sparse {
                        f.pass.vertex_buffer(0, s.gpu.id, 0);
                        f.pass.uniform(&Uniform { color: palette_rgba(i, 1.0), a: [0.0, 2.6 * dpr, 0.0, 0.0], ..base });
                        f.pass.draw(4, n);
                    } else {
                        f.pass.vertex_buffer(0, s.gpu.id, (n - 1) * 8);
                        f.pass.uniform(&Uniform { color: palette_rgba(i, 1.0), a: [0.0, 3.5 * dpr, 0.0, 0.0], ..base });
                        f.pass.draw(4, 1);
                    }
                }
            }
            View::Scatter => {
                let radius = if self.points > 20_000 { 1.6 } else { 2.4 } * dpr;
                for (i, s) in self.series.iter().enumerate() {
                    let n = s.pts.len() as u32;
                    if n == 0 {
                        continue;
                    }
                    f.pass.pipeline(point);
                    f.pass.vertex_buffer(0, s.gpu.id, 0);
                    f.pass.uniform(&Uniform { color: palette_rgba(i, 0.78), a: [0.0, radius, 0.0, 0.0], ..base });
                    f.pass.draw(4, n);
                }
            }
            View::Bar => {
                let gap = if self.min_dx.is_finite() { self.min_dx } else { 1.0 };
                let gap = if self.mode == XMode::Cat { 1.0 } else { gap };
                let bucket = (gap / xd.span().max(1e-12)) as f32 * f.plot[2];
                let group = (20.0 * dpr * n_series as f32).min(bucket * 0.8).max(1.0);
                let slot = group / n_series as f32;
                let width = (slot * 0.88).max(1.0);
                let baseline = (0.0f64.clamp(yd.lo, yd.hi) - yo) as f32;
                for (i, s) in self.series.iter().enumerate() {
                    let n = s.pts.len() as u32;
                    if n == 0 {
                        continue;
                    }
                    let offset = (i as f32 - (n_series as f32 - 1.0) / 2.0) * slot;
                    f.pass.pipeline(bar);
                    f.pass.vertex_buffer(0, s.gpu.id, 0);
                    f.pass.uniform(&Uniform { color: palette_rgba(i, 0.86), a: [width, offset, baseline, 0.0], ..base });
                    f.pass.draw(4, n);
                }
            }
            _ => {}
        }
    }

    fn release(&mut self, gpu: &mut Gpu) {
        for s in &mut self.series {
            s.gpu.release(gpu);
        }
    }
}

const POINT_LAYOUT: &[BufferLayout] = &[BufferLayout { stride: 8, instance: true, attrs: &[Attr { location: 0, format: Format::Float32x2, offset: 0 }] }];

pub static LINE: PipelineDesc = PipelineDesc {
    name: "xy.line",
    strip: true,
    buffers: &[
        BufferLayout { stride: 8, instance: true, attrs: &[Attr { location: 0, format: Format::Float32x2, offset: 0 }] },
        BufferLayout { stride: 8, instance: true, attrs: &[Attr { location: 1, format: Format::Float32x2, offset: 0 }] },
    ],
    wgsl: r#"
struct LineOut { @builtin(position) pos: vec4f, @location(0) local: vec2f, @location(1) @interpolate(flat) len: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec2f, @location(1) b: vec2f) -> LineOut {
  var o: LineOut;
  if (missing(a) || missing(b)) { o.pos = OUTSIDE; o.local = vec2f(0.0); o.len = 0.0; return o; }
  let pa = to_px(a);
  let pb = to_px(b);
  let d = pb - pa;
  let len = length(d);
  var dir = vec2f(1.0, 0.0);
  if (len > 1e-4) { dir = d / len; }
  let nrm = vec2f(-dir.y, dir.x);
  let r = u.a.x * 0.5 + 1.0;
  var corners = CORNERS;
  let k = corners[vi];
  let along = select(-r, len + r, k.x > 0.0);
  let across = k.y * r;
  o.pos = to_clip(pa + dir * along + nrm * across);
  o.local = vec2f(along, across);
  o.len = len;
  return o;
}
@fragment fn fs(i: LineOut) -> @location(0) vec4f {
  let t = clamp(i.local.x, 0.0, i.len);
  let dist = length(vec2f(i.local.x - t, i.local.y));
  let cov = clamp(u.a.x * 0.5 - dist + 0.5, 0.0, 1.0);
  return u.color * cov;
}
"#,
    vert: r#"
layout(location = 0) in vec2 a;
layout(location = 1) in vec2 b;
out vec2 local;
flat out float len;
void main() {
  if (missing(a) || missing(b)) { gl_Position = OUTSIDE; local = vec2(0.0); len = 0.0; return; }
  vec2 pa = to_px(a);
  vec2 pb = to_px(b);
  vec2 d = pb - pa;
  len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = u.a.x * 0.5 + 1.0;
  vec2 k = CORNERS[gl_VertexID];
  float along = k.x > 0.0 ? len + r : -r;
  float across = k.y * r;
  gl_Position = to_clip(pa + dir * along + nrm * across);
  local = vec2(along, across);
}
"#,
    frag: r#"
in vec2 local;
flat in float len;
void main() {
  float t = clamp(local.x, 0.0, len);
  float dist = length(vec2(local.x - t, local.y));
  float cov = clamp(u.a.x * 0.5 - dist + 0.5, 0.0, 1.0);
  frag = u.color * cov;
}
"#,
};

pub static POINT: PipelineDesc = PipelineDesc {
    name: "xy.point",
    strip: true,
    buffers: POINT_LAYOUT,
    wgsl: r#"
struct PointOut { @builtin(position) pos: vec4f, @location(0) local: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) p: vec2f) -> PointOut {
  var o: PointOut;
  if (missing(p)) { o.pos = OUTSIDE; o.local = vec2f(0.0); return o; }
  var corners = CORNERS;
  let r = u.a.y + 1.0;
  o.local = corners[vi] * r;
  o.pos = to_clip(to_px(p) + vec2f(u.a.z, 0.0) + o.local);
  return o;
}
@fragment fn fs(i: PointOut) -> @location(0) vec4f {
  let cov = clamp(u.a.y - length(i.local) + 0.5, 0.0, 1.0);
  return u.color * cov;
}
"#,
    vert: r#"
layout(location = 0) in vec2 p;
out vec2 local;
void main() {
  if (missing(p)) { gl_Position = OUTSIDE; local = vec2(0.0); return; }
  float r = u.a.y + 1.0;
  local = CORNERS[gl_VertexID] * r;
  gl_Position = to_clip(to_px(p) + vec2(u.a.z, 0.0) + local);
}
"#,
    frag: r#"
in vec2 local;
void main() {
  float cov = clamp(u.a.y - length(local) + 0.5, 0.0, 1.0);
  frag = u.color * cov;
}
"#,
};

pub static BAR: PipelineDesc = PipelineDesc {
    name: "xy.bar",
    strip: true,
    buffers: POINT_LAYOUT,
    wgsl: r#"
struct BarOut { @builtin(position) pos: vec4f, @location(0) px: vec2f, @location(1) @interpolate(flat) rect: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) p: vec2f) -> BarOut {
  var o: BarOut;
  if (missing(p)) { o.pos = OUTSIDE; o.px = vec2f(0.0); o.rect = vec4f(0.0); return o; }
  let top = to_px(p);
  let base = to_px(vec2f(p.x, u.a.z));
  let cx = top.x + u.a.y;
  let half = u.a.x * 0.5;
  var y0 = min(top.y, base.y);
  let y1 = max(top.y, base.y);
  if (y1 - y0 < 1.0) { y0 = y1 - 1.0; }
  o.rect = vec4f(cx - half, y0, cx + half, y1);
  var corners = CORNERS;
  let k = corners[vi];
  o.px = vec2f(select(o.rect.x - 1.0, o.rect.z + 1.0, k.x > 0.0), select(o.rect.y - 1.0, o.rect.w + 1.0, k.y > 0.0));
  o.pos = to_clip(o.px);
  return o;
}
@fragment fn fs(i: BarOut) -> @location(0) vec4f {
  let e = min(min(i.px.x - i.rect.x, i.rect.z - i.px.x), min(i.px.y - i.rect.y, i.rect.w - i.px.y));
  return u.color * clamp(e + 0.5, 0.0, 1.0);
}
"#,
    vert: r#"
layout(location = 0) in vec2 p;
out vec2 px;
flat out vec4 rect;
void main() {
  if (missing(p)) { gl_Position = OUTSIDE; px = vec2(0.0); rect = vec4(0.0); return; }
  vec2 top = to_px(p);
  vec2 base = to_px(vec2(p.x, u.a.z));
  float cx = top.x + u.a.y;
  float half_w = u.a.x * 0.5;
  float y0 = min(top.y, base.y);
  float y1 = max(top.y, base.y);
  if (y1 - y0 < 1.0) { y0 = y1 - 1.0; }
  rect = vec4(cx - half_w, y0, cx + half_w, y1);
  vec2 k = CORNERS[gl_VertexID];
  px = vec2(k.x > 0.0 ? rect.z + 1.0 : rect.x - 1.0, k.y > 0.0 ? rect.w + 1.0 : rect.y - 1.0);
  gl_Position = to_clip(px);
}
"#,
    frag: r#"
in vec2 px;
flat in vec4 rect;
void main() {
  float e = min(min(px.x - rect.x, rect.z - px.x), min(px.y - rect.y, rect.w - px.y));
  frag = u.color * clamp(e + 0.5, 0.0, 1.0);
}
"#,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{infer_roles, ColumnInfo, ColumnType, TypeCode};
    use crate::store::RawColumn;
    use crate::view::pipeline_table;

    fn store_with(rows: &[(i64, &str, Option<f64>)]) -> Store {
        let cols = vec![
            ColumnInfo { name: "ts".into(), ty: ColumnType { code: TypeCode::Timestamp, param: 1 } },
            ColumnInfo { name: "s".into(), ty: ColumnType { code: TypeCode::Utf8, param: 0 } },
            ColumnInfo { name: "v".into(), ty: ColumnType { code: TypeCode::F64, param: 0 } },
        ];
        let roles = infer_roles(&cols);
        let mut store = Store::new(cols, roles);
        let ts: Vec<u8> = rows.iter().flat_map(|r| r.0.to_le_bytes()).collect();
        let v: Vec<u8> = rows.iter().flat_map(|r| r.2.unwrap_or(0.0).to_le_bytes()).collect();
        let mut bits = vec![0u8; (rows.len() + 7) / 8];
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
        let n = rows.len();
        let base = |index, code, param, data| RawColumn { index, code, param, rows: n, data, validity: None, bit_offset: 0, offsets: &[], dict: None };
        let mut s = base(1, TypeCode::Utf8, 0, text.as_bytes());
        s.offsets = &off;
        let mut vc = base(2, TypeCode::F64, 0, &v);
        vc.validity = Some((&bits, 0));
        store.append(n, &[base(0, TypeCode::Timestamp, 1, &ts), s, vc]);
        store
    }

    #[test]
    fn splits_series_and_keeps_nulls_missing() {
        let t0 = 1_760_000_000_000i64;
        let store = store_with(&[(t0, "a", Some(1.0)), (t0, "b", Some(5.0)), (t0 + 1000, "a", None), (t0 + 2000, "a", Some(3.0))]);
        let pipes = pipeline_table();
        let mut xy = Xy::new(&store.roles, View::Line, &pipes);
        xy.ingest(&store, 0, store.rows);
        assert_eq!(xy.series.len(), 2);
        assert_eq!(xy.points(), 3);
        let a = &xy.series[0].pts;
        assert_eq!(a.len(), 3);
        assert_eq!(a[0], [0.0, 0.0]);
        assert_eq!(a[1][1], MISSING);
        assert_eq!(a[2], [2000.0, 2.0]);
        assert_eq!(xy.series[1].pts[0], [0.0, 4.0]);
        assert_eq!(xy.min_dx, 1000.0);
        let m = xy.axes(View::Line, &store);
        assert_eq!(m.legend, vec![("a".to_string(), 0), ("b".to_string(), 1)]);
        assert_eq!(m.x, AxisScale::Time { lo: t0 * 1000, hi: (t0 + 2000) * 1000 });
        assert_eq!(m.y, AxisScale::Linear(Domain::new(1.0, 5.0)));
        assert_eq!(xy.y_display(View::Bar), Domain::new(0.0, 5.0));
    }

    #[test]
    fn unsorted_series_are_sorted_for_lines_and_rewritten() {
        let t0 = 1_000i64;
        let store = store_with(&[(t0 + 2000, "a", Some(1.0)), (t0, "a", Some(2.0)), (t0 + 1000, "a", Some(3.0))]);
        let pipes = pipeline_table();
        let mut xy = Xy::new(&store.roles, View::Line, &pipes);
        xy.ingest(&store, 0, store.rows);
        assert!(!xy.series[0].sorted);
        let mut words = Vec::new();
        let mut next = 0;
        xy.upload(View::Line, &mut Gpu { words: &mut words, next_id: &mut next });
        let xs: Vec<f32> = xy.series[0].pts.iter().map(|p| p[0]).collect();
        assert_eq!(xs, [-2000.0, -1000.0, 0.0]);
        assert!(xy.series[0].sorted);
    }

    #[test]
    fn line_draw_binds_segment_pairs() {
        let store = store_with(&[(0, "a", Some(1.0)), (1000, "a", Some(2.0)), (2000, "a", Some(3.0))]);
        let pipes = pipeline_table();
        let mut xy = Xy::new(&store.roles, View::Line, &pipes);
        xy.ingest(&store, 0, store.rows);
        let mut words = Vec::new();
        let mut next = 0;
        xy.upload(View::Line, &mut Gpu { words: &mut words, next_id: &mut next });
        let mut pass = crate::gpu::PassRecorder::default();
        let axes = crate::axes::AxesOut::default();
        xy.draw(View::Line, &mut DrawFrame { pass: &mut pass, plot: [10.0, 10.0, 300.0, 200.0], canvas: [320.0, 220.0], dpr: 1.0, axes: &axes });
        use crate::gpu::op;
        let w = &pass.words;
        let id = xy.series[0].gpu.id;
        let find = |seq: &[u32]| w.windows(seq.len()).any(|x| x == seq);
        assert!(find(&[op::VB, 0, id, 0]));
        assert!(find(&[op::VB, 1, id, 8]));
        assert!(find(&[op::DRAW, 4, 2]), "two segments for three points: {w:?}");
        assert!(find(&[op::DRAW, 4, 3]), "sparse series draws every marker");
    }
}
