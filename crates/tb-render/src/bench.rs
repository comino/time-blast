//! Kernels measured by `render-bench.html` to choose between data-path alternatives.

/// Reinterpret 8-byte-aligned bytes as f64.
pub fn as_f64(bytes: &[u8]) -> &[f64] {
    assert!(bytes.as_ptr() as usize % 8 == 0 && bytes.len() % 8 == 0);
    // SAFETY: alignment and length checked; every bit pattern is a valid f64.
    unsafe { core::slice::from_raw_parts(bytes.as_ptr() as *const f64, bytes.len() / 8) }
}

/// NaN-skipping min/max.
pub fn minmax_scalar(values: &[f64]) -> (f64, f64) {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for &v in values {
        if v < lo {
            lo = v;
        }
        if v > hi {
            hi = v;
        }
    }
    (lo, hi)
}

#[cfg(target_arch = "wasm32")]
pub fn minmax_simd(values: &[f64]) -> (f64, f64) {
    // SAFETY: the simd128 target feature is enabled for this function only; every engine
    // that runs WebGPU/WebGL2 time-blast supports Wasm SIMD.
    unsafe { minmax_simd128(values) }
}

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn minmax_simd128(values: &[f64]) -> (f64, f64) {
    use core::arch::wasm32::*;
    let mut lo = f64x2_splat(f64::INFINITY);
    let mut hi = f64x2_splat(f64::NEG_INFINITY);
    let chunks = values.chunks_exact(2);
    let rest = chunks.remainder();
    for c in chunks {
        let v = f64x2(c[0], c[1]);
        // pmin/pmax: NaN in `v` keeps the accumulator (b < a ? b : a).
        lo = f64x2_pmin(lo, v);
        hi = f64x2_pmax(hi, v);
    }
    let (mut l, mut h) = (f64x2_extract_lane::<0>(lo).min(f64x2_extract_lane::<1>(lo)), f64x2_extract_lane::<0>(hi).max(f64x2_extract_lane::<1>(hi)));
    for &v in rest {
        l = l.min(v);
        h = h.max(v);
    }
    (l, h)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn minmax_simd(values: &[f64]) -> (f64, f64) {
    minmax_scalar(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minmax_skips_nan() {
        assert_eq!(minmax_scalar(&[3.0, f64::NAN, -1.0, 2.0]), (-1.0, 3.0));
        assert_eq!(minmax_simd(&[3.0, f64::NAN, -1.0, 2.0, 7.0]), (-1.0, 7.0));
    }
}
