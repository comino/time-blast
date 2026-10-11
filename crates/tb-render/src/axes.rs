//! Axis models → plot rectangle, tick positions/labels and legend (posted to the UI, which
//! draws the text in DOM), plus the grid-line instances the GPU draws.

use crate::gpu::json_str;
use crate::scale::{format_number, format_time_tick, linear_ticks, time_ticks, Domain};

/// What one axis shows. Families return these; layout turns them into ticks.
#[derive(Clone, Debug, PartialEq)]
pub enum AxisScale {
    None,
    Linear(Domain),
    /// Exact UTC instants in µs.
    Time { lo: i64, hi: i64 },
    /// Labels at integer positions 0..n inside `domain`.
    Category { labels: Vec<String>, domain: Domain },
}

#[derive(Clone, Debug, PartialEq)]
pub struct AxisModel {
    pub x: AxisScale,
    pub y: AxisScale,
    /// (label, palette index)
    pub legend: Vec<(String, usize)>,
}

impl AxisModel {
    pub fn none() -> AxisModel {
        AxisModel { x: AxisScale::None, y: AxisScale::None, legend: Vec::new() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Rect {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct AxesOut {
    /// CSS pixels relative to the canvas.
    pub plot: Rect,
    /// (CSS px from the canvas's left edge, label)
    pub x: Vec<(f32, String)>,
    /// (CSS px from the canvas's top edge, label)
    pub y: Vec<(f32, String)>,
    pub legend: Vec<(String, usize)>,
    /// y position (CSS px) of the value-zero baseline when inside the plot.
    pub zero: Option<f32>,
    /// Free-positioned text from `Family::decorate`: (x, y CSS px, label, horizontal anchor
    /// 0 start / 0.5 middle / 1 end); vertically centred on y.
    pub labels: Vec<(f32, f32, String, f32)>,
}

/// Series palette (legacy `SERIES_COLORS`): mid-saturation, readable on dark and light cards.
pub const PALETTE: [[u8; 3]; 6] = [[0xff, 0x90, 0x6c], [0x74, 0xd4, 0xc3], [0xd4, 0xc1, 0x7e], [0x83, 0xb9, 0xe3], [0xe3, 0x9e, 0xaf], [0xb0, 0xc9, 0x85]];

/// Legend/palette "indices" at or above this flag are literal 0xRRGGBB colours (colour scales).
pub const RGB_FLAG: usize = 1 << 24;

/// A legend colour index carrying a literal RGB colour instead of a palette entry.
pub const fn rgb_index(c: [u8; 3]) -> usize {
    RGB_FLAG | (c[0] as usize) << 16 | (c[1] as usize) << 8 | c[2] as usize
}

fn color_of(i: usize) -> [u8; 3] {
    if i >= RGB_FLAG {
        return [(i >> 16) as u8, (i >> 8) as u8, i as u8];
    }
    PALETTE[i % PALETTE.len()]
}

pub fn palette_hex(i: usize) -> String {
    let c = color_of(i);
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

/// Premultiplied RGBA for palette entry `i` at opacity `alpha`.
pub fn palette_rgba(i: usize, alpha: f32) -> [f32; 4] {
    let c = color_of(i);
    [c[0] as f32 / 255.0 * alpha, c[1] as f32 / 255.0 * alpha, c[2] as f32 / 255.0 * alpha, alpha]
}

/// Approximate label width in CSS px for the UI's 10–11px mono labels.
fn text_width(s: &str) -> f32 {
    s.chars().count() as f32 * 6.4
}

const TOP: f32 = 10.0;
const RIGHT: f32 = 14.0;
const BOTTOM: f32 = 24.0;

/// `vertical`: labels stack (y axis), so category labels need a line height, not their width.
fn ticks(scale: &AxisScale, length: f32, spacing: f32, vertical: bool) -> Vec<(f64, String)> {
    let count = ((length / spacing).floor() as usize).clamp(2, 12);
    match scale {
        AxisScale::None => Vec::new(),
        AxisScale::Linear(d) => {
            let (values, step) = linear_ticks(*d, count);
            values.into_iter().map(|v| (v, format_number(v, step))).collect()
        }
        AxisScale::Time { lo, hi } => {
            let (values, step) = time_ticks(*lo, *hi, count);
            values.into_iter().map(|t| (t as f64, format_time_tick(t, step))).collect()
        }
        AxisScale::Category { labels, domain } => {
            if labels.is_empty() {
                return Vec::new();
            }
            let need = if vertical { 16.0 } else { (labels.iter().take(200).map(|l| text_width(l)).fold(0.0f32, f32::max).min(120.0) + 10.0).max(spacing * 0.5) };
            let per = length / (domain.span() as f32).max(1.0);
            let stride = ((need / per.max(1e-3)).ceil() as usize).max(1);
            labels.iter().enumerate().step_by(stride).map(|(i, l)| (i as f64, l.clone())).collect()
        }
    }
}

fn domain_of(scale: &AxisScale) -> Domain {
    match scale {
        AxisScale::None => Domain::new(0.0, 1.0),
        AxisScale::Linear(d) => *d,
        AxisScale::Time { lo, hi } => Domain::new(*lo as f64, *hi as f64),
        AxisScale::Category { domain, .. } => *domain,
    }
}

/// Lay out the plot inside a `width × height` CSS-pixel canvas.
pub fn layout(model: &AxisModel, width: f32, height: f32) -> AxesOut {
    let y_ticks = ticks(&model.y, (height - TOP - BOTTOM).max(10.0), 42.0, true);
    let label_w = y_ticks.iter().map(|(_, l)| text_width(l)).fold(0.0f32, f32::max);
    let left = if matches!(model.y, AxisScale::None) { 8.0 } else { (label_w + 12.0).max(30.0).min(width * 0.4) };
    let bottom = if matches!(model.x, AxisScale::None) { 8.0 } else { BOTTOM };
    let plot = Rect { left, top: TOP, width: (width - left - RIGHT).max(1.0), height: (height - TOP - bottom).max(1.0) };
    let xd = domain_of(&model.x);
    let yd = domain_of(&model.y);
    let x_ticks = ticks(&model.x, plot.width, 92.0, false);
    let x = x_ticks
        .into_iter()
        .map(|(v, l)| (xd.map(v, plot.left as f64, (plot.left + plot.width) as f64) as f32, l))
        .filter(|(at, _)| *at >= plot.left - 0.5 && *at <= plot.left + plot.width + 0.5)
        .collect();
    let y = y_ticks
        .into_iter()
        .map(|(v, l)| (yd.map(v, (plot.top + plot.height) as f64, plot.top as f64) as f32, l))
        .filter(|(at, _)| *at >= plot.top - 0.5 && *at <= plot.top + plot.height + 0.5)
        .collect();
    let zero = match model.y {
        AxisScale::Linear(d) if d.lo <= 0.0 && d.hi >= 0.0 => Some(d.map(0.0, (plot.top + plot.height) as f64, plot.top as f64) as f32),
        _ => None,
    };
    AxesOut { plot, x, y, legend: model.legend.clone(), zero, labels: Vec::new() }
}

impl AxesOut {
    /// The `AxisTicks` object of `src/engine/contracts.ts`, as JSON.
    pub fn to_json(&self) -> String {
        let mut s = String::from("{\"x\":[");
        let ticks = |s: &mut String, list: &[(f32, String)]| {
            for (i, (at, label)) in list.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                s.push_str(&format!("{{\"at\":{},\"label\":{}}}", round2(*at), json_str(label)));
            }
        };
        ticks(&mut s, &self.x);
        s.push_str("],\"y\":[");
        ticks(&mut s, &self.y);
        let p = self.plot;
        s.push_str(&format!(
            "],\"plot\":{{\"left\":{},\"top\":{},\"width\":{},\"height\":{}}},\"legend\":[",
            round2(p.left),
            round2(p.top),
            round2(p.width),
            round2(p.height)
        ));
        for (i, (label, color)) in self.legend.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&format!("{{\"label\":{},\"color\":\"{}\"}}", json_str(label), palette_hex(*color)));
        }
        s.push(']');
        if !self.labels.is_empty() {
            s.push_str(",\"labels\":[");
            for (i, (x, y, label, anchor)) in self.labels.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                s.push_str(&format!("{{\"x\":{},\"y\":{},\"label\":{},\"anchor\":{}}}", round2(*x), round2(*y), json_str(label), anchor));
            }
            s.push(']');
        }
        s.push('}');
        s
    }

    /// Grid instances for the `rule` pipeline (device pixels): one hairline per y tick,
    /// a stronger zero/base line, and short x tick marks.
    pub fn grid(&self, dpr: f32, out: &mut Vec<[u32; 5]>) {
        out.clear();
        let p = self.plot;
        let (l, r) = (p.left * dpr, (p.left + p.width) * dpr);
        let bottom = (p.top + p.height) * dpr;
        let hair = dpr.max(1.0).round();
        let line = |out: &mut Vec<[u32; 5]>, x0: f32, y0: f32, x1: f32, y1: f32, rgba: [u8; 4]| {
            out.push([x0.to_bits(), y0.to_bits(), x1.to_bits(), y1.to_bits(), u32::from_le_bytes(rgba)]);
        };
        for (at, _) in &self.y {
            let y = (at * dpr).round();
            line(out, l, y - hair * 0.5, r, y + hair * 0.5, [128, 150, 162, 46]);
        }
        let base = self.zero.map(|z| (z * dpr).round()).unwrap_or(bottom.round());
        if !self.y.is_empty() || !self.x.is_empty() {
            line(out, l, base - hair * 0.5, r, base + hair * 0.5, [128, 150, 162, 110]);
        }
        for (at, _) in &self.x {
            let x = (at * dpr).round();
            line(out, x - hair * 0.5, bottom, x + hair * 0.5, bottom + 4.0 * dpr, [128, 150, 162, 110]);
        }
    }
}

fn round2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scale::{days_from_civil, US_PER_DAY};

    #[test]
    fn layout_reserves_room_for_labels() {
        let m = AxisModel { x: AxisScale::Linear(Domain::new(0.0, 10.0)), y: AxisScale::Linear(Domain::new(0.0, 100_000.0)), legend: vec![] };
        let a = layout(&m, 400.0, 300.0);
        assert!(a.plot.left >= 30.0);
        assert_eq!(a.plot.top, 10.0);
        assert!((a.plot.left + a.plot.width - (400.0 - 14.0)).abs() < 1e-3);
        // y ticks run from bottom (0) to top (max).
        assert_eq!(a.y.first().unwrap().0, a.plot.top + a.plot.height);
        assert_eq!(a.y.first().unwrap().1, "0");
        assert_eq!(a.zero, Some(a.plot.top + a.plot.height));
        assert_eq!(a.x.first().unwrap().0, a.plot.left);
    }

    #[test]
    fn time_axis_json() {
        let lo = days_from_civil(2026, 1, 1) * US_PER_DAY;
        let m = AxisModel { x: AxisScale::Time { lo, hi: lo + 7 * US_PER_DAY }, y: AxisScale::Linear(Domain::new(0.0, 1.0)), legend: vec![("a\"b".into(), 1)] };
        let a = layout(&m, 600.0, 200.0);
        let j = a.to_json();
        assert!(j.contains("\"label\":\"2026\""), "{j}");
        assert!(j.contains("\"legend\":[{\"label\":\"a\\\"b\",\"color\":\"#74d4c3\"}]"), "{j}");
        let mut grid = Vec::new();
        a.grid(2.0, &mut grid);
        assert_eq!(grid.len(), a.y.len() + 1 + a.x.len());
    }

    #[test]
    fn category_labels_thin_out() {
        let labels: Vec<String> = (0..100).map(|i| format!("category-{i}")).collect();
        let m = AxisModel { x: AxisScale::Category { labels, domain: Domain::new(-0.5, 99.5) }, y: AxisScale::None, legend: vec![] };
        let a = layout(&m, 500.0, 200.0);
        assert!(a.x.len() < 12, "{}", a.x.len());
        assert_eq!(a.x[0].1, "category-0");
        assert_eq!(a.plot.left, 8.0);
    }
}
