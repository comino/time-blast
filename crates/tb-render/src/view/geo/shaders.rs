//! Geo pipelines (WGSL + GLSL ES 3.00). Every vertex shader projects lon/lat itself (Web
//! Mercator, see `proj.rs`); the CPU never touches per-point positions after ingest.
//!
//! Uniform use (shared `Uniform` block): `domain` = projected window, `b.w` = 1 when drawing in
//! 0..360 longitude (antimeridian-spanning data). Per pipeline:
//! - `geo.point`  instance `[lon, lat, t, v]`. `a` = (radius, max radius, mode, outline px);
//!   `b.xy` = value domain; `b.z` = playback cut (t). Modes: 0 uniform colour, 1 colour by v
//!   (ramp), 2 size by v, 3 palette colour with index v (track markers).
//! - `geo.line`   instances `[lon, lat, t, v]` i and i+1 (one buffer bound twice). `a.x` = width;
//!   `b.z` = cut: segments after the cut vanish, the crossing one is clipped at the cut.
//! - `geo.coast`  instances `[lon, lat]` i and i+1, hairline; NaN-like MISSING pairs separate
//!   polylines.
//! - `geo.cell`   instance `[col, row, count, 0]`; `a` = grid origin and cell size (projected);
//!   `b.x` = ln(1 + max count).
//! - `geo.grid`   no buffers: instance i < `b.x` is a meridian at `a.x + i·a.y`, the rest are
//!   parallels at `a.z + k·a.y` degrees latitude.
//!
//! Segments whose ends are more than 180° of longitude apart are dropped (polylines crossing
//! the drawing's longitude seam), never drawn across the whole map.

use crate::gpu::{Attr, BufferLayout, Format, PipelineDesc};

macro_rules! wgsl_geo {
    () => {
        r#"
const PI: f32 = 3.14159265;
fn lonw(x: f32) -> f32 { if (u.b.w > 0.5 && x < 0.0) { return x + 360.0; } return x; }
fn merc(lat: f32) -> f32 { let l = clamp(lat, -85.05113, 85.05113) * (PI / 180.0); return log(tan(PI * 0.25 + l * 0.5)) * (180.0 / PI); }
fn proj(p: vec2f) -> vec2f { return vec2f(lonw(p.x), merc(p.y)); }
fn ramp(t: f32) -> vec3f {
  let s = clamp(t, 0.0, 1.0) * 3.0;
  let c0 = vec3f(0.231, 0.322, 0.545); let c1 = vec3f(0.129, 0.569, 0.549);
  let c2 = vec3f(0.369, 0.788, 0.384); let c3 = vec3f(0.992, 0.906, 0.145);
  if (s < 1.0) { return mix(c0, c1, s); }
  if (s < 2.0) { return mix(c1, c2, s - 1.0); }
  return mix(c2, c3, s - 2.0);
}
fn palette(i: f32) -> vec3f {
  let k = u32(i) % 6u;
  var p = array<vec3f, 6>(vec3f(1.0, 0.565, 0.424), vec3f(0.455, 0.831, 0.765), vec3f(0.831, 0.757, 0.494),
    vec3f(0.514, 0.725, 0.890), vec3f(0.890, 0.620, 0.686), vec3f(0.690, 0.788, 0.522));
  return p[k];
}
"#
    };
}

macro_rules! glsl_geo {
    () => {
        r#"
const float PI = 3.14159265;
float lonw(float x) { return (u.b.w > 0.5 && x < 0.0) ? x + 360.0 : x; }
float merc(float lat) { float l = clamp(lat, -85.05113, 85.05113) * (PI / 180.0); return log(tan(PI * 0.25 + l * 0.5)) * (180.0 / PI); }
vec2 proj(vec2 p) { return vec2(lonw(p.x), merc(p.y)); }
vec3 ramp(float t) {
  float s = clamp(t, 0.0, 1.0) * 3.0;
  vec3 c0 = vec3(0.231, 0.322, 0.545); vec3 c1 = vec3(0.129, 0.569, 0.549);
  vec3 c2 = vec3(0.369, 0.788, 0.384); vec3 c3 = vec3(0.992, 0.906, 0.145);
  if (s < 1.0) return mix(c0, c1, s);
  if (s < 2.0) return mix(c1, c2, s - 1.0);
  return mix(c2, c3, s - 2.0);
}
vec3 palette(float i) {
  int k = int(i) % 6;
  if (k == 0) return vec3(1.0, 0.565, 0.424);
  if (k == 1) return vec3(0.455, 0.831, 0.765);
  if (k == 2) return vec3(0.831, 0.757, 0.494);
  if (k == 3) return vec3(0.514, 0.725, 0.890);
  if (k == 4) return vec3(0.890, 0.620, 0.686);
  return vec3(0.690, 0.788, 0.522);
}
"#
    };
}

const VEC4: Format = Format::Float32x4;

pub static POINT: PipelineDesc = PipelineDesc {
    name: "geo.point",
    strip: true,
    buffers: &[BufferLayout { stride: 16, instance: true, attrs: &[Attr { location: 0, format: VEC4, offset: 0 }] }],
    wgsl: concat!(
        wgsl_geo!(),
        r#"
struct PointOut { @builtin(position) pos: vec4f, @location(0) local: vec2f, @location(1) @interpolate(flat) style: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) p: vec4f) -> PointOut {
  var o: PointOut;
  o.local = vec2f(0.0); o.style = vec4f(0.0);
  if (missing(p.xy) || p.z > u.b.z) { o.pos = OUTSIDE; return o; }
  let has_v = abs(p.w) < MISSING;
  let t = select(0.0, clamp((p.w - u.b.x) / max(u.b.y - u.b.x, 1e-30), 0.0, 1.0), has_v);
  var r = u.a.x;
  var rgb = u.color.rgb / max(u.color.a, 1e-6);
  let mode = u.a.z;
  if (mode > 0.5 && mode < 1.5) { rgb = select(vec3f(0.55, 0.6, 0.63), ramp(t), has_v); }
  if (mode > 1.5 && mode < 2.5 && has_v) { r = mix(u.a.x, u.a.y, sqrt(t)); }
  if (mode > 2.5) { rgb = palette(p.w); }
  let R = r + u.a.w + 1.0;
  var corners = CORNERS;
  o.local = corners[vi] * R;
  o.style = vec4f(rgb, r);
  o.pos = to_clip(to_px(proj(p.xy)) + o.local);
  return o;
}
@fragment fn fs(i: PointOut) -> @location(0) vec4f {
  let d = length(i.local);
  let r = i.style.w;
  let fill = clamp(r - d + 0.5, 0.0, 1.0);
  let ring = clamp(r + u.a.w - d + 0.5, 0.0, 1.0);
  let a = u.color.a;
  // Fill in the point colour; an optional dark outline of `a.w` px around it.
  let c = vec4f(i.style.rgb * a, a) * fill + vec4f(0.03, 0.07, 0.1, 0.9) * (ring - fill);
  return c;
}
"#
    ),
    vert: concat!(
        glsl_geo!(),
        r#"
layout(location = 0) in vec4 p;
out vec2 local;
flat out vec4 style;
void main() {
  local = vec2(0.0); style = vec4(0.0);
  if (missing(p.xy) || p.z > u.b.z) { gl_Position = OUTSIDE; return; }
  bool has_v = abs(p.w) < MISSING;
  float t = has_v ? clamp((p.w - u.b.x) / max(u.b.y - u.b.x, 1e-30), 0.0, 1.0) : 0.0;
  float r = u.a.x;
  vec3 rgb = u.color.rgb / max(u.color.a, 1e-6);
  float mode = u.a.z;
  if (mode > 0.5 && mode < 1.5) rgb = has_v ? ramp(t) : vec3(0.55, 0.6, 0.63);
  if (mode > 1.5 && mode < 2.5 && has_v) r = mix(u.a.x, u.a.y, sqrt(t));
  if (mode > 2.5) rgb = palette(p.w);
  float R = r + u.a.w + 1.0;
  local = CORNERS[gl_VertexID] * R;
  style = vec4(rgb, r);
  gl_Position = to_clip(to_px(proj(p.xy)) + local);
}
"#
    ),
    frag: r#"
in vec2 local;
flat in vec4 style;
void main() {
  float d = length(local);
  float r = style.w;
  float fill = clamp(r - d + 0.5, 0.0, 1.0);
  float ring = clamp(r + u.a.w - d + 0.5, 0.0, 1.0);
  float a = u.color.a;
  frag = vec4(style.rgb * a, a) * fill + vec4(0.03, 0.07, 0.1, 0.9) * (ring - fill);
}
"#,
};

pub static LINE: PipelineDesc = PipelineDesc {
    name: "geo.line",
    strip: true,
    buffers: &[
        BufferLayout { stride: 16, instance: true, attrs: &[Attr { location: 0, format: VEC4, offset: 0 }] },
        BufferLayout { stride: 16, instance: true, attrs: &[Attr { location: 1, format: VEC4, offset: 0 }] },
    ],
    wgsl: concat!(
        wgsl_geo!(),
        r#"
struct LineOut { @builtin(position) pos: vec4f, @location(0) local: vec2f, @location(1) @interpolate(flat) len: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b0: vec4f) -> LineOut {
  var o: LineOut;
  o.local = vec2f(0.0); o.len = 0.0;
  var b = b0;
  let cut = u.b.z;
  if (missing(a.xy) || missing(b.xy) || a.z > cut) { o.pos = OUTSIDE; return o; }
  if (b.z > cut) { b = vec4f(mix(a.xy, b.xy, (cut - a.z) / max(b.z - a.z, 1e-30)), cut, b.w); }
  let qa = proj(a.xy);
  let qb = proj(b.xy);
  if (abs(qa.x - qb.x) > 180.0) { o.pos = OUTSIDE; return o; }
  let pa = to_px(qa);
  let pb = to_px(qb);
  let d = pb - pa;
  let len = length(d);
  var dir = vec2f(1.0, 0.0);
  if (len > 1e-4) { dir = d / len; }
  let nrm = vec2f(-dir.y, dir.x);
  let r = u.a.x * 0.5 + 1.0;
  var corners = CORNERS;
  let k = corners[vi];
  let along = select(-r, len + r, k.x > 0.0);
  let across = k.y * r;
  o.pos = to_clip(pa + dir * along + nrm * across);
  o.local = vec2f(along, across);
  o.len = len;
  return o;
}
@fragment fn fs(i: LineOut) -> @location(0) vec4f {
  let t = clamp(i.local.x, 0.0, i.len);
  let dist = length(vec2f(i.local.x - t, i.local.y));
  return u.color * clamp(u.a.x * 0.5 - dist + 0.5, 0.0, 1.0);
}
"#
    ),
    vert: concat!(
        glsl_geo!(),
        r#"
layout(location = 0) in vec4 a;
layout(location = 1) in vec4 b0;
out vec2 local;
flat out float len;
void main() {
  local = vec2(0.0); len = 0.0;
  vec4 b = b0;
  float cut = u.b.z;
  if (missing(a.xy) || missing(b.xy) || a.z > cut) { gl_Position = OUTSIDE; return; }
  if (b.z > cut) b = vec4(mix(a.xy, b.xy, (cut - a.z) / max(b.z - a.z, 1e-30)), cut, b.w);
  vec2 qa = proj(a.xy);
  vec2 qb = proj(b.xy);
  if (abs(qa.x - qb.x) > 180.0) { gl_Position = OUTSIDE; return; }
  vec2 pa = to_px(qa);
  vec2 pb = to_px(qb);
  vec2 d = pb - pa;
  len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = u.a.x * 0.5 + 1.0;
  vec2 k = CORNERS[gl_VertexID];
  float along = k.x > 0.0 ? len + r : -r;
  float across = k.y * r;
  gl_Position = to_clip(pa + dir * along + nrm * across);
  local = vec2(along, across);
}
"#
    ),
    frag: r#"
in vec2 local;
flat in float len;
void main() {
  float t = clamp(local.x, 0.0, len);
  float dist = length(vec2(local.x - t, local.y));
  frag = u.color * clamp(u.a.x * 0.5 - dist + 0.5, 0.0, 1.0);
}
"#,
};

pub static COAST: PipelineDesc = PipelineDesc {
    name: "geo.coast",
    strip: true,
    buffers: &[
        BufferLayout { stride: 8, instance: true, attrs: &[Attr { location: 0, format: Format::Float32x2, offset: 0 }] },
        BufferLayout { stride: 8, instance: true, attrs: &[Attr { location: 1, format: Format::Float32x2, offset: 0 }] },
    ],
    wgsl: concat!(
        wgsl_geo!(),
        r#"
struct CoastOut { @builtin(position) pos: vec4f, @location(0) across: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec2f, @location(1) b: vec2f) -> CoastOut {
  var o: CoastOut;
  o.across = 0.0;
  if (missing(a) || missing(b)) { o.pos = OUTSIDE; return o; }
  let qa = proj(a);
  let qb = proj(b);
  if (abs(qa.x - qb.x) > 180.0) { o.pos = OUTSIDE; return o; }
  let pa = to_px(qa);
  let pb = to_px(qb);
  let d = pb - pa;
  let len = length(d);
  var dir = vec2f(1.0, 0.0);
  if (len > 1e-4) { dir = d / len; }
  let nrm = vec2f(-dir.y, dir.x);
  let r = u.a.x * 0.5 + 1.0;
  var corners = CORNERS;
  let k = corners[vi];
  o.pos = to_clip(select(pa, pb, k.x > 0.0) + nrm * k.y * r);
  o.across = k.y * r;
  return o;
}
@fragment fn fs(i: CoastOut) -> @location(0) vec4f {
  return u.color * clamp(u.a.x * 0.5 - abs(i.across) + 0.5, 0.0, 1.0);
}
"#
    ),
    vert: concat!(
        glsl_geo!(),
        r#"
layout(location = 0) in vec2 a;
layout(location = 1) in vec2 b;
out float across;
void main() {
  across = 0.0;
  if (missing(a) || missing(b)) { gl_Position = OUTSIDE; return; }
  vec2 qa = proj(a);
  vec2 qb = proj(b);
  if (abs(qa.x - qb.x) > 180.0) { gl_Position = OUTSIDE; return; }
  vec2 pa = to_px(qa);
  vec2 pb = to_px(qb);
  vec2 d = pb - pa;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = u.a.x * 0.5 + 1.0;
  vec2 k = CORNERS[gl_VertexID];
  gl_Position = to_clip((k.x > 0.0 ? pb : pa) + nrm * k.y * r);
  across = k.y * r;
}
"#
    ),
    frag: r#"
in float across;
void main() { frag = u.color * clamp(u.a.x * 0.5 - abs(across) + 0.5, 0.0, 1.0); }
"#,
};

pub static CELL: PipelineDesc = PipelineDesc {
    name: "geo.cell",
    strip: true,
    buffers: &[BufferLayout { stride: 16, instance: true, attrs: &[Attr { location: 0, format: VEC4, offset: 0 }] }],
    wgsl: concat!(
        wgsl_geo!(),
        r#"
struct CellOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) color: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) c: vec4f) -> CellOut {
  var corners = CORNERS;
  let k = corners[vi] * 0.5 + 0.5;
  let d = vec2f(u.a.x + (c.x + k.x) * u.a.z, u.a.y + (c.y + k.y) * u.a.w);
  var o: CellOut;
  o.pos = to_clip(to_px(d));
  let t = log(1.0 + c.z) / max(u.b.x, 1e-6);
  let alpha = 0.55 + 0.45 * t;
  o.color = vec4f(ramp(t) * alpha, alpha);
  return o;
}
@fragment fn fs(i: CellOut) -> @location(0) vec4f { return i.color; }
"#
    ),
    vert: concat!(
        glsl_geo!(),
        r#"
layout(location = 0) in vec4 c;
flat out vec4 color;
void main() {
  vec2 k = CORNERS[gl_VertexID] * 0.5 + 0.5;
  vec2 d = vec2(u.a.x + (c.x + k.x) * u.a.z, u.a.y + (c.y + k.y) * u.a.w);
  gl_Position = to_clip(to_px(d));
  float t = log(1.0 + c.z) / max(u.b.x, 1e-6);
  float alpha = 0.55 + 0.45 * t;
  color = vec4(ramp(t) * alpha, alpha);
}
"#
    ),
    frag: r#"
flat in vec4 color;
void main() { frag = color; }
"#,
};

pub static GRID: PipelineDesc = PipelineDesc {
    name: "geo.grid",
    strip: true,
    buffers: &[],
    wgsl: concat!(
        wgsl_geo!(),
        r#"
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  var corners = CORNERS;
  let k = corners[vi];
  let hair = max(u.canvas.z, 1.0) * 0.5;
  let i = f32(ii);
  var p: vec2f;
  if (i < u.b.x) {
    let x = to_px(vec2f(u.a.x + i * u.a.y, u.domain.z)).x;
    p = vec2f(x + k.x * hair, select(u.plot.y, u.plot.y + u.plot.w, k.y > 0.0));
  } else {
    let y = to_px(vec2f(u.domain.x, merc(u.a.z + (i - u.b.x) * u.a.y))).y;
    p = vec2f(select(u.plot.x, u.plot.x + u.plot.z, k.x > 0.0), y + k.y * hair);
  }
  return to_clip(p);
}
@fragment fn fs() -> @location(0) vec4f { return u.color; }
"#
    ),
    vert: concat!(
        glsl_geo!(),
        r#"
void main() {
  vec2 k = CORNERS[gl_VertexID];
  float hair = max(u.canvas.z, 1.0) * 0.5;
  float i = float(gl_InstanceID);
  vec2 p;
  if (i < u.b.x) {
    float x = to_px(vec2(u.a.x + i * u.a.y, u.domain.z)).x;
    p = vec2(x + k.x * hair, k.y > 0.0 ? u.plot.y + u.plot.w : u.plot.y);
  } else {
    float y = to_px(vec2(u.domain.x, merc(u.a.z + (i - u.b.x) * u.a.y))).y;
    p = vec2(k.x > 0.0 ? u.plot.x + u.plot.z : u.plot.x, y + k.y * hair);
  }
  gl_Position = to_clip(p);
}
"#
    ),
    frag: r#"
void main() { frag = u.color; }
"#,
};
