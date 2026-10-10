//! tb-render: the Rust/Wasm renderer core of time-blast.
//!
//! The core owns everything except the GPU calls themselves: column roles and view choice,
//! canonical columns, scales/domains and ticks, geometry, uniforms, binding and fencing,
//! frame scheduling decisions and the command stream. A hand-written JS shim
//! (`src/engine/render/`) replays the command stream on WebGPU, or WebGL2 as a fallback.
//! See `docs/batch-1/render.md`.

pub mod axes;
pub mod bench;
pub mod ffi;
pub mod gpu;
pub mod renderer;
pub mod scale;
pub mod schema;
pub mod store;
pub mod view;
