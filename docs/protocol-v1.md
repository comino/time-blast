# Protocol v1 (`tb1`)

Status: **normative for batch 1.** This replaces the per-component JSON protocols
(`time-blast.v1`, `time-blast.inference.v1`, the HTTP database bridge, worker messages).
Direction: [vision.md](vision.md). Reference codecs: `crates/tb-protocol` (Rust) and
`src/protocol/` (TypeScript). Golden vectors in `crates/tb-protocol/vectors/` keep the
two implementations identical.

## Nodes and links

Every component is a **node**: UI, coordinator, inference, database, renderer. Nodes exchange
**frames** over **links**. The frame semantics are the same on every link. The link only decides
how a frame travels:

| Link | Used when | Encoding |
|---|---|---|
| In-process | Both nodes in the same thread (coordinator, database and renderer in the engine worker) | Decoded frame object; payload may be a live object (e.g. an Arrow `RecordBatch`). **No bytes are produced.** |
| MessagePort | Different threads in one page (UI ↔ engine worker, engine ↔ WebLLM worker) | One encoded frame per message; the frame's `ArrayBuffer` is **transferred**, not cloned |
| WebSocket | Different hosts | One encoded frame per binary WebSocket message; subprotocol `tb1` |

A frame is encoded only when it crosses a thread or host boundary. Moving a node between
placements changes the link, never the frames or the node's logic.

## Browser topology (batch 1)

```
 main thread (UI, JS glue)                 engine worker
 ┌──────────────────────┐  MessagePort  ┌─────────────────────────────────────────┐
 │ input → DRAFT/COMMIT │ ────────────► │ coordinator (Rust/Wasm, sans-IO)        │
 │ cards, DOM chrome    │ ◄──────────── │   ├─ in-process ─► database node        │
 │ (canvases transferred│  events       │   │                (DuckDB blocking)    │
 │  to engine worker)   │               │   ├─ in-process ─► renderer (Rust/Wasm  │
 └──────────────────────┘               │   │                + WebGPU shim,       │
                                        │   │                OffscreenCanvas)     │
                                        │   └─ inference link: MessagePort to     │
                                        │      WebLLM worker  | WebSocket to Rust │
                                        └─────────────────────────────────────────┘
```

- **BATCH bypasses the coordinator.** The database node sends `BATCH` straight to the renderer
  over the in-process link. The coordinator receives only a header-only copy (`HEADER_ONLY` flag)
  for stamps and progress. The renderer fences by request using `BIND`/`UNBIND`.
- **The coordinator is sans-IO Rust.** It consumes `(link, frame, now)` and produces
  `(link, frame)` outputs and timer deadlines. The same crate compiles to Wasm (engine worker) and
  native (future remote coordinator).
- **Remote placements** swap one in-process link for a WebSocket link. Two remote nodes talk
  directly: a remote coordinator would send `EXEC` straight to a remote database. Batch 1
  implements the remote inference placement. Remote database and coordinator come in batch 2.

## Frame layout

All integers are little-endian. Payloads start 8-byte aligned so Arrow buffers inside them can be
viewed in place.

```
offset size  field
0      u8    version   = 1
1      u8    kind      (table below)
2      u8    flags     (kind-specific bits, plus the common bits below)
3      u8    stamps    number of trace stamps n (0..=255)
4      u32   len       payload length in bytes
8      u32   epoch     cancellation epoch the frame was created under
12     u32   request   request id (0 = none)
16     u32   revision  draft revision (0 = none)
20     u32   context   dataset context id (0 = none)
24     n×16  stamps    each: u16 stage, u16 node, u32 reserved (0), f64 at
24+16n len   payload
```

Header size is 24 bytes. A stamp is 16 bytes. `at` is **Unix epoch milliseconds as f64**
(`performance.timeOrigin + performance.now()` in browsers, `SystemTime` natively). Within one
browser all threads share that clock. Across hosts the stamps are comparable only up to clock
skew, which reports must label.

Common flag bits: `0x80 HEADER_ONLY` means the payload was omitted on purpose and `len` is 0.
The other bits are kind-specific.

Limits: payload ≤ 16 MiB, and decoders reject anything larger. Decoders reject unknown versions,
unknown kinds, truncated frames, and nonzero reserved stamp fields.

## Kinds

### Session (cold path, UTF-8 JSON payload)

| Kind | Name | Direction | Payload |
|---|---|---|---|
| 0x01 | `HELLO` | any → peer | `{"node": "<role>", "name": "...", "version": 1}` |
| 0x02 | `READY` | peer → any | `{"node": "<role>", "name": "...", "model"?: "..."}` |
| 0x03 | `CONTEXT` | database → coordinator → inference | `DatasetContext` (below); header `context` = its id |
| 0x04 | `STATUS` | any → UI | `{"component": "database|inference|renderer|coordinator", "state": "cold|loading|ready|error", "label", "detail"?, "progress"?}` |
| 0x05 | `ERROR` | any | `{"code", "message", "detail"?}`; header `request` names the failed request or 0 |
| 0x06 | `CONFIG` | UI → coordinator | `CoordinatorConfig` (below) |

### Loop (hot path)

| Kind | Name | Direction | Header | Payload |
|---|---|---|---|---|
| 0x10 | `DRAFT` | UI → coordinator | revision, context | UTF-8 text. Flag `0x01 COMPOSING` |
| 0x11 | `COMMIT` | UI → coordinator | revision, context | UTF-8 text (always the full text; Enter) |
| 0x12 | `CANCEL` | any → any | request = 0: cancel everything, epoch = **new** epoch. request ≠ 0: cancel that request only, epoch unchanged | empty |
| 0x18 | `INFER` | coordinator → inference | request, revision, context | UTF-8 question text |
| 0x19 | `SQL_DELTA` | inference → coordinator | request | UTF-8 fragment of the SQL being generated |
| 0x1A | `SQL` | inference → coordinator | request | UTF-8 complete SQL. Flag `0x01 CACHED` (inference-side cache) |
| 0x1B | `INFER_STATS` | inference → coordinator → UI | request | JSON `{model, promptTokens, completionTokens, cachedTokens?, reasoningTokens?, costUsd?, attempts, cancelled?}`; also sent for cancelled requests that reached the provider |
| 0x20 | `EXEC` | coordinator → database | request, context | UTF-8 SQL. Flag `0x01 SPECULATIVE` |
| 0x21 | `RESULT_SCHEMA` | database → renderer (+ header-only → coordinator) | request | Arrow IPC encapsulated **schema** message |
| 0x22 | `BATCH` | database → renderer (+ header-only → coordinator) | request | Arrow IPC encapsulated **record batch** message |
| 0x23 | `DONE` | database → coordinator, renderer | request | `u64 rows, u64 bytes` (16 bytes) |

Concatenating the `RESULT_SCHEMA` payload, every `BATCH` payload and an Arrow end-of-stream
marker gives a valid Arrow IPC stream. On in-process links, `RESULT_SCHEMA` and `BATCH` carry the
decoded Arrow `Schema` / `RecordBatch` objects instead of bytes.

### Presentation

| Kind | Name | Direction | Header | Payload |
|---|---|---|---|---|
| 0x30 | `BIND` | coordinator → renderer, UI | request, revision | `u32 slot` |
| 0x31 | `UNBIND` | coordinator → renderer, UI | request | `u32 slot` |
| 0x32 | `DRAWN` | renderer → coordinator | request | `u32 slot, u32 points` + stamp `FIRST_DRAW_SUBMITTED`. May repeat; a later DRAWN can carry `FIRST_PRESENTED` |
| 0x33 | `RESULT` | coordinator → UI | request, revision, context | JSON `{slot, sql, columns: [{name, type, role}], view, cached}` once per bound request |
| 0x34 | `TIMING` | coordinator → UI | request, revision | empty; the stamps carry the request's full stage ledger |
| 0x35 | `KEEP` | coordinator → UI | request, revision | `u32 slot`: the committed result keeps this slot; the UI pins its card and registers a new live slot |

## Identities and fencing

- **revision**: monotonic per editor, assigned by the UI. A newer revision supersedes older ones.
- **request**: assigned by the coordinator, monotonic u32, never reused in a session. One request
  covers one translation and its execution.
- **epoch**: a full `CANCEL` (request 0) carries the new epoch; a targeted `CANCEL` keeps it.
  Every node drops request-scoped frames whose epoch is below its current epoch. **Every reply
  echoes the epoch of the frame that caused it** (INFER → SQL_DELTA/SQL/INFER_STATS/ERROR,
  EXEC → RESULT_SCHEMA/BATCH/DONE/ERROR, BIND → DRAWN).
- **context**: the dataset context id. Loading new data creates a new context. Frames for another
  context are dropped.
- **slot**: a render target (a card canvas), registered by the UI **before** results exist, so a
  first draw never waits for a canvas to be created. The renderer accepts `RESULT_SCHEMA`/`BATCH`
  only for the request currently bound to a slot. It keeps the previous image until the newly bound
  request draws its first point, so there is no flicker of empty frames.

## Coordinator behavior

- **Per-keystroke translation.** Every `DRAFT` may start a translation, with no idle debounce.
  `inferencePolicy` decides what happens to an in-flight request:
  - `latest` (default): let the in-flight translation finish, then translate the newest revision.
    Results keep arriving while you type.
  - `restart`: cancel the in-flight translation and start the newest immediately.
- **At most one translation in flight per session.**
- **SQL dedup.** If a new translation yields byte-identical SQL to the request bound to the live
  slot, skip execution and rebind only the revision.
- **Translation cache and latency dial.** An exact text→SQL cache, bounded LRU. With
  `latencyDialMs` set, a cache hit is released after exactly that delay, simulating faster (or
  slower) inference. Hits are stamped `CACHE_HIT`.
- **`COMMIT` (Enter).** If the live slot already shows this exact revision's text, emit `KEEP`
  immediately. Otherwise translate and execute at committed priority and `KEEP` when it is bound.
- **Stale results.** A result is shown only if its request is still bound to a slot. An early
  wrong chart is a failure.
- **Short drafts.** A draft shorter than `minChars` (after trimming) cancels speculative work
  and `UNBIND`s the live slot.
- **Forwarding.** `CONTEXT` from the database is stored and forwarded to inference (again after
  every inference `READY`). `STATUS`, `ERROR` and `INFER_STATS` are forwarded to the UI.

## Data contracts

### `DatasetContext` (JSON)

```json
{
  "id": 7,
  "name": "vessels",
  "dialect": "duckdb",
  "description": "Synthetic vessel telemetry",
  "tables": [{
    "name": "telemetry",
    "rows": 1209600,
    "columns": [
      {"name": "ts", "type": "TIMESTAMP", "min": "2026-01-01T00:00:00Z", "max": "2026-01-15T00:00:00Z"},
      {"name": "vessel", "type": "VARCHAR", "distinct": 6, "values": ["Aurora", "..."]},
      {"name": "speed", "type": "DOUBLE", "min": 0, "max": 21.4}
    ],
    "sample": [["2026-01-01T00:00:00Z", "Aurora", 12.3]]
  }]
}
```

`min`/`max` and `distinct`/`values` (for low-cardinality text, ≤ 32 values) are optional
statistics computed at load time. The inference prompt puts this context in a stable,
cacheable prefix.

### `CoordinatorConfig` (JSON)

```json
{"live": true, "minChars": 3, "inferencePolicy": "latest", "latencyDialMs": null,
 "translationCache": true, "speculate": true, "freeSlots": [1, 2]}
```

Every field is optional, and a `CONFIG` updates only the fields it names. `freeSlots` **adds**
slots (already attached to the renderer by the UI) to the coordinator's pool. The coordinator
binds live results to a pool slot. When it sends `KEEP(slot)`, that slot leaves the pool, and the
UI attaches a new canvas and adds its id with another `CONFIG`. The UI keeps at least two
slots in the pool so that typing right after Enter never waits for a canvas.

### Result shape convention

The model is told to shape results so that roles can be read off column order and type, at zero
extra tokens. The renderer infers roles from this convention and still behaves sensibly when the
model ignores it.

1. **First column:** x: time (`TIMESTAMP`/`DATE`) or category.
2. **Middle text/integer-category column, if any:** series.
3. **Last numeric column:** value. More numeric columns are extra measures (scatter uses two).
4. **Columns named `lat`/`latitude` and `lon`/`lng`/`longitude`:** geographic position.
5. **Optional view hint:** a leading SQL comment `-- view: <name>`. Names: `line bar scatter table
   heatmap surface map density tracks seasons`. Emitted only when the user asks for a
   presentation.

Roles: `time`, `category`, `series`, `value`, `measure`, `lat`, `lon`.

## Trace stages

`node`: 1 UI, 2 coordinator, 3 inference, 4 database, 5 renderer, 6 provider.

| Stage | Name | Stamped by |
|---:|---|---|
| 1 | `KEY_INPUT` | UI: the input event's `timeStamp`, converted to Unix ms |
| 2 | `DRAFT_SENT` | UI |
| 3 | `COORD_RECEIVED` | coordinator |
| 4 | `INFER_SENT` | coordinator |
| 5 | `INFER_RECEIVED` | inference node |
| 6 | `PROVIDER_REQUEST` | inference node, when calling an upstream provider |
| 7 | `FIRST_TOKEN` | inference node, with node 6 (provider), on the inference node's clock |
| 8 | `SQL_FIRST_DELTA` | inference node |
| 9 | `SQL_COMPLETE` | inference node |
| 10 | `SQL_RECEIVED` | coordinator |
| 11 | `EXEC_SENT` | coordinator |
| 12 | `EXEC_RECEIVED` | database |
| 13 | `DB_FIRST_BATCH` | database |
| 14 | `DB_DONE` | database |
| 15 | `RENDER_FIRST_BATCH` | renderer |
| 16 | `FIRST_DRAW_SUBMITTED` | renderer |
| 17 | `FIRST_PRESENTED` | renderer, best effort (`onSubmittedWorkDone` / next frame) |
| 18 | `CACHE_HIT` | coordinator |

The headline number is **`KEY_INPUT` of the bound revision → `FIRST_DRAW_SUBMITTED`**, i.e. last
keystroke → first point. The coordinator keeps one ledger per request and emits it in `TIMING`.

## Remote links

- WebSocket subprotocol `tb1`. One frame per binary message. Text messages are a protocol error.
- The first frame on a link is `HELLO`. The peer answers `READY`.
- A link may be closed at any time. Cancellation is `CANCEL`, and closing a link cancels
  everything that link started.
- Providers' API keys stay in the server environment and never cross a link.
