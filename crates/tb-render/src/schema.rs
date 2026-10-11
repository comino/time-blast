//! Column types, role inference (protocol-v1 "Result shape convention") and view names.

/// Physical column type as described by the JS shim from the Arrow schema.
/// Wire values: the shim writes these codes; never renumber.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum TypeCode {
    Unsupported = 0,
    Bool = 1,
    I8 = 2,
    I16 = 3,
    I32 = 4,
    I64 = 5,
    U8 = 6,
    U16 = 7,
    U32 = 8,
    U64 = 9,
    F32 = 11,
    F64 = 12,
    /// param = scale (i32 as u32) | bit width << 16 (64 or 128).
    Decimal = 13,
    /// Days since epoch, i32.
    Date32 = 15,
    /// Milliseconds since epoch, i64.
    Date64 = 16,
    /// i64; param = unit (0 s, 1 ms, 2 µs, 3 ns).
    Timestamp = 17,
    /// i32 offsets + bytes.
    Utf8 = 18,
    /// i64 offsets + bytes.
    LargeUtf8 = 19,
    /// Dictionary of utf8; param = index type code (I8..U64).
    Dict = 20,
    /// Time of day; param = unit | bit width << 8. Numeric (ms since midnight).
    TimeOfDay = 21,
    /// Duration; param = unit. Numeric (ms).
    Duration = 22,
}

impl TypeCode {
    pub fn from_u32(v: u32) -> TypeCode {
        use TypeCode::*;
        match v {
            1 => Bool,
            2 => I8,
            3 => I16,
            4 => I32,
            5 => I64,
            6 => U8,
            7 => U16,
            8 => U32,
            9 => U64,
            11 => F32,
            12 => F64,
            13 => Decimal,
            15 => Date32,
            16 => Date64,
            17 => Timestamp,
            18 => Utf8,
            19 => LargeUtf8,
            20 => Dict,
            21 => TimeOfDay,
            22 => Duration,
            _ => Unsupported,
        }
    }
    pub fn is_temporal(self) -> bool {
        matches!(self, TypeCode::Date32 | TypeCode::Date64 | TypeCode::Timestamp)
    }
    pub fn is_integer(self) -> bool {
        use TypeCode::*;
        matches!(self, I8 | I16 | I32 | I64 | U8 | U16 | U32 | U64)
    }
    pub fn is_numeric(self) -> bool {
        use TypeCode::*;
        self.is_integer() || matches!(self, F32 | F64 | Decimal | TimeOfDay | Duration)
    }
    pub fn is_text(self) -> bool {
        matches!(self, TypeCode::Utf8 | TypeCode::LargeUtf8 | TypeCode::Dict | TypeCode::Bool)
    }
    /// Bytes per value for fixed-width integer/float codes.
    pub fn width(self) -> usize {
        use TypeCode::*;
        match self {
            I8 | U8 => 1,
            I16 | U16 => 2,
            I32 | U32 | F32 | Date32 => 4,
            I64 | U64 | F64 | Date64 | Timestamp => 8,
            _ => 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ColumnType {
    pub code: TypeCode,
    pub param: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ColumnInfo {
    pub name: String,
    pub ty: ColumnType,
}

/// Column roles of protocol-v1. `None` = not used by any chart view.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Time,
    Category,
    Series,
    Value,
    Measure,
    Lat,
    Lon,
    None,
}

impl Role {
    pub fn name(self) -> &'static str {
        match self {
            Role::Time => "time",
            Role::Category => "category",
            Role::Series => "series",
            Role::Value => "value",
            Role::Measure => "measure",
            Role::Lat => "lat",
            Role::Lon => "lon",
            Role::None => "",
        }
    }
}

/// How the x column is positioned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum XKind {
    /// Temporal: exact i64 µs, drawn relative to an origin.
    Time,
    /// Text: interned in first-seen order, drawn at integer positions.
    Category,
    /// Numeric: drawn at its value. `integer` decides category vs measure labelling.
    Numeric { integer: bool },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Roles {
    pub per_column: Vec<Role>,
    pub x: Option<(usize, XKind)>,
    pub series: Option<usize>,
    pub value: Option<usize>,
    /// Extra numeric columns between x and value, in column order.
    pub measures: Vec<usize>,
    pub lat: Option<usize>,
    pub lon: Option<usize>,
}

impl Roles {
    /// Columns the renderer needs from every batch, ascending.
    pub fn needed(&self) -> Vec<usize> {
        let mut out: Vec<usize> = self.x.map(|x| x.0).into_iter().collect();
        out.extend(self.series);
        out.extend(self.value);
        out.extend(self.measures.iter().copied());
        out.extend(self.lat);
        out.extend(self.lon);
        out.sort_unstable();
        out.dedup();
        out
    }
}

/// `lat`/`latitude`, or a `*_lat`/`*_latitude` suffix (`start_lat`).
fn is_lat(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(n.as_str(), "lat" | "latitude") || n.ends_with("_lat") || n.ends_with("_latitude")
}
/// `lon`/`lng`/`long`/`longitude`, or the same as a `*_lon`-style suffix.
fn is_lon(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(n.as_str(), "lon" | "lng" | "long" | "longitude") || ["_lon", "_lng", "_long", "_longitude"].iter().any(|s| n.ends_with(s))
}
/// Integer middle columns are series only when they look like identifiers; counts and sums
/// are integers too and must stay measures.
fn is_id_like(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "id" || n.ends_with("_id") || name.ends_with("Id") || n == "series" || n == "group" || n == "key" || n.ends_with("_key")
}

/// Infer roles from column order and type (protocol-v1 "Result shape convention").
pub fn infer_roles(columns: &[ColumnInfo]) -> Roles {
    let mut roles = Roles {
        per_column: vec![Role::None; columns.len()],
        x: None,
        series: None,
        value: None,
        measures: Vec::new(),
        lat: None,
        lon: None,
    };
    // 4. Geographic position by name.
    for (i, c) in columns.iter().enumerate() {
        if !c.ty.code.is_numeric() {
            continue;
        }
        if roles.lat.is_none() && is_lat(&c.name) {
            roles.lat = Some(i);
            roles.per_column[i] = Role::Lat;
        } else if roles.lon.is_none() && is_lon(&c.name) {
            roles.lon = Some(i);
            roles.per_column[i] = Role::Lon;
        }
    }
    let rest: Vec<usize> = (0..columns.len())
        .filter(|&i| roles.per_column[i] == Role::None && columns[i].ty.code != TypeCode::Unsupported)
        .collect();
    if rest.is_empty() {
        return roles;
    }
    let numeric: Vec<usize> = rest.iter().copied().filter(|&i| columns[i].ty.code.is_numeric()).collect();
    // 1. First column: x (time or category). A lone numeric column is a value, not an x.
    let first = rest[0];
    let code = columns[first].ty.code;
    let x_kind = if code.is_temporal() {
        Some(XKind::Time)
    } else if code.is_text() {
        Some(XKind::Category)
    } else if code.is_numeric() && numeric.len() >= 2 {
        Some(XKind::Numeric { integer: code.is_integer() })
    } else {
        None
    };
    if let Some(kind) = x_kind {
        roles.x = Some((first, kind));
        roles.per_column[first] = match kind {
            XKind::Time => Role::Time,
            XKind::Category | XKind::Numeric { integer: true } => Role::Category,
            XKind::Numeric { integer: false } => Role::Measure,
        };
    }
    // 3. Last numeric column (after x): value.
    let after_x: Vec<usize> = rest.iter().copied().filter(|&i| Some(i) != roles.x.map(|x| x.0)).collect();
    roles.value = after_x.iter().rev().copied().find(|&i| columns[i].ty.code.is_numeric());
    if let Some(v) = roles.value {
        roles.per_column[v] = Role::Value;
    }
    // 2. Middle text (or id-like integer) column: series.
    let middle: Vec<usize> = after_x.iter().copied().filter(|&i| Some(i) != roles.value).collect();
    roles.series = middle
        .iter()
        .copied()
        .find(|&i| columns[i].ty.code.is_text())
        .or_else(|| middle.iter().copied().find(|&i| columns[i].ty.code.is_integer() && is_id_like(&columns[i].name)));
    if let Some(s) = roles.series {
        roles.per_column[s] = Role::Series;
    }
    // Remaining numeric middle columns are extra measures.
    for &i in &middle {
        if Some(i) != roles.series && columns[i].ty.code.is_numeric() && roles.value.map_or(false, |v| i < v) {
            roles.measures.push(i);
            roles.per_column[i] = Role::Measure;
        }
    }
    roles
}

/// View names of protocol-v1. Wire values (u8) are used across the FFI; never renumber.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum View {
    Line = 0,
    Bar = 1,
    Scatter = 2,
    Table = 3,
    Heatmap = 4,
    Surface = 5,
    Map = 6,
    Density = 7,
    Tracks = 8,
    Seasons = 9,
}

impl View {
    pub const ALL: [View; 10] = [
        View::Line,
        View::Bar,
        View::Scatter,
        View::Table,
        View::Heatmap,
        View::Surface,
        View::Map,
        View::Density,
        View::Tracks,
        View::Seasons,
    ];
    pub fn from_u32(v: u32) -> Option<View> {
        View::ALL.get(v as usize).copied()
    }
    pub fn name(self) -> &'static str {
        match self {
            View::Line => "line",
            View::Bar => "bar",
            View::Scatter => "scatter",
            View::Table => "table",
            View::Heatmap => "heatmap",
            View::Surface => "surface",
            View::Map => "map",
            View::Density => "density",
            View::Tracks => "tracks",
            View::Seasons => "seasons",
        }
    }
    pub fn bit(self) -> u32 {
        1 << self as u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, code: TypeCode) -> ColumnInfo {
        ColumnInfo { name: name.into(), ty: ColumnType { code, param: 2 } }
    }

    #[test]
    fn time_series_value() {
        let r = infer_roles(&[col("ts", TypeCode::Timestamp), col("vessel", TypeCode::Utf8), col("speed", TypeCode::F64)]);
        assert_eq!(r.x, Some((0, XKind::Time)));
        assert_eq!(r.series, Some(1));
        assert_eq!(r.value, Some(2));
        assert_eq!(r.per_column, [Role::Time, Role::Series, Role::Value]);
        assert_eq!(r.needed(), [0, 1, 2]);
    }

    #[test]
    fn integer_counts_are_measures_not_series() {
        let r = infer_roles(&[col("day", TypeCode::Date32), col("n", TypeCode::I64), col("avg_speed", TypeCode::F64)]);
        assert_eq!(r.series, None);
        assert_eq!(r.measures, [1]);
        assert_eq!(r.value, Some(2));
        let r = infer_roles(&[col("ts", TypeCode::Timestamp), col("vessel_id", TypeCode::I32), col("v", TypeCode::F64)]);
        assert_eq!(r.series, Some(1));
    }

    #[test]
    fn category_bars_and_numeric_x() {
        let r = infer_roles(&[col("vessel", TypeCode::Dict), col("max_speed", TypeCode::F64)]);
        assert_eq!(r.x, Some((0, XKind::Category)));
        assert_eq!(r.value, Some(1));
        let r = infer_roles(&[col("wind", TypeCode::F64), col("speed", TypeCode::F64)]);
        assert_eq!(r.x, Some((0, XKind::Numeric { integer: false })));
        assert_eq!(r.per_column[0], Role::Measure);
        let r = infer_roles(&[col("hour", TypeCode::I32), col("speed", TypeCode::F64)]);
        assert_eq!(r.per_column[0], Role::Category);
    }

    #[test]
    fn lone_number_is_value_only() {
        let r = infer_roles(&[col("count_star()", TypeCode::I64)]);
        assert_eq!(r.x, None);
        assert_eq!(r.value, Some(0));
    }

    #[test]
    fn lat_lon_by_name_anywhere() {
        let r = infer_roles(&[
            col("ts", TypeCode::Timestamp),
            col("vessel", TypeCode::Utf8),
            col("Latitude", TypeCode::F64),
            col("lng", TypeCode::F64),
            col("speed", TypeCode::F32),
        ]);
        assert_eq!((r.lat, r.lon), (Some(2), Some(3)));
        assert_eq!(r.value, Some(4));
        assert_eq!(r.series, Some(1));
    }

    #[test]
    fn lat_lon_by_suffix() {
        let r = infer_roles(&[col("start_lat", TypeCode::F64), col("START_LNG", TypeCode::F32), col("n", TypeCode::I64)]);
        assert_eq!((r.lat, r.lon, r.value), (Some(0), Some(1), Some(2)));
        // Text columns never take a position role, and `latency` is not a latitude.
        let r = infer_roles(&[col("latency", TypeCode::F64), col("home_lat", TypeCode::Utf8), col("x_lon", TypeCode::F64)]);
        assert_eq!((r.lat, r.lon), (None, Some(2)));
    }

    #[test]
    fn text_only_has_no_value() {
        let r = infer_roles(&[col("name", TypeCode::Utf8), col("kind", TypeCode::Utf8)]);
        assert_eq!(r.value, None);
        assert_eq!(r.x, Some((0, XKind::Category)));
    }

    #[test]
    fn view_codes_round_trip() {
        for v in View::ALL {
            assert_eq!(View::from_u32(v as u32), Some(v));
        }
        assert_eq!(View::from_u32(10), None);
    }
}
