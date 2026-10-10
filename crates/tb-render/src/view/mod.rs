//! View families: the extension point for chart types.
//!
//! A family owns the geometry for one or more views that share it (line/bar/scatter share
//! per-series point buffers; heatmap/surface would share a value grid; map/density/tracks
//! share projected positions). To add a family:
//!
//! 1. Write `view/<family>.rs` with a struct implementing [`Family`] and a `pub static DEF:
//!    FamilyDef`.
//! 2. Add its pipelines (WGSL + GLSL ES 3.00, see `gpu::RULE` and `xy.rs`) to `DEF.pipelines`.
//! 3. Register `DEF` in [`FAMILIES`].
//!
//! The slot machinery (binding, fencing, keeping the old image, first-draw stamping, frame
//! coalescing, axes posting, view picking) is shared; a family only turns canonical columns
//! ([`Store`]) into GPU buffers and draws.

use crate::axes::{AxesOut, AxisModel};
use crate::gpu::{Gpu, PassRecorder, PipelineDesc, PipelineTable};
use crate::schema::{Roles, View};
use crate::store::Store;

pub mod calendar;
pub mod xy;

/// Everything a family needs to record its draws for one frame.
pub struct DrawFrame<'a> {
    pub pass: &'a mut PassRecorder,
    /// Plot rectangle in device pixels: left, top, width, height.
    pub plot: [f32; 4],
    /// Canvas size in device pixels.
    pub canvas: [f32; 2],
    pub dpr: f32,
    /// The axes this frame was laid out with (CSS px), e.g. for label-aligned geometry.
    pub axes: &'a AxesOut,
}

pub trait Family {
    /// Can this instance draw `view` with the geometry it has? If not, the slot creates a
    /// fresh family for that view and re-ingests the stored rows.
    fn handles(&self, view: View) -> bool;
    /// Consume rows `from..to` of `store` (rows arrive in order; `from` is the previous `to`).
    fn ingest(&mut self, store: &Store, from: usize, to: usize);
    /// Drawable points so far (a point is drawable when every coordinate is non-null).
    fn points(&self) -> u32;
    /// Bring GPU buffers up to date (append tails, grow, rewrite after sorting).
    fn upload(&mut self, view: View, gpu: &mut Gpu);
    /// Axis scales and legend for `view`. Called every drawn frame; must be cheap.
    fn axes(&self, view: View, store: &Store) -> AxisModel;
    /// Add free-positioned text (`AxesOut::labels`) after layout, e.g. polar labels.
    fn decorate(&self, _view: View, _store: &Store, _axes: &mut AxesOut) {}
    /// Record draws for `view`. Buffers are already uploaded.
    fn draw(&mut self, view: View, frame: &mut DrawFrame);
    /// View-specific interaction (rotation, playback, …). Return true to request a redraw.
    fn set_param(&mut self, _name: &str, _value: f64) -> bool {
        false
    }
    /// Destroy GPU buffers.
    fn release(&mut self, gpu: &mut Gpu);
}

pub struct FamilyDef {
    pub name: &'static str,
    /// Push `(view, rank)` for every view this family can draw for a result with `roles`.
    /// The lowest rank across families becomes the automatic choice.
    pub applicable: fn(&Roles, &mut Vec<(View, u8)>),
    /// Create an instance for `view` (one of the views `applicable` returned).
    pub create: fn(&Roles, View, &PipelineTable) -> Box<dyn Family>,
    pub pipelines: &'static [&'static PipelineDesc],
}

/// Registered families, in registration order. Wave 2 appends matrix, geo and calendar.
pub static FAMILIES: &[&FamilyDef] = &[&xy::DEF, &calendar::DEF];

/// All pipelines: the shared `rule` pipeline first, then each family's.
pub fn pipeline_table() -> PipelineTable {
    let mut list: Vec<&'static PipelineDesc> = vec![&crate::gpu::RULE];
    for f in FAMILIES {
        list.extend(f.pipelines.iter().copied());
    }
    PipelineTable { list }
}

/// Applicable views in preference order; `table` is always available and last.
pub fn available_views(roles: &Roles) -> Vec<View> {
    let mut ranked: Vec<(View, u8)> = Vec::new();
    for f in FAMILIES {
        (f.applicable)(roles, &mut ranked);
    }
    ranked.sort_by_key(|&(_, rank)| rank);
    let mut out: Vec<View> = Vec::new();
    for (v, _) in ranked {
        if !out.contains(&v) && v != View::Table {
            out.push(v);
        }
    }
    out.push(View::Table);
    out
}

/// The hint wins when applicable; otherwise the best-ranked view.
pub fn choose_view(available: &[View], hint: Option<View>) -> View {
    match hint {
        Some(h) if available.contains(&h) => h,
        _ => available.first().copied().unwrap_or(View::Table),
    }
}

/// The family that draws `view`, if any (`table` has none).
pub fn family_for(view: View, roles: &Roles) -> Option<&'static FamilyDef> {
    FAMILIES.iter().copied().find(|f| {
        let mut v = Vec::new();
        (f.applicable)(roles, &mut v);
        v.iter().any(|&(x, _)| x == view)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{infer_roles, ColumnInfo, ColumnType, TypeCode};

    fn roles(cols: &[(&str, TypeCode)]) -> Roles {
        let c: Vec<ColumnInfo> = cols.iter().map(|(n, t)| ColumnInfo { name: n.to_string(), ty: ColumnType { code: *t, param: 2 } }).collect();
        infer_roles(&c)
    }

    #[test]
    fn automatic_choice_follows_x_kind() {
        let time = roles(&[("ts", TypeCode::Timestamp), ("v", TypeCode::F64)]);
        assert_eq!(available_views(&time), [View::Line, View::Bar, View::Scatter, View::Seasons, View::Table]);
        let cat = roles(&[("name", TypeCode::Utf8), ("v", TypeCode::F64)]);
        assert_eq!(choose_view(&available_views(&cat), None), View::Bar);
        let num = roles(&[("wind", TypeCode::F64), ("speed", TypeCode::F64)]);
        assert_eq!(choose_view(&available_views(&num), None), View::Scatter);
        let text = roles(&[("name", TypeCode::Utf8)]);
        assert_eq!(available_views(&text), [View::Table]);
    }

    #[test]
    fn hint_wins_only_when_applicable() {
        let time = roles(&[("ts", TypeCode::Timestamp), ("v", TypeCode::F64)]);
        let a = available_views(&time);
        assert_eq!(choose_view(&a, Some(View::Bar)), View::Bar);
        assert_eq!(choose_view(&a, Some(View::Table)), View::Table);
        assert_eq!(choose_view(&a, Some(View::Map)), View::Line);
    }

    #[test]
    fn pipelines_are_unique() {
        let t = pipeline_table();
        for (i, p) in t.list.iter().enumerate() {
            assert_eq!(t.index(p.name), i as u32);
        }
    }
}
