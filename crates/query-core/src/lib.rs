//! An allowlisted query compiler. Numerical results never pass through this heap.
use std::cell::RefCell;

thread_local! { static OUTPUT: RefCell<String> = const { RefCell::new(String::new()) }; }

pub fn compile(metric: u32, aggregate: u32, bucket: u32, hours: u32, split: u32,
    vessel: i32, start: f64, end: f64) -> Result<String, &'static str> {
    compile_in_range(metric, aggregate, bucket, hours, split, vessel, start, end, None)
}

/// Restrict execution to whole groups of the original logical query. Dataset
/// bounds and relative-window anchoring stay unchanged across both statements.
pub fn compile_range(metric: u32, aggregate: u32, bucket: u32, hours: u32, split: u32,
    vessel: i32, start: f64, end: f64, range_start: f64, range_end: f64) -> Result<String, &'static str> {
    compile_in_range(metric, aggregate, bucket, hours, split, vessel, start, end, Some((range_start, range_end)))
}

fn compile_in_range(metric: u32, aggregate: u32, bucket: u32, hours: u32, split: u32,
    vessel: i32, start: f64, end: f64, range: Option<(f64, f64)>) -> Result<String, &'static str> {
    let metric = match metric { 0 => "speed", 1 => "wind", 2 => "wave_height", 3 => "water_temp", _ => return Err("Unknown metric") };
    let aggregate = match aggregate { 0 => "avg", 1 => "min", 2 => "max", _ => return Err("Unknown aggregate") };
    if ![1,5,15,60,360,1440].contains(&bucket) || hours == 0 || split > 1 || !(-1..=5).contains(&vessel) {
        return Err("Invalid query parameters");
    }
    if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start || end > 8_640_000_000_000_000.0 || start.fract() != 0.0 || end.fract() != 0.0 {
        return Err("Invalid dataset window");
    }
    let lower = start.max(end - f64::from(hours) * 3_600_000.0);
    let bucket_ms = u64::from(bucket) * 60_000;
    let (lower, end) = if let Some((lo, hi)) = range {
        if !lo.is_finite() || !hi.is_finite() || lo.fract() != 0.0 || hi.fract() != 0.0
            || lo < lower || hi > end || lo >= hi
            || (lo != lower && lo as u64 % bucket_ms != 0)
            || (hi != end && hi as u64 % bucket_ms != 0) {
            return Err("Execution range must contain complete query groups within the requested window");
        }
        (lo, hi)
    } else { (lower, end) };
    let series = if split == 1 || vessel >= 0 { "vessel" } else { "0" };
    let filter = if vessel >= 0 { format!(" AND vessel = {vessel}") } else { String::new() };
    Ok(format!("SELECT (floor(t / {bucket_ms}) * {bucket_ms})::DOUBLE AS x,\n       {aggregate}({metric})::DOUBLE AS y, {series}::INTEGER AS series,\n       avg(lat)::DOUBLE AS lat, avg(lon)::DOUBLE AS lon\nFROM telemetry\nWHERE t >= {lower:.0} AND t < {end:.0}{filter}\nGROUP BY 1, 3\nORDER BY 1, 3"))
}

/// The output borrow remains valid until the next compile call; the JS bridge copies only SQL text.
#[no_mangle]
pub extern "C" fn compile_query(metric:u32, aggregate:u32, bucket:u32, hours:u32, split:u32, vessel:i32, start:f64, end:f64) -> u32 {
    match compile(metric,aggregate,bucket,hours,split,vessel,start,end) {
        Ok(sql) => { OUTPUT.with(|out| *out.borrow_mut() = sql); 0 }
        Err(error) => { OUTPUT.with(|out| *out.borrow_mut() = error.to_string()); 1 }
    }
}
#[no_mangle]
pub extern "C" fn compile_query_range(metric:u32, aggregate:u32, bucket:u32, hours:u32, split:u32, vessel:i32,
    start:f64, end:f64, range_start:f64, range_end:f64) -> u32 {
    match compile_range(metric,aggregate,bucket,hours,split,vessel,start,end,range_start,range_end) {
        Ok(sql) => { OUTPUT.with(|out| *out.borrow_mut() = sql); 0 }
        Err(error) => { OUTPUT.with(|out| *out.borrow_mut() = error.to_string()); 1 }
    }
}
#[no_mangle]
pub extern "C" fn output_ptr() -> *const u8 { OUTPUT.with(|out| out.borrow().as_ptr()) }
#[no_mangle]
pub extern "C" fn output_len() -> usize { OUTPUT.with(|out| out.borrow().len()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_invalid_metrics_and_bounds() {
        assert!(compile(99,0,60,24,0,-1,0.0,1_000.0).is_err());
        assert!(compile(0,0,60,24,0,6,0.0,1_000.0).is_err());
        assert!(compile(0,0,60,24,0,-1,f64::NAN,1_000.0).is_err());
        assert!(compile(0,0,60,24,0,-1,1_000.0,0.0).is_err());
    }
    #[test] fn window_clamps_to_snapshot_and_identifiers_are_fixed() {
        let sql=compile(2,2,15,24,1,3,1000.0,3_600_000.0).unwrap();
        assert!(sql.contains("max(wave_height)"));
        assert!(sql.contains("t >= 1000 AND t < 3600000 AND vessel = 3"));
        assert!(sql.contains("vessel::INTEGER AS series"));
        assert!(!sql.contains(';'));
    }
    #[test] fn matches_committed_relative_window() {
        let sql=compile(0,0,60,1,0,-1,0.0,7_200_000.0).unwrap();
        assert!(sql.contains("t >= 3600000 AND t < 7200000"));
    }
    #[test] fn wide_requests_query_available_coverage() {
        let start = 1_788_220_800_000.0;
        let end = start + 14.0 * 86_400_000.0;
        for hours in [15 * 24, 710 * 24, u32::MAX] {
            let sql = compile(2,0,60,hours,1,-1,start,end).unwrap();
            assert!(sql.contains(&format!("t >= {start:.0} AND t < {end:.0}")));
            assert!(sql.contains("avg(wave_height)"));
        }
        assert!(compile(2,0,60,0,1,-1,start,end).is_err());
    }
    #[test] fn long_datasets_do_not_inherit_demo_coverage_limits() {
        let start = 1_700_000_000_000.0;
        let end = start + 1000.0 * 86_400_000.0;
        let lower = end - 710.0 * 86_400_000.0;
        let sql = compile(0,0,60,710*24,1,-1,start,end).unwrap();
        assert!(sql.contains(&format!("t >= {lower:.0} AND t < {end:.0}")));
    }
    #[test] fn bounded_execution_preserves_partial_first_bucket_and_original_anchor() {
        // A 25-hour request ends at 48h and starts at 23h. The first complete
        // requested group ends at 24h, not 29h; its label stays at 18h.
        let start = 0.0;
        let end = 48.0 * 3_600_000.0;
        let lower = 23.0 * 3_600_000.0;
        let cut = 24.0 * 3_600_000.0;
        let first = compile_range(2,0,360,25,1,-1,start,end,lower,cut).unwrap();
        let rest = compile_range(2,0,360,25,1,-1,start,end,cut,end).unwrap();
        assert!(first.contains("floor(t / 21600000)"));
        assert!(first.contains("t >= 82800000 AND t < 86400000"));
        assert!(rest.contains("t >= 86400000 AND t < 172800000"));
        assert!(compile_range(2,0,360,25,1,-1,start,end,lower,lower+21_600_000.0).is_err());
    }
    #[test] fn rejects_outside_nonfinite_and_group_splitting_ranges() {
        for (lo,hi) in [(0.0,3_600_000.0),(3_600_000.0,7_200_001.0),(3_600_000.0,3_600_000.0),
            (3_600_001.0,7_200_000.0),(3_600_000.0,4_000_000.0),(f64::NAN,7_200_000.0),
            (3_600_000.0,f64::INFINITY),(3_600_000.5,7_200_000.0)] {
            assert!(compile_range(0,0,60,1,0,-1,0.0,7_200_000.0,lo,hi).is_err());
        }
    }
    #[test] fn full_execution_range_matches_original_and_retains_vessel_filter() {
        for aggregate in [0,1,2] {
            let whole = compile(1,aggregate,15,u32::MAX,0,3,1000.0,7_200_000.0).unwrap();
            assert_eq!(whole,compile_range(1,aggregate,15,u32::MAX,0,3,1000.0,7_200_000.0,1000.0,7_200_000.0).unwrap());
            let first=compile_range(1,aggregate,15,u32::MAX,0,3,1000.0,7_200_000.0,1000.0,900_000.0).unwrap();
            assert!(first.contains("AND vessel = 3"));
            assert!(first.contains("vessel::INTEGER AS series"));
        }
    }
}
