//! Heatmap and surface: x × series × value, sharing one geometry.
//!
//! Rows come from the series column (text: first-seen order, i.e. the SQL's ORDER BY), or,
//! without one, from `roles.grid_rows`: a numeric column keyed by value and ordered
//! numerically (`hour, dow, avg` → one row per dow, 0 at the top). Row order is a uniform
//! (`pos`), so a row first seen in a later batch re-ranks without re-uploading anything.
//!
//! Both views draw from per-series point buffers `[x, value]` (f32, relative to per-result
//! origins, like `xy`), so switching heatmap ↔ surface never rebuilds or re-uploads, and a
//! streamed batch uploads only each series' new tail. Everything that depends on the whole
//! result — x window, colour/height domain, row order, camera — lives in uniforms.
//!
//! - heatmap: one instanced draw per series row; each point is a cell spanning one bucket
//!   (the smallest x gap seen) coloured by a viridis polynomial in the fragment shader. Cell
//!   edges snap to device pixels, so adjacent buckets meet without seams. Null = blank cell.
//! - surface: one flat ribbon per series lane at height = value (instanced segments, the point
//!   buffer bound twice at offsets 0 and 8, as `xy.line`), under a perspective camera rotated
//!   about the vertical axis by the `rotation` param. Lanes never interpolate across series; a
//!   null or a gap wider than 1.5 buckets breaks the ribbon. No depth buffer: lanes are drawn
//!   back to front, and when the rotation makes high x farther, each lane draws from a lazily
//!   built reversed copy of its buffer (painter's order within a lane).

use super::{DrawFrame, Family, FamilyDef};
use crate::axes::{palette_rgba, rgb_index, AxesOut, AxisModel, AxisScale};
use crate::gpu::{as_bytes, Attr, BufferLayout, Format, Gpu, GpuVec, PipelineDesc, PipelineTable, Uniform, KIND_VERTEX};
use crate::scale::{format_number, linear_ticks, nice_domain, Domain};
use crate::schema::{Roles, View, XKind};
use crate::store::{Store, XValues, NULL_TIME};

/// Null value in vertex data (shaders treat |v| ≥ 1e37 as missing).
pub const MISSING: f32 = f32::MAX;
/// More distinct series than this make the heatmap the automatic choice over lines/bars.
pub const MANY_SERIES: usize = 12;
/// A grid dimension with more distinct values than this is not "low-cardinality": no
/// automatic heatmap from numeric rows, and numeric rows that never repeat are no grid.
pub const GRID_MAX_LEVELS: usize = 100;
/// Default surface rotation in degrees (high x nearer: no reversed buffers needed).
pub const DEFAULT_ROTATION: f64 = -30.0;

pub static DEF: FamilyDef = FamilyDef { name: "matrix", applicable, create, pipelines: &[&CELL, &RIBBON] };

/// x (any kind) × rows × value, rows = the series column or `grid_rows`. Ranks sit after
/// xy's (10–12): line/bar/scatter stay the automatic choice at schema time; `refine` promotes
/// the heatmap once many series or a numeric grid show up; the surface is offered but never
/// automatic. A hint (`-- view: heatmap`) picks them from the schema alone.
fn applicable(roles: &Roles, out: &mut Vec<(View, u8)>) {
    if roles.x.is_none() || roles.value.is_none() || (roles.series.is_none() && roles.grid_rows.is_none()) {
        return;
    }
    out.push((View::Heatmap, 20));
    out.push((View::Surface, 40));
}

/// Data-aware preference (see `view::REFINE`, consulted only without a view hint).
///
/// - Text series: with more than [`MANY_SERIES`] on a time or category x, lines and grouped
///   bars are unreadable; prefer the heatmap.
/// - Numeric rows (`grid_rows`): rows that are not integer-valued or have more than
///   [`GRID_MAX_LEVELS`] values, or an x that never repeats (`hour, n, avg`: one row per x),
///   are no grid: drop heatmap/surface from the menu. When the rows are clearly a grid (see
///   [`is_grid`]) prefer the heatmap. A hint skips all of this and draws what was asked.
pub fn refine(store: &Store, views: &mut Vec<View>) {
    if store.roles.series.is_none() {
        match grid_rows(store).map(|rows| (integer_levels(rows), rows)) {
            None => {}
            Some((Some(_), rows)) if is_grid(store, rows) => promote(views, View::Heatmap),
            Some((Some(_), _)) if x_repeats(store) => {}
            Some(_) => views.retain(|&v| !matches!(v, View::Heatmap | View::Surface)),
        }
        return;
    }
    if matches!(store.roles.x, Some((_, XKind::Numeric { integer: false })) | None) {
        return;
    }
    if store.series_labels.len() > MANY_SERIES {
        promote(views, View::Heatmap);
    }
}

fn promote(views: &mut Vec<View>, view: View) {
    if let Some(i) = views.iter().position(|&v| v == view) {
        let v = views.remove(i);
        views.insert(0, v);
    }
}

/// The `grid_rows` column's values in the store.
fn grid_rows(store: &Store) -> Option<&[f64]> {
    let col = store.roles.grid_rows?;
    let k = store.roles.measures.iter().position(|&m| m == col)?;
    store.measures.get(k).map(|v| &v[..])
}

/// u64 keys (f64 bits, ids) → dense index in first-insert order. Open addressing, linear
/// probing, fmix64 slot index. Why not `store::FxMap`: FxHash keeps the all-zero low bits of
/// integer-valued doubles (1.0 = 0x3ff0…0), so they all hit one slot and probing goes linear
/// (`refine` over 2048 non-grid integer rows: 0.86 ms; 35 µs with this, native release p50).
/// Why not std `HashMap` with a better hasher: its instantiations cost 3.8 KB of Wasm.
struct KeyIndex {
    /// (key, index + 1); index 0 = empty slot.
    slots: Vec<(u64, u32)>,
    len: u32,
}

impl KeyIndex {
    fn with_capacity(n: usize) -> KeyIndex {
        KeyIndex { slots: vec![(0, 0); (n * 2).next_power_of_two().max(16)], len: 0 }
    }
    fn len(&self) -> usize {
        self.len as usize
    }
    #[inline]
    fn mix(mut k: u64) -> u64 {
        k ^= k >> 33;
        k = k.wrapping_mul(0xff51_afd7_ed55_8ccd);
        k ^= k >> 33;
        k = k.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
        k ^ (k >> 33)
    }
    /// The key's index, and whether it was new.
    #[inline]
    fn insert(&mut self, k: u64) -> (u32, bool) {
        if (self.len as usize + 1) * 2 > self.slots.len() {
            let grown = vec![(0, 0); self.slots.len() * 2];
            let old = std::mem::replace(&mut self.slots, grown);
            for (key, id) in old {
                if id != 0 {
                    self.place(key, id);
                }
            }
        }
        let mask = self.slots.len() - 1;
        let mut i = Self::mix(k) as usize & mask;
        loop {
            let (key, id) = self.slots[i];
            if id == 0 {
                self.len += 1;
                self.slots[i] = (k, self.len);
                return (self.len - 1, true);
            }
            if key == k {
                return (id - 1, false);
            }
            i = (i + 1) & mask;
        }
    }
    fn place(&mut self, k: u64, id: u32) {
        let mask = self.slots.len() - 1;
        let mut i = Self::mix(k) as usize & mask;
        while self.slots[i].1 != 0 {
            i = (i + 1) & mask;
        }
        self.slots[i] = (k, id);
    }
}

#[inline]
fn integer_valued(v: f64) -> bool {
    v.is_finite() && v == v.trunc()
}

/// Normalised hash key of a number (-0 = 0, one NaN).
#[inline]
fn key(v: f64) -> u64 {
    if v.is_nan() {
        f64::NAN.to_bits()
    } else {
        (v + 0.0).to_bits()
    }
}

/// Distinct non-null values when every one is integer-valued and there are at most
/// [`GRID_MAX_LEVELS`]; `None` otherwise (stops at the first offending value).
fn integer_levels(values: &[f64]) -> Option<usize> {
    let mut seen = KeyIndex::with_capacity(GRID_MAX_LEVELS);
    for &v in values {
        if v.is_nan() {
            continue;
        }
        if !integer_valued(v) {
            return None;
        }
        seen.insert(key(v));
        if seen.len() > GRID_MAX_LEVELS {
            return None;
        }
    }
    Some(seen.len())
}

/// Does any x value occur twice? Checks at most `GRID_MAX_LEVELS²` rows: an x without a
/// repeat by then has too many levels for a grid anyway.
fn x_repeats(store: &Store) -> bool {
    let n = store.rows.min(GRID_MAX_LEVELS * GRID_MAX_LEVELS);
    let mut seen = KeyIndex::with_capacity(n);
    for i in 0..n {
        let k = match &store.x {
            Some(XValues::Time(v)) => v[i] as u64,
            Some(XValues::Num(v)) => key(v[i]),
            Some(XValues::Cat(v)) => v[i] as u64,
            None => return false,
        };
        if !seen.insert(k).1 {
            return true;
        }
    }
    false
}

/// Is x × `rows` → value clearly a grid? Both dimensions are low-cardinality and discrete
/// (integer-valued numbers, or text x), both repeat (≥ 2 levels, each seen more than once),
/// every (x, row) cell occurs at most once and at least half the cells are filled. A per-x
/// result with an extra count (`hour, n, avg`) fails: its x never repeats. Time x never
/// qualifies (calendar/seasons views own that). Cost: one pass over at most
/// `GRID_MAX_LEVELS²` rows (more rows cannot have unique cells).
pub fn is_grid(store: &Store, rows: &[f64]) -> bool {
    let n = store.rows.min(rows.len());
    if n > GRID_MAX_LEVELS * GRID_MAX_LEVELS {
        return false;
    }
    let x_key = |i: usize| -> Option<u64> {
        match &store.x {
            Some(XValues::Num(v)) if v[i].is_nan() || integer_valued(v[i]) => Some(key(v[i])),
            Some(XValues::Cat(v)) => Some(v[i] as u64),
            _ => None,
        }
    };
    // Level → dense index; cells as a GRID_MAX_LEVELS² bitset.
    let (mut xs, mut rs) = (KeyIndex::with_capacity(GRID_MAX_LEVELS), KeyIndex::with_capacity(GRID_MAX_LEVELS));
    let mut cells = vec![0u64; (GRID_MAX_LEVELS * GRID_MAX_LEVELS).div_ceil(64)];
    for i in 0..n {
        let Some(x) = x_key(i) else { return false };
        let xi = xs.insert(x).0 as usize;
        let ri = rs.insert(key(rows[i])).0 as usize;
        if xs.len() > GRID_MAX_LEVELS || rs.len() > GRID_MAX_LEVELS {
            return false;
        }
        let c = xi * GRID_MAX_LEVELS + ri;
        let (w, bit) = (c / 64, 1u64 << (c % 64));
        if cells[w] & bit != 0 {
            return false;
        }
        cells[w] |= bit;
    }
    let (nx, nr) = (xs.len(), rs.len());
    nx >= 2 && nr >= 2 && n > nx && n > nr && 2 * n >= nx * nr
}

fn create(roles: &Roles, _view: View, pipes: &PipelineTable) -> Box<dyn Family> {
    Box::new(Matrix::new(roles, pipes))
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum XMode {
    Time,
    Num,
    Cat,
}

#[derive(Default)]
struct Series {
    pts: Vec<[f32; 2]>,
    gpu: GpuVec,
    sorted: bool,
    rewrite: bool,
    last_x: f32,
    /// Reversed copy of `pts` for back-to-front ribbons, built only when needed. It fills from
    /// the end: `rev[rev_start..]` = `pts` reversed, so appended points are prepended at lower
    /// offsets and an append uploads only the new points (bound at offset `rev_start * 8`).
    rev: Vec<[f32; 2]>,
    rev_start: usize,
    rev_gpu: GpuVec,
}

pub struct Matrix {
    mode: XMode,
    /// Rows from `store.measures[k]` (numeric, ordered by value) instead of the series column.
    rows_from: Option<usize>,
    /// Numeric rows: value key → local series index.
    /// The index is the local series index (rows are created in insertion order).
    row_map: KeyIndex,
    /// Numeric rows: each local series' value (NaN = the NULL row, last).
    row_keys: Vec<f64>,
    /// Numeric rows: local series indices in ascending value order.
    row_order: Vec<u32>,
    /// Display position of each local series: row from the top (heatmap), lane from the back
    /// (surface), palette and legend index. Identity for text series (first-seen order).
    pos: Vec<usize>,
    series_map: Vec<u32>,
    series: Vec<Series>,
    labels: Vec<String>,
    /// ms for time, the first value for numbers, 0 for categories.
    x_origin: Option<f64>,
    v_origin: Option<f64>,
    x_ext: Domain,
    v_ext: Domain,
    /// Smallest positive x gap within a series (relative units): one bucket.
    min_dx: f64,
    points: u32,
    cats: usize,
    rotation: f64,
    /// Surface guides: value-axis segment `[x_c, v_lo] → [x_c, v_hi]` and floor edge
    /// `[x_lo, v_lo] → [x_hi, v_lo]`, rewritten when the domain changes.
    guides: [[f32; 2]; 4],
    guides_gpu: GpuVec,
    pipes: [u32; 2],
}

/// Camera constants, mirrored in the ribbon shader.
const SIN_ELEV: f64 = 0.5; // 30° elevation
const COS_ELEV: f64 = 0.866_025_4;
const DIST: f64 = 3.0;
const HEIGHT: f64 = 0.55;
/// Footprint radius used to fit the camera: constant over rotations, so rotating never zooms.
const FIT_RADIUS: f64 = 0.7072;

/// Screen mapping of the surface for one plot rectangle and rotation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    pub cos: f64,
    pub sin: f64,
    pub scale: f64,
    pub cx: f64,
    pub cy: f64,
}

impl Camera {
    /// Project model space (X, Y ∈ [-0.5, 0.5], Z ∈ [0, HEIGHT]) to plot pixels. Same math as
    /// `project()` in the ribbon shader.
    pub fn project(&self, m: [f64; 3]) -> [f64; 2] {
        let [sx, sy] = unit_project(m[0] * self.cos - m[1] * self.sin, m[0] * self.sin + m[1] * self.cos, m[2] - HEIGHT * 0.5);
        [self.cx + sx * self.scale, self.cy + sy * self.scale]
    }
}

fn unit_project(xr: f64, yr: f64, z: f64) -> [f64; 2] {
    let up = z * COS_ELEV + yr * SIN_ELEV;
    let k = DIST / (DIST + yr * COS_ELEV - z * SIN_ELEV);
    [xr * k, -up * k]
}

/// Fit the rotated box into `plot` = [left, top, width, height].
pub fn camera(rotation_deg: f64, plot: [f64; 4]) -> Camera {
    let (sin, cos) = rotation_deg.to_radians().sin_cos();
    let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    for xr in [-FIT_RADIUS, FIT_RADIUS] {
        for yr in [-FIT_RADIUS, FIT_RADIUS] {
            for z in [-HEIGHT * 0.5, HEIGHT * 0.5] {
                let p = unit_project(xr, yr, z);
                for k in 0..2 {
                    lo[k] = lo[k].min(p[k]);
                    hi[k] = hi[k].max(p[k]);
                }
            }
        }
    }
    let scale = (plot[2] / (hi[0] - lo[0])).min(plot[3] / (hi[1] - lo[1])).max(1e-6);
    Camera {
        cos,
        sin,
        scale,
        cx: plot[0] + plot[2] * 0.5 - (lo[0] + hi[0]) * 0.5 * scale,
        cy: plot[1] + plot[3] * 0.5 - (lo[1] + hi[1]) * 0.5 * scale,
    }
}

/// Viridis, 6th-degree polynomial fit (same coefficients as the shaders). `t` in [0, 1].
pub fn viridis(t: f64) -> [f64; 3] {
    const C: [[f64; 3]; 7] = [
        [0.277_727_327_223_417_7, 0.005_407_344_544_966_578, 0.334_099_805_335_306_1],
        [0.105_093_043_108_577_4, 1.404_613_529_898_575, 1.384_590_162_594_685],
        [-0.330_861_828_725_556_3, 0.214_847_559_468_213, 0.095_095_163_028_236_59],
        [-4.634_230_498_983_486, -5.799_100_973_351_585, -19.332_440_956_279_87],
        [6.228_269_936_347_081, 14.179_933_366_805_09, 56.690_552_600_681_05],
        [4.776_384_997_670_288, -13.745_145_377_746_01, -65.353_032_633_372_34],
        [-5.435_455_855_934_631, 4.645_852_612_178_535, 26.312_435_249_583_2],
    ];
    let t = t.clamp(0.0, 1.0);
    let mut out = [0.0; 3];
    for (k, o) in out.iter_mut().enumerate() {
        let mut v = C[6][k];
        for c in C[..6].iter().rev() {
            v = c[k] + t * v;
        }
        *o = v.clamp(0.0, 1.0);
    }
    out
}

impl Matrix {
    pub fn new(roles: &Roles, pipes: &PipelineTable) -> Matrix {
        let mode = match roles.x {
            Some((_, XKind::Time)) => XMode::Time,
            Some((_, XKind::Category)) => XMode::Cat,
            _ => XMode::Num,
        };
        let rows_from = if roles.series.is_some() { None } else { roles.grid_rows.and_then(|c| roles.measures.iter().position(|&m| m == c)) };
        Matrix {
            mode,
            rows_from,
            row_map: KeyIndex::with_capacity(16),
            row_keys: Vec::new(),
            row_order: Vec::new(),
            pos: Vec::new(),
            series_map: Vec::new(),
            series: Vec::new(),
            labels: Vec::new(),
            x_origin: if mode == XMode::Cat { Some(0.0) } else { None },
            v_origin: None,
            x_ext: Domain::EMPTY,
            v_ext: Domain::EMPTY,
            min_dx: f64::INFINITY,
            points: 0,
            cats: 0,
            rotation: DEFAULT_ROTATION,
            guides: [[0.0; 2]; 4],
            guides_gpu: GpuVec::default(),
            pipes: [pipes.index("matrix.cell"), pipes.index("matrix.ribbon")],
        }
    }

    fn local_series(&mut self, store_id: u32, store: &Store) -> usize {
        let i = store_id as usize;
        if self.series_map.len() <= i {
            self.series_map.resize(i + 1, u32::MAX);
        }
        if self.series_map[i] == u32::MAX {
            self.series_map[i] = self.series.len() as u32;
            self.pos.push(self.series.len());
            self.series.push(Series { sorted: true, ..Default::default() });
            self.labels.push(store.series_labels.labels.get(i).cloned().unwrap_or_default());
        }
        self.series_map[i] as usize
    }

    /// Local series for a numeric row value (`true` when new; positions are updated).
    fn local_row(&mut self, v: f64) -> (usize, bool) {
        let (s, new) = self.row_map.insert(key(v));
        let s = s as usize;
        if !new {
            return (s, false);
        }
        debug_assert_eq!(s, self.series.len());
        self.series.push(Series { sorted: true, ..Default::default() });
        self.labels.push(if v.is_nan() { String::from("NULL") } else { crate::scale::format_value(v, 12) });
        let v = if v.is_nan() { f64::NAN } else { v + 0.0 };
        self.row_keys.push(v);
        // Insert into ascending value order (NULL = NaN sorts last); positions from there on
        // shift by one. A binary search + memmove instead of a sort: no new sort
        // monomorphization (a `sort_by` here added 7.7 KB to the Wasm).
        let keys = &self.row_keys;
        let at = self.row_order.partition_point(|&o| keys[o as usize].total_cmp(&v).is_lt());
        self.row_order.insert(at, s as u32);
        self.pos.push(0);
        for (p, &o) in self.row_order.iter().enumerate().skip(at) {
            self.pos[o as usize] = p;
        }
        (s, true)
    }

    /// Labels in display order (position 0 first).
    fn ordered_labels(&self) -> Vec<String> {
        let mut out = vec![String::new(); self.labels.len()];
        for (i, l) in self.labels.iter().enumerate() {
            out[self.pos[i]] = l.clone();
        }
        out
    }

    #[inline]
    fn push(&mut self, s: usize, x: f64, v: f64) {
        let xo = *self.x_origin.get_or_insert(x);
        let rx = x - xo;
        let fv = if v.is_nan() {
            MISSING
        } else {
            let vo = *self.v_origin.get_or_insert(v);
            self.x_ext.include(rx);
            self.v_ext.include(v);
            self.points += 1;
            (v - vo) as f32
        };
        let series = &mut self.series[s];
        let fx = rx as f32;
        if !series.pts.is_empty() {
            let dx = (fx - series.last_x) as f64;
            if dx < 0.0 {
                series.sorted = false;
            }
            let gap = dx.abs();
            if gap > 0.0 && gap < self.min_dx {
                self.min_dx = gap;
            }
        }
        series.last_x = fx;
        series.pts.push([fx, fv]);
    }

    /// One bucket in relative x units.
    fn bucket(&self) -> f64 {
        if self.mode == XMode::Cat {
            return 1.0;
        }
        if self.min_dx.is_finite() {
            return self.min_dx;
        }
        if self.mode == XMode::Time {
            3_600_000.0
        } else {
            1.0
        }
    }

    /// Where a heatmap cell starts relative to its x: buckets start at their timestamp;
    /// numbers and categories are centred.
    fn cell_offset(&self) -> f64 {
        if self.mode == XMode::Time {
            0.0
        } else {
            -0.5 * self.bucket()
        }
    }

    /// x window (relative units) for `view`.
    fn x_display(&self, view: View) -> Domain {
        if self.mode == XMode::Cat && view == View::Heatmap {
            return Domain::new(-0.5, self.cats.max(1) as f64 - 0.5);
        }
        let ext = self.x_ext;
        if ext.is_empty() {
            return Domain::new(0.0, 1.0);
        }
        let w = self.bucket();
        if view == View::Heatmap {
            let lo = ext.lo + self.cell_offset();
            return Domain::new(lo, ext.hi + self.cell_offset() + w);
        }
        if ext.span() == 0.0 {
            return Domain::new(ext.lo - w, ext.hi + w);
        }
        ext
    }

    /// Value window (absolute): exact extent for heatmap colours (full contrast), a nice
    /// domain for surface heights (axis ticks at round values).
    fn v_display(&self, view: View) -> Domain {
        let ext = self.v_ext;
        if ext.is_empty() {
            return Domain::new(0.0, 1.0);
        }
        if view == View::Surface {
            return nice_domain(ext, 5);
        }
        if ext.span() == 0.0 {
            return Domain::new(ext.lo - 0.5, ext.hi + 0.5);
        }
        ext
    }

    fn x_scale(&self, xd: Domain, store: &Store) -> AxisScale {
        let xo = self.x_origin.unwrap_or(0.0);
        match self.mode {
            XMode::Time => AxisScale::Time { lo: ((xd.lo + xo) * 1000.0).floor() as i64, hi: ((xd.hi + xo) * 1000.0).ceil() as i64 },
            XMode::Num => AxisScale::Linear(Domain::new(xd.lo + xo, xd.hi + xo)),
            XMode::Cat => AxisScale::Category { labels: store.x_labels.labels.clone(), domain: xd },
        }
    }

    /// Lane centre (model Y) of local series `i`: position 0 at the back.
    fn lane(&self, i: usize) -> f64 {
        let n = self.series.len().max(1) as f64;
        0.5 - (self.pos[i] as f64 + 0.5) / n
    }

    /// Ribbons draw from their reversed copy when high x is farther from the viewer.
    fn reversed(&self) -> bool {
        self.rotation.to_radians().sin() > 1e-6
    }

    /// The floor corner (X, Y) leftmost on screen: where the value axis stands.
    fn axis_corner(&self) -> [f64; 2] {
        let cam = camera(self.rotation, [0.0, 0.0, 1.0, 1.0]);
        let mut best = ([-0.5, -0.5], f64::INFINITY);
        for x in [-0.5, 0.5] {
            for y in [-0.5, 0.5] {
                let p = cam.project([x, y, 0.0]);
                if p[0] < best.1 - 1e-9 {
                    best = ([x, y], p[0]);
                }
            }
        }
        best.0
    }

    /// Back-to-front lane order for the current rotation.
    fn lane_order(&self) -> Vec<usize> {
        let cos = self.rotation.to_radians().cos();
        let mut order: Vec<usize> = (0..self.series.len()).collect();
        // Larger rotated depth (lane * cos) is farther: draw it first.
        order.sort_by(|&a, &b| (self.lane(b) * cos).total_cmp(&(self.lane(a) * cos)));
        order
    }
}

/// Bring a series' reversed copy up to date: prepend new points (uploading only them), or
/// rebuild with headroom when the order changed or the buffer is full.
fn sync_reversed(s: &mut Series, gpu: &mut Gpu, rewrite: bool) {
    let n = s.pts.len();
    let have = s.rev.len() - s.rev_start;
    if n == have && !rewrite {
        return;
    }
    if rewrite || s.rev_gpu.id == 0 || n > s.rev.len() || have > n {
        let cap = (n * 2).next_power_of_two().max(256);
        s.rev.clear();
        s.rev.resize(cap - n, [MISSING, MISSING]);
        s.rev.extend(s.pts.iter().rev());
        s.rev_start = cap - n;
        s.rev_gpu.sync(gpu, as_bytes(&s.rev), KIND_VERTEX, true);
        return;
    }
    let new = n - have;
    let start = s.rev_start - new;
    for (k, p) in s.pts[have..].iter().enumerate() {
        s.rev[s.rev_start - 1 - k] = *p;
    }
    s.rev_start = start;
    let bytes = as_bytes(&s.rev[start..start + new]);
    gpu.words.extend_from_slice(&[crate::gpu::op::BUF_WRITE, s.rev_gpu.id, start as u32 * 8, bytes.as_ptr() as usize as u32, bytes.len() as u32]);
}

impl Family for Matrix {
    fn handles(&self, view: View) -> bool {
        matches!(view, View::Heatmap | View::Surface)
    }

    fn ingest(&mut self, store: &Store, from: usize, to: usize) {
        self.cats = store.x_labels.len();
        let Some(value) = store.value.as_deref() else { return };
        let rows = match self.rows_from {
            Some(k) => store.measures.get(k).map(|v| &v[..]),
            None => None,
        };
        let ids = store.series.as_deref();
        if rows.is_none() && ids.is_none() {
            return;
        }
        for i in from..to {
            let x = match &store.x {
                Some(XValues::Time(v)) if v[i] == NULL_TIME => continue,
                Some(XValues::Time(v)) => v[i] as f64 / 1000.0,
                Some(XValues::Num(v)) if v[i].is_nan() => continue,
                Some(XValues::Num(v)) => v[i],
                Some(XValues::Cat(v)) => v[i] as f64,
                None => continue,
            };
            let s = match (rows, ids) {
                (Some(r), _) => self.local_row(r[i]).0,
                (None, Some(ids)) => self.local_series(ids[i], store),
                (None, None) => unreachable!(),
            };
            self.push(s, x, value[i]);
        }
    }

    fn points(&self) -> u32 {
        self.points
    }

    fn upload(&mut self, view: View, gpu: &mut Gpu) {
        let reversed = view == View::Surface && self.reversed();
        for s in &mut self.series {
            // Ribbons need x order; cells don't care, but one order serves both views.
            if !s.sorted {
                s.pts.sort_by(|a, b| a[0].total_cmp(&b[0]));
                s.sorted = true;
                s.rewrite = true;
                s.last_x = s.pts.last().map_or(0.0, |p| p[0]);
            }
            let rewrite = std::mem::take(&mut s.rewrite);
            s.gpu.sync(gpu, as_bytes(&s.pts), KIND_VERTEX, rewrite);
            if reversed {
                sync_reversed(s, gpu, rewrite);
            }
        }
        if view == View::Surface {
            let xd = self.x_display(view);
            let vd = self.v_display(view);
            let vo = self.v_origin.unwrap_or(0.0);
            let (vlo, vhi) = ((vd.lo - vo) as f32, (vd.hi - vo) as f32);
            let xc = if self.axis_corner()[0] < 0.0 { xd.lo } else { xd.hi } as f32;
            let guides = [[xc, vlo], [xc, vhi], [xd.lo as f32, vlo], [xd.hi as f32, vlo]];
            let changed = guides != self.guides || self.guides_gpu.id == 0;
            self.guides = guides;
            self.guides_gpu.sync(gpu, as_bytes(&self.guides), KIND_VERTEX, changed);
        }
    }

    fn axes(&self, view: View, store: &Store) -> AxisModel {
        let xd = self.x_display(view);
        let vd = self.v_display(view);
        match view {
            View::Heatmap => {
                // Rows top to bottom in display order: the label at position j sits on row j.
                let labels: Vec<String> = self.ordered_labels().into_iter().rev().collect();
                let n = labels.len().max(1) as f64;
                let (ticks, step) = linear_ticks(vd, 5);
                let legend = ticks
                    .into_iter()
                    .map(|v| {
                        let c = viridis((v - vd.lo) / vd.span().max(1e-300));
                        (format_number(v, step), rgb_index([(c[0] * 255.0).round() as u8, (c[1] * 255.0).round() as u8, (c[2] * 255.0).round() as u8]))
                    })
                    .collect();
                AxisModel { x: self.x_scale(xd, store), y: AxisScale::Category { labels, domain: Domain::new(-0.5, n - 0.5) }, legend }
            }
            _ => AxisModel {
                x: self.x_scale(xd, store),
                y: AxisScale::Linear(vd),
                legend: self.ordered_labels().into_iter().enumerate().map(|(i, l)| (l, i)).collect(),
            },
        }
    }

    /// Surface: project the 2D tick positions onto the box — x ticks along the front floor
    /// edge, value ticks up the axis corner — and drop the 2D grid (it would lie in 3D).
    fn place_axes(&self, view: View, axes: &mut AxesOut) -> bool {
        if view != View::Surface {
            return true;
        }
        let p = axes.plot;
        let (l, t, w, h) = (p.left as f64, p.top as f64, p.width as f64, p.height as f64);
        let cam = camera(self.rotation, [l, t, w, h]);
        // Front edge: the floor edge along x nearest the viewer.
        let front = if cam.cos >= 0.0 { -0.5 } else { 0.5 };
        let mut x: Vec<(f32, String)> = Vec::new();
        let mut placed: Vec<f64> = Vec::new();
        for (at, label) in axes.x.drain(..) {
            let f = (at as f64 - l) / w.max(1e-9);
            let sx = cam.project([f - 0.5, front, 0.0])[0];
            // Keep labels apart; edge-on rotations squeeze x into a few pixels.
            if sx < l - 0.5 || sx > l + w + 0.5 || placed.iter().any(|&q| (q - sx).abs() < 56.0) {
                continue;
            }
            placed.push(sx);
            x.push((sx as f32, label));
        }
        axes.x = x;
        let corner = self.axis_corner();
        let mut y: Vec<(f32, String)> = Vec::new();
        for (at, label) in axes.y.drain(..) {
            let g = (t + h - at as f64) / h.max(1e-9);
            let sy = cam.project([corner[0], corner[1], g * HEIGHT])[1];
            if sy >= t - 0.5 && sy <= t + h + 0.5 {
                y.push((sy as f32, label));
            }
        }
        axes.y = y;
        axes.zero = None;
        false
    }

    fn draw(&mut self, view: View, f: &mut DrawFrame) {
        let xd = self.x_display(view);
        let vd = self.v_display(view);
        let vo = self.v_origin.unwrap_or(0.0);
        let (vlo, vhi) = ((vd.lo - vo) as f32, (vd.hi - vo) as f32);
        let canvas = [f.canvas[0], f.canvas[1], f.dpr, 0.0];
        let [cell, ribbon] = self.pipes;
        let n = self.series.len();
        match view {
            View::Heatmap => {
                let row_px = f.plot[3] / n.max(1) as f32;
                let gap = if row_px >= 6.0 * f.dpr { f.dpr.round().max(1.0) } else { 0.0 };
                let base = Uniform {
                    domain: [xd.lo as f32, xd.hi as f32, -0.5, n.max(1) as f32 - 0.5],
                    plot: f.plot,
                    canvas,
                    b: [vlo, vhi, 0.0, 0.0],
                    ..Default::default()
                };
                let (offset, width) = (self.cell_offset() as f32, self.bucket() as f32);
                for (i, s) in self.series.iter().enumerate() {
                    if s.pts.is_empty() {
                        continue;
                    }
                    f.pass.pipeline(cell);
                    f.pass.vertex_buffer(0, s.gpu.id, 0);
                    f.pass.uniform(&Uniform { a: [(n - 1 - self.pos[i]) as f32, offset, width, gap], ..base });
                    f.pass.draw(4, s.pts.len() as u32);
                }
            }
            View::Surface => {
                let plot = [f.plot[0] as f64, f.plot[1] as f64, f.plot[2] as f64, f.plot[3] as f64];
                let cam = camera(self.rotation, plot);
                let max_gap = if self.mode == XMode::Cat { 1.5 } else { self.bucket() * 1.5 } as f32;
                let base = Uniform {
                    domain: [xd.lo as f32, xd.hi as f32, vlo, vhi],
                    plot: f.plot,
                    canvas,
                    a: [cam.cos as f32, cam.sin as f32, 0.0, 0.0],
                    b: [cam.scale as f32, cam.cx as f32, cam.cy as f32, max_gap],
                    ..Default::default()
                };
                let half = (0.36 / n.max(1) as f64) as f32;
                let floor = Uniform { canvas: [canvas[0], canvas[1], canvas[2], 1.0], ..base };
                let guide = [0.50 * 0.55, 0.59 * 0.55, 0.64 * 0.55, 0.55];
                // Floor: lane footprints (gaps show), then the near and far floor edges.
                f.pass.pipeline(ribbon);
                for (i, s) in self.series.iter().enumerate() {
                    if s.pts.len() < 2 {
                        continue;
                    }
                    f.pass.vertex_buffer(0, s.gpu.id, 0);
                    f.pass.vertex_buffer(1, s.gpu.id, 8);
                    f.pass.uniform(&Uniform { color: [0.5 * 0.16, 0.59 * 0.16, 0.64 * 0.16, 0.16], a: [base.a[0], base.a[1], self.lane(i) as f32, half], ..floor });
                    f.pass.draw(4, s.pts.len() as u32 - 1);
                }
                let g = self.guides_gpu.id;
                let line = Uniform { canvas: [canvas[0], canvas[1], canvas[2], 2.0], color: guide, b: [base.b[0], base.b[1], base.b[2], f32::MAX], ..base };
                let width = f.dpr.max(1.0);
                if g != 0 {
                    f.pass.vertex_buffer(0, g, 16);
                    f.pass.vertex_buffer(1, g, 24);
                    for y in [-0.5f32, 0.5] {
                        f.pass.uniform(&Uniform { a: [base.a[0], base.a[1], y, width], ..line });
                        f.pass.draw(4, 1);
                    }
                }
                // Ribbons, back to front.
                let reversed = self.reversed();
                for i in self.lane_order() {
                    let s = &self.series[i];
                    if s.pts.len() < 2 {
                        continue;
                    }
                    let (id, at) = if reversed { (s.rev_gpu.id, s.rev_start as u32 * 8) } else { (s.gpu.id, 0) };
                    f.pass.vertex_buffer(0, id, at);
                    f.pass.vertex_buffer(1, id, at + 8);
                    f.pass.uniform(&Uniform { color: palette_rgba(self.pos[i], 1.0), a: [base.a[0], base.a[1], self.lane(i) as f32, half], ..base });
                    f.pass.draw(4, s.pts.len() as u32 - 1);
                }
                // Value axis at the leftmost floor corner, drawn last so it stays visible.
                if g != 0 {
                    let corner = self.axis_corner();
                    f.pass.vertex_buffer(0, g, 0);
                    f.pass.vertex_buffer(1, g, 8);
                    f.pass.uniform(&Uniform { a: [base.a[0], base.a[1], corner[1] as f32, width], ..line });
                    f.pass.draw(4, 1);
                }
            }
            _ => {}
        }
    }

    fn set_param(&mut self, name: &str, value: f64) -> bool {
        if name != "rotation" || !value.is_finite() {
            return false;
        }
        let r = value.clamp(-180.0, 180.0);
        let changed = r != self.rotation;
        self.rotation = r;
        changed
    }

    fn reset_params(&mut self) -> bool { self.set_param("rotation", DEFAULT_ROTATION) }

    fn release(&mut self, gpu: &mut Gpu) {
        for s in &mut self.series {
            s.gpu.release(gpu);
            s.rev_gpu.release(gpu);
        }
        self.guides_gpu.release(gpu);
    }
}

// ───────────────────────── pipelines ─────────────────────────

macro_rules! viridis_wgsl {
    () => {
        r#"
fn viridis(t: f32) -> vec3f {
  let c0 = vec3f(0.2777273272234177, 0.005407344544966578, 0.3340998053353061);
  let c1 = vec3f(0.1050930431085774, 1.404613529898575, 1.384590162594685);
  let c2 = vec3f(-0.3308618287255563, 0.214847559468213, 0.09509516302823659);
  let c3 = vec3f(-4.634230498983486, -5.799100973351585, -19.33244095627987);
  let c4 = vec3f(6.228269936347081, 14.17993336680509, 56.69055260068105);
  let c5 = vec3f(4.776384997670288, -13.74514537774601, -65.35303263337234);
  let c6 = vec3f(-5.435455855934631, 4.645852612178535, 26.3124352495832);
  return clamp(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))), vec3f(0.0), vec3f(1.0));
}
"#
    };
}

macro_rules! viridis_glsl {
    () => {
        r#"
vec3 viridis(float t) {
  const vec3 c0 = vec3(0.2777273272234177, 0.005407344544966578, 0.3340998053353061);
  const vec3 c1 = vec3(0.1050930431085774, 1.404613529898575, 1.384590162594685);
  const vec3 c2 = vec3(-0.3308618287255563, 0.214847559468213, 0.09509516302823659);
  const vec3 c3 = vec3(-4.634230498983486, -5.799100973351585, -19.33244095627987);
  const vec3 c4 = vec3(6.228269936347081, 14.17993336680509, 56.69055260068105);
  const vec3 c5 = vec3(4.776384997670288, -13.74514537774601, -65.35303263337234);
  const vec3 c6 = vec3(-5.435455855934631, 4.645852612178535, 26.3124352495832);
  return clamp(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))), vec3(0.0), vec3(1.0));
}
"#
    };
}

const POINT_LAYOUT: &[BufferLayout] = &[BufferLayout { stride: 8, instance: true, attrs: &[Attr { location: 0, format: Format::Float32x2, offset: 0 }] }];

/// Heatmap cell. Uniform: domain = x window × row window; a = [row, cell offset, cell width,
/// row gap px]; b = [value lo, value hi] (relative).
pub static CELL: PipelineDesc = PipelineDesc {
    name: "matrix.cell",
    strip: true,
    buffers: POINT_LAYOUT,
    wgsl: concat!(
        viridis_wgsl!(),
        r#"
struct CellOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) t: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) p: vec2f) -> CellOut {
  var o: CellOut;
  if (missing(p)) { o.pos = OUTSIDE; o.t = 0.0; return o; }
  let x0 = p.x + u.a.y;
  let lo = to_px(vec2f(x0, u.a.x - 0.5));
  let hi = to_px(vec2f(x0 + u.a.z, u.a.x + 0.5));
  // Shared edges snap to the same device pixel: no seams, no double-blended overlaps.
  let l = round(min(lo.x, hi.x));
  let r = max(round(max(lo.x, hi.x)), l + 1.0);
  let top = round(min(lo.y, hi.y));
  var bottom = max(round(max(lo.y, hi.y)), top + 1.0);
  bottom = max(bottom - u.a.w, top + 1.0);
  var corners = CORNERS;
  let k = corners[vi];
  o.pos = to_clip(vec2f(select(l, r, k.x > 0.0), select(top, bottom, k.y > 0.0)));
  o.t = clamp((p.y - u.b.x) / max(u.b.y - u.b.x, 1e-30), 0.0, 1.0);
  return o;
}
@fragment fn fs(i: CellOut) -> @location(0) vec4f { return vec4f(viridis(i.t), 1.0); }
"#
    ),
    vert: r#"
layout(location = 0) in vec2 p;
flat out float t;
void main() {
  if (missing(p)) { gl_Position = OUTSIDE; t = 0.0; return; }
  float x0 = p.x + u.a.y;
  vec2 lo = to_px(vec2(x0, u.a.x - 0.5));
  vec2 hi = to_px(vec2(x0 + u.a.z, u.a.x + 0.5));
  float l = floor(min(lo.x, hi.x) + 0.5);
  float r = max(floor(max(lo.x, hi.x) + 0.5), l + 1.0);
  float top = floor(min(lo.y, hi.y) + 0.5);
  float bottom = max(floor(max(lo.y, hi.y) + 0.5), top + 1.0);
  bottom = max(bottom - u.a.w, top + 1.0);
  vec2 k = CORNERS[gl_VertexID];
  gl_Position = to_clip(vec2(k.x > 0.0 ? r : l, k.y > 0.0 ? bottom : top));
  t = clamp((p.y - u.b.x) / max(u.b.y - u.b.x, 1e-30), 0.0, 1.0);
}
"#,
    frag: concat!(
        viridis_glsl!(),
        r#"
flat in float t;
void main() { frag = vec4(viridis(t), 1.0); }
"#
    ),
};

/// Surface ribbon segment (point i → i+1 of one series). Uniform: domain = x window × value
/// window (relative); a = [cos θ, sin θ, lane Y, lane half width]; b = [scale px, centre x,
/// centre y, max x gap]; canvas.w = 1 flattens to the floor, 2 draws a 3D guide line a.w
/// device px wide; color = premultiplied RGBA.
pub static RIBBON: PipelineDesc = PipelineDesc {
    name: "matrix.ribbon",
    strip: true,
    buffers: &[
        BufferLayout { stride: 8, instance: true, attrs: &[Attr { location: 0, format: Format::Float32x2, offset: 0 }] },
        BufferLayout { stride: 8, instance: true, attrs: &[Attr { location: 1, format: Format::Float32x2, offset: 0 }] },
    ],
    wgsl: r#"
const SIN_ELEV: f32 = 0.5;
const COS_ELEV: f32 = 0.8660254;
const DIST: f32 = 3.0;
const HEIGHT: f32 = 0.55;
const LIGHT = vec3f(-0.3713907, -0.5570860, 0.7427814);
fn xn(x: f32) -> f32 { return (x - u.domain.x) / (u.domain.y - u.domain.x) - 0.5; }
fn zn(v: f32) -> f32 { return clamp((v - u.domain.z) / (u.domain.w - u.domain.z), 0.0, 1.0) * HEIGHT; }
fn project(m: vec3f) -> vec2f {
  let xr = m.x * u.a.x - m.y * u.a.y;
  let yr = m.x * u.a.y + m.y * u.a.x;
  let z = m.z - HEIGHT * 0.5;
  let up = z * COS_ELEV + yr * SIN_ELEV;
  let k = DIST / (DIST + yr * COS_ELEV - z * SIN_ELEV);
  return vec2f(u.b.y + xr * k * u.b.x, u.b.z - up * k * u.b.x);
}
struct RibbonOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) shade: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec2f, @location(1) b: vec2f) -> RibbonOut {
  var o: RibbonOut;
  o.shade = 1.0;
  if (missing(a) || missing(b) || abs(b.x - a.x) > u.b.w) { o.pos = OUTSIDE; return o; }
  var corners = CORNERS;
  let k = corners[vi];
  if (u.canvas.w > 1.5) {
    // 3D guide line, u.a.w device px wide.
    let pa = project(vec3f(xn(a.x), u.a.z, zn(a.y)));
    let pb = project(vec3f(xn(b.x), u.a.z, zn(b.y)));
    let d = pb - pa;
    var dir = vec2f(1.0, 0.0);
    if (length(d) > 1e-4) { dir = normalize(d); }
    o.pos = to_clip(select(pa, pb, k.x > 0.0) + vec2f(-dir.y, dir.x) * k.y * u.a.w * 0.5);
    return o;
  }
  let flat_floor = u.canvas.w > 0.5;
  let za = select(zn(a.y), 0.0, flat_floor);
  let zb = select(zn(b.y), 0.0, flat_floor);
  let p = select(a, b, k.x > 0.0);
  let z = select(za, zb, k.x > 0.0);
  o.pos = to_clip(project(vec3f(xn(p.x), u.a.z + k.y * u.a.w, z)));
  let dx = xn(b.x) - xn(a.x);
  var n = vec3f(0.0, 0.0, 1.0);
  if (abs(dx) > 1e-9) { n = normalize(vec3f(za - zb, 0.0, dx) * sign(dx)); }
  let nr = vec3f(n.x * u.a.x, n.x * u.a.y, n.z);
  o.shade = select(0.5 + 0.5 * max(dot(nr, LIGHT), 0.0), 1.0, flat_floor);
  return o;
}
@fragment fn fs(i: RibbonOut) -> @location(0) vec4f { return vec4f(u.color.rgb * i.shade, u.color.a); }
"#,
    vert: r#"
layout(location = 0) in vec2 a;
layout(location = 1) in vec2 b;
flat out float shade;
const float SIN_ELEV = 0.5;
const float COS_ELEV = 0.8660254;
const float DIST = 3.0;
const float HEIGHT = 0.55;
const vec3 LIGHT = vec3(-0.3713907, -0.5570860, 0.7427814);
float xn(float x) { return (x - u.domain.x) / (u.domain.y - u.domain.x) - 0.5; }
float zn(float v) { return clamp((v - u.domain.z) / (u.domain.w - u.domain.z), 0.0, 1.0) * HEIGHT; }
vec2 project(vec3 m) {
  float xr = m.x * u.a.x - m.y * u.a.y;
  float yr = m.x * u.a.y + m.y * u.a.x;
  float z = m.z - HEIGHT * 0.5;
  float up = z * COS_ELEV + yr * SIN_ELEV;
  float k = DIST / (DIST + yr * COS_ELEV - z * SIN_ELEV);
  return vec2(u.b.y + xr * k * u.b.x, u.b.z - up * k * u.b.x);
}
void main() {
  shade = 1.0;
  if (missing(a) || missing(b) || abs(b.x - a.x) > u.b.w) { gl_Position = OUTSIDE; return; }
  vec2 k = CORNERS[gl_VertexID];
  if (u.canvas.w > 1.5) {
    vec2 pa = project(vec3(xn(a.x), u.a.z, zn(a.y)));
    vec2 pb = project(vec3(xn(b.x), u.a.z, zn(b.y)));
    vec2 d = pb - pa;
    vec2 dir = length(d) > 1e-4 ? normalize(d) : vec2(1.0, 0.0);
    gl_Position = to_clip((k.x > 0.0 ? pb : pa) + vec2(-dir.y, dir.x) * k.y * u.a.w * 0.5);
    return;
  }
  bool flat_floor = u.canvas.w > 0.5;
  float za = flat_floor ? 0.0 : zn(a.y);
  float zb = flat_floor ? 0.0 : zn(b.y);
  vec2 p = k.x > 0.0 ? b : a;
  float z = k.x > 0.0 ? zb : za;
  gl_Position = to_clip(project(vec3(xn(p.x), u.a.z + k.y * u.a.w, z)));
  float dx = xn(b.x) - xn(a.x);
  vec3 n = vec3(0.0, 0.0, 1.0);
  if (abs(dx) > 1e-9) { n = normalize(vec3(za - zb, 0.0, dx) * sign(dx)); }
  vec3 nr = vec3(n.x * u.a.x, n.x * u.a.y, n.z);
  shade = flat_floor ? 1.0 : 0.5 + 0.5 * max(dot(nr, LIGHT), 0.0);
}
"#,
    frag: r#"
flat in float shade;
void main() { frag = vec4(u.color.rgb * shade, u.color.a); }
"#,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::axes::layout;
    use crate::gpu::{op, PassRecorder, Pool};
    use crate::schema::{infer_roles, ColumnInfo, ColumnType, TypeCode};
    use crate::store::RawColumn;
    use crate::view::{available_views, choose_view, pipeline_table};

    /// Arrow-like utf8 column bytes: (offsets, text).
    fn utf8(values: &[&str]) -> (Vec<u8>, Vec<u8>) {
        let mut offsets = vec![0i32];
        for v in values {
            offsets.push(offsets.last().unwrap() + v.len() as i32);
        }
        (offsets.iter().flat_map(|o| o.to_le_bytes()).collect(), values.concat().into_bytes())
    }

    /// Tests leak their tiny buffers to keep `RawColumn` lifetimes simple.
    fn leak(v: Vec<u8>) -> &'static [u8] {
        Box::leak(v.into_boxed_slice())
    }

    fn text(index: usize, rows: usize, off: &[u8], data: &[u8]) -> RawColumn<'static> {
        RawColumn { index, code: TypeCode::Utf8, param: 0, rows, data: leak(data.to_vec()), validity: None, bit_offset: 0, offsets: leak(off.to_vec()), dict: None }
    }

    fn values(index: usize, v: &[Option<f64>]) -> RawColumn<'static> {
        let data: Vec<u8> = v.iter().flat_map(|x| x.unwrap_or(0.0).to_le_bytes()).collect();
        let mut bits = vec![0u8; (v.len() + 7) / 8];
        for (i, x) in v.iter().enumerate() {
            if x.is_some() {
                bits[i / 8] |= 1 << (i % 8);
            }
        }
        RawColumn { index, code: TypeCode::F64, param: 0, rows: v.len(), data: leak(data), validity: Some((leak(bits), 0)), bit_offset: 0, offsets: &[], dict: None }
    }

    fn time_columns() -> Vec<ColumnInfo> {
        vec![
            ColumnInfo { name: "ts".into(), ty: ColumnType { code: TypeCode::Timestamp, param: 1 } },
            ColumnInfo { name: "station".into(), ty: ColumnType { code: TypeCode::Utf8, param: 0 } },
            ColumnInfo { name: "v".into(), ty: ColumnType { code: TypeCode::F64, param: 0 } },
        ]
    }

    /// Raw columns for rows (ms timestamp, series, value).
    fn raw_time(rows: &[(i64, &str, Option<f64>)]) -> Vec<RawColumn<'static>> {
        let ts = leak(rows.iter().flat_map(|r| r.0.to_le_bytes()).collect());
        let names: Vec<&str> = rows.iter().map(|r| r.1).collect();
        let (off, data) = utf8(&names);
        let n = rows.len();
        let x = RawColumn { index: 0, code: TypeCode::Timestamp, param: 1, rows: n, data: ts, validity: None, bit_offset: 0, offsets: &[], dict: None };
        let v: Vec<Option<f64>> = rows.iter().map(|r| r.2).collect();
        vec![x, text(1, n, &off, &data), values(2, &v)]
    }

    fn time_store(rows: &[(i64, &str, Option<f64>)]) -> Store {
        let cols = time_columns();
        let mut store = Store::new(cols.clone(), infer_roles(&cols));
        store.append(rows.len(), &raw_time(rows));
        store
    }

    /// `series` series × `buckets` minute buckets, ordered by time then series.
    fn grid_rows(series: usize, buckets: usize) -> Vec<(i64, String, Option<f64>)> {
        let mut rows = Vec::new();
        for b in 0..buckets {
            for s in 0..series {
                rows.push((1_760_000_000_000 + b as i64 * 60_000, format!("s{s:02}"), Some((b as f64 / 10.0).sin() + s as f64)));
            }
        }
        rows
    }

    fn as_ref(rows: &[(i64, String, Option<f64>)]) -> Vec<(i64, &str, Option<f64>)> {
        rows.iter().map(|r| (r.0, r.1.as_str(), r.2)).collect()
    }

    fn upload(m: &mut Matrix, view: View, next_id: u32) -> Vec<u32> {
        let mut words = Vec::new();
        let mut next = next_id;
        let mut pool = Pool::default();
        m.upload(view, &mut Gpu { words: &mut words, next_id: &mut next, pool: &mut pool });
        words
    }

    fn uniforms(pass: &PassRecorder) -> Vec<Uniform> {
        pass.uniforms
            .chunks(crate::gpu::UNIFORM_STRIDE)
            .map(|c| {
                let f: Vec<f32> = c[..96].chunks(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
                let v = |k: usize| [f[k], f[k + 1], f[k + 2], f[k + 3]];
                Uniform { domain: v(0), plot: v(4), canvas: v(8), color: v(12), a: v(16), b: v(20) }
            })
            .collect()
    }

    fn draw(m: &mut Matrix, view: View, plot: [f32; 4]) -> PassRecorder {
        let mut pass = PassRecorder::default();
        let axes = AxesOut::default();
        m.draw(view, &mut DrawFrame { pass: &mut pass, plot, canvas: [plot[0] * 2.0 + plot[2], plot[1] * 2.0 + plot[3]], dpr: 1.0, axes: &axes });
        pass
    }

    fn roles(cols: &[(&str, TypeCode)]) -> Roles {
        let c: Vec<ColumnInfo> = cols.iter().map(|(n, t)| ColumnInfo { name: n.to_string(), ty: ColumnType { code: *t, param: 1 } }).collect();
        infer_roles(&c)
    }

    #[test]
    fn applicability_keeps_line_default_and_never_picks_surface() {
        let tsv = roles(&[("ts", TypeCode::Timestamp), ("station", TypeCode::Utf8), ("v", TypeCode::F64)]);
        let a = available_views(&tsv);
        assert_eq!(a[..5], [View::Line, View::Bar, View::Scatter, View::Heatmap, View::Surface]);
        assert_eq!(choose_view(&a, None), View::Line);
        assert_eq!(choose_view(&a, Some(View::Surface)), View::Surface);
        // category × category × value: a 2-category heatmap is offered after bars.
        let cc = roles(&[("weekday", TypeCode::Utf8), ("site", TypeCode::Utf8), ("n", TypeCode::I64)]);
        assert_eq!(available_views(&cc)[..4], [View::Bar, View::Line, View::Scatter, View::Heatmap]);
        // No series column, or no value: no matrix views.
        let tv = roles(&[("ts", TypeCode::Timestamp), ("v", TypeCode::F64)]);
        assert!(!available_views(&tv).contains(&View::Heatmap));
        let ts = roles(&[("ts", TypeCode::Timestamp), ("station", TypeCode::Utf8)]);
        assert!(!available_views(&ts).contains(&View::Heatmap));
    }

    #[test]
    fn many_series_prefer_heatmap() {
        let few = grid_rows(12, 2);
        let store = time_store(&as_ref(&few));
        let mut v = available_views(&store.roles);
        refine(&store, &mut v);
        assert_eq!(v[0], View::Line, "12 series stay lines");
        let many = grid_rows(13, 2);
        let store = time_store(&as_ref(&many));
        let mut v = available_views(&store.roles);
        refine(&store, &mut v);
        assert_eq!(v[..3], [View::Heatmap, View::Line, View::Bar]);
        assert_eq!(*v.last().unwrap(), View::Table);
    }

    #[test]
    fn heatmap_cells_and_streaming_color_domain() {
        let t0 = 1_760_000_000_000i64;
        let mut store = time_store(&[(t0, "a", Some(1.0)), (t0, "b", Some(5.0)), (t0 + 60_000, "a", None), (t0 + 120_000, "a", Some(3.0))]);
        let pipes = pipeline_table();
        let mut m = Matrix::new(&store.roles, &pipes);
        m.ingest(&store, 0, store.rows);
        assert_eq!(m.points(), 3);
        assert_eq!(m.series[0].pts, vec![[0.0, 0.0], [60_000.0, MISSING], [120_000.0, 2.0]]);
        assert_eq!(m.series[1].pts, vec![[0.0, 4.0]]);
        assert_eq!(m.bucket(), 60_000.0);
        assert_eq!(m.cell_offset(), 0.0, "time buckets start at their timestamp");
        assert_eq!(m.x_display(View::Heatmap), Domain::new(0.0, 180_000.0));
        assert_eq!(m.v_display(View::Heatmap), Domain::new(1.0, 5.0));
        let model = m.axes(View::Heatmap, &store);
        assert_eq!(model.x, AxisScale::Time { lo: t0 * 1000, hi: (t0 + 180_000) * 1000 });
        assert_eq!(model.y, AxisScale::Category { labels: vec!["b".into(), "a".into()], domain: Domain::new(-0.5, 1.5) });
        assert!(model.legend.iter().all(|(_, c)| *c >= crate::axes::RGB_FLAG), "legend is a colour scale");
        assert_eq!(model.legend.first().unwrap().0, "1");
        let words = upload(&mut m, View::Heatmap, 0);
        assert_eq!(words[0], op::BUF_CREATE);
        assert!(m.series.iter().all(|s| s.gpu.id != 0 && s.gpu.uploaded == s.pts.len() as u32 * 8));
        let pass = draw(&mut m, View::Heatmap, [10.0, 10.0, 300.0, 200.0]);
        let u = uniforms(&pass);
        assert_eq!(u.len(), 2, "one draw per series row: {u:?}");
        assert_eq!(u[0].a, [1.0, 0.0, 60_000.0, 1.0], "series a: top row, bucket width, 1px row gap");
        assert_eq!(u[1].a[0], 0.0);
        assert_eq!(u[0].b[..2], [0.0, 4.0], "colour domain relative to the first value (1)");
        assert_eq!(pass.draws, 2);
        // A later batch with a larger value: only the tail uploads; the colour domain is a uniform.
        let before = m.series[0].gpu.uploaded;
        let rows = [(t0 + 180_000, "a", Some(11.0))];
        store.append(1, &raw_time(&rows));
        m.ingest(&store, 4, store.rows);
        let words = upload(&mut m, View::Heatmap, 100);
        assert_eq!(words.len(), 5);
        assert_eq!([words[0], words[1], words[2], words[4]], [op::BUF_WRITE, m.series[0].gpu.id, before, 8], "tail only");
        let u = uniforms(&draw(&mut m, View::Heatmap, [10.0, 10.0, 300.0, 200.0]));
        assert_eq!(u[0].b[..2], [0.0, 10.0]);
        assert_eq!(u[0].domain[..2], [0.0, 240_000.0]);
    }

    #[test]
    fn category_heatmap_centres_cells() {
        let cols = vec![
            ColumnInfo { name: "weekday".into(), ty: ColumnType { code: TypeCode::Utf8, param: 0 } },
            ColumnInfo { name: "site".into(), ty: ColumnType { code: TypeCode::Utf8, param: 0 } },
            ColumnInfo { name: "v".into(), ty: ColumnType { code: TypeCode::F64, param: 0 } },
        ];
        let mut store = Store::new(cols.clone(), infer_roles(&cols));
        let (xo, xd) = utf8(&["mon", "mon", "tue", "wed"]);
        let (so, sd) = utf8(&["x", "y", "x", "y"]);
        store.append(4, &[text(0, 4, &xo, &xd), text(1, 4, &so, &sd), values(2, &[Some(1.0), Some(2.0), Some(3.0), Some(4.0)])]);
        let pipes = pipeline_table();
        let mut m = Matrix::new(&store.roles, &pipes);
        m.ingest(&store, 0, 4);
        assert_eq!(m.x_display(View::Heatmap), Domain::new(-0.5, 2.5));
        assert_eq!(m.cell_offset(), -0.5);
        assert_eq!(m.series[1].pts, vec![[0.0, 1.0], [2.0, 3.0]]);
        match m.axes(View::Heatmap, &store).x {
            AxisScale::Category { labels, .. } => assert_eq!(labels, ["mon", "tue", "wed"]),
            other => panic!("{other:?}"),
        }
    }

    fn num_columns(code: TypeCode) -> Vec<ColumnInfo> {
        ["hour", "dow", "avg_delay"].iter().map(|n| ColumnInfo { name: n.to_string(), ty: ColumnType { code, param: 0 } }).collect()
    }

    /// Raw columns for numeric rows (x, row, value), all of `code` (I64 or F64).
    fn raw_num(code: TypeCode, rows: &[(f64, f64, f64)]) -> Vec<RawColumn<'static>> {
        let col = |index: usize, f: &dyn Fn(&(f64, f64, f64)) -> f64| {
            let data: Vec<u8> = match code {
                TypeCode::I64 => rows.iter().flat_map(|r| (f(r) as i64).to_le_bytes()).collect(),
                _ => rows.iter().flat_map(|r| f(r).to_le_bytes()).collect(),
            };
            RawColumn { index, code, param: 0, rows: rows.len(), data: leak(data), validity: None, bit_offset: 0, offsets: &[], dict: None }
        };
        vec![col(0, &|r| r.0), col(1, &|r| r.1), col(2, &|r| r.2)]
    }

    fn num_store(code: TypeCode, rows: &[(f64, f64, f64)]) -> Store {
        let cols = num_columns(code);
        let mut store = Store::new(cols.clone(), infer_roles(&cols));
        store.append(rows.len(), &raw_num(code, rows));
        store
    }

    /// hour × dow → value, in `ORDER BY` value: rows (dow) arrive out of numeric order.
    fn week_rows() -> Vec<(f64, f64, f64)> {
        let mut rows = Vec::new();
        for h in 0..24 {
            for d in [3, 6, 0, 5, 1, 4, 2] {
                rows.push((h as f64, d as f64, (h * 7 + d) as f64 * 0.5));
            }
        }
        rows
    }

    #[test]
    fn numeric_grid_is_recognised_from_the_rows() {
        // hour × dow, integer typed: heatmap becomes the automatic choice.
        let store = num_store(TypeCode::I64, &week_rows());
        let mut v = available_views(&store.roles);
        assert_eq!(v[0], View::Bar);
        refine(&store, &mut v);
        assert_eq!(v[..2], [View::Heatmap, View::Bar]);
        // The same grid as doubles (engines whose EXTRACT returns DOUBLE): scatter at schema
        // time, heatmap once the values are seen to be integers.
        let store = num_store(TypeCode::F64, &week_rows());
        let mut v = available_views(&store.roles);
        assert_eq!(v[0], View::Scatter);
        refine(&store, &mut v);
        assert_eq!(v[0], View::Heatmap);
        // Per-hour count + average (`hour, n, avg`): x never repeats, so no grid; bars stay and
        // the matrix views leave the menu.
        let per_hour: Vec<(f64, f64, f64)> = (0..24).map(|h| (h as f64, (100 + h % 5) as f64, h as f64)).collect();
        let store = num_store(TypeCode::I64, &per_hour);
        let mut v = available_views(&store.roles);
        refine(&store, &mut v);
        assert_eq!(v, [View::Bar, View::Line, View::Scatter, View::Table]);
        // Non-integer middle values are no row dimension: matrix views are dropped.
        let wind: Vec<(f64, f64, f64)> = (0..24).flat_map(|h| [(h as f64, 3.25, 1.0), (h as f64, 7.5, 2.0)]).collect();
        let store = num_store(TypeCode::F64, &wind);
        let mut v = available_views(&store.roles);
        refine(&store, &mut v);
        assert!(!v.contains(&View::Heatmap) && !v.contains(&View::Surface), "{v:?}");
        // Too many row levels: no matrix views either.
        let wide: Vec<(f64, f64, f64)> = (0..2).flat_map(|h| (0..(GRID_MAX_LEVELS + 1)).map(move |d| (h as f64, d as f64, 1.0))).collect();
        let store = num_store(TypeCode::I64, &wide);
        let mut v = available_views(&store.roles);
        refine(&store, &mut v);
        assert!(!v.contains(&View::Heatmap));
        // A duplicated cell is no grid (but still a valid row dimension).
        let mut dup = week_rows();
        dup.push(dup[0]);
        let store = num_store(TypeCode::I64, &dup);
        let mut v = available_views(&store.roles);
        refine(&store, &mut v);
        assert_eq!(v[0], View::Bar);
        assert!(v.contains(&View::Heatmap));
    }

    #[test]
    fn numeric_rows_are_ordered_by_value_while_streaming() {
        let rows = week_rows();
        // First batch: hour 0 without dow 2 (it arrives later), in ORDER BY value order.
        let first: Vec<(f64, f64, f64)> = rows[..7].iter().copied().filter(|r| r.1 != 2.0).collect();
        let mut store = num_store(TypeCode::I64, &first);
        let pipes = pipeline_table();
        let mut m = Matrix::new(&store.roles, &pipes);
        m.ingest(&store, 0, store.rows);
        let ys = |m: &Matrix, store: &Store| match m.axes(View::Heatmap, store).y {
            AxisScale::Category { labels, .. } => labels,
            other => panic!("{other:?}"),
        };
        // y labels run bottom → top: largest dow at the bottom, 0 on the top row.
        assert_eq!(ys(&m, &store), ["6", "5", "4", "3", "1", "0"]);
        assert_eq!(m.labels, ["3", "6", "0", "5", "1", "4"], "local series stay in first-seen order");
        // The rest, including dow 2: re-ranked (uniforms only), not re-uploaded.
        upload(&mut m, View::Heatmap, 0);
        let rest: Vec<(f64, f64, f64)> = rows.iter().copied().filter(|r| !(r.0 == 0.0 && r.1 != 2.0)).collect();
        store.append(rest.len(), &raw_num(TypeCode::I64, &rest));
        m.ingest(&store, first.len(), store.rows);
        assert_eq!(ys(&m, &store), ["6", "5", "4", "3", "2", "1", "0"]);
        assert_eq!(m.points(), 168);
        assert!(m.series.iter().all(|s| s.pts.len() == 24));
        upload(&mut m, View::Heatmap, 100);
        let pass = draw(&mut m, View::Heatmap, [10.0, 10.0, 336.0, 140.0]);
        let u = uniforms(&pass);
        assert_eq!(u.len(), 7, "one draw per row");
        // Row position from the top = numeric order: draw i belongs to local series i.
        for (i, s) in m.labels.iter().enumerate() {
            let dow: f64 = s.parse().unwrap();
            assert_eq!(u[i].a[0], (6.0 - dow) as f32, "dow {dow} at row {} from the bottom", 6.0 - dow);
        }
        assert_eq!(u[0].a[1..3], [-0.5, 1.0], "integer x: centred one-hour cells");
        assert_eq!(u[0].domain[..2], [-0.5, 23.5]);
        // Surface lanes and legend follow the same order (dow 0 at the back, palette 0).
        let model = m.axes(View::Surface, &store);
        assert_eq!(model.legend[0], ("0".to_string(), 0));
        assert_eq!(model.legend[6], ("6".to_string(), 6));
        let lane0 = m.labels.iter().position(|l| l == "0").unwrap();
        assert_eq!(m.lane(lane0), 0.5 - 0.5 / 7.0);
    }

    #[test]
    fn hinted_and_automatic_numeric_heatmap_in_the_renderer() {
        use crate::hit::Query;
        use crate::renderer::{Binding, Renderer};
        let mut r = Renderer::new();
        r.attach(1, 400.0, 240.0, 1.0);
        r.frame(false);
        r.frame_done();
        let run = |r: &mut Renderer, request: u32, hint: Option<View>, rows: &[(f64, f64, f64)]| -> View {
            r.bind(1, Binding { request, revision: request, epoch: 0 });
            r.bind_view(1, hint);
            r.schema(request, 0, num_columns(TypeCode::I64));
            r.batch(request, 0, rows.len(), &raw_num(TypeCode::I64, rows));
            r.done(request, 0);
            let words = r.frame(true).to_vec();
            r.frame_done();
            assert!(words.iter().any(|&w| w == op::DRAW));
            r.slots[0].shown.as_ref().unwrap().view
        };
        assert_eq!(run(&mut r, 1, None, &week_rows()), View::Heatmap, "a clear grid without a hint");
        let per_hour: Vec<(f64, f64, f64)> = (0..24).map(|h| (h as f64, (100 + h % 5) as f64, h as f64)).collect();
        assert_eq!(run(&mut r, 2, None, &per_hour), View::Bar);
        assert_eq!(run(&mut r, 3, Some(View::Heatmap), &per_hour), View::Heatmap, "hinted: drawn from the schema alone");
        assert_eq!(run(&mut r, 4, Some(View::Heatmap), &week_rows()), View::Heatmap);
        // A click on the top row picks dow 0 and the hour under the pointer.
        r.frame(false);
        r.frame_done();
        let sc = r.slots[0].scales.clone().unwrap();
        let px = crate::hit::x_to_px(&sc, 5.0).unwrap() as f32;
        let py = crate::hit::y_to_px(&sc, 6.0).unwrap() as f32;
        let j = r.hit(1, 4, Query::Point { x: px, y: py }).unwrap();
        assert!(j.contains("\"x\":{\"column\":0,\"name\":\"hour\",\"type\":\"integer\",\"value\":5}"), "{j}");
        assert!(j.contains("\"series\":{\"column\":1,\"name\":\"dow\",\"type\":\"integer\",\"value\":0}"), "{j}");
    }

    #[test]
    fn text_rows_keep_result_order() {
        // ORDER BY month number: rows keep that order, not alphabetical.
        let cols = vec![
            ColumnInfo { name: "hour".into(), ty: ColumnType { code: TypeCode::F64, param: 0 } },
            ColumnInfo { name: "month".into(), ty: ColumnType { code: TypeCode::Utf8, param: 0 } },
            ColumnInfo { name: "v".into(), ty: ColumnType { code: TypeCode::F64, param: 0 } },
        ];
        let months = ["January", "February", "March", "April"];
        let mut store = Store::new(cols.clone(), infer_roles(&cols));
        let names: Vec<&str> = (0..8).map(|i| months[i % 4]).collect();
        let (o, d) = utf8(&names);
        let hours: Vec<Option<f64>> = (0..8).map(|i| Some((i / 4) as f64)).collect();
        let vals: Vec<Option<f64>> = (0..8).map(|i| Some(i as f64)).collect();
        store.append(8, &[values(0, &hours), text(1, 8, &o, &d), values(2, &vals)]);
        let pipes = pipeline_table();
        let mut m = Matrix::new(&store.roles, &pipes);
        m.ingest(&store, 0, 8);
        match m.axes(View::Heatmap, &store).y {
            AxisScale::Category { labels, .. } => assert_eq!(labels, ["April", "March", "February", "January"], "bottom → top"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn camera_fits_every_rotation() {
        let plot = [40.0, 10.0, 500.0, 300.0];
        for deg in (-180..=180).step_by(15) {
            let cam = camera(deg as f64, plot);
            for x in [-0.5, 0.5] {
                for y in [-0.5, 0.5] {
                    for z in [0.0, HEIGHT] {
                        let p = cam.project([x, y, z]);
                        assert!(p[0] >= plot[0] - 1e-6 && p[0] <= plot[0] + plot[2] + 1e-6, "{deg}° x {p:?}");
                        assert!(p[1] >= plot[1] - 1e-6 && p[1] <= plot[1] + plot[3] + 1e-6, "{deg}° y {p:?}");
                    }
                }
            }
            // Constant scale: rotating never zooms.
            assert_eq!(cam.scale, camera(0.0, plot).scale);
        }
        // Higher values project higher on screen; nearer lanes lower.
        let cam = camera(0.0, plot);
        assert!(cam.project([0.0, 0.0, HEIGHT])[1] < cam.project([0.0, 0.0, 0.0])[1]);
        assert!(cam.project([0.0, -0.5, 0.0])[1] > cam.project([0.0, 0.5, 0.0])[1]);
    }

    #[test]
    fn surface_draws_back_to_front_and_reverses_when_needed() {
        let rows = grid_rows(3, 5);
        let store = time_store(&as_ref(&rows));
        let pipes = pipeline_table();
        let mut m = Matrix::new(&store.roles, &pipes);
        m.ingest(&store, 0, store.rows);
        upload(&mut m, View::Surface, 0);
        assert!(m.series.iter().all(|s| s.rev_gpu.id == 0), "default rotation needs no reversed copies");
        let pass = draw(&mut m, View::Surface, [10.0, 10.0, 400.0, 300.0]);
        let u = uniforms(&pass);
        let ribbons: Vec<&Uniform> = u.iter().filter(|u| u.canvas[3] == 0.0).collect();
        assert_eq!(ribbons.len(), 3);
        // Default rotation: cos > 0, lane 0 (back) first.
        assert!(ribbons[0].a[2] > ribbons[1].a[2] && ribbons[1].a[2] > ribbons[2].a[2]);
        assert_eq!(ribbons[0].b[3], 90_000.0, "ribbons break at gaps over 1.5 buckets");
        assert_eq!(u.iter().filter(|u| u.canvas[3] == 1.0).count(), 3, "one floor footprint per lane");
        assert_eq!(u.iter().filter(|u| u.canvas[3] == 2.0).count(), 3, "two floor edges and the value axis");
        // Rotation 150°: high x is farther (sin > 0) and lane 0 nearer (cos < 0).
        assert!(m.set_param("rotation", 150.0));
        assert!(!m.set_param("rotation", 150.0));
        assert!(!m.set_param("elevation", 1.0));
        upload(&mut m, View::Surface, 50);
        let s0 = &m.series[0];
        assert_eq!(s0.rev[s0.rev_start..].first(), s0.pts.last());
        assert_eq!(s0.rev.last(), s0.pts.first());
        let pass = draw(&mut m, View::Surface, [10.0, 10.0, 400.0, 300.0]);
        let ribbons: Vec<Uniform> = uniforms(&pass).into_iter().filter(|u| u.canvas[3] == 0.0).collect();
        assert!(ribbons[0].a[2] < ribbons[2].a[2], "front lane (series 0) drawn last");
        let rev = m.series[0].rev_gpu.id;
        let at = m.series[0].rev_start as u32 * 8;
        assert!(pass.words.windows(4).any(|w| w == [op::VB, 0, rev, at]));
        assert!(pass.words.windows(4).any(|w| w == [op::VB, 1, rev, at + 8]));
        // Streaming while reversed: new points are prepended; only they upload.
        let mut store = store;
        let more = [(1_760_000_000_000 + 5 * 60_000, "s00", Some(7.0)), (1_760_000_000_000 + 6 * 60_000, "s00", Some(8.0))];
        store.append(2, &raw_time(&more));
        m.ingest(&store, store.rows - 2, store.rows);
        let start = m.series[0].rev_start;
        let words = upload(&mut m, View::Surface, 80);
        let s0 = &m.series[0];
        assert_eq!(s0.rev_start, start - 2);
        assert_eq!(s0.rev[s0.rev_start..].iter().rev().copied().collect::<Vec<_>>(), s0.pts);
        let rev_writes: Vec<&[u32]> = words.chunks(5).filter(|w| w[0] == op::BUF_WRITE && w[1] == s0.rev_gpu.id).collect();
        assert_eq!(rev_writes.len(), 1);
        assert_eq!((rev_writes[0][2], rev_writes[0][4]), (s0.rev_start as u32 * 8, 16), "two points, at the new start");
        // Clamped to ±180.
        assert!(m.set_param("rotation", 720.0));
        assert_eq!(m.rotation, 180.0);
    }

    #[test]
    fn surface_axes_follow_the_projection() {
        let rows = grid_rows(4, 120);
        let store = time_store(&as_ref(&rows));
        let pipes = pipeline_table();
        let mut m = Matrix::new(&store.roles, &pipes);
        m.ingest(&store, 0, store.rows);
        m.set_param("rotation", 0.0);
        let model = m.axes(View::Surface, &store);
        assert_eq!(model.legend.len(), 4, "legend names the lanes");
        let mut axes = layout(&model, 600.0, 320.0);
        let flat_y: Vec<f32> = axes.y.iter().map(|t| t.0).collect();
        assert!(!m.place_axes(View::Surface, &mut axes), "no 2D grid under a 3D view");
        assert!(axes.x.len() >= 2, "{:?}", axes.x);
        assert!(axes.x.windows(2).all(|w| w[1].0 - w[0].0 >= 56.0), "x labels increase and stay apart");
        let p = axes.plot;
        assert!(axes.x.iter().all(|t| t.0 >= p.left && t.0 <= p.left + p.width));
        assert!(axes.y.len() >= 2, "{:?}", axes.y);
        assert!(axes.y.windows(2).all(|w| w[1].0 < w[0].0), "higher values sit higher");
        assert_ne!(axes.y.iter().map(|t| t.0).collect::<Vec<_>>(), flat_y);
        assert_eq!(axes.zero, None);
        // Heatmap keeps the 2D layout.
        let mut h = layout(&m.axes(View::Heatmap, &store), 600.0, 320.0);
        let before = h.clone();
        assert_eq!(h.y.len(), 4, "every row labelled when rows are taller than a text line");
        assert_eq!(h.y[0].1, "s03", "first series on the top row");
        assert!(m.place_axes(View::Heatmap, &mut h));
        assert_eq!(h, before);
    }

    #[test]
    fn viridis_endpoints() {
        let lo = viridis(0.0);
        let hi = viridis(1.0);
        assert!((lo[0] - 0.267).abs() < 0.02 && lo[1] < 0.03 && (lo[2] - 0.329).abs() < 0.02, "{lo:?}");
        assert!((hi[0] - 0.993).abs() < 0.02 && (hi[1] - 0.906).abs() < 0.02 && (hi[2] - 0.144).abs() < 0.03, "{hi:?}");
        // Perceptual sequential: luminance rises monotonically.
        let lum = |c: [f64; 3]| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        let mut last = -1.0;
        for i in 0..=50 {
            let l = lum(viridis(i as f64 / 50.0));
            assert!(l > last, "{i}");
            last = l;
        }
    }

    #[test]
    fn renderer_switches_to_heatmap_for_many_series_and_keeps_rotation() {
        use crate::renderer::{ev, Binding, Renderer, EVENT_WORDS};
        let mut r = Renderer::new();
        r.attach(1, 400.0, 240.0, 1.0);
        r.frame(false);
        r.frame_done();
        let run = |r: &mut Renderer, request: u32, series: usize| -> (View, Vec<[u32; 6]>) {
            r.bind(1, Binding { request, revision: request, epoch: 0 });
            r.schema(request, 0, time_columns());
            r.clear_events();
            let rows = grid_rows(series, 30);
            let rows = as_ref(&rows);
            r.batch(request, 0, rows.len(), &raw_time(&rows));
            let words = r.frame(true).to_vec();
            r.frame_done();
            assert!(words.iter().any(|&w| w == op::DRAW));
            let events = r.events.chunks(EVENT_WORDS).map(|c| c.try_into().unwrap()).collect();
            (r.slots[0].shown.as_ref().unwrap().view, events)
        };
        let (view, events) = run(&mut r, 1, 3);
        assert_eq!(view, View::Line);
        assert!(!events.iter().any(|e| e[0] == ev::VIEWS));
        let (view, events) = run(&mut r, 2, 20);
        assert_eq!(view, View::Heatmap);
        assert!(events.iter().any(|e| e[0] == ev::VIEWS && e[3] == View::Heatmap as u32));
        assert!(events.iter().any(|e| e[0] == ev::FIRST_DRAW && e[2] == 2));
        // A rotation set on the slot carries over to the family of the next result.
        r.set_view(1, Some(View::Surface));
        r.set_param(1, "rotation", 45.0);
        let fam = r.slots[0].shown.as_mut().unwrap().family.as_mut().unwrap();
        assert!(!fam.set_param("rotation", 45.0), "applied to the shown family");
        let (view, _) = run(&mut r, 3, 5);
        assert_eq!(view, View::Surface);
        let fam = r.slots[0].shown.as_mut().unwrap().family.as_mut().unwrap();
        assert!(!fam.set_param("rotation", 45.0), "replayed into the new family");
        r.reset_params(1);
        let fam = r.slots[0].shown.as_mut().unwrap().family.as_mut().unwrap();
        assert!(!fam.set_param("rotation", DEFAULT_ROTATION), "reset updates an existing family");
        assert!(r.slots[0].params.is_empty());
        run(&mut r, 4, 5);
        let fam = r.slots[0].shown.as_mut().unwrap().family.as_mut().unwrap();
        assert!(!fam.set_param("rotation", DEFAULT_ROTATION), "deleted params stay absent on a fresh result");
    }
}
