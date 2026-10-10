//! Map, density and tracks: one family for every result with a latitude and a longitude column.
//!
//! One instance draws all three views from the same geometry, so switching between them never
//! re-ingests:
//!
//! - Per series, points `[lon, lat, t, v]` (f32; lon normalised to -180..180, t = seconds since
//!   the first timestamp, v = value or `MISSING`). Appends upload only the tail. `map` draws
//!   them as discs; `tracks` sorts each series by time once (rewrite) and draws capsule
//!   segments cut at the `playback` time, plus a marker at each series' position at that time.
//! - `density` bins positions on the CPU into a grid aligned with the fitted window (≈3 CSS px
//!   cells, rows uniform in Mercator northing) and draws the non-empty cells with a log ramp.
//!   Binning is incremental; the grid is rebuilt only when the window changes.
//!
//! Projection is Web Mercator, evaluated per vertex on the GPU; the CPU only fits the window
//! (equal scale, padded data extent, antimeridian-aware) — see `geo/proj.rs`.
//!
//! The basemap (Natural Earth 1:110m coastline, `geo/coastline.bin`, public domain) and the
//! graticule never gate the first data draw: the coastline is uploaded and drawn from the
//! second frame on (`wants_frame` asks for that frame).

use super::{DrawFrame, Family, FamilyDef};
use crate::axes::{palette_rgba, AxisModel, AxisScale, LEGEND_RGB};
use crate::gpu::{as_bytes, Gpu, GpuVec, PipelineTable, Uniform, KIND_VERTEX};
use crate::scale::{format_value, Domain};
use crate::schema::{Roles, View, XKind};
use crate::store::{Interner, Store, XValues, NULL_TIME};
use std::sync::OnceLock;

pub mod proj;
pub mod shaders;

use proj::{fit, graticule, inv_merc_y, lon_w, norm_lon, ramp_rgb, Extent};

/// Null value / separator in vertex data (shaders treat |v| ≥ 1e37 as missing).
pub const MISSING: f32 = f32::MAX;
/// Playback cut that shows everything.
const ALL: f32 = 1e30;
/// Density cell edge in CSS px.
const CELL_CSS_PX: f32 = 3.0;
/// Plot size (device px) assumed before the first draw reports the real one.
const DEFAULT_PLOT: [f32; 2] = [600.0, 300.0];

pub static DEF: FamilyDef = FamilyDef {
    name: "geo",
    applicable,
    create,
    pipelines: &[&shaders::GRID, &shaders::COAST, &shaders::CELL, &shaders::LINE, &shaders::POINT],
};

/// Geo views when both a latitude and a longitude column exist (by name, see `schema.rs`).
///
/// Ranking: positions are the point of a result that selects them, so geo views come before
/// line/bar/scatter (ranks 10+) unless the result also carries several measures (then the
/// numbers are the focus and geo views rank after xy). With a time x, `tracks` leads; otherwise
/// `map`. `density` is always offered, never automatic.
fn applicable(roles: &Roles, out: &mut Vec<(View, u8)>) {
    if roles.lat.is_none() || roles.lon.is_none() {
        return;
    }
    let base = if roles.measures.is_empty() { 5 } else { 20 };
    if matches!(roles.x, Some((_, XKind::Time))) {
        out.extend([(View::Tracks, base), (View::Map, base + 1), (View::Density, base + 2)]);
    } else {
        out.extend([(View::Map, base), (View::Density, base + 1)]);
    }
}

fn create(roles: &Roles, _view: View, pipes: &PipelineTable) -> Box<dyn Family> {
    Box::new(Geo::new(roles, pipes))
}

/// The bundled coastline, decoded once: `[lon, lat]` f32 pairs, `MISSING` pairs between polylines.
pub fn coastline() -> &'static [[f32; 2]] {
    static DATA: OnceLock<Vec<[f32; 2]>> = OnceLock::new();
    DATA.get_or_init(|| {
        include_bytes!("geo/coastline.bin")
            .chunks_exact(4)
            .map(|c| {
                let lon = i16::from_le_bytes([c[0], c[1]]);
                let lat = i16::from_le_bytes([c[2], c[3]]);
                if lon == i16::MIN {
                    [MISSING, MISSING]
                } else {
                    [lon as f32 / 100.0, lat as f32 / 100.0]
                }
            })
            .collect()
    })
}

#[derive(Default)]
struct Series {
    pts: Vec<[f32; 4]>,
    gpu: GpuVec,
    sorted: bool,
    rewrite: bool,
    last_t: f32,
}

/// Density grid aligned with a projected window.
#[derive(Default)]
struct Grid {
    /// Window it was built for and its size in cells.
    dom: [f64; 4],
    cols: usize,
    rows: usize,
    wrap: bool,
    /// Latitudes of the row edges (rows + 1, ascending): binning needs no per-point projection.
    lat_edges: Vec<f64>,
    counts: Vec<u32>,
    max: u32,
    /// Positions (`flat`) already binned.
    binned: usize,
    /// Non-empty cells `[col, row, count, 0]`.
    cells: Vec<[f32; 4]>,
    cells_dirty: bool,
    gpu: GpuVec,
}

impl Grid {
    fn reset(&mut self, dom: [f64; 4], cols: usize, rows: usize, wrap: bool) {
        self.dom = dom;
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        self.wrap = wrap;
        let dy = (dom[3] - dom[2]) / self.rows as f64;
        self.lat_edges.clear();
        self.lat_edges.extend((0..=self.rows).map(|k| inv_merc_y(dom[2] + k as f64 * dy)));
        self.counts.clear();
        self.counts.resize(self.cols * self.rows, 0);
        self.max = 0;
        self.binned = 0;
        self.cells_dirty = true;
    }

    fn bin(&mut self, flat: &[[f32; 2]]) {
        if self.binned >= flat.len() {
            return;
        }
        let (x0, sx) = (self.dom[0], self.cols as f64 / (self.dom[1] - self.dom[0]));
        let (lat_lo, lat_hi) = (self.lat_edges[0], self.lat_edges[self.rows]);
        for p in &flat[self.binned..] {
            let lat = p[1] as f64;
            if !(lat >= lat_lo && lat < lat_hi) {
                continue;
            }
            let c = ((lon_w(p[0] as f64, self.wrap) - x0) * sx).floor();
            if !(c >= 0.0 && c < self.cols as f64) {
                continue;
            }
            // Row edges are ascending latitudes: the row is the last edge ≤ lat.
            let r = self.lat_edges.partition_point(|&e| e <= lat).saturating_sub(1).min(self.rows - 1);
            let k = r * self.cols + c as usize;
            self.counts[k] += 1;
            self.max = self.max.max(self.counts[k]);
        }
        self.binned = flat.len();
        self.cells_dirty = true;
    }

    fn rebuild_cells(&mut self) {
        self.cells.clear();
        for (k, &n) in self.counts.iter().enumerate() {
            if n > 0 {
                self.cells.push([(k % self.cols) as f32, (k / self.cols) as f32, n as f32, 0.0]);
            }
        }
        self.cells_dirty = false;
    }
}

pub struct Geo {
    has_time: bool,
    has_value: bool,
    has_series: bool,
    series_map: Vec<u32>,
    series: Vec<Series>,
    labels: Vec<String>,
    value_name: String,
    /// All drawable positions in arrival order (density input).
    flat: Vec<[f32; 2]>,
    ext: Extent,
    v_ext: Domain,
    t_origin: Option<i64>,
    t_ext: Domain,
    points: u32,
    /// 0..1 fraction of the time extent shown by `tracks`.
    playback: f64,
    markers: Vec<[f32; 4]>,
    markers_gpu: GpuVec,
    markers_dirty: bool,
    coast: GpuVec,
    /// Frames drawn by this instance (the coastline waits for the second).
    frames: u32,
    grid: Grid,
    /// Last plot size and device pixel ratio seen by `draw`.
    plot: [f32; 2],
    dpr: f32,
    last_view: Option<View>,
    pipes: [u32; 5],
}

impl Geo {
    pub fn new(roles: &Roles, pipes: &PipelineTable) -> Geo {
        Geo {
            has_time: matches!(roles.x, Some((_, XKind::Time))),
            has_value: roles.value.is_some(),
            // A text x (no time) colours like a series: `vessel, lat, lon` is one colour per vessel.
            has_series: roles.series.is_some() || matches!(roles.x, Some((_, XKind::Category))),
            series_map: Vec::new(),
            series: Vec::new(),
            labels: Vec::new(),
            value_name: String::new(),
            flat: Vec::new(),
            ext: Extent::default(),
            v_ext: Domain::EMPTY,
            t_origin: None,
            t_ext: Domain::EMPTY,
            points: 0,
            playback: 1.0,
            markers: Vec::new(),
            markers_gpu: GpuVec::default(),
            markers_dirty: true,
            coast: GpuVec::default(),
            frames: 0,
            grid: Grid::default(),
            plot: [0.0; 2],
            dpr: 1.0,
            last_view: None,
            pipes: [
                pipes.index("geo.grid"),
                pipes.index("geo.coast"),
                pipes.index("geo.cell"),
                pipes.index("geo.line"),
                pipes.index("geo.point"),
            ],
        }
    }

    fn local_series(&mut self, store_id: u32, labels: &Interner) -> usize {
        let i = store_id as usize;
        if self.series_map.len() <= i {
            self.series_map.resize(i + 1, u32::MAX);
        }
        if self.series_map[i] == u32::MAX {
            self.series_map[i] = self.series.len() as u32;
            self.series.push(Series { sorted: true, ..Default::default() });
            self.labels.push(labels.labels.get(i).cloned().unwrap_or_default());
        }
        self.series_map[i] as usize
    }

    /// The projected window for the last known plot size.
    fn window(&self) -> [f64; 4] {
        let p = if self.plot[0] > 0.0 { self.plot } else { DEFAULT_PLOT };
        fit(&self.ext, p[0], p[1])
    }

    /// Playback cut in relative seconds (`ALL` when everything is shown).
    fn cut(&self) -> f32 {
        if self.playback >= 1.0 || self.t_ext.is_empty() {
            return ALL;
        }
        (self.t_ext.lo + self.playback.max(0.0) * self.t_ext.span()) as f32
    }

    /// Each series' position at the playback cut (interpolated), coloured by series.
    fn compute_markers(&mut self) {
        let cut = self.cut();
        self.markers.clear();
        for (i, s) in self.series.iter().enumerate() {
            let pts = &s.pts;
            // Points are sorted by t here (tracks view).
            let n = pts.partition_point(|p| p[2] <= cut);
            if n == 0 {
                continue;
            }
            let a = pts[n - 1];
            let pos = match pts.get(n) {
                Some(b) if cut < ALL && b[2] > a[2] && (a[0] - b[0]).abs() <= 180.0 => {
                    let f = (cut - a[2]) / (b[2] - a[2]);
                    [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
                }
                _ => [a[0], a[1]],
            };
            self.markers.push([pos[0], pos[1], 0.0, i as f32]);
        }
        self.markers_dirty = false;
    }

    /// Density grid size for window `dom`: ≈`CELL_CSS_PX` columns, square cells in projected units.
    fn density_grid_for(&self, dom: [f64; 4]) -> (usize, usize) {
        let p = if self.plot[0] > 0.0 { self.plot } else { DEFAULT_PLOT };
        let cols = ((p[0] / (CELL_CSS_PX * self.dpr.max(1.0))).ceil() as usize).clamp(1, 1024);
        let cell = (dom[1] - dom[0]) / cols as f64;
        let rows = ((dom[3] - dom[2]) / cell).round().clamp(1.0, 1024.0) as usize;
        (cols, rows)
    }

    fn legend(&self, view: View) -> Vec<(String, usize)> {
        let mut out = match view {
            View::Density => {
                let max = self.grid.max.max(1) as f64;
                let mid = ((1.0 + max).ln() / 2.0).exp() - 1.0;
                let mut out = vec![(String::from("1 / cell"), LEGEND_RGB | ramp_rgb(0.0) as usize)];
                if mid.round() > 1.0 && mid.round() < max {
                    out.push((format!("{} / cell", format_value(mid.round(), 3)), LEGEND_RGB | ramp_rgb(0.5) as usize));
                }
                if max > 1.0 {
                    out.push((format!("{} / cell", format_value(max, 6)), LEGEND_RGB | ramp_rgb(1.0) as usize));
                }
                out
            }
            _ if self.has_series || self.labels.len() > 1 => self.labels.iter().enumerate().map(|(i, l)| (l.clone(), i)).collect(),
            View::Map if self.has_value && !self.v_ext.is_empty() => {
                let (lo, hi) = (self.v_ext.lo, self.v_ext.hi);
                let mut out = vec![(format!("{} {}", self.value_name, format_value(lo, 4)), LEGEND_RGB | ramp_rgb(0.0) as usize)];
                if hi > lo {
                    out.push((format_value((lo + hi) / 2.0, 4), LEGEND_RGB | ramp_rgb(0.5) as usize));
                    out.push((format_value(hi, 4), LEGEND_RGB | ramp_rgb(1.0) as usize));
                }
                out
            }
            _ => Vec::new(),
        };
        let step = graticule(self.window()).4;
        out.push((format!("grid {}°", format_value(step, 3)), LEGEND_RGB | 0x5b6d78));
        out
    }

    fn uniform(&self, dom: [f64; 4], f: &DrawFrame) -> Uniform {
        Uniform {
            domain: [dom[0] as f32, dom[1] as f32, dom[2] as f32, dom[3] as f32],
            plot: f.plot,
            canvas: [f.canvas[0], f.canvas[1], f.dpr, 0.0],
            b: [0.0, 0.0, ALL, if self.ext.wrap() { 1.0 } else { 0.0 }],
            ..Default::default()
        }
    }
}

impl Family for Geo {
    fn handles(&self, view: View) -> bool {
        match view {
            View::Map | View::Density => true,
            View::Tracks => self.has_time,
            _ => false,
        }
    }

    fn ingest(&mut self, store: &Store, from: usize, to: usize) {
        let (Some(lat), Some(lon)) = (store.lat.as_deref(), store.lon.as_deref()) else { return };
        if self.value_name.is_empty() {
            self.value_name = store.roles.value.map(|v| store.columns[v].name.clone()).unwrap_or_default();
        }
        if !self.has_series && self.series.is_empty() {
            self.series.push(Series { sorted: true, ..Default::default() });
            self.labels.push(self.value_name.clone());
        }
        let times = match (&store.x, self.has_time) {
            (Some(XValues::Time(v)), true) => Some(v.as_slice()),
            _ => None,
        };
        let value = store.value.as_deref();
        let (ids, names) = match (&store.series, &store.x) {
            (Some(ids), _) => (Some(ids.as_slice()), &store.series_labels),
            (None, Some(XValues::Cat(ids))) if self.has_series => (Some(ids.as_slice()), &store.x_labels),
            _ => (None, &store.series_labels),
        };
        for i in from..to {
            let (la, lo) = (lat[i], lon[i]);
            if !(la.abs() <= 90.0) || !lo.is_finite() {
                continue;
            }
            let t = match times {
                Some(ts) if ts[i] == NULL_TIME => continue,
                Some(ts) => {
                    let t0 = *self.t_origin.get_or_insert(ts[i]);
                    let rel = (ts[i] - t0) as f64 / 1e6;
                    self.t_ext.include(rel);
                    rel as f32
                }
                None => 0.0,
            };
            let lo = norm_lon(lo);
            let v = match value {
                Some(v) if v[i].is_finite() => {
                    self.v_ext.include(v[i]);
                    v[i] as f32
                }
                _ => MISSING,
            };
            let s = match ids {
                Some(ids) => self.local_series(ids[i], names),
                None => 0,
            };
            let series = &mut self.series[s];
            if !series.pts.is_empty() && t < series.last_t {
                series.sorted = false;
            }
            series.last_t = t;
            series.pts.push([lo as f32, la as f32, t, v]);
            self.flat.push([lo as f32, la as f32]);
            self.ext.include(lo, la);
            self.points += 1;
        }
        self.markers_dirty = true;
    }

    fn points(&self) -> u32 {
        self.points
    }

    fn upload(&mut self, view: View, gpu: &mut Gpu) {
        if view == View::Density {
            let dom = self.window();
            let (cols, rows) = self.density_grid_for(dom);
            let g = &mut self.grid;
            if g.dom != dom || g.cols != cols || g.rows != rows || g.wrap != self.ext.wrap() {
                g.reset(dom, cols, rows, self.ext.wrap());
            }
            g.bin(&self.flat);
            if g.cells_dirty {
                g.rebuild_cells();
                g.gpu.sync(gpu, as_bytes(&g.cells), KIND_VERTEX, true);
            }
        } else {
            for s in &mut self.series {
                if view == View::Tracks && !s.sorted {
                    s.pts.sort_by(|a, b| a[2].total_cmp(&b[2]));
                    s.sorted = true;
                    s.rewrite = true;
                    s.last_t = s.pts.last().map_or(0.0, |p| p[2]);
                    self.markers_dirty = true;
                }
                let rewrite = std::mem::take(&mut s.rewrite);
                s.gpu.sync(gpu, as_bytes(&s.pts), KIND_VERTEX, rewrite);
            }
            if view == View::Tracks && self.markers_dirty {
                self.compute_markers();
                self.markers_gpu.sync(gpu, as_bytes(&self.markers), KIND_VERTEX, true);
            }
        }
        // Static basemap: after the first data frame, once per instance.
        if self.frames > 0 && self.coast.id == 0 {
            self.coast.sync(gpu, as_bytes(coastline()), KIND_VERTEX, true);
        }
    }

    fn axes(&self, view: View, _store: &Store) -> AxisModel {
        AxisModel { x: AxisScale::None, y: AxisScale::None, legend: self.legend(view) }
    }

    fn draw(&mut self, view: View, f: &mut DrawFrame) {
        self.plot = [f.plot[2], f.plot[3]];
        self.dpr = f.dpr;
        self.last_view = Some(view);
        let dom = fit(&self.ext, f.plot[2], f.plot[3]);
        let base = self.uniform(dom, f);
        let dpr = f.dpr;
        let [grid, coast, cell, line, point] = self.pipes;

        // Graticule hairlines.
        let (lon0, nm, lat0, np, step) = graticule(dom);
        if nm + np > 0 {
            f.pass.pipeline(grid);
            f.pass.uniform(&Uniform { color: [0.06, 0.07, 0.08, 0.13], a: [lon0 as f32, step as f32, lat0 as f32, 0.0], b: [nm as f32, 0.0, 0.0, base.b[3]], ..base });
            f.pass.draw(4, nm + np);
        }
        let coastline = |f: &mut DrawFrame, id: u32| {
            if id != 0 {
                let n = coastline().len() as u32;
                f.pass.pipeline(coast);
                f.pass.vertex_buffer(0, id, 0);
                f.pass.vertex_buffer(1, id, 8);
                f.pass.uniform(&Uniform { color: [0.36, 0.43, 0.47, 0.75], a: [1.1 * dpr, 0.0, 0.0, 0.0], ..base });
                f.pass.draw(4, n - 1);
            }
        };
        match view {
            View::Density => {
                let g = &self.grid;
                if !g.cells.is_empty() {
                    let (dx, dy) = ((g.dom[1] - g.dom[0]) / g.cols as f64, (g.dom[3] - g.dom[2]) / g.rows as f64);
                    f.pass.pipeline(cell);
                    f.pass.vertex_buffer(0, g.gpu.id, 0);
                    f.pass.uniform(&Uniform {
                        a: [g.dom[0] as f32, g.dom[2] as f32, dx as f32, dy as f32],
                        b: [(1.0 + g.max as f32).ln(), 0.0, 0.0, base.b[3]],
                        ..base
                    });
                    f.pass.draw(4, g.cells.len() as u32);
                }
                coastline(f, self.coast.id);
            }
            View::Tracks => {
                coastline(f, self.coast.id);
                let cut = self.cut();
                for (i, s) in self.series.iter().enumerate() {
                    let n = s.pts.len() as u32;
                    if n >= 2 {
                        f.pass.pipeline(line);
                        f.pass.vertex_buffer(0, s.gpu.id, 0);
                        f.pass.vertex_buffer(1, s.gpu.id, 16);
                        f.pass.uniform(&Uniform { color: palette_rgba(i, 0.9), a: [1.6 * dpr, 0.0, 0.0, 0.0], b: [0.0, 0.0, cut, base.b[3]], ..base });
                        f.pass.draw(4, n - 1);
                    }
                }
                if !self.markers.is_empty() {
                    f.pass.pipeline(point);
                    f.pass.vertex_buffer(0, self.markers_gpu.id, 0);
                    f.pass.uniform(&Uniform { color: [1.0; 4], a: [4.0 * dpr, 0.0, 3.0, 1.5 * dpr], b: [0.0, 0.0, ALL, base.b[3]], ..base });
                    f.pass.draw(4, self.markers.len() as u32);
                }
            }
            _ => {
                coastline(f, self.coast.id);
                let radius = if self.points > 20_000 {
                    1.4
                } else if self.points > 2_000 {
                    2.0
                } else {
                    3.0
                } * dpr;
                // Colour by value without series; with series, colour by series and size by value.
                let mode = match (self.has_value, self.has_series) {
                    (true, false) => 1.0,
                    (true, true) => 2.0,
                    _ => 0.0,
                };
                let (vlo, vhi) = if self.v_ext.is_empty() { (0.0, 1.0) } else { (self.v_ext.lo as f32, self.v_ext.hi as f32) };
                for (i, s) in self.series.iter().enumerate() {
                    let n = s.pts.len() as u32;
                    if n == 0 {
                        continue;
                    }
                    f.pass.pipeline(point);
                    f.pass.vertex_buffer(0, s.gpu.id, 0);
                    f.pass.uniform(&Uniform {
                        color: palette_rgba(i, 0.82),
                        a: [radius, radius * 2.6, mode, 0.0],
                        b: [vlo, vhi, ALL, base.b[3]],
                        ..base
                    });
                    f.pass.draw(4, n);
                }
            }
        }
        self.frames += 1;
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        if name != "playback" || !value.is_finite() {
            return false;
        }
        let p = value.clamp(0.0, 1.0);
        if p == self.playback {
            return false;
        }
        self.playback = p;
        self.markers_dirty = true;
        true
    }

    fn release(&mut self, gpu: &mut Gpu) {
        for s in &mut self.series {
            s.gpu.release(gpu);
        }
        self.markers_gpu.release(gpu);
        self.coast.release(gpu);
        self.grid.gpu.release(gpu);
    }

    fn wants_frame(&self) -> bool {
        // The deferred coastline, or a density grid built for a guessed plot size.
        (self.frames > 0 && self.coast.id == 0) || (self.last_view == Some(View::Density) && self.grid.dom != self.window())
    }
}

#[cfg(test)]
mod tests;
