use super::*;
use super::proj::merc_y;
use crate::axes::AxesOut;
use crate::gpu::{op, PassRecorder, Pool};
use crate::schema::{infer_roles, ColumnInfo, ColumnType, TypeCode};
use crate::store::RawColumn;
use crate::view::{available_views, choose_view, pipeline_table};

fn col(name: &str, code: TypeCode) -> ColumnInfo {
    ColumnInfo { name: name.into(), ty: ColumnType { code, param: 1 } }
}

/// Rows: (ts ms, series, lat, lon, value).
type Row = (i64, &'static str, f64, f64, f64);

/// A store with columns `ts, vessel, lat, lon, speed` (or a subset: `time`/`series`/`value` off).
fn store(rows: &[Row], time: bool, series: bool, value: bool) -> Store {
    let mut cols = Vec::new();
    if time {
        cols.push(col("ts", TypeCode::Timestamp));
    }
    if series {
        cols.push(col("vessel", TypeCode::Utf8));
    }
    cols.push(col("lat", TypeCode::F64));
    cols.push(col("lon", TypeCode::F64));
    if value {
        cols.push(col("speed", TypeCode::F64));
    }
    let roles = infer_roles(&cols);
    let mut st = Store::new(cols, roles);
    let n = rows.len();
    let ts: Vec<u8> = rows.iter().flat_map(|r| r.0.to_le_bytes()).collect();
    let lat: Vec<u8> = rows.iter().flat_map(|r| r.2.to_le_bytes()).collect();
    let lon: Vec<u8> = rows.iter().flat_map(|r| r.3.to_le_bytes()).collect();
    let v: Vec<u8> = rows.iter().flat_map(|r| r.4.to_le_bytes()).collect();
    let text: String = rows.iter().map(|r| r.1).collect();
    let mut offsets = vec![0i32];
    for r in rows {
        offsets.push(offsets.last().unwrap() + r.1.len() as i32);
    }
    let off: Vec<u8> = offsets.iter().flat_map(|o| o.to_le_bytes()).collect();
    let raw = |index, code, data| RawColumn { index, code, param: 1, rows: n, data, validity: None, bit_offset: 0, offsets: &[], dict: None };
    let mut raws = Vec::new();
    let mut i = 0;
    if time {
        raws.push(raw(i, TypeCode::Timestamp, &ts[..]));
        i += 1;
    }
    if series {
        let mut s = raw(i, TypeCode::Utf8, text.as_bytes());
        s.offsets = &off;
        raws.push(s);
        i += 1;
    }
    raws.push(raw(i, TypeCode::F64, &lat[..]));
    raws.push(raw(i + 1, TypeCode::F64, &lon[..]));
    if value {
        raws.push(raw(i + 2, TypeCode::F64, &v[..]));
    }
    st.append(n, &raws);
    st
}

fn geo_for(st: &Store) -> Geo {
    let mut g = Geo::new(&st.roles, &pipeline_table());
    g.ingest(st, 0, st.rows);
    g
}

struct Harness {
    words: Vec<u32>,
    next: u32,
    pool: Pool,
}
impl Harness {
    fn new() -> Harness {
        Harness { words: Vec::new(), next: 0, pool: Pool::default() }
    }
    fn gpu(&mut self) -> Gpu<'_> {
        Gpu { words: &mut self.words, next_id: &mut self.next, pool: &mut self.pool }
    }
}

fn draw_pass(g: &mut Geo, view: View, h: &mut Harness) -> PassRecorder {
    g.upload(view, &mut h.gpu());
    let mut pass = PassRecorder::default();
    let axes = AxesOut::default();
    g.draw(view, &mut DrawFrame { pass: &mut pass, plot: [8.0, 10.0, 600.0, 300.0], canvas: [622.0, 318.0], dpr: 1.0, axes: &axes });
    pass
}
fn draw(g: &mut Geo, view: View, h: &mut Harness) -> Vec<u32> {
    draw_pass(g, view, h).words
}

fn has(words: &[u32], seq: &[u32]) -> bool {
    words.windows(seq.len()).any(|w| w == seq)
}

#[test]
fn applicability_and_ranks() {
    let r = |cols: &[(&str, TypeCode)]| infer_roles(&cols.iter().map(|(n, t)| col(n, *t)).collect::<Vec<_>>());
    // Positions only: map first, density offered, nothing from xy.
    let pos = r(&[("lat", TypeCode::F64), ("lon", TypeCode::F64)]);
    assert_eq!(available_views(&pos), [View::Map, View::Density, View::Table]);
    // Time + series + positions + value: tracks lead, xy views follow.
    let ais = r(&[("ts", TypeCode::Timestamp), ("vessel", TypeCode::Utf8), ("lat", TypeCode::F64), ("lon", TypeCode::F64), ("speed", TypeCode::F64)]);
    let v = available_views(&ais);
    assert_eq!(&v[..3], &[View::Tracks, View::Map, View::Density]);
    assert!(v.contains(&View::Line));
    // Category + positions + value: map before bar.
    let ports = r(&[("port", TypeCode::Utf8), ("lat", TypeCode::F64), ("lon", TypeCode::F64), ("calls", TypeCode::I64)]);
    assert_eq!(choose_view(&available_views(&ports), None), View::Map);
    // Several measures: the numbers are the focus, geo ranks after xy.
    let wide = r(&[("ts", TypeCode::Timestamp), ("lat", TypeCode::F64), ("lon", TypeCode::F64), ("a", TypeCode::F64), ("b", TypeCode::F64)]);
    assert_eq!(choose_view(&available_views(&wide), None), View::Line);
    assert!(available_views(&wide).contains(&View::Tracks));
    // Suffix names; no time: no tracks.
    let trips = r(&[("start_lat", TypeCode::F64), ("start_lon", TypeCode::F64), ("fare", TypeCode::F64)]);
    assert_eq!(available_views(&trips), [View::Map, View::Density, View::Table]);
    // One position column is not a map.
    let half = r(&[("ts", TypeCode::Timestamp), ("lat", TypeCode::F64), ("v", TypeCode::F64)]);
    assert!(!available_views(&half).contains(&View::Map));
    // A hint for tracks without time falls back to the automatic choice.
    assert_eq!(choose_view(&available_views(&trips), Some(View::Tracks)), View::Map);
}

#[test]
fn ingest_skips_invalid_positions_and_normalises() {
    let st = store(&[(0, "a", 54.0, 10.0, 1.0), (1000, "a", f64::NAN, 10.0, 1.0), (2000, "a", 95.0, 10.0, 1.0), (3000, "a", 54.5, 370.0, 2.0)], true, true, true);
    let g = geo_for(&st);
    assert_eq!(g.points(), 2);
    assert_eq!(g.series[0].pts[1], [10.0, 54.5, 3.0, 2.0]);
    assert_eq!(g.flat.len(), 2);
    assert_eq!(g.ext.lat, Domain::new(54.0, 54.5));
}

#[test]
fn tracks_sort_by_time_per_series() {
    let st = store(
        &[(3000, "a", 3.0, 3.0, 0.0), (1000, "a", 1.0, 1.0, 0.0), (2000, "b", 9.0, 9.0, 0.0), (2000, "a", 2.0, 2.0, 0.0), (0, "b", 8.0, 8.0, 0.0)],
        true,
        true,
        true,
    );
    let mut g = geo_for(&st);
    assert!(!g.series[0].sorted && !g.series[1].sorted);
    let mut h = Harness::new();
    // Map draws in arrival order; tracks sorts once and rewrites.
    draw(&mut g, View::Map, &mut h);
    assert!(!g.series[0].sorted);
    let words = draw(&mut g, View::Tracks, &mut h);
    let lat: Vec<f32> = g.series[0].pts.iter().map(|p| p[1]).collect();
    assert_eq!(lat, [1.0, 2.0, 3.0]);
    assert_eq!(g.series[1].pts[0][1], 8.0);
    // Segments: one buffer bound twice, 16 bytes apart; n - 1 instances.
    let id = g.series[0].gpu.id;
    assert!(has(&words, &[op::VB, 0, id, 0]) && has(&words, &[op::VB, 1, id, 16]));
    assert!(has(&words, &[op::DRAW, 4, 2]));
    // Two markers (one per series) at the last positions.
    assert_eq!(g.markers, vec![[3.0, 3.0, 0.0, 0.0], [9.0, 9.0, 0.0, 1.0]]);
}

#[test]
fn playback_cuts_and_interpolates_markers() {
    // Series a: t = 0, 10, 20 s; series b starts at t = 15 s.
    let st = store(&[(0, "a", 0.0, 0.0, 0.0), (10_000, "a", 10.0, 10.0, 0.0), (20_000, "a", 20.0, 20.0, 0.0), (15_000, "b", 5.0, 50.0, 0.0), (20_000, "b", 6.0, 60.0, 0.0)], true, true, true);
    let mut g = geo_for(&st);
    let mut h = Harness::new();
    draw(&mut g, View::Tracks, &mut h);
    assert!(g.set_param("playback", 0.25), "redraw requested");
    assert!(!g.set_param("playback", 0.25), "unchanged");
    assert!(!g.set_param("rotation", 0.5), "unknown param");
    assert_eq!(g.cut(), 5.0);
    let pass = draw_pass(&mut g, View::Tracks, &mut h);
    // Halfway between the first two points of a; b has not started.
    assert_eq!(g.markers, vec![[5.0, 5.0, 0.0, 0.0]]);
    // The cut reaches the line shader as b.z (uniform block: 6 vec4s, b is the last).
    let blocks: Vec<&[u8]> = pass.uniforms.chunks(crate::gpu::UNIFORM_STRIDE).collect();
    let b_z = |blk: &[u8]| f32::from_le_bytes(blk[88..92].try_into().unwrap());
    assert!(blocks.iter().any(|blk| b_z(blk) == 5.0), "cut uniform");
    g.set_param("playback", 0.0);
    draw(&mut g, View::Tracks, &mut h);
    assert_eq!(g.markers, vec![[0.0, 0.0, 0.0, 0.0]]);
    g.set_param("playback", 1.0);
    assert_eq!(g.cut(), ALL);
    draw(&mut g, View::Tracks, &mut h);
    assert_eq!(g.markers.len(), 2);
    // Out-of-range values clamp.
    g.set_param("playback", 7.0);
    assert_eq!(g.playback, 1.0);
}

#[test]
fn coastline_decodes_and_never_gates_the_first_draw() {
    let c = coastline();
    assert_eq!(c.len(), 1965 + 121);
    assert_eq!(c[0], [-163.71, -78.6]);
    assert_eq!(c.iter().filter(|p| p[0] == MISSING).count(), 121);
    assert!(c.iter().filter(|p| p[0] != MISSING).all(|p| p[0].abs() <= 180.0 && p[1].abs() <= 90.0));

    let st = store(&[(0, "", 54.0, 10.0, 1.0)], false, false, true);
    let mut g = geo_for(&st);
    let mut h = Harness::new();
    let first = draw(&mut g, View::Map, &mut h);
    assert_eq!(g.coast.id, 0, "no basemap upload in the first frame");
    assert!(has(&first, &[op::DRAW, 4, 1]), "the point is drawn");
    assert!(g.wants_frame(), "asks for the basemap frame");
    let uploads_before = h.words.iter().filter(|&&w| w == op::BUF_WRITE).count();
    let second = draw(&mut g, View::Map, &mut h);
    assert_ne!(g.coast.id, 0);
    assert!(h.words.iter().filter(|&&w| w == op::BUF_WRITE).count() > uploads_before);
    assert!(has(&second, &[op::DRAW, 4, c.len() as u32 - 1]));
    assert!(!g.wants_frame());
    // Uploaded once.
    h.words.clear();
    draw(&mut g, View::Map, &mut h);
    assert!(h.words.is_empty(), "nothing to upload: {:?}", h.words);
}

#[test]
fn map_modes_follow_roles() {
    let mut h = Harness::new();
    // Value without series: colour by value (mode 1); legend is the colour ramp.
    let st = store(&[(0, "", 54.0, 10.0, 1.0), (0, "", 55.0, 11.0, 3.0)], false, false, true);
    let mut g = geo_for(&st);
    draw(&mut g, View::Map, &mut h);
    let legend = g.axes(View::Map, &st).legend;
    assert_eq!(legend[0], ("speed 1".to_string(), LEGEND_RGB | 0x3b528b));
    assert_eq!(legend[2], ("3".to_string(), LEGEND_RGB | 0xfde725));
    assert!(legend.last().unwrap().0.starts_with("grid "));
    // Series: legend by series.
    let st = store(&[(0, "x", 54.0, 10.0, 1.0), (0, "y", 55.0, 11.0, 3.0)], false, true, true);
    let g = geo_for(&st);
    let legend = g.axes(View::Map, &st).legend;
    assert_eq!(&legend[..2], &[("x".to_string(), 0), ("y".to_string(), 1)]);
    assert_eq!(g.axes(View::Map, &st).x, AxisScale::None);
}

#[test]
fn density_bins_incrementally_and_rebuilds_on_window_change() {
    let mut rows: Vec<Row> = Vec::new();
    for i in 0..1000 {
        // A dense cluster and a sparse ring.
        let a = i as f64 * 0.37;
        let (lat, lon) = if i % 4 == 0 { (54.0 + a.sin(), 10.0 + a.cos()) } else { (54.0 + 0.01 * a.sin(), 10.0 + 0.01 * a.cos()) };
        rows.push((0, "", lat, lon, 1.0));
    }
    let st = store(&rows, false, false, false);
    let mut g = geo_for(&st);
    let mut h = Harness::new();
    draw(&mut g, View::Density, &mut h);
    let total: u32 = g.grid.counts.iter().sum();
    assert_eq!(total, 1000, "every point lands in the fitted grid");
    assert!(g.grid.max >= 100, "the cluster is dense: {}", g.grid.max);
    assert_eq!(g.grid.cols, 200, "3 CSS px cells over 600 px");
    assert!(!g.grid.cells.is_empty() && g.grid.cells.len() < 1000);
    // Same plot as the default guess: no follow-up frame.
    assert!(!g.wants_frame() || g.coast.id == 0);
    let dom = g.grid.dom;
    // Appending inside the window bins only the new points.
    let more = store(&rows[..10], false, false, false);
    g.ingest(&more, 0, 10);
    let before = g.grid.dom;
    draw(&mut g, View::Density, &mut h);
    assert_eq!(g.grid.dom, before);
    assert_eq!(g.grid.counts.iter().sum::<u32>(), 1010);
    // A point far away grows the extent: the grid is rebuilt for the new window.
    let far = store(&[(0, "", 40.0, -5.0, 1.0)], false, false, false);
    g.ingest(&far, 0, 1);
    draw(&mut g, View::Density, &mut h);
    assert_ne!(g.grid.dom, dom);
    assert_eq!(g.grid.counts.iter().sum::<u32>(), 1011);
    let legend = g.axes(View::Density, &st).legend;
    assert_eq!(legend[0].0, "1 / cell");
    assert!(legend.iter().any(|l| l.1 == LEGEND_RGB | 0xfde725));
}

#[test]
fn density_rows_are_uniform_in_mercator() {
    let mut grid = Grid::default();
    let dom = [0.0, 10.0, merc_y(0.0), merc_y(60.0)];
    grid.reset(dom, 10, 10, false);
    let mid = inv_merc_y((dom[2] + dom[3]) / 2.0);
    assert!((grid.lat_edges[5] - mid).abs() < 1e-9);
    // A point just above the middle edge lands in row 5, just below in row 4.
    grid.bin(&[[5.0, (mid + 0.01) as f32], [5.0, (mid - 0.01) as f32]]);
    assert_eq!(grid.counts[5 * 10 + 5], 1);
    assert_eq!(grid.counts[4 * 10 + 5], 1);
}

#[test]
fn antimeridian_tracks_use_wrapped_longitudes() {
    let st = store(&[(0, "a", 0.0, 179.0, 0.0), (1000, "a", 0.0, -179.0, 0.0)], true, true, true);
    let mut g = geo_for(&st);
    assert!(g.ext.wrap());
    let mut h = Harness::new();
    draw(&mut g, View::Tracks, &mut h);
    let dom = fit(&g.ext, 600.0, 300.0);
    assert!(dom[0] < 179.0 && dom[1] > 181.0, "{dom:?}");
}

#[test]
fn view_switches_keep_the_instance() {
    let st = store(&[(0, "a", 1.0, 1.0, 0.0), (1000, "a", 2.0, 2.0, 0.0)], true, true, true);
    let g = geo_for(&st);
    assert!(g.handles(View::Map) && g.handles(View::Density) && g.handles(View::Tracks));
    assert!(!g.handles(View::Line));
    let st = store(&[(0, "", 1.0, 1.0, 0.0)], false, false, false);
    assert!(!geo_for(&st).handles(View::Tracks));
}
