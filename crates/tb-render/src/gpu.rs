//! The command stream the JS shim replays, GPU buffer bookkeeping, uniforms and the pass
//! recorder that view families draw with.
//!
//! The stream is a flat list of u32 words in Wasm linear memory. The shim (WebGPU or WebGL2)
//! walks it once per frame. Buffer writes point straight into Wasm memory, so the shim
//! uploads with `queue.writeBuffer` / `bufferSubData` from a view of `memory.buffer` and no
//! intermediate JS copy.

/// Opcodes. Operand counts in brackets. Wire values; never renumber.
pub mod op {
    /// [slot] Following buffer ops and the next pass target this slot (WebGL2: its context).
    pub const CTX: u32 = 1;
    /// [id, bytes, kind] Create a buffer. kind: 1 vertex, 2 uniform.
    pub const BUF_CREATE: u32 = 2;
    /// [id] Destroy a buffer (the shim defers this until after submit).
    pub const BUF_DESTROY: u32 = 3;
    /// [id, dst_offset, src_ptr, len] Upload `len` bytes from Wasm memory.
    pub const BUF_WRITE: u32 = 4;
    /// [slot, uniform_buffer_id, r, g, b, a (f32 bits)] Begin a render pass that clears the slot.
    pub const PASS: u32 = 5;
    /// [pipeline]
    pub const PIPE: u32 = 6;
    /// [index, buffer_id, offset]
    pub const VB: u32 = 7;
    /// [offset] Dynamic offset into the pass's uniform buffer (256-byte aligned).
    pub const UNI: u32 = 8;
    /// [x, y, w, h] Device pixels, origin top-left.
    pub const SCISSOR: u32 = 9;
    /// [vertex_count, instance_count]
    pub const DRAW: u32 = 10;
    /// []
    pub const END: u32 = 11;

    pub fn operands(op: u32) -> usize {
        match op {
            CTX | BUF_DESTROY | PIPE | UNI => 1,
            BUF_CREATE | VB => 3,
            BUF_WRITE | SCISSOR => 4,
            PASS => 6,
            DRAW => 2,
            END => 0,
            _ => usize::MAX,
        }
    }
}

pub const KIND_VERTEX: u32 = 1;
pub const KIND_UNIFORM: u32 = 2;
/// Uniform block stride: WebGPU's minUniformBufferOffsetAlignment and WebGL2's typical
/// UNIFORM_BUFFER_OFFSET_ALIGNMENT are both ≤ 256.
pub const UNIFORM_STRIDE: usize = 256;

/// Allocator of buffer ids plus the stream that out-of-pass buffer ops go to.
pub struct Gpu<'a> {
    pub words: &'a mut Vec<u32>,
    pub next_id: &'a mut u32,
}

impl<'a> Gpu<'a> {
    pub fn alloc_id(&mut self) -> u32 {
        *self.next_id += 1;
        *self.next_id
    }
}

/// A growable GPU buffer mirroring bytes that live in Wasm memory. Appends upload only the
/// new tail; growth reallocates with doubling and uploads everything once.
#[derive(Default, Debug)]
pub struct GpuVec {
    pub id: u32,
    pub capacity: u32,
    pub uploaded: u32,
}

impl GpuVec {
    /// Make the GPU copy equal `bytes`. `rewrite` forces a full upload (data changed in place).
    pub fn sync(&mut self, gpu: &mut Gpu, bytes: &[u8], kind: u32, rewrite: bool) {
        let len = bytes.len() as u32;
        debug_assert!(len % 4 == 0);
        if len == 0 {
            self.uploaded = 0;
            return;
        }
        if len > self.capacity {
            if self.id != 0 {
                gpu.words.extend_from_slice(&[op::BUF_DESTROY, self.id]);
            }
            let capacity = len.next_power_of_two().max(4096);
            self.id = gpu.alloc_id();
            self.capacity = capacity;
            gpu.words.extend_from_slice(&[op::BUF_CREATE, self.id, capacity, kind]);
            self.uploaded = 0;
        }
        let from = if rewrite || len < self.uploaded { 0 } else { self.uploaded };
        if len > from {
            let src = bytes[from as usize..].as_ptr() as usize as u32;
            gpu.words.extend_from_slice(&[op::BUF_WRITE, self.id, from, src, len - from]);
        }
        self.uploaded = len;
    }

    pub fn release(&mut self, gpu: &mut Gpu) {
        if self.id != 0 {
            gpu.words.extend_from_slice(&[op::BUF_DESTROY, self.id]);
        }
        *self = GpuVec::default();
    }
}

/// View a slice of plain floats/words as bytes for upload.
pub fn as_bytes<T: Copy>(v: &[T]) -> &[u8] {
    // SAFETY: T is plain old data (f32/u32 arrays) without padding; the byte view has the
    // same lifetime and covers exactly the slice's memory.
    unsafe { core::slice::from_raw_parts(v.as_ptr() as *const u8, core::mem::size_of_val(v)) }
}

/// The one uniform layout shared by all built-in shaders (std140-compatible: vec4s only).
/// Families may reinterpret `a`/`b` per pipeline.
#[derive(Clone, Copy, Default, Debug, PartialEq)]
#[repr(C)]
pub struct Uniform {
    /// Data-space window: x0, x1, y0, y1 (in the family's relative units).
    pub domain: [f32; 4],
    /// Plot rectangle in device pixels: left, top, width, height.
    pub plot: [f32; 4],
    /// Canvas width, height in device pixels; device pixel ratio; spare.
    pub canvas: [f32; 4],
    /// Premultiplied RGBA.
    pub color: [f32; 4],
    pub a: [f32; 4],
    pub b: [f32; 4],
}

/// Records one slot's render pass: draws plus their uniform blocks, eliding redundant
/// pipeline/vertex-buffer/uniform rebinds so the shim makes as few GPU calls as possible.
#[derive(Default)]
pub struct PassRecorder {
    pub words: Vec<u32>,
    pub uniforms: Vec<u8>,
    pipe: Option<u32>,
    vbs: [Option<(u32, u32)>; 4],
    uni: Option<u32>,
    last_uniform: Option<Uniform>,
    pub draws: u32,
}

impl PassRecorder {
    pub fn reset(&mut self) {
        self.words.clear();
        self.uniforms.clear();
        self.pipe = None;
        self.vbs = [None; 4];
        self.uni = None;
        self.last_uniform = None;
        self.draws = 0;
    }
    /// Append a uniform block (deduplicated against the previous one) and bind it.
    pub fn uniform(&mut self, u: &Uniform) {
        if self.last_uniform.as_ref() == Some(u) {
            return;
        }
        let offset = self.uniforms.len() as u32;
        self.uniforms.extend_from_slice(as_bytes(core::slice::from_ref(u)));
        self.uniforms.resize(offset as usize + UNIFORM_STRIDE, 0);
        self.last_uniform = Some(*u);
        self.words.extend_from_slice(&[op::UNI, offset]);
        self.uni = Some(offset);
    }
    pub fn pipeline(&mut self, p: u32) {
        if self.pipe != Some(p) {
            self.pipe = Some(p);
            self.vbs = [None; 4];
            self.words.extend_from_slice(&[op::PIPE, p]);
        }
    }
    pub fn vertex_buffer(&mut self, index: u32, id: u32, offset: u32) {
        if self.vbs[index as usize] != Some((id, offset)) {
            self.vbs[index as usize] = Some((id, offset));
            self.words.extend_from_slice(&[op::VB, index, id, offset]);
        }
    }
    pub fn scissor(&mut self, x: u32, y: u32, w: u32, h: u32) {
        self.words.extend_from_slice(&[op::SCISSOR, x, y, w, h]);
    }
    pub fn draw(&mut self, vertices: u32, instances: u32) {
        if instances > 0 && vertices > 0 {
            self.words.extend_from_slice(&[op::DRAW, vertices, instances]);
            self.draws += 1;
        }
    }
}

// ───────────────────────── pipelines ─────────────────────────

#[derive(Clone, Copy, Debug)]
pub enum Format {
    Float32,
    Float32x2,
    Float32x4,
    Unorm8x4,
}
impl Format {
    pub fn name(self) -> &'static str {
        match self {
            Format::Float32 => "float32",
            Format::Float32x2 => "float32x2",
            Format::Float32x4 => "float32x4",
            Format::Unorm8x4 => "unorm8x4",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Attr {
    pub location: u32,
    pub format: Format,
    pub offset: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct BufferLayout {
    pub stride: u32,
    pub instance: bool,
    pub attrs: &'static [Attr],
}

/// A pipeline as data: the shim builds the WebGPU pipeline (from `wgsl`) or the WebGL2
/// program (from `vert`/`frag`) generically. All pipelines share one bind group layout:
/// binding 0 = the `Uniform` block with a dynamic offset. Blending is premultiplied alpha.
#[derive(Debug)]
pub struct PipelineDesc {
    pub name: &'static str,
    pub wgsl: &'static str,
    pub vert: &'static str,
    pub frag: &'static str,
    /// true: triangle-strip, false: triangle-list.
    pub strip: bool,
    pub buffers: &'static [BufferLayout],
}

/// Pipelines in shim order, looked up by name once when a family is created.
pub struct PipelineTable {
    pub list: Vec<&'static PipelineDesc>,
}

impl PipelineTable {
    pub fn index(&self, name: &str) -> u32 {
        self.list.iter().position(|p| p.name == name).unwrap_or_else(|| panic!("pipeline {name}")) as u32
    }

    /// JSON description for the shim (cold path, once at startup).
    pub fn to_json(&self) -> String {
        let mut s = String::from("[");
        for (i, p) in self.list.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&format!(
                "{{\"name\":{},\"strip\":{},\"wgsl\":{},\"vert\":{},\"frag\":{},\"buffers\":[",
                json_str(p.name),
                p.strip,
                json_str(&format!("{}{}", WGSL_PRELUDE, p.wgsl)),
                json_str(&format!("{}{}", GLSL_VERT_PRELUDE, p.vert)),
                json_str(&format!("{}{}", GLSL_FRAG_PRELUDE, p.frag))
            ));
            for (j, b) in p.buffers.iter().enumerate() {
                if j > 0 {
                    s.push(',');
                }
                s.push_str(&format!("{{\"stride\":{},\"instance\":{},\"attrs\":[", b.stride, b.instance));
                for (k, a) in b.attrs.iter().enumerate() {
                    if k > 0 {
                        s.push(',');
                    }
                    s.push_str(&format!("{{\"location\":{},\"format\":\"{}\",\"offset\":{}}}", a.location, a.format.name(), a.offset));
                }
                s.push_str("]}");
            }
            s.push_str("]}");
        }
        s.push(']');
        s
    }
}

pub fn json_str(v: &str) -> String {
    let mut s = String::with_capacity(v.len() + 2);
    s.push('"');
    for c in v.chars() {
        match c {
            '"' => s.push_str("\\\""),
            '\\' => s.push_str("\\\\"),
            '\n' => s.push_str("\\n"),
            '\r' => s.push_str("\\r"),
            '\t' => s.push_str("\\t"),
            c if (c as u32) < 0x20 => s.push_str(&format!("\\u{:04x}", c as u32)),
            c => s.push(c),
        }
    }
    s.push('"');
    s
}

/// Prepended to every WGSL module.
pub const WGSL_PRELUDE: &str = r#"
struct U { domain: vec4f, plot: vec4f, canvas: vec4f, color: vec4f, a: vec4f, b: vec4f };
@group(0) @binding(0) var<uniform> u: U;
const MISSING: f32 = 1e37;
const CORNERS = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
fn missing(d: vec2f) -> bool { return abs(d.x) >= MISSING || abs(d.y) >= MISSING; }
// Data (relative units) → device pixels, y down.
fn to_px(d: vec2f) -> vec2f {
  let t = (d - vec2f(u.domain.x, u.domain.z)) / vec2f(u.domain.y - u.domain.x, u.domain.w - u.domain.z);
  return vec2f(u.plot.x + t.x * u.plot.z, u.plot.y + (1.0 - t.y) * u.plot.w);
}
fn to_clip(p: vec2f) -> vec4f { return vec4f(p.x / u.canvas.x * 2.0 - 1.0, 1.0 - p.y / u.canvas.y * 2.0, 0.0, 1.0); }
const OUTSIDE = vec4f(2.0, 2.0, 2.0, 1.0);
"#;

/// Prepended to every GLSL ES 3.00 vertex shader.
pub const GLSL_VERT_PRELUDE: &str = r#"#version 300 es
precision highp float;
layout(std140) uniform U { vec4 domain; vec4 plot; vec4 canvas; vec4 color; vec4 a; vec4 b; } u;
const float MISSING = 1e37;
const vec2 CORNERS[4] = vec2[4](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0), vec2(1.0, 1.0));
bool missing(vec2 d) { return abs(d.x) >= MISSING || abs(d.y) >= MISSING; }
vec2 to_px(vec2 d) {
  vec2 t = (d - vec2(u.domain.x, u.domain.z)) / vec2(u.domain.y - u.domain.x, u.domain.w - u.domain.z);
  return vec2(u.plot.x + t.x * u.plot.z, u.plot.y + (1.0 - t.y) * u.plot.w);
}
vec4 to_clip(vec2 p) { return vec4(p.x / u.canvas.x * 2.0 - 1.0, 1.0 - p.y / u.canvas.y * 2.0, 0.0, 1.0); }
const vec4 OUTSIDE = vec4(2.0, 2.0, 2.0, 1.0);
"#;

/// Prepended to every GLSL ES 3.00 fragment shader.
pub const GLSL_FRAG_PRELUDE: &str = r#"#version 300 es
precision highp float;
layout(std140) uniform U { vec4 domain; vec4 plot; vec4 canvas; vec4 color; vec4 a; vec4 b; } u;
out vec4 frag;
"#;

/// Pixel-space rectangles with per-instance colour: grid lines, axes, overlays.
/// Instance: [x0, y0, x1, y1] f32 device px + rgba8 colour (straight alpha).
pub static RULE: PipelineDesc = PipelineDesc {
    name: "rule",
    strip: true,
    buffers: &[BufferLayout {
        stride: 20,
        instance: true,
        attrs: &[Attr { location: 0, format: Format::Float32x4, offset: 0 }, Attr { location: 1, format: Format::Unorm8x4, offset: 16 }],
    }],
    wgsl: r#"
struct RuleOut { @builtin(position) pos: vec4f, @location(0) color: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) r: vec4f, @location(1) c: vec4f) -> RuleOut {
  var corners = CORNERS;
  let k = corners[vi];
  var o: RuleOut;
  o.pos = to_clip(vec2f(select(r.x, r.z, k.x > 0.0), select(r.y, r.w, k.y > 0.0)));
  o.color = vec4f(c.rgb * c.a, c.a);
  return o;
}
@fragment fn fs(i: RuleOut) -> @location(0) vec4f { return i.color; }
"#,
    vert: r#"
layout(location = 0) in vec4 r;
layout(location = 1) in vec4 c;
out vec4 color;
void main() {
  vec2 k = CORNERS[gl_VertexID];
  gl_Position = to_clip(vec2(k.x > 0.0 ? r.z : r.x, k.y > 0.0 ? r.w : r.y));
  color = vec4(c.rgb * c.a, c.a);
}
"#,
    frag: r#"
in vec4 color;
void main() { frag = color; }
"#,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpuvec_appends_tail_and_grows() {
        let mut words = Vec::new();
        let mut next = 0;
        let mut v = GpuVec::default();
        let data = vec![0u8; 100];
        let mut gpu = Gpu { words: &mut words, next_id: &mut next };
        v.sync(&mut gpu, &data[..40], KIND_VERTEX, false);
        assert_eq!(&gpu.words[..4], &[op::BUF_CREATE, 1, 4096, KIND_VERTEX]);
        assert_eq!(gpu.words[4], op::BUF_WRITE);
        assert_eq!(gpu.words[6], 0); // dst offset
        assert_eq!(gpu.words[8], 40); // len
        gpu.words.clear();
        v.sync(&mut gpu, &data[..100], KIND_VERTEX, false);
        assert_eq!(gpu.words[0], op::BUF_WRITE);
        assert_eq!((gpu.words[2], gpu.words[4]), (40, 60));
        gpu.words.clear();
        v.sync(&mut gpu, &data[..100], KIND_VERTEX, false);
        assert!(gpu.words.is_empty(), "nothing new to upload");
        let big = vec![0u8; 5000];
        v.sync(&mut gpu, &big, KIND_VERTEX, false);
        assert_eq!(&gpu.words[..2], &[op::BUF_DESTROY, 1]);
        assert_eq!(&gpu.words[2..6], &[op::BUF_CREATE, 2, 8192, KIND_VERTEX]);
        assert_eq!(gpu.words[10], 5000);
    }

    #[test]
    fn recorder_elides_redundant_binds() {
        let mut r = PassRecorder::default();
        let u = Uniform::default();
        r.uniform(&u);
        r.uniform(&u);
        r.pipeline(1);
        r.pipeline(1);
        r.vertex_buffer(0, 5, 0);
        r.vertex_buffer(0, 5, 0);
        r.draw(4, 10);
        r.draw(4, 0);
        assert_eq!(r.words, [op::UNI, 0, op::PIPE, 1, op::VB, 0, 5, 0, op::DRAW, 4, 10]);
        assert_eq!(r.uniforms.len(), UNIFORM_STRIDE);
        let mut u2 = u;
        u2.color = [1.0; 4];
        r.uniform(&u2);
        assert_eq!(&r.words[r.words.len() - 2..], &[op::UNI, 256]);
    }

    #[test]
    fn uniform_is_six_vec4s() {
        assert_eq!(core::mem::size_of::<Uniform>(), 96);
    }

    #[test]
    fn pipeline_json_is_escaped() {
        let t = PipelineTable { list: vec![&RULE] };
        let j = t.to_json();
        assert!(j.starts_with("[{\"name\":\"rule\""));
        assert!(j.contains("\\n"));
        assert!(j.contains("\"format\":\"unorm8x4\""));
    }
}
