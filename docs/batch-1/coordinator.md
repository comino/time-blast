# Batch 1: coordinator

Status: implemented and tested (wave 1). Spec: [protocol-v1.md](../protocol-v1.md).

| Piece | Path |
|---|---|
| Sans-IO state machine | `crates/tb-coordinator/src/lib.rs` |
| Config parser, RESULT writer (no deps, no `core::fmt`) | `crates/tb-coordinator/src/json.rs` |
| Raw C-ABI exports | `crates/tb-coordinator/src/abi.rs` |
| Native tests (63, plus one opt-in benchmark) | `crates/tb-coordinator/src/tests.rs` |
| JS loader (`createCoordinator`, `loadCoordinator`) | `src/engine/coordinator.ts` |
| Wasm tests (5) / opt-in benchmark | `tests/coordinator-core.test.ts`, `tests/coordinator-core.bench.test.ts` |
| Built module | `public/wasm/tb-coordinator.wasm` (59.4 KB, 22.7 KB gzip -9, no imports) |

## API

Rust: `Coordinator::new()`, `input(LinkId, FrameRef, now) -> Result<(), InputError>`, `tick(now)`,
`outbox()`/`drain()` of `(LinkId, Frame)`, `next_deadline() -> Option<f64>`, `stats()`.
`LinkId`: `Ui=0, Inference=1, Database=2, Renderer=3` (also the ABI link numbers).

Wasm: `tb_alloc(len)`, `tb_free(ptr, len)`, `tb_coord_new()`, `tb_coord_free(h)`,
`tb_coord_input(h, link, ptr, len, now) -> i32` (0 ok; 1 decode, 2 link, 3 UTF-8, 4 config,
5 payload, 6 handle; message via `tb_last_error_ptr/len`), `tb_coord_tick(h, now)`,
`tb_coord_next_deadline(h)` (NaN = none), `tb_coord_flush(h) -> count` which encodes the whole
outbox into one reused buffer, then `tb_coord_out_index(h)` (`count × [link, offset, len]` u32) and
`tb_coord_out_bytes(h)`. One `flush` replaces per-frame accessor calls.

JS: `loadCoordinator(source?)` accepts a `WebAssembly.Module`, bytes (Node tests) or a `Response`;
without a source it fetches `${BASE_URL}wasm/tb-coordinator.wasm` (compiled once per page).
`input(link, Frame)` encodes straight into Wasm memory; the extra `inputEncoded(link, bytes)` takes
frames that arrived encoded (MessagePort/WebSocket) and skips a decode + re-encode. `drain()` copies
each frame out into its own `ArrayBuffer` (transferable; the Wasm buffer is reused).

## Rules chosen where the spec left room

Each rule has a native test named after it.

- **Showing a stale-but-newest result.** A completed speculative translation is shown only if its
  revision is newer than what the live slot is bound to (or waiting to be). Under `latest` this
  means the older in-flight result is shown while you keep typing, and is replaced as soon as a
  newer one lands. A committed result is always shown. An older result never replaces a newer one
  (checked by a randomized invariant test over 16 000 steps).
- **Committed work wins.** `restart` never cancels a committed translation; newer drafts wait
  behind it. A `COMMIT` cancels conflicting speculative translation under either policy.
- **"Shows exactly this text"** means: the live slot is bound (drawn or not) to a usable request
  with the same context and byte-identical text. `KEEP` then goes out at once and the stream
  continues into the kept slot.
- **KEEP when bound.** A committed result sends `BIND`, `KEEP`, then `EXEC`; it does not wait for
  the first draw. The next pool slot becomes live immediately.
- **Text adoption** (beyond SQL dedup). If the newest draft's text equals the in-flight request's
  text, or the text the live slot shows (typed back after a detour), no new translation starts:
  that request serves the new revision and the UI gets `BIND` with the new revision. Under
  `restart` the detour's in-flight translation is cancelled; under `latest` it finishes (it warms
  the cache) but is never shown.
- **SQL dedup** sends `BIND` with the new revision to the **UI only**: the renderer stays bound to
  the original request, whose batches are what it draws. The deduped request gets its own `TIMING`
  ending at `SQL_RECEIVED` (its answer was already on screen). Dedup never applies to a failed
  bound request.
- **Supersede** a bound request by binding the new one (`BIND` replaces; no `UNBIND`), and
  `CANCEL` its database work if still running.
- **Frame order: INFER first, EXEC last.** When SQL lands and a newer draft is waiting, `INFER`
  for it goes out before `BIND`/`EXEC`, and `EXEC` is always last in its batch, because the
  in-process DuckDB call may block the worker.
- **RESULT** is sent once per bound request on the header-only `RESULT_SCHEMA` (the query
  produced a schema), with `columns: []`. `view` is read from a leading `-- view: <name>` SQL hint
  (known names only), else `null`. Column roles come from the renderer, not the coordinator.
- **TIMING** goes out after every `DRAWN` and after `DONE`, for requests bound to a slot (live or
  kept). The ledger keeps the first stamp per stage. `DRAWN` after `DONE` (e.g. a late
  `FIRST_PRESENTED`) still reaches the ledger. `SQL_FIRST_DELTA` is stamped by the coordinator on
  the first `SQL_DELTA` unless inference stamped it.
- **Errors.** A database error on the live slot's request rebinds the slot to the last request that
  drew there and reached `DONE` (the renderer still shows its image); if there is none, the slot is
  unbound. Errors for superseded/cancelled requests are dropped. A failed revision is not retried
  automatically; the next keystroke or Enter retries.
- **Epochs.** Only a UI `CANCEL` (request 0) bumps the epoch (`max(epoch+1, frame.epoch)`) and is
  propagated to inference and database. Targeted cancels (`restart`, supersede, short draft) carry
  the current epoch and a request id; bumping the epoch for them would fence results of other live
  requests. After a UI cancel the cancelled revision is not re-translated until a new DRAFT/COMMIT.
- **Context.** Drafts for a context the coordinator has not seen are stored, not dropped, and
  translated when that `CONTEXT` arrives (boot race). A context change cancels in-flight work and
  unbinds the live slot. Cache keys include the context.
- **Inference `READY`** re-sends the context and treats an in-flight translation as lost, so it is
  retried. `HELLO` on any link is answered with `READY`.
- **Latency dial.** A dial-delayed cache hit counts as the one in-flight translation (`latest`
  waits for it, `restart` drops it). `next_deadline` = hit time + dial; `SQL_RECEIVED` is stamped
  at the `tick` that releases it. Dial `null` or `0` releases at once.
- **`live: false`**: drafts are stored but only commits translate. **`speculate: false`**: drafts
  translate (warming the cache and the request) but nothing speculative executes; Enter on that
  text executes the already-translated SQL without another inference call.
- **Forwarding.** `INFER_STATS` is forwarded even for cancelled requests: it is the cost of
  speculation and must be reported. `STATUS` and request-0 `ERROR` are forwarded unchanged.
- **Bounds.** Translation cache: 256 entries, LRU. Requests tracked: at most 64; a request in a
  kept slot is kept until it has both drawn and finished. Ledger: 32 stamps.

## Measurements

Host: ARM64 VM (Neoverse-N1), 4 cores shared with four other agents building in parallel, so
tails are noisy. Node 23.11.1. Rust 1.98.1, release profile (`opt-level=3`, LTO, `panic=abort`).
Workload: one DRAFT per call with a 36-byte text and the UI's two stamps; context loaded, two slots.
200 000 timed iterations after 20 000 warm-up, timed per call. Timer overhead: `performance.now()`
≈ 0.16 µs per pair, `Instant::now()` ≈ 0.03 µs; both are included in the samples below.

| Path | Case | median | p99 | p99.9 |
|---|---|---:|---:|---:|
| native | `latest`, translation in flight (draft stored) — decode + input | 0.12 µs | 0.28 µs | 0.56 µs |
| native | same — drain + encode outputs (none) | 0.04 µs | 0.04 µs | 0.04 µs |
| native | `restart`: CANCEL + INFER — decode + input | 0.24 µs | 0.44 µs | 0.88 µs |
| native | same — drain + encode 2 frames | 0.08 µs | 0.12 µs | 0.12 µs |
| Wasm (Node) | `latest`, in flight — `input(Frame)` | 0.48 µs | 1.16 µs | 13.6 µs |
| Wasm (Node) | `latest`, in flight — `inputEncoded(bytes)` | 0.36 µs | 0.92 µs | 11.5 µs |
| Wasm (Node) | `restart`: CANCEL + INFER — `input(Frame)` | 1.48 µs | 3.68 µs | 36.3 µs |
| Wasm (Node) | `restart` — `inputEncoded(bytes)` | 1.04 µs | 2.44 µs | 21.4 µs |
| Wasm (Node) | `restart` — `drain()` of 2 frames (copy out + JS decode) | 2.76 µs | 14.3 µs | 1042 µs |

Reproduce: `cargo test -p tb-coordinator --release -- --ignored --nocapture bench_` and
`TB_BENCH=1 pnpm vitest run tests/coordinator-core.bench.test.ts --silent=false`.

Reading: the coordinator's own decision cost is well under a microsecond natively and about a
microsecond in Wasm. The largest JS-side cost is `drain()`: decoding each output into a JS `Frame`
object (stamp arrays, object allocation); its p99.9 is GC. That cost exists only because the
contract hands decoded frames to the host, which then re-encodes frames bound for the UI or a
remote link (see contract notes).

Not measured: cold instantiate time in a browser, behaviour inside the real engine worker, and
end-to-end keystroke → first draw (needs the engine, renderer and UI from the other wave-1 areas).

## Contract notes (for the coordinating agent)

1. **Targeted CANCEL and epochs.** protocol-v1 says CANCEL carries "the new epoch". Proposed
   wording: a `CANCEL` with `request = 0` carries a new epoch; a `CANCEL` with `request ≠ 0` cancels
   that request only and carries the current epoch. Otherwise a `restart` cancel would fence every
   other live request.
2. **Echo the epoch.** Inference, database and renderer must copy the epoch of the frame that
   started the work (`INFER`, `EXEC`, `BIND`) into every response (`SQL_DELTA`, `SQL`,
   `INFER_STATS`, `RESULT_SCHEMA`, `BATCH`, `DONE`, `DRAWN`, `ERROR`). The coordinator drops
   request-scoped frames below its epoch, so a renderer that always sends epoch 0 loses every
   `DRAWN` after the first UI cancel.
3. **Bytes in, bytes out.** Add `inputEncoded(link, bytes, now)` to `CoordinatorCore` (implemented
   already as an extension), and consider `drainEncoded()` returning `[LinkId, Uint8Array]` for
   frames bound to the UI or a remote link: today the host decodes the coordinator's encoded
   output and re-encodes it to post it. Measured: decode is the largest JS cost in `drain()`.
4. **DRAWN may arrive more than once** per request (e.g. a second one carrying `FIRST_PRESENTED`);
   the coordinator merges it and re-sends `TIMING`. Worth stating in the spec for the renderer.

## Known gaps

- Wasm size is dominated by std's panic/formatting path (reached only on bugs). Removing it needs
  `tb-protocol` to be `no_std` (it implements `std::error::Error`) or a nightly
  `panic_immediate_abort` build.
- `SQL_DELTA` text is not used beyond stamping (no early speculative execution from partial SQL).
- Link close is not an input: the host should map an inference reconnect to `READY` (which retries
  the lost request) and a database/renderer loss to a UI `CANCEL`.
- Request ids are u32 and abort when exhausted (2³² requests per session).
- `CONTEXT` payload is stored and forwarded opaquely; the coordinator does not validate it.
