//! Scales, nice numbers, axis ticks and label formatting (numbers and UTC time).
//!
//! Everything here is pure and allocation-light so it can be unit tested natively.

/// A closed numeric interval.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Domain {
    pub lo: f64,
    pub hi: f64,
}

impl Domain {
    pub const EMPTY: Domain = Domain { lo: f64::INFINITY, hi: f64::NEG_INFINITY };
    pub fn new(lo: f64, hi: f64) -> Domain {
        Domain { lo, hi }
    }
    pub fn is_empty(&self) -> bool {
        !(self.lo <= self.hi)
    }
    pub fn span(&self) -> f64 {
        self.hi - self.lo
    }
    #[inline]
    pub fn include(&mut self, v: f64) {
        if v < self.lo {
            self.lo = v;
        }
        if v > self.hi {
            self.hi = v;
        }
    }
    pub fn union(&mut self, other: Domain) {
        if !other.is_empty() {
            self.include(other.lo);
            self.include(other.hi);
        }
    }
    pub fn contains(&self, other: Domain) -> bool {
        other.is_empty() || (!self.is_empty() && self.lo <= other.lo && self.hi >= other.hi)
    }
    /// Map `v` from this domain into `[a, b]`.
    pub fn map(&self, v: f64, a: f64, b: f64) -> f64 {
        let span = self.span();
        if span == 0.0 {
            return (a + b) * 0.5;
        }
        a + (v - self.lo) / span * (b - a)
    }
}

/// The 1-2-5 step closest to `span / count`.
pub fn nice_step(span: f64, count: usize) -> f64 {
    let count = count.max(1) as f64;
    if !(span > 0.0) || !span.is_finite() {
        return 1.0;
    }
    let raw = span / count;
    let power = 10f64.powf(raw.log10().floor());
    let fraction = raw / power;
    // d3's thresholds: geometric midpoints between 1, 2, 5 and 10.
    let nice = if fraction < 1.414_213_6 {
        1.0
    } else if fraction < 3.162_277_7 {
        2.0
    } else if fraction < 7.071_067_8 {
        5.0
    } else {
        10.0
    };
    nice * power
}

/// Extend `extent` outward to multiples of a nice step, giving stable axes as data streams in.
/// A degenerate extent (one value) is widened around the value.
pub fn nice_domain(extent: Domain, count: usize) -> Domain {
    if extent.is_empty() {
        return Domain::new(0.0, 1.0);
    }
    let (mut lo, mut hi) = (extent.lo, extent.hi);
    if lo == hi {
        let pad = if lo == 0.0 { 1.0 } else { lo.abs() * 0.1 };
        lo -= pad;
        hi += pad;
    }
    let step = nice_step(hi - lo, count);
    let nlo = (lo / step).floor() * step;
    let nhi = (hi / step).ceil() * step;
    Domain::new(nlo, nhi)
}

/// Tick values at multiples of a nice step inside `domain`.
pub fn linear_ticks(domain: Domain, count: usize) -> (Vec<f64>, f64) {
    if domain.is_empty() || domain.span() <= 0.0 {
        return (if domain.is_empty() { vec![] } else { vec![domain.lo] }, 1.0);
    }
    let step = nice_step(domain.span(), count);
    let first = (domain.lo / step - 1e-9).ceil() as i64;
    let last = (domain.hi / step + 1e-9).floor() as i64;
    let mut ticks = Vec::with_capacity((last - first + 1).max(0) as usize);
    for k in first..=last {
        let v = k as f64 * step;
        // Snap -0 and float noise like 0.30000000000000004 to the step grid.
        ticks.push(if v.abs() < step * 1e-9 { 0.0 } else { v });
        if ticks.len() > 1000 {
            break;
        }
    }
    (ticks, step)
}

/// Format `v` for an axis whose ticks are `step` apart: enough decimals to distinguish
/// neighbours, SI suffixes for large magnitudes.
pub fn format_number(v: f64, step: f64) -> String {
    if v == 0.0 {
        return String::from("0");
    }
    if !v.is_finite() {
        return if v.is_nan() { String::from("NULL") } else if v > 0.0 { String::from("∞") } else { String::from("-∞") };
    }
    let mag = v.abs().max(step.abs());
    let (div, suffix) = if mag >= 1e12 {
        (1e12, "T")
    } else if mag >= 1e9 {
        (1e9, "G")
    } else if mag >= 1e6 {
        (1e6, "M")
    } else if mag >= 1e4 {
        (1e3, "k")
    } else {
        (1.0, "")
    };
    let scaled = v / div;
    let scaled_step = (step / div).abs();
    let decimals = if scaled_step > 0.0 && scaled_step < 1.0 {
        ((-scaled_step.log10()).ceil() as usize).min(12)
    } else {
        0
    };
    let mut s = format!("{:.*}", decimals, scaled);
    if s.starts_with('-') && s[1..].chars().all(|c| c == '0' || c == '.') {
        s.remove(0);
    }
    s.push_str(suffix);
    s
}

/// Format a value with up to `sig` significant digits (table cells, legends).
pub fn format_value(v: f64, sig: usize) -> String {
    if !v.is_finite() {
        return format_number(v, 1.0);
    }
    if v == v.trunc() && v.abs() < 1e15 {
        return format!("{}", v as i64);
    }
    let mag = v.abs().log10().floor() as i32;
    let decimals = (sig as i32 - 1 - mag).clamp(0, 12) as usize;
    let s = format!("{:.*}", decimals, v);
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    }
}

// ───────────────────────── time ─────────────────────────

pub const US_PER_SECOND: i64 = 1_000_000;
pub const US_PER_MINUTE: i64 = 60 * US_PER_SECOND;
pub const US_PER_HOUR: i64 = 60 * US_PER_MINUTE;
pub const US_PER_DAY: i64 = 24 * US_PER_HOUR;

/// Days since 1970-01-01 → (year, month 1..=12, day 1..=31). Howard Hinnant's algorithm.
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// (year, month 1..=12, day) → days since 1970-01-01.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// Calendar-aware tick interval.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeStep {
    /// Fixed length in microseconds (sub-second up to weeks).
    Fixed(i64),
    Months(u32),
    Years(u32),
}

const FIXED_STEPS: [i64; 26] = [
    1, 10, 100, 1_000, 10_000, 100_000, // sub-millisecond / millisecond ranges
    US_PER_SECOND, 2 * US_PER_SECOND, 5 * US_PER_SECOND, 10 * US_PER_SECOND, 15 * US_PER_SECOND, 30 * US_PER_SECOND,
    US_PER_MINUTE, 2 * US_PER_MINUTE, 5 * US_PER_MINUTE, 10 * US_PER_MINUTE, 15 * US_PER_MINUTE, 30 * US_PER_MINUTE,
    US_PER_HOUR, 2 * US_PER_HOUR, 3 * US_PER_HOUR, 6 * US_PER_HOUR, 12 * US_PER_HOUR,
    US_PER_DAY, 2 * US_PER_DAY, 7 * US_PER_DAY,
];

/// Choose the time step giving about `count` ticks over `[lo, hi]` (µs since epoch, UTC).
pub fn time_step(lo: i64, hi: i64, count: usize) -> TimeStep {
    let span = (hi - lo).max(1) as f64;
    let target = span / count.max(1) as f64;
    let year = 365.25 * US_PER_DAY as f64;
    if target >= year * 0.75 {
        let step = nice_step(span / year, count).max(1.0);
        return TimeStep::Years(step as u32);
    }
    // The candidate closest to the target in log space.
    let month = 30.44 * US_PER_DAY as f64;
    let candidates = FIXED_STEPS
        .iter()
        .map(|&s| (TimeStep::Fixed(s), s as f64))
        .chain([1u32, 2, 3, 6].iter().map(|&m| (TimeStep::Months(m), m as f64 * month)))
        .chain(core::iter::once((TimeStep::Years(1), year)));
    let mut best = (TimeStep::Fixed(1), f64::INFINITY);
    for (step, length) in candidates {
        let distance = (length / target).ln().abs();
        if distance < best.1 {
            best = (step, distance);
        }
    }
    best.0
}

/// Tick instants (µs, UTC) at calendar-aligned multiples of the step inside `[lo, hi]`.
pub fn time_ticks(lo: i64, hi: i64, count: usize) -> (Vec<i64>, TimeStep) {
    let step = time_step(lo, hi, count);
    let mut out = Vec::new();
    if hi < lo {
        return (out, step);
    }
    match step {
        TimeStep::Fixed(s) => {
            // Align weeks to Monday (1970-01-05 was a Monday); everything else to the epoch.
            let anchor = if s == 7 * US_PER_DAY { 4 * US_PER_DAY } else { 0 };
            let mut t = (lo - anchor).div_euclid(s) * s + anchor;
            if t < lo {
                t += s;
            }
            while t <= hi && out.len() < 1000 {
                out.push(t);
                t += s;
            }
        }
        TimeStep::Months(m) => {
            let (mut y, mut mo, _) = civil_from_days(lo.div_euclid(US_PER_DAY));
            mo = ((mo - 1) / m) * m + 1;
            loop {
                let t = days_from_civil(y, mo, 1) * US_PER_DAY;
                if t > hi || out.len() >= 1000 {
                    break;
                }
                if t >= lo {
                    out.push(t);
                }
                mo += m;
                while mo > 12 {
                    mo -= 12;
                    y += 1;
                }
            }
        }
        TimeStep::Years(n) => {
            let n = n.max(1) as i64;
            let (y0, _, _) = civil_from_days(lo.div_euclid(US_PER_DAY));
            let mut y = y0.div_euclid(n) * n;
            loop {
                let t = days_from_civil(y, 1, 1) * US_PER_DAY;
                if t > hi || out.len() >= 1000 {
                    break;
                }
                if t >= lo {
                    out.push(t);
                }
                y += n;
            }
        }
    }
    (out, step)
}

/// UTC label for a tick at `t` (µs) given the tick step. Day boundaries inside sub-day
/// steps show the date instead of `00:00`.
pub fn format_time_tick(t: i64, step: TimeStep) -> String {
    let days = t.div_euclid(US_PER_DAY);
    let in_day = t.rem_euclid(US_PER_DAY);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm) = (in_day / US_PER_HOUR, (in_day / US_PER_MINUTE) % 60);
    let ss = (in_day / US_PER_SECOND) % 60;
    let sub = in_day % US_PER_SECOND;
    let month = MONTHS[(m - 1) as usize];
    match step {
        TimeStep::Fixed(s) if s < US_PER_SECOND => {
            if s < 1_000 {
                format!("{:02}:{:02}:{:02}.{:06}", hh, mm, ss, sub)
            } else {
                format!("{:02}:{:02}:{:02}.{:03}", hh, mm, ss, sub / 1_000)
            }
        }
        TimeStep::Fixed(s) if s < US_PER_MINUTE => {
            if in_day == 0 {
                format!("{} {}", month, d)
            } else {
                format!("{:02}:{:02}:{:02}", hh, mm, ss)
            }
        }
        TimeStep::Fixed(s) if s < US_PER_DAY => {
            if in_day == 0 {
                format!("{} {}", month, d)
            } else {
                format!("{:02}:{:02}", hh, mm)
            }
        }
        TimeStep::Fixed(_) => {
            if m == 1 && d == 1 {
                format!("{}", y)
            } else {
                format!("{} {}", month, d)
            }
        }
        TimeStep::Months(_) => {
            if m == 1 {
                format!("{}", y)
            } else {
                month.to_string()
            }
        }
        TimeStep::Years(_) => format!("{}", y),
    }
}

/// Full UTC timestamp, e.g. `2026-01-05 13:45:00` (seconds always shown; fraction when present).
pub fn format_timestamp(t: i64) -> String {
    let days = t.div_euclid(US_PER_DAY);
    let in_day = t.rem_euclid(US_PER_DAY);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (in_day / US_PER_HOUR, (in_day / US_PER_MINUTE) % 60, (in_day / US_PER_SECOND) % 60);
    let sub = in_day % US_PER_SECOND;
    if in_day == 0 {
        format!("{:04}-{:02}-{:02}", y, m, d)
    } else if sub == 0 {
        format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, m, d, hh, mm, ss)
    } else if sub % 1000 == 0 {
        format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}", y, m, d, hh, mm, ss, sub / 1000)
    } else {
        format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:06}", y, m, d, hh, mm, ss, sub)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nice_steps() {
        assert_eq!(nice_step(10.0, 5), 2.0);
        assert_eq!(nice_step(100.0, 5), 20.0);
        assert_eq!(nice_step(1.0, 4), 0.2);
        assert_eq!(nice_step(37.0, 5), 10.0);
        assert_eq!(nice_step(30.0, 5), 5.0);
        assert_eq!(nice_step(0.0, 5), 1.0);
    }

    #[test]
    fn nice_domains_cover_extent() {
        let d = nice_domain(Domain::new(0.3, 17.2), 5);
        assert_eq!(d, Domain::new(0.0, 20.0));
        let single = nice_domain(Domain::new(5.0, 5.0), 5);
        assert!(single.lo < 5.0 && single.hi > 5.0);
        let neg = nice_domain(Domain::new(-3.2, 4.1), 5);
        assert_eq!(neg, Domain::new(-4.0, 6.0));
        assert_eq!(nice_domain(Domain::EMPTY, 5), Domain::new(0.0, 1.0));
    }

    #[test]
    fn linear_ticks_are_on_step_grid() {
        let (t, step) = linear_ticks(Domain::new(0.0, 1.0), 5);
        assert_eq!(step, 0.2);
        assert_eq!(t.len(), 6);
        assert_eq!(format_number(t[3], step), "0.6");
        let (t, _) = linear_ticks(Domain::new(-0.5, 0.5), 4);
        assert!(t.contains(&0.0));
        assert!(t.iter().all(|v| !(v.is_sign_negative() && *v == 0.0)));
    }

    #[test]
    fn number_labels() {
        assert_eq!(format_number(1500.0, 500.0), "1500");
        assert_eq!(format_number(15000.0, 5000.0), "15k");
        assert_eq!(format_number(2_500_000.0, 500_000.0), "2.5M");
        assert_eq!(format_number(0.25, 0.05), "0.25");
        assert_eq!(format_number(-0.0, 0.5), "0");
        assert_eq!(format_number(f64::NAN, 1.0), "NULL");
        assert_eq!(format_value(12.3456789, 6), "12.3457");
        assert_eq!(format_value(42.0, 6), "42");
    }

    #[test]
    fn civil_round_trip() {
        for days in [-1_000_000i64, -1, 0, 1, 365, 10_957, 20_454, 2_000_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
    }

    #[test]
    fn hourly_ticks_label_midnight_with_date() {
        let lo = days_from_civil(2026, 1, 1) * US_PER_DAY + 20 * US_PER_HOUR;
        let hi = lo + 10 * US_PER_HOUR;
        let (ticks, step) = time_ticks(lo, hi, 5);
        assert_eq!(step, TimeStep::Fixed(2 * US_PER_HOUR));
        let labels: Vec<String> = ticks.iter().map(|&t| format_time_tick(t, step)).collect();
        assert_eq!(labels, ["20:00", "22:00", "Jan 2", "02:00", "04:00", "06:00"]);
    }

    #[test]
    fn multi_week_and_month_ticks() {
        let lo = days_from_civil(2026, 1, 1) * US_PER_DAY;
        let (ticks, step) = time_ticks(lo, lo + 14 * US_PER_DAY, 5);
        assert_eq!(step, TimeStep::Fixed(2 * US_PER_DAY));
        assert_eq!(format_time_tick(ticks[0], step), "2026");
        assert_eq!(format_time_tick(ticks[1], step), "Jan 3");
        let (ticks, step) = time_ticks(lo, days_from_civil(2026, 12, 31) * US_PER_DAY, 5);
        assert_eq!(step, TimeStep::Months(2));
        let labels: Vec<String> = ticks.iter().map(|&t| format_time_tick(t, step)).collect();
        assert_eq!(labels, ["2026", "Mar", "May", "Jul", "Sep", "Nov"]);
        let (ticks, step) = time_ticks(lo, days_from_civil(2046, 1, 1) * US_PER_DAY, 5);
        assert!(matches!(step, TimeStep::Years(5)));
        assert_eq!(format_time_tick(ticks[0], step), "2030");
    }

    #[test]
    fn subsecond_ticks_keep_precision() {
        let lo = 1_700_000_000 * US_PER_SECOND + 123;
        let (ticks, step) = time_ticks(lo, lo + 50, 5);
        assert_eq!(step, TimeStep::Fixed(10));
        assert!(format_time_tick(ticks[0], step).ends_with(".000130"));
    }

    #[test]
    fn timestamps_format_exactly() {
        let t = days_from_civil(2026, 10, 10) * US_PER_DAY + 13 * US_PER_HOUR + 5 * US_PER_MINUTE + 7 * US_PER_SECOND + 1;
        assert_eq!(format_timestamp(t), "2026-10-10 13:05:07.000001");
        assert_eq!(format_timestamp(days_from_civil(2026, 10, 10) * US_PER_DAY), "2026-10-10");
    }
}
