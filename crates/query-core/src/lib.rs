//! An allowlisted query compiler. Numerical results never pass through this heap.
use std::cell::RefCell;

thread_local! { static OUTPUT: RefCell<String> = const { RefCell::new(String::new()) }; }

pub fn compile(metric: u32, aggregate: u32, bucket: u32, hours: u32, split: u32,
    vessel: i32, start: f64, end: f64) -> Result<String, &'static str> {
    let metric = match metric { 0 => "speed", 1 => "wind", 2 => "wave_height", 3 => "water_temp", _ => return Err("Unknown metric") };
    let aggregate = match aggregate { 0 => "avg", 1 => "min", 2 => "max", _ => return Err("Unknown aggregate") };
    if ![1,5,15,60,360,1440].contains(&bucket) || hours == 0 || hours > 336 || split > 1 || !(-1..=5).contains(&vessel) {
        return Err("Invalid query parameters");
    }
    if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start || end > 8_640_000_000_000_000.0 || start.fract() != 0.0 || end.fract() != 0.0 {
        return Err("Invalid dataset window");
    }
    let lower = start.max(end - f64::from(hours) * 3_600_000.0);
    let series = if split == 1 || vessel >= 0 { "vessel" } else { "0" };
    let filter = if vessel >= 0 { format!(" AND vessel = {vessel}") } else { String::new() };
    let bucket_ms = u64::from(bucket) * 60_000;
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
}
