//! Canonical columns of one result, appended batch by batch from raw Arrow buffers.
//!
//! The JS shim copies each needed Arrow buffer once into Wasm memory (staging). Ingest
//! converts it column-wise into exact canonical values — time as i64 µs, numbers as f64,
//! text as interned u32 ids — with nulls kept as nulls (never zeros). View families read
//! these columns to build GPU geometry and can rebuild from them when the view changes.

use crate::schema::{ColumnInfo, Roles, TypeCode, XKind};
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

/// Null time.
pub const NULL_TIME: i64 = i64::MIN;

/// Tiny FxHash: interning short strings with SipHash costs more than the rest of ingest.
#[derive(Default)]
pub struct FxHasher(u64);
impl Hasher for FxHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8) {
            let mut w = [0u8; 8];
            w[..chunk.len()].copy_from_slice(chunk);
            self.0 = (self.0.rotate_left(5) ^ u64::from_le_bytes(w)).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
        }
    }
}
pub type FxMap<K, V> = HashMap<K, V, BuildHasherDefault<FxHasher>>;

/// Strings → dense ids in first-seen order. Null has its own id, labelled `NULL`.
#[derive(Default)]
pub struct Interner {
    ids: FxMap<Box<[u8]>, u32>,
    pub labels: Vec<String>,
    null: Option<u32>,
}

impl Interner {
    pub fn intern(&mut self, bytes: &[u8]) -> u32 {
        if let Some(&id) = self.ids.get(bytes) {
            return id;
        }
        let id = self.labels.len() as u32;
        self.labels.push(String::from_utf8_lossy(bytes).into_owned());
        self.ids.insert(bytes.into(), id);
        id
    }
    pub fn null(&mut self) -> u32 {
        if let Some(id) = self.null {
            return id;
        }
        let id = self.labels.len() as u32;
        self.labels.push(String::from("NULL"));
        self.null = Some(id);
        id
    }
    pub fn len(&self) -> usize {
        self.labels.len()
    }
    /// Is `id` the null id?
    pub fn is_null(&self, id: u32) -> bool {
        self.null == Some(id)
    }
    /// The id of a label as drawn (legend text): a real value wins over the null id when a
    /// value is literally spelled `NULL`. Returns (id, is_null).
    pub fn find(&self, label: &str) -> Option<(u32, bool)> {
        if let Some(&id) = self.ids.get(label.as_bytes()) {
            return Some((id, false));
        }
        self.null.filter(|&id| self.labels[id as usize] == label).map(|id| (id, true))
    }
}

/// One Arrow column of one batch, as copied into staging by the shim.
pub struct RawColumn<'a> {
    pub index: usize,
    pub code: TypeCode,
    pub param: u32,
    pub rows: usize,
    /// Fixed-width values (already offset to the first row), dictionary indices, or utf8 bytes.
    pub data: &'a [u8],
    /// Validity bitmap and the bit index of the first row, when the column has nulls.
    pub validity: Option<(&'a [u8], usize)>,
    /// Bit index of the first row inside `data` for Bool columns.
    pub bit_offset: usize,
    /// utf8 offsets (i32, or i64 for LargeUtf8), `rows + 1` entries, absolute into the original
    /// values buffer; `data` starts at `offsets[0]`.
    pub offsets: &'a [u8],
    /// New dictionary for a Dict column: (i32 offsets, bytes). `None` = same as the last batch.
    pub dict: Option<(&'a [u8], &'a [u8])>,
}

impl<'a> RawColumn<'a> {
    #[inline]
    fn valid(&self, row: usize) -> bool {
        match self.validity {
            None => true,
            Some((bits, off)) => {
                let b = off + row;
                bits.get(b >> 3).map_or(false, |byte| byte >> (b & 7) & 1 == 1)
            }
        }
    }

    fn offset(&self, i: usize) -> usize {
        if self.code == TypeCode::LargeUtf8 {
            i64::from_le_bytes(self.offsets[i * 8..i * 8 + 8].try_into().unwrap()) as usize
        } else {
            i32::from_le_bytes(self.offsets[i * 4..i * 4 + 4].try_into().unwrap()) as usize
        }
    }

    /// Append numbers (f64, NaN for null). Temporal columns become epoch µs as f64.
    pub fn read_numbers(&self, out: &mut Vec<f64>) {
        use TypeCode::*;
        let n = self.rows;
        out.reserve(n);
        let start = out.len();
        let d = self.data;
        macro_rules! fixed {
            ($t:ty, $w:expr, $conv:expr) => {{
                let f = $conv;
                out.extend(d[..n * $w].chunks_exact($w).map(|b| f(<$t>::from_le_bytes(b.try_into().unwrap()))));
            }};
        }
        match self.code {
            F64 => fixed!(f64, 8, |v: f64| v),
            F32 => fixed!(f32, 4, |v: f32| v as f64),
            I8 => fixed!(i8, 1, |v: i8| v as f64),
            I16 => fixed!(i16, 2, |v: i16| v as f64),
            I32 => fixed!(i32, 4, |v: i32| v as f64),
            I64 => fixed!(i64, 8, |v: i64| v as f64),
            U8 => fixed!(u8, 1, |v: u8| v as f64),
            U16 => fixed!(u16, 2, |v: u16| v as f64),
            U32 => fixed!(u32, 4, |v: u32| v as f64),
            U64 => fixed!(u64, 8, |v: u64| v as f64),
            Decimal => {
                let scale = 10f64.powi(self.param as u16 as i16 as i32);
                if self.param >> 16 == 64 {
                    fixed!(i64, 8, |v: i64| v as f64 / scale)
                } else {
                    fixed!(i128, 16, |v: i128| v as f64 / scale)
                }
            }
            TimeOfDay => {
                let div = unit_per_ms(self.param & 0xff);
                if self.param >> 8 == 32 {
                    fixed!(i32, 4, |v: i32| v as f64 / div)
                } else {
                    fixed!(i64, 8, |v: i64| v as f64 / div)
                }
            }
            Duration => {
                let div = unit_per_ms(self.param);
                fixed!(i64, 8, |v: i64| v as f64 / div)
            }
            Date32 | Date64 | Timestamp => {
                let mut tmp = Vec::with_capacity(n);
                self.read_times(&mut tmp);
                out.extend(tmp.iter().map(|&t| if t == NULL_TIME { f64::NAN } else { t as f64 }));
            }
            _ => out.extend(std::iter::repeat(f64::NAN).take(n)),
        }
        if self.validity.is_some() {
            for (i, v) in out[start..].iter_mut().enumerate() {
                if !self.valid(i) {
                    *v = f64::NAN;
                }
            }
        }
    }

    /// Append exact timestamps in µs since the epoch (`NULL_TIME` for null).
    /// Nanoseconds are floored to µs.
    pub fn read_times(&self, out: &mut Vec<i64>) {
        use TypeCode::*;
        let n = self.rows;
        out.reserve(n);
        let start = out.len();
        let d = self.data;
        match self.code {
            Date32 => out.extend(d[..n * 4].chunks_exact(4).map(|b| i32::from_le_bytes(b.try_into().unwrap()) as i64 * 86_400_000_000)),
            Date64 => out.extend(d[..n * 8].chunks_exact(8).map(|b| i64::from_le_bytes(b.try_into().unwrap()).saturating_mul(1000))),
            Timestamp => {
                let raw = d[..n * 8].chunks_exact(8).map(|b| i64::from_le_bytes(b.try_into().unwrap()));
                match self.param {
                    0 => out.extend(raw.map(|v| v.saturating_mul(1_000_000))),
                    1 => out.extend(raw.map(|v| v.saturating_mul(1_000))),
                    2 => out.extend(raw),
                    _ => out.extend(raw.map(|v| v.div_euclid(1_000))),
                }
            }
            _ => {
                let mut tmp = Vec::with_capacity(n);
                self.read_numbers(&mut tmp);
                out.extend(tmp.iter().map(|&v| if v.is_finite() { v as i64 } else { NULL_TIME }));
            }
        }
        if self.validity.is_some() {
            for (i, v) in out[start..].iter_mut().enumerate() {
                if !self.valid(i) {
                    *v = NULL_TIME;
                }
            }
        }
    }

    /// Append interned ids for text, dictionary, bool (and, as a fallback, numbers).
    pub fn read_ids(&self, interner: &mut Interner, dict_map: &mut Vec<u32>, out: &mut Vec<u32>) {
        use TypeCode::*;
        let n = self.rows;
        out.reserve(n);
        match self.code {
            Utf8 | LargeUtf8 => {
                let base = self.offset(0);
                for i in 0..n {
                    if !self.valid(i) {
                        out.push(interner.null());
                        continue;
                    }
                    let (a, b) = (self.offset(i) - base, self.offset(i + 1) - base);
                    out.push(interner.intern(&self.data[a..b]));
                }
            }
            Dict => {
                if let Some((offsets, bytes)) = self.dict {
                    let count = offsets.len() / 4 - 1;
                    let at = |i: usize| i32::from_le_bytes(offsets[i * 4..i * 4 + 4].try_into().unwrap()) as usize;
                    let base = at(0);
                    dict_map.clear();
                    for i in 0..count {
                        dict_map.push(interner.intern(&bytes[at(i) - base..at(i + 1) - base]));
                    }
                }
                let index_code = TypeCode::from_u32(self.param);
                let w = index_code.width().max(1);
                for i in 0..n {
                    if !self.valid(i) {
                        out.push(interner.null());
                        continue;
                    }
                    let b = &self.data[i * w..i * w + w];
                    let k = match w {
                        1 => b[0] as usize,
                        2 => u16::from_le_bytes([b[0], b[1]]) as usize,
                        4 => u32::from_le_bytes(b.try_into().unwrap()) as usize,
                        _ => u64::from_le_bytes(b.try_into().unwrap()) as usize,
                    };
                    let id = match dict_map.get(k) {
                        Some(&id) => id,
                        None => interner.null(),
                    };
                    out.push(id);
                }
            }
            Bool => {
                for i in 0..n {
                    if !self.valid(i) {
                        out.push(interner.null());
                        continue;
                    }
                    let b = self.bit_offset + i;
                    let on = self.data.get(b >> 3).map_or(false, |byte| byte >> (b & 7) & 1 == 1);
                    out.push(interner.intern(if on { b"true" } else { b"false" }));
                }
            }
            _ => {
                let mut tmp = Vec::with_capacity(n);
                self.read_numbers(&mut tmp);
                for v in tmp {
                    if v.is_nan() {
                        out.push(interner.null());
                    } else {
                        let label = crate::scale::format_value(v, 12);
                        out.push(interner.intern(label.as_bytes()));
                    }
                }
            }
        }
    }
}

fn unit_per_ms(unit: u32) -> f64 {
    match unit {
        0 => 1e-3,
        1 => 1.0,
        2 => 1e3,
        _ => 1e6,
    }
}

/// x positions in their exact form.
pub enum XValues {
    Time(Vec<i64>),
    Num(Vec<f64>),
    Cat(Vec<u32>),
}

/// All rows received so far for one result, in arrival order, only for role columns.
pub struct Store {
    pub columns: Vec<ColumnInfo>,
    pub roles: Roles,
    pub rows: usize,
    pub x: Option<XValues>,
    pub series: Option<Vec<u32>>,
    pub value: Option<Vec<f64>>,
    /// Parallel to `roles.measures`.
    pub measures: Vec<Vec<f64>>,
    pub lat: Option<Vec<f64>>,
    pub lon: Option<Vec<f64>>,
    pub x_labels: Interner,
    pub series_labels: Interner,
    dict_x: Vec<u32>,
    dict_series: Vec<u32>,
}

impl Store {
    pub fn new(columns: Vec<ColumnInfo>, roles: Roles) -> Store {
        let x = roles.x.map(|(_, kind)| match kind {
            XKind::Time => XValues::Time(Vec::new()),
            XKind::Category => XValues::Cat(Vec::new()),
            XKind::Numeric { .. } => XValues::Num(Vec::new()),
        });
        Store {
            measures: roles.measures.iter().map(|_| Vec::new()).collect(),
            series: roles.series.map(|_| Vec::new()),
            value: roles.value.map(|_| Vec::new()),
            lat: roles.lat.map(|_| Vec::new()),
            lon: roles.lon.map(|_| Vec::new()),
            columns,
            roles,
            rows: 0,
            x,
            x_labels: Interner::default(),
            series_labels: Interner::default(),
            dict_x: Vec::new(),
            dict_series: Vec::new(),
        }
    }

    /// Append one batch. Columns not used by any role are ignored; missing role columns
    /// are filled with nulls so every canonical column keeps `rows` entries.
    pub fn append(&mut self, rows: usize, columns: &[RawColumn]) {
        let find = |i: Option<usize>| i.and_then(|i| columns.iter().find(|c| c.index == i && c.rows == rows));
        if let Some((xi, _)) = self.roles.x {
            let col = find(Some(xi));
            match (&mut self.x, col) {
                (Some(XValues::Time(v)), Some(c)) => c.read_times(v),
                (Some(XValues::Time(v)), None) => v.extend(std::iter::repeat(NULL_TIME).take(rows)),
                (Some(XValues::Num(v)), Some(c)) => c.read_numbers(v),
                (Some(XValues::Num(v)), None) => v.extend(std::iter::repeat(f64::NAN).take(rows)),
                (Some(XValues::Cat(v)), Some(c)) => c.read_ids(&mut self.x_labels, &mut self.dict_x, v),
                (Some(XValues::Cat(v)), None) => {
                    let null = self.x_labels.null();
                    v.extend(std::iter::repeat(null).take(rows))
                }
                (None, _) => {}
            }
        }
        if let Some(out) = &mut self.series {
            match find(self.roles.series) {
                Some(c) => c.read_ids(&mut self.series_labels, &mut self.dict_series, out),
                None => {
                    let null = self.series_labels.null();
                    out.extend(std::iter::repeat(null).take(rows))
                }
            }
        }
        let numbers = |out: &mut Vec<f64>, col: Option<&RawColumn>| match col {
            Some(c) => c.read_numbers(out),
            None => out.extend(std::iter::repeat(f64::NAN).take(rows)),
        };
        if let Some(out) = &mut self.value {
            numbers(out, find(self.roles.value));
        }
        for (k, out) in self.measures.iter_mut().enumerate() {
            numbers(out, find(Some(self.roles.measures[k])));
        }
        if let Some(out) = &mut self.lat {
            numbers(out, find(self.roles.lat));
        }
        if let Some(out) = &mut self.lon {
            numbers(out, find(self.roles.lon));
        }
        self.rows += rows;
    }

    /// Steady charts: are rows `from..to` of `self` identical to the same rows of `other`?
    /// Identical means the same canonical values in every role column (bit-equal floats, so
    /// nulls match nulls) and the same labels for every text id used so far. Ids are interned in
    /// first-seen order, so equal id sequences plus an equal label prefix mean equal text.
    /// Callers check schema (types, roles) separately. Cost: one pass over the new rows.
    pub fn same_rows(&self, other: &Store, from: usize, to: usize) -> bool {
        if to > other.rows || to > self.rows || from > to {
            return false;
        }
        fn floats(a: &Option<Vec<f64>>, b: &Option<Vec<f64>>, r: std::ops::Range<usize>) -> bool {
            match (a, b) {
                (Some(a), Some(b)) => a[r.clone()].iter().zip(&b[r]).all(|(x, y)| x.to_bits() == y.to_bits()),
                (None, None) => true,
                _ => false,
            }
        }
        let r = from..to;
        let x = match (&self.x, &other.x) {
            (Some(XValues::Time(a)), Some(XValues::Time(b))) => a[r.clone()] == b[r.clone()],
            (Some(XValues::Num(a)), Some(XValues::Num(b))) => a[r.clone()].iter().zip(&b[r.clone()]).all(|(x, y)| x.to_bits() == y.to_bits()),
            (Some(XValues::Cat(a)), Some(XValues::Cat(b))) => a[r.clone()] == b[r.clone()],
            (None, None) => true,
            _ => false,
        };
        let series = match (&self.series, &other.series) {
            (Some(a), Some(b)) => a[r.clone()] == b[r.clone()],
            (None, None) => true,
            _ => false,
        };
        let labels = |a: &Interner, b: &Interner| a.labels.len() <= b.labels.len() && a.labels[..] == b.labels[..a.labels.len()] && a.null == b.null.filter(|&n| (n as usize) < a.labels.len());
        x && series
            && floats(&self.value, &other.value, r.clone())
            && floats(&self.lat, &other.lat, r.clone())
            && floats(&self.lon, &other.lon, r.clone())
            && self.measures.len() == other.measures.len()
            && self.measures.iter().zip(&other.measures).all(|(a, b)| a[r.clone()].iter().zip(&b[r.clone()]).all(|(x, y)| x.to_bits() == y.to_bits()))
            && labels(&self.x_labels, &other.x_labels)
            && labels(&self.series_labels, &other.series_labels)
    }

    /// The x value of row `i` as a number on the axis (time: µs; category: id).
    pub fn x_number(&self, i: usize) -> f64 {
        match &self.x {
            Some(XValues::Time(v)) if v[i] == NULL_TIME => f64::NAN,
            Some(XValues::Time(v)) => v[i] as f64,
            Some(XValues::Num(v)) => v[i],
            Some(XValues::Cat(v)) => v[i] as f64,
            None => f64::NAN,
        }
    }

    /// Exact x label for row `i` (tables, tooltips).
    pub fn x_label(&self, i: usize) -> String {
        match &self.x {
            Some(XValues::Time(v)) if v[i] == NULL_TIME => String::from("NULL"),
            Some(XValues::Time(v)) => crate::scale::format_timestamp(v[i]),
            Some(XValues::Num(v)) => crate::scale::format_value(v[i], 12),
            Some(XValues::Cat(v)) => self.x_labels.labels[v[i] as usize].clone(),
            None => String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{infer_roles, ColumnType};

    fn info(name: &str, code: TypeCode, param: u32) -> ColumnInfo {
        ColumnInfo { name: name.into(), ty: ColumnType { code, param } }
    }
    fn raw<'a>(index: usize, code: TypeCode, param: u32, rows: usize, data: &'a [u8]) -> RawColumn<'a> {
        RawColumn { index, code, param, rows, data, validity: None, bit_offset: 0, offsets: &[], dict: None }
    }
    fn bytes_i64(v: &[i64]) -> Vec<u8> {
        v.iter().flat_map(|x| x.to_le_bytes()).collect()
    }
    fn bytes_f64(v: &[f64]) -> Vec<u8> {
        v.iter().flat_map(|x| x.to_le_bytes()).collect()
    }
    fn bytes_i32(v: &[i32]) -> Vec<u8> {
        v.iter().flat_map(|x| x.to_le_bytes()).collect()
    }

    #[test]
    fn timestamps_units_and_nulls() {
        let ms = bytes_i64(&[1_700_000_000_123, 0]);
        let mut col = raw(0, TypeCode::Timestamp, 1, 2, &ms);
        let bits = [0b01u8];
        col.validity = Some((&bits, 0));
        let mut out = Vec::new();
        col.read_times(&mut out);
        assert_eq!(out, [1_700_000_000_123_000, NULL_TIME]);
        let ns = bytes_i64(&[1_999]);
        let mut out = Vec::new();
        raw(0, TypeCode::Timestamp, 3, 1, &ns).read_times(&mut out);
        assert_eq!(out, [1]);
        let days = bytes_i32(&[1]);
        let mut out = Vec::new();
        raw(0, TypeCode::Date32, 0, 1, &days).read_times(&mut out);
        assert_eq!(out, [86_400_000_000]);
    }

    #[test]
    fn numbers_keep_nulls_as_nan_with_bit_offset() {
        let data = bytes_f64(&[1.0, 2.0, 3.0]);
        let mut col = raw(0, TypeCode::F64, 0, 3, &data);
        // Rows start at bit 3 of the bitmap: bits 3,4,5 = 1,0,1.
        let bits = [0b0010_1000u8];
        col.validity = Some((&bits, 3));
        let mut out = Vec::new();
        col.read_numbers(&mut out);
        assert_eq!(out[0], 1.0);
        assert!(out[1].is_nan());
        assert_eq!(out[2], 3.0);
    }

    #[test]
    fn decimals_and_ints() {
        let dec: Vec<u8> = [12345i128, -5].iter().flat_map(|v| v.to_le_bytes()).collect();
        let mut out = Vec::new();
        raw(0, TypeCode::Decimal, 2 | 128 << 16, 2, &dec).read_numbers(&mut out);
        assert_eq!(out, [123.45, -0.05]);
        let mut out = Vec::new();
        raw(0, TypeCode::U16, 0, 2, &[1, 0, 255, 255]).read_numbers(&mut out);
        assert_eq!(out, [1.0, 65535.0]);
    }

    #[test]
    fn utf8_and_dictionary_intern_in_first_seen_order() {
        let mut interner = Interner::default();
        let mut map = Vec::new();
        // Offsets absolute into a larger buffer starting at 10.
        let offsets = bytes_i32(&[10, 11, 12, 13]);
        let mut col = raw(0, TypeCode::Utf8, 0, 3, b"bab");
        col.offsets = &offsets;
        let mut out = Vec::new();
        col.read_ids(&mut interner, &mut map, &mut out);
        assert_eq!(out, [0, 1, 0]);
        assert_eq!(interner.labels, ["b", "a"]);

        let dict_offsets = bytes_i32(&[0, 1, 2]);
        let mut col = raw(1, TypeCode::Dict, TypeCode::I32 as u32, 3, &[]);
        let idx = bytes_i32(&[1, 0, 1]);
        col.data = &idx;
        col.dict = Some((&dict_offsets, b"ac"));
        let mut out = Vec::new();
        col.read_ids(&mut interner, &mut map, &mut out);
        assert_eq!(out, [2, 1, 2]);
        // Unchanged dictionary on the next batch reuses the map.
        col.dict = None;
        let idx2 = bytes_i32(&[0]);
        col.data = &idx2;
        col.rows = 1;
        let mut out = Vec::new();
        col.read_ids(&mut interner, &mut map, &mut out);
        assert_eq!(out, [1]);
    }

    #[test]
    fn store_appends_role_columns() {
        let columns = vec![info("ts", TypeCode::Timestamp, 2), info("vessel", TypeCode::Utf8, 0), info("v", TypeCode::F64, 0)];
        let roles = infer_roles(&columns);
        let mut store = Store::new(columns, roles);
        let ts = bytes_i64(&[0, 1_000_000]);
        let v = bytes_f64(&[1.5, 2.5]);
        let offsets = bytes_i32(&[0, 1, 2]);
        let mut s = raw(1, TypeCode::Utf8, 0, 2, b"ab");
        s.offsets = &offsets;
        store.append(2, &[raw(0, TypeCode::Timestamp, 2, 2, &ts), s, raw(2, TypeCode::F64, 0, 2, &v)]);
        assert_eq!(store.rows, 2);
        assert_eq!(store.value.as_deref(), Some(&[1.5, 2.5][..]));
        assert_eq!(store.series.as_deref(), Some(&[0u32, 1][..]));
        assert_eq!(store.x_label(1), "1970-01-01 00:00:01");
    }
}
