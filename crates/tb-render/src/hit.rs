//! Hit-testing for chart-as-query (docs/batch-2/manipulation.md): pointer positions in CSS px
//! (relative to the canvas) → data values, using exactly the scales the slot's last frame was
//! drawn with. The answer is a small JSON event the engine turns into a SQL restriction:
//!
//! ```json
//! {"request":7,"view":"line",
//!  "x":{"column":0,"name":"hour","type":"timestamp","value":1757289600000000},
//!  "range":{"column":0,"name":"hour","type":"timestamp","lo":…,"hi":…,"count":12},
//!  "series":{"column":1,"name":"vessel","type":"text","label":"Aurora","null":false}}
//! ```
//!
//! Values are the exact data values of rows on screen (time in µs since the epoch, numbers as
//! f64, text as the label), never interpolated pixels: a brush selects the rows whose x lies in
//! the dragged span, so the SQL can restrict to exactly those buckets.

use crate::axes::{AxisModel, AxisScale, Rect};
use crate::gpu::json_str;
use crate::scale::Domain;
use crate::schema::{TypeCode, View, XKind};
use crate::store::{Interner, Store, XValues, NULL_TIME};
use crate::view::Family;

/// Pointer radius (CSS px) within which a click picks a point of a line/scatter/map.
pub const PICK_RADIUS: f32 = 20.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Query {
    /// A click at (x, y).
    Point { x: f32, y: f32 },
    /// A horizontal brush from x0 to x1 (either order).
    Range { x0: f32, x1: f32 },
    /// A click on legend entry `index` (the order of the AXES legend).
    Legend { index: usize },
}

/// The scales one slot's last frame was laid out with.
#[derive(Clone, Debug, PartialEq)]
pub struct Scales {
    pub request: u32,
    pub view: View,
    pub model: AxisModel,
    pub plot: Rect,
}

fn domain(scale: &AxisScale) -> Option<Domain> {
    match scale {
        AxisScale::None => None,
        AxisScale::Linear(d) => Some(*d),
        AxisScale::Time { lo, hi } => Some(Domain::new(*lo as f64, *hi as f64)),
        AxisScale::Category { domain, .. } => Some(*domain),
    }
}

/// Data → CSS px along x.
pub fn x_to_px(s: &Scales, v: f64) -> Option<f64> {
    let d = domain(&s.model.x)?;
    Some(d.map(v, s.plot.left as f64, (s.plot.left + s.plot.width) as f64))
}
/// Data → CSS px along y (up).
pub fn y_to_px(s: &Scales, v: f64) -> Option<f64> {
    let d = domain(&s.model.y)?;
    Some(d.map(v, (s.plot.top + s.plot.height) as f64, s.plot.top as f64))
}
/// CSS px → data along x (inverse of [`x_to_px`]).
pub fn px_to_x(s: &Scales, px: f32) -> Option<f64> {
    let d = domain(&s.model.x)?;
    if s.plot.width <= 0.0 {
        return None;
    }
    Some(d.lo + (px - s.plot.left) as f64 / s.plot.width as f64 * d.span())
}
/// CSS px → data along y.
pub fn px_to_y(s: &Scales, py: f32) -> Option<f64> {
    let d = domain(&s.model.y)?;
    if s.plot.height <= 0.0 {
        return None;
    }
    Some(d.lo + (s.plot.top + s.plot.height - py) as f64 / s.plot.height as f64 * d.span())
}

fn type_name(code: TypeCode) -> &'static str {
    match code {
        TypeCode::Timestamp => "timestamp",
        TypeCode::Date32 | TypeCode::Date64 => "date",
        TypeCode::Bool => "boolean",
        c if c.is_integer() => "integer",
        c if c.is_text() => "text",
        c if c.is_numeric() => "number",
        _ => "other",
    }
}

fn column_head(store: &Store, column: usize) -> String {
    let c = &store.columns[column];
    format!("\"column\":{},\"name\":{},\"type\":\"{}\"", column, json_str(&c.name), type_name(c.ty.code))
}

fn label_json(interner: &Interner, id: u32) -> String {
    format!("\"label\":{},\"null\":{}", json_str(&interner.labels[id as usize]), interner.is_null(id))
}

fn number(v: f64) -> String {
    if v.is_finite() {
        if v == v.trunc() && v.abs() < 9.007e15 {
            format!("{}", v as i64)
        } else {
            format!("{v:?}")
        }
    } else {
        "null".into()
    }
}

/// Which column the x axis shows for `view` (scatter of two measures puts measure 0 on x).
fn x_column(store: &Store, view: View) -> Option<usize> {
    let roles = &store.roles;
    let x = roles.x;
    if view == View::Scatter && !roles.measures.is_empty() && !matches!(x, Some((_, XKind::Numeric { .. }))) {
        return roles.measures.first().copied();
    }
    x.map(|(i, _)| i)
}

/// x of row `i` on the axis of `view` (time µs, number, or category id); NaN when null.
fn x_at(store: &Store, view: View, i: usize) -> f64 {
    let col = x_column(store, view);
    if col.is_some() && col != store.roles.x.map(|x| x.0) {
        return store.measures.first().map_or(f64::NAN, |m| m[i]);
    }
    store.x_number(i)
}

fn x_value_json(store: &Store, view: View, i: usize) -> Option<String> {
    let col = x_column(store, view)?;
    let head = column_head(store, col);
    if col == store.roles.x?.0 {
        return Some(match &store.x {
            Some(XValues::Time(v)) if v[i] == NULL_TIME => format!("{{{head},\"value\":null}}"),
            Some(XValues::Time(v)) => format!("{{{head},\"value\":{}}}", v[i]),
            Some(XValues::Num(v)) => format!("{{{head},\"value\":{}}}", number(v[i])),
            Some(XValues::Cat(v)) => format!("{{{head},{}}}", label_json(&store.x_labels, v[i])),
            None => return None,
        });
    }
    Some(format!("{{{head},\"value\":{}}}", number(x_at(store, view, i))))
}

fn series_json(store: &Store, i: usize) -> Option<String> {
    let col = store.roles.series?;
    let id = store.series.as_ref()?[i];
    Some(format!("{{{},{}}}", column_head(store, col), label_json(&store.series_labels, id)))
}

/// The category column a map point or legend entry stands for: the series, else a text x.
fn category_of_row(store: &Store, i: usize) -> Option<String> {
    if store.roles.series.is_some() {
        return series_json(store, i);
    }
    match (&store.x, store.roles.x) {
        (Some(XValues::Cat(ids)), Some((col, _))) => Some(format!("{{{},{}}}", column_head(store, col), label_json(&store.x_labels, ids[i]))),
        _ => None,
    }
}

/// Nearest row by x pixel distance (bars, heatmap columns): (row, |dx|).
fn nearest_x(store: &Store, s: &Scales, px: f32) -> Option<usize> {
    let mut best: Option<(usize, f64)> = None;
    for i in 0..store.rows {
        let x = x_at(store, s.view, i);
        if !x.is_finite() {
            continue;
        }
        let d = (x_to_px(s, x)? - px as f64).abs();
        if best.map_or(true, |(_, b)| d < b) {
            best = Some((i, d));
        }
    }
    best.map(|(i, _)| i)
}

/// Nearest drawn point (line/scatter) within [`PICK_RADIUS`].
fn nearest_point(store: &Store, s: &Scales, px: f32, py: f32) -> Option<usize> {
    let wide = store.roles.series.is_none() && !store.roles.measures.is_empty() && s.view != View::Scatter;
    let measure_x = x_column(store, s.view) != store.roles.x.map(|x| x.0);
    let mut best: Option<(usize, f64)> = None;
    let mut consider = |i: usize, x: f64, y: f64| {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        let (Some(xp), Some(yp)) = (x_to_px(s, x), y_to_px(s, y)) else { return };
        let d = (xp - px as f64).hypot(yp - py as f64);
        if d <= PICK_RADIUS as f64 && best.map_or(true, |(_, b)| d < b) {
            best = Some((i, d));
        }
    };
    let value = store.value.as_deref();
    for i in 0..store.rows {
        let x = x_at(store, s.view, i);
        if let Some(v) = value {
            consider(i, x, v[i]);
        }
        if wide && !measure_x {
            for m in &store.measures {
                consider(i, x, m[i]);
            }
        }
    }
    best.map(|(i, _)| i)
}

fn category_index(scale: &AxisScale, pos: f64) -> Option<(usize, String)> {
    let AxisScale::Category { labels, .. } = scale else { return None };
    let k = pos.round();
    if k < 0.0 || k as usize >= labels.len() {
        return None;
    }
    Some((k as usize, labels[k as usize].clone()))
}

/// Answer `query` for the result on screen. `family` is that result's view family.
pub fn hit(store: &Store, family: Option<&dyn Family>, s: &Scales, query: Query) -> Option<String> {
    let mut x: Option<String> = None;
    let mut range: Option<String> = None;
    let mut series: Option<String> = None;
    let in_plot = |px: f32, py: f32| {
        let p = s.plot;
        px >= p.left - 2.0 && px <= p.left + p.width + 2.0 && py >= p.top - 2.0 && py <= p.top + p.height + 2.0
    };
    match query {
        Query::Legend { index } => {
            let (label, _) = s.model.legend.get(index)?;
            if !matches!(s.view, View::Line | View::Bar | View::Scatter | View::Map | View::Tracks) {
                return None;
            }
            if let Some(col) = store.roles.series {
                let (id, _) = store.series_labels.find(label)?;
                series = Some(format!("{{{},{}}}", column_head(store, col), label_json(&store.series_labels, id)));
            } else if let (Some((col, XKind::Category)), true) = (store.roles.x, matches!(s.view, View::Map | View::Tracks)) {
                let (id, _) = store.x_labels.find(label)?;
                series = Some(format!("{{{},{}}}", column_head(store, col), label_json(&store.x_labels, id)));
            } else {
                return None;
            }
        }
        Query::Point { x: px, y: py } => {
            if !in_plot(px, py) {
                return None;
            }
            match s.view {
                View::Line | View::Scatter => {
                    let i = nearest_point(store, s, px, py)?;
                    x = x_value_json(store, s.view, i);
                    series = series_json(store, i);
                }
                View::Bar => {
                    if let AxisScale::Category { .. } = s.model.x {
                        let (_, label) = category_index(&s.model.x, px_to_x(s, px)?)?;
                        let (col, _) = store.roles.x?;
                        let (id, _) = store.x_labels.find(&label)?;
                        x = Some(format!("{{{},{}}}", column_head(store, col), label_json(&store.x_labels, id)));
                    } else {
                        let i = nearest_x(store, s, px)?;
                        x = x_value_json(store, s.view, i);
                    }
                }
                View::Heatmap => {
                    let i = nearest_x(store, s, px)?;
                    x = x_value_json(store, s.view, i);
                    if let (Some(col), Some((_, label))) = (store.roles.series, category_index(&s.model.y, px_to_y(s, py)?)) {
                        let (id, _) = store.series_labels.find(&label)?;
                        series = Some(format!("{{{},{}}}", column_head(store, col), label_json(&store.series_labels, id)));
                    }
                }
                View::Map | View::Tracks | View::Density => {
                    let i = family?.nearest(s.view, store, s.plot, px, py)?;
                    series = category_of_row(store, i);
                    series.as_ref()?;
                }
                _ => return None,
            }
        }
        Query::Range { x0, x1 } => {
            if !matches!(s.view, View::Line | View::Bar | View::Scatter | View::Heatmap) {
                return None;
            }
            let (a, b) = (x0.min(x1).max(s.plot.left), x0.max(x1).min(s.plot.left + s.plot.width));
            if b <= a {
                return None;
            }
            let col = x_column(store, s.view)?;
            let head = column_head(store, col);
            if let (AxisScale::Category { labels, .. }, true) = (&s.model.x, col == store.roles.x?.0) {
                let (lo, hi) = (px_to_x(s, a)?, px_to_x(s, b)?);
                let picked: Vec<String> = (0..labels.len())
                    .filter(|&k| (k as f64) >= lo && (k as f64) <= hi)
                    .map(|k| json_str(&labels[k]))
                    .collect();
                if picked.is_empty() {
                    return None;
                }
                range = Some(format!("{{{head},\"labels\":[{}],\"count\":{}}}", picked.join(","), picked.len()));
            } else {
                let (mut lo, mut hi, mut count) = (f64::INFINITY, f64::NEG_INFINITY, 0usize);
                for i in 0..store.rows {
                    let v = x_at(store, s.view, i);
                    if !v.is_finite() {
                        continue;
                    }
                    let p = x_to_px(s, v)? as f32;
                    if p >= a && p <= b {
                        lo = lo.min(v);
                        hi = hi.max(v);
                        count += 1;
                    }
                }
                if count == 0 {
                    return None;
                }
                range = Some(format!("{{{head},\"lo\":{},\"hi\":{},\"count\":{count}}}", number(lo), number(hi)));
            }
        }
    }
    let field = |name: &str, v: &Option<String>| v.as_ref().map(|j| format!(",\"{name}\":{j}")).unwrap_or_default();
    Some(format!("{{\"request\":{},\"view\":{}{}{}{}}}", s.request, json_str(s.view.name()), field("x", &x), field("range", &range), field("series", &series)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scale::Domain;

    fn scales(x: AxisScale, y: AxisScale, view: View) -> Scales {
        Scales { request: 1, view, model: AxisModel { x, y, legend: vec![] }, plot: Rect { left: 40.0, top: 10.0, width: 400.0, height: 200.0 } }
    }

    #[test]
    fn scale_inversion_round_trips() {
        let s = scales(AxisScale::Time { lo: 1_000_000, hi: 5_000_000 }, AxisScale::Linear(Domain::new(-2.0, 8.0)), View::Line);
        for v in [1_000_000.0, 2_345_678.0, 5_000_000.0] {
            let px = x_to_px(&s, v).unwrap() as f32;
            assert!((px_to_x(&s, px).unwrap() - v).abs() < 1.0, "{v}");
        }
        assert_eq!(x_to_px(&s, 1_000_000.0), Some(40.0));
        assert_eq!(x_to_px(&s, 5_000_000.0), Some(440.0));
        // y grows upwards: the domain's low end is the plot's bottom edge.
        assert_eq!(y_to_px(&s, -2.0), Some(210.0));
        assert_eq!(y_to_px(&s, 8.0), Some(10.0));
        assert!((px_to_y(&s, 110.0).unwrap() - 3.0).abs() < 1e-9);
        let none = scales(AxisScale::None, AxisScale::None, View::Map);
        assert_eq!(px_to_x(&none, 10.0), None);
    }

    #[test]
    fn category_positions_round_to_labels() {
        let labels = vec!["a".to_string(), "b".into(), "c".into()];
        let s = scales(AxisScale::Category { labels: labels.clone(), domain: Domain::new(-0.5, 2.5) }, AxisScale::None, View::Bar);
        let at = |k: f64| x_to_px(&s, k).unwrap() as f32;
        assert_eq!(category_index(&s.model.x, px_to_x(&s, at(1.0) + 30.0).unwrap()).unwrap().1, "b");
        assert_eq!(category_index(&s.model.x, px_to_x(&s, at(2.0)).unwrap()).unwrap().1, "c");
        assert!(category_index(&s.model.x, px_to_x(&s, at(2.0) + 80.0).unwrap()).is_none());
    }
}
