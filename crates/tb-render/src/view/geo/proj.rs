//! Web-Mercator maths on the CPU side: extents, fitting the view, graticule steps, colour ramp.
//!
//! Per-point projection happens on the GPU (`shaders.rs`); the CPU only projects the few
//! numbers that define the view (extent corners, grid lines, density row edges).
//!
//! Projected units: x = longitude in degrees (optionally wrapped to 0..360), y = Mercator
//! northing scaled to degrees (`merc_y`), so one unit is the same length on both axes at the
//! equator and an equal-scale fit is just an aspect-ratio fit.

use crate::scale::{nice_step, Domain};
use std::f64::consts::PI;

/// Web-Mercator latitude limit (the square world).
pub const MAX_LAT: f64 = 85.051_128_779_806_59;
/// Smallest fitted span in projected degrees (~5 km): one point still shows its surroundings.
pub const MIN_SPAN: f64 = 0.05;
/// Padding around the data extent, as a fraction of the span on each side.
pub const PAD: f64 = 0.06;

#[inline]
pub fn merc_y(lat: f64) -> f64 {
    let l = lat.clamp(-MAX_LAT, MAX_LAT).to_radians();
    (PI / 4.0 + l / 2.0).tan().ln().to_degrees()
}

#[inline]
pub fn inv_merc_y(y: f64) -> f64 {
    y.to_radians().sinh().atan().to_degrees()
}

/// Longitude normalised to -180..=180 (data in 0..360 or beyond becomes canonical).
#[inline]
pub fn norm_lon(lon: f64) -> f64 {
    if (-180.0..=180.0).contains(&lon) {
        lon
    } else {
        (lon + 180.0).rem_euclid(360.0) - 180.0
    }
}

/// Data extent in degrees, tracked both in -180..180 and 0..360 longitude so data spanning
/// the antimeridian (the Pacific) fits tightly instead of spanning the whole world.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Extent {
    pub lon: Domain,
    pub lon360: Domain,
    pub lat: Domain,
}

impl Default for Extent {
    fn default() -> Self {
        Extent { lon: Domain::EMPTY, lon360: Domain::EMPTY, lat: Domain::EMPTY }
    }
}

impl Extent {
    #[inline]
    pub fn include(&mut self, lon: f64, lat: f64) {
        self.lon.include(lon);
        self.lon360.include(if lon < 0.0 { lon + 360.0 } else { lon });
        self.lat.include(lat);
    }
    pub fn is_empty(&self) -> bool {
        self.lat.is_empty()
    }
    /// Draw in 0..360 longitude (negative longitudes + 360)?
    pub fn wrap(&self) -> bool {
        !self.is_empty() && self.lon360.span() < self.lon.span()
    }
    /// Longitude range in the drawing's longitude space.
    pub fn lon_range(&self) -> Domain {
        if self.wrap() {
            self.lon360
        } else {
            self.lon
        }
    }
}

/// The drawing longitude of `lon` under `wrap`.
#[inline]
pub fn lon_w(lon: f64, wrap: bool) -> f64 {
    if wrap && lon < 0.0 {
        lon + 360.0
    } else {
        lon
    }
}

/// Projected window `[x0, x1, y0, y1]` showing `ext` at equal scale in a `w × h` plot:
/// padded, at least `MIN_SPAN`, then widened along one axis to the plot's aspect ratio.
/// Empty data shows the world between 60°S and 75°N.
pub fn fit(ext: &Extent, w: f32, h: f32) -> [f64; 4] {
    let (w, h) = (w.max(1.0) as f64, h.max(1.0) as f64);
    let (x, y) = if ext.is_empty() {
        (Domain::new(-180.0, 180.0), Domain::new(merc_y(-60.0), merc_y(75.0)))
    } else {
        (ext.lon_range(), Domain::new(merc_y(ext.lat.lo), merc_y(ext.lat.hi)))
    };
    let (cx, cy) = ((x.lo + x.hi) / 2.0, (y.lo + y.hi) / 2.0);
    let mut sx = x.span().max(MIN_SPAN) * (1.0 + 2.0 * PAD);
    let mut sy = y.span().max(MIN_SPAN) * (1.0 + 2.0 * PAD);
    let aspect = w / h;
    if sx / sy < aspect {
        sx = sy * aspect;
    } else {
        sy = sx / aspect;
    }
    [cx - sx / 2.0, cx + sx / 2.0, cy - sy / 2.0, cy + sy / 2.0]
}

/// Graticule spacing in degrees for a window `span` degrees wide: 1-2-5 steps below 10°,
/// then the cartographic 10/15/30/45/90.
pub fn graticule_step(span: f64) -> f64 {
    let raw = nice_step(span, 5);
    if raw <= 5.0 {
        return raw;
    }
    for s in [10.0, 15.0, 30.0, 45.0] {
        if raw <= s {
            return s;
        }
    }
    90.0
}

/// Graticule lines inside a projected window: `(first_lon, n_meridians, first_lat, n_parallels, step)`.
pub fn graticule(dom: [f64; 4]) -> (f64, u32, f64, u32, f64) {
    let step = graticule_step(dom[1] - dom[0]);
    let count = |lo: f64, hi: f64| -> (f64, u32) {
        let first = (lo / step - 1e-9).ceil() * step;
        let n = if hi >= first { ((hi - first) / step + 1e-9).floor() as u32 + 1 } else { 0 };
        (first, n.min(96))
    };
    let (lon0, nm) = count(dom[0], dom[1]);
    let lat_lo = inv_merc_y(dom[2]).max(-80.0);
    let lat_hi = inv_merc_y(dom[3]).min(80.0);
    let (lat0, np) = count(lat_lo, lat_hi);
    (lon0, nm, lat0, np, step)
}

/// The colour ramp for values and density (upper three quarters of viridis: every stop is
/// visible on dark and light cards). Shaders carry the same stops (`shaders.rs`).
pub const RAMP: [[u8; 3]; 4] = [[0x3b, 0x52, 0x8b], [0x21, 0x91, 0x8c], [0x5e, 0xc9, 0x62], [0xfd, 0xe7, 0x25]];

/// Ramp colour at `t` in 0..1 as 0xRRGGBB.
pub fn ramp_rgb(t: f64) -> u32 {
    let t = t.clamp(0.0, 1.0) * 3.0;
    let i = (t.floor() as usize).min(2);
    let f = t - i as f64;
    let mut out = 0u32;
    for c in 0..3 {
        let v = RAMP[i][c] as f64 + (RAMP[i + 1][c] as f64 - RAMP[i][c] as f64) * f;
        out = out << 8 | v.round().clamp(0.0, 255.0) as u32;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mercator_round_trips_and_clamps() {
        assert!(merc_y(0.0).abs() < 1e-12);
        for lat in [-80.0, -45.5, -1.0, 12.25, 54.3, 85.0] {
            assert!((inv_merc_y(merc_y(lat)) - lat).abs() < 1e-9, "{lat}");
        }
        // The square world: y at the limit equals 180 projected degrees.
        assert!((merc_y(MAX_LAT) - 180.0).abs() < 1e-6);
        assert_eq!(merc_y(89.9), merc_y(MAX_LAT));
        // Northing grows faster than latitude away from the equator.
        assert!(merc_y(60.0) - merc_y(50.0) > merc_y(10.0) - merc_y(0.0));
    }

    #[test]
    fn longitudes_normalise() {
        assert_eq!(norm_lon(12.5), 12.5);
        assert_eq!(norm_lon(190.0), -170.0);
        assert_eq!(norm_lon(-190.0), 170.0);
        assert_eq!(norm_lon(360.0), 0.0);
    }

    #[test]
    fn antimeridian_data_wraps_and_greenwich_data_does_not() {
        let mut pacific = Extent::default();
        pacific.include(170.0, -10.0);
        pacific.include(-175.0, 5.0);
        assert!(pacific.wrap());
        assert_eq!(pacific.lon_range(), Domain::new(170.0, 185.0));
        let mut europe = Extent::default();
        europe.include(-5.0, 50.0);
        europe.include(10.0, 55.0);
        assert!(!europe.wrap());
        assert_eq!(europe.lon_range(), Domain::new(-5.0, 10.0));
        assert_eq!(lon_w(-175.0, true), 185.0);
    }

    #[test]
    fn fit_keeps_equal_scale_and_contains_the_data() {
        let mut e = Extent::default();
        e.include(8.0, 53.0);
        e.include(10.0, 55.0);
        for (w, h) in [(600.0, 300.0), (200.0, 400.0), (500.0, 500.0)] {
            let d = fit(&e, w, h);
            let (sx, sy) = (d[1] - d[0], d[3] - d[2]);
            assert!(((sx / sy) - (w / h) as f64).abs() < 1e-9, "aspect {w}x{h}");
            assert!(d[0] < 8.0 && d[1] > 10.0);
            assert!(d[2] < merc_y(53.0) && d[3] > merc_y(55.0));
            // Data is centred.
            assert!(((d[0] + d[1]) / 2.0 - 9.0).abs() < 1e-9);
        }
        // A single point gets the minimum span, centred on it.
        let mut one = Extent::default();
        one.include(4.5, 52.0);
        let d = fit(&one, 100.0, 100.0);
        assert!((d[1] - d[0] - MIN_SPAN * (1.0 + 2.0 * PAD)).abs() < 1e-9);
        assert!(((d[2] + d[3]) / 2.0 - merc_y(52.0)).abs() < 1e-9);
        // No data: the world.
        let w = fit(&Extent::default(), 720.0, 300.0);
        assert!(w[0] <= -180.0 && w[1] >= 180.0);
    }

    #[test]
    fn graticule_steps_and_counts() {
        assert_eq!(graticule_step(360.0), 90.0);
        assert_eq!(graticule_step(120.0), 30.0);
        assert_eq!(graticule_step(10.0), 2.0);
        assert_eq!(graticule_step(0.1), 0.02);
        let (lon0, nm, lat0, np, step) = graticule([-12.0, 12.0, merc_y(-5.0), merc_y(5.0)]);
        assert_eq!(step, 5.0);
        assert_eq!((lon0, nm), (-10.0, 5));
        assert_eq!((lat0, np), (-5.0, 3));
    }

    #[test]
    fn ramp_ends_are_the_stops() {
        assert_eq!(ramp_rgb(0.0), 0x3b528b);
        assert_eq!(ramp_rgb(1.0), 0xfde725);
        assert_eq!(ramp_rgb(-3.0), 0x3b528b);
        assert_eq!(ramp_rgb(1.0 / 3.0), 0x21918c);
    }
}
