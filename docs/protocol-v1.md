# Protocol v1 (`tb1`)

Status: **normative, including negotiated persistent-canvas extensions.** This replaces the per-component JSON protocols
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
| 0x01 | `HELLO` | any → peer | `{"node": "<role>", "name": "...", "version": 1, "context"?: <u32>}`. `context` tells a remote database node which id to give the CONTEXT it sends |
| 0x02 | `READY` | peer → any | `{"node": "<role>", "name": "...", "model"?: "...", "capabilities"?: ["..."]}` |
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
| 0x13 | `QUERY` | UI → coordinator | revision, context | `u32 slot` + UTF-8 SQL: execute this SQL for this slot, no translation (chart-as-query, back). Stamps `KEY_INPUT` (the pointer/key event), `DRAFT_SENT`, `SQL_COMPLETE` (end of the SQL rewrite, node 2) |
| 0x14 | `REGISTER_TARGET` | UI → coordinator → renderer, UI | context, epoch | `u32 slot, u32 generation`; register a persistent target lifetime |
| 0x15 | `RELEASE_TARGET` | UI → coordinator → renderer, UI | epoch | `u32 slot, u32 generation`; cancel/release the lifetime and retain a tombstone |
| 0x18 | `INFER` | coordinator → inference | request, revision, context | UTF-8 question text |
| 0x19 | `SQL_DELTA` | inference → coordinator | request | UTF-8 fragment of the SQL being generated. Flag `0x02 RESET`: discard earlier deltas (a repair restarted the SQL) |
| 0x1A | `SQL` | inference → coordinator | request | UTF-8 complete SQL. Flag `0x01 CACHED` (inference-side cache) |
| 0x1B | `INFER_STATS` | inference → coordinator → UI | request | JSON `{model, provider?, promptTokens, completionTokens, cachedTokens?, reasoningTokens?, costUsd?, attempts, cancelled?}`; also sent for cancelled requests that reached the provider |
| 0x1C | `PRIME` | UI → inference | context | JSON `{question, sql}`: answer an INFER for exactly this question (trimmed, whitespace collapsed, case-folded) with this SQL. See "Suggestions" |
| 0x1D | `EDIT_CONTEXT` | UI → coordinator → inference | request = slot, revision = generation, context | Immutable edit-base JSON; see persistent targets below |
| 0x1E | `EDIT_INFER` | coordinator → inference | request, revision, context | `u32 slot, u32 generation` + UTF-8 change request |
| 0x20 | `EXEC` | coordinator → database; UI → database (WARM only) | request, context | UTF-8 SQL. Flags `0x01 SPECULATIVE`, `0x02 WARM` (see "Suggestions") |
| 0x21 | `RESULT_SCHEMA` | database → renderer (+ header-only → coordinator) | request | Arrow IPC encapsulated **schema** message |
| 0x22 | `BATCH` | database → renderer (+ header-only → coordinator) | request | Arrow IPC encapsulated **record batch** message |
| 0x23 | `DONE` | database → coordinator, renderer (WARM: → sender) | request | `u64 rows, u64 bytes` (16 bytes). Flags: `0x01 ROLLUP` (served from a pre-aggregated rollup), `0x02 RESULT_CACHE` (replayed from the result cache), `0x04 WARM` (answers a WARM EXEC; nothing was streamed) |

A cancelled request gets neither `DONE` nor `ERROR` from the database. Database `ERROR` codes:
`sql_rejected` (guard: not exactly one read-only query), `sql_error`, `timeout`, `result_limit`,
`queue_full`, `dataset`, `unavailable` (remote database unreachable or link lost).
`DONE.bytes` counts the BATCH payload bytes.

Arrow types from DuckDB: `TIMESTAMP` arrives as a microsecond Timestamp (int64 / BigInt64),
`COUNT(*)` and other integer aggregates as Int64. Consumers must not assume Float64.
From ClickHouse: time may arrive as `Timestamp<SECOND|MICROSECOND, UTC>`, counts as `Uint64`,
small literals as `Uint8`; ClickHouse contexts carry ClickHouse type names and text min/max.

Concatenating the `RESULT_SCHEMA` payload, every `BATCH` payload and an Arrow end-of-stream
marker gives a valid Arrow IPC stream. On in-process links, `RESULT_SCHEMA` and `BATCH` carry the
decoded Arrow `Schema` / `RecordBatch` objects instead of bytes.

### Suggestions (anticipation)

Two additions let a UI prepare likely next questions without bypassing the coordinator for
anything visible ([batch-2/voice-anticipation.md](batch-2/voice-anticipation.md)):

- **`EXEC` flag `WARM`**: the database runs the statement at the lowest priority (only when no
  other EXEC is queued; a real EXEC preempts a running warm-up, which is requeued) and stores the
  result in its result cache. It emits **no** `RESULT_SCHEMA`/`BATCH`, only `DONE` (flag `WARM`,
  plus `RESULT_CACHE` if it was already cached) or `ERROR` (`not_cacheable` for statements the cache
  never stores, plus the usual codes). Warm-ups are newest first, at most 8 waiting. A WARM EXEC
  carries a **sender-assigned request id with bit 31 set** (`0x8000_0000 | n`); coordinator request
  ids stay below 2³¹, so the two never collide. Epoch fencing and full `CANCEL` apply as usual.
- **`PRIME`**: `{question, sql}` for the inference node. A later `INFER` whose question matches
  is answered with `SQL` (flag `CACHED`) + `INFER_STATS` (`model: "primed"`, cost 0) echoing the
  INFER's identities and stamps `INFER_RECEIVED`/`SQL_COMPLETE`. Scoped to the header's context,
  bounded (LRU, 128). In the browser topology the engine host answers primed INFERs at its end of
  the inference link, so no frame reaches the remote node; a remote node that receives `PRIME`
  may ignore it (the Rust server does).
- **Routing:** the host passes `PRIME` and WARM EXECs from the UI past the coordinator (to the
  inference edge and the database), drops non-WARM EXECs and WARM EXECs without bit 31 from the
  UI, and sends every database frame of a bit-31 request back to the UI only (never to the
  renderer or coordinator). A click on a suggestion is an ordinary `COMMIT`.

### Presentation

| Kind | Name | Direction | Header | Payload |
|---|---|---|---|---|
| 0x30 | `BIND` | coordinator → renderer, UI | request, revision | `u32 slot, u32 view`. `view` is an index into `line bar scatter table heatmap surface map density tracks seasons`, or 255 for the automatic choice. It is set only when the SQL's `-- view:` hint names a presentation **the question asked for** (models add hints unasked). A BIND with a view field resets the slot's view for its result; a 4-byte legacy BIND leaves it unchanged |
| 0x31 | `UNBIND` | coordinator → renderer, UI | request | `u32 slot` |
| 0x32 | `DRAWN` | renderer → coordinator | request | `u32 slot, u32 points` + stamp `FIRST_DRAW_SUBMITTED`. May repeat; a later DRAWN can carry `FIRST_PRESENTED`. A result identical to the one on screen is adopted without drawing (steady charts): one DRAWN with `FIRST_DRAW_SUBMITTED` = `FIRST_PRESENTED` = the instant equality was proven |
| 0x33 | `RESULT` | coordinator → UI | request, revision, context | JSON `{slot, sql, columns: [{name, type, role}], view, cached}` once per bound request |
| 0x34 | `TIMING` | coordinator → UI | request, revision | empty; the stamps carry the request's full stage ledger |
| 0x35 | `KEEP` | coordinator → UI | request, revision | `u32 slot`: the committed result keeps this slot; the UI pins its card and registers a new live slot |
| 0x36 | `EXECUTION` | coordinator → UI | request, served revision, context, current epoch | JSON `{slot, generation, status: "succeeded" | "failed" | "cancelled"}` |
| 0x37 | `CANDIDATE` | coordinator → UI | request, served revision, context, epoch | JSON `{slot, generation, sql}` with the exact final SQL, before execution |

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
- **`QUERY` (chart-as-query).** A new request with the given SQL, bound to the slot with a 4-byte
  `BIND` (the slot keeps its view) and executed at once; the slot's previous request is
  superseded. On the live slot it answers the live question's text and revision, so `COMMIT` of
  that text keeps it and the next keystroke replaces it. On a kept slot it is committed. A free
  slot that is not live, another context or an older epoch is dropped. Details:
  [batch-2/manipulation.md](batch-2/manipulation.md).
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

### Persistent targets and contextual edits

These extensions use the same frame codec and transports. The UI requires
`canvas-targets-v1` in the coordinator's `READY`; contextual inference additionally
requires `edit-context-v1` from inference. An older inference peer can still serve
new questions; saved SQL loads without inference. Unsupported contextual edits
fail explicitly, without silently sending a bare change request to `INFER`.

- A target is `(slot, generation)`, independent of query request IDs. Registration
  accepts only a newer nonzero generation. Release of an unknown/future generation
  creates an inactive tombstone; a late registration cannot resurrect it. The
  coordinator keeps at most 10,000 target entries: released tombstones are evicted
  lowest slot first and leave a floor. UI slot numbers only grow, so an absent slot
  below the floor counts as released and stays fenced. Re-registering or releasing a
  target cancels its work and lets the next queued target `COMMIT` start. Context
  zero invalidates pending work while retaining the previous picture.
- Targeted `DRAFT`/`COMMIT` put the slot in header `request` and prepend a little-endian
  `u32 generation` to the text. Header `revision` is a monotonically increasing
  sequence within that lifetime. Equal sequence with different text rejects. Legacy
  request-zero text frames keep their existing meaning.
- Targeted `QUERY` puts generation in header `request`, with the existing
  `u32 slot + SQL` payload. It requires a fresh sequence and always executes: it
  cannot adopt a result from a previous target generation or restored definition.
  It becomes the target's newest answer. A later `COMMIT` reuses an executed result
  only if it is still the target's bound one; otherwise it translates and executes
  again, so `EXECUTION succeeded` always names the SQL on screen.
- Targeted `BIND`/`UNBIND` carry `u32 slot, u32 view, u32 generation`. View 256
  preserves the full current presentation; 255 is explicit Auto; 0–9 select the
  listed views. A confirmed explicit view requested in text becomes durable intent.
  A newer manual picker choice suppresses a delayed hint from that sequence in
  both the host and UI, including renderer-startup replay; later text can request
  another view normally.
- `CANDIDATE` reports only final, nonempty SQL, including cache/adoption paths.
  `EXECUTION` is terminal and emitted once per request/served-sequence. SQL success
  is distinct from rendering success and from an IndexedDB acknowledgement.
- Renderer UI controls and callbacks also carry generation and bound request.
  The host rejects late database frames and callbacks before drawing or updating
  chrome. Source activation first invalidates execution context, even if loading fails.
- Persistent slots never enter the legacy `freeSlots` pool. DOM shells can exist
  without a renderer allocation; releasing a resident target frees its result/GPU
  resources while preserving the durable definition.

#### Changes to legacy (request-zero) behaviour

These came with the target work and apply to the live-slot path too:

- `DRAFT`/`COMMIT` whose epoch is below the coordinator's are dropped, like every
  other request-scoped frame. The UI stamps the current epoch on text frames.
- A renderer `ERROR` for a target request is forwarded to the UI only: drawing failure
  is not SQL failure, and the target keeps its binding. For a request-zero request it
  still marks the request failed and the live slot falls back to its last drawn result.
- A context change cancels every tracked request (translations and executions), not
  only the in-flight translation.
- Full `CANCEL` reports each target's `EXECUTION cancelled` under the new epoch.
- Inference accepts questions up to 16,384 characters (was 4,096), matching the bound
  on saved canvas questions (`src/canvas/limits.ts`).

`EDIT_CONTEXT` is at most 128 KiB of strict JSON:

```json
{"mode":"refine","originalQuestion":"Average temperature by station",
 "sql":"SELECT station, avg(temperature) FROM weather GROUP BY 1",
 "history":[{"kind":"create","text":"Average temperature by station"}],
 "presentation":{"view":null,"params":{}}}
```

`mode` is `refine` or `regenerate`. History contains up to 32 entries from the
selected lineage, with `kind`, `text` and optional `details`; sibling branches are
excluded. The full history remains in the document. No result rows, files or
schema samples belong in this payload. Schema still travels in `CONTEXT`.
The base is immutable for its slot/generation/context handle. `EDIT_INFER` resolves
that handle and supplies only the new request. Both backends append the exact
validated wire JSON to the same golden-tested prompt. Repair retains that base.
Cache identity includes source context, complete base bytes and request text;
transport-local handles do not affect reuse. Refinement preserves selected SQL
semantics; regeneration prioritizes original intent plus selected revisions.

The browser journals draft text and final SQL separately from execution. Enter or
leaving the editor freezes a sequence; only its successful execution can atomically
append a chart revision and canvas commit. Restore/cancel changes runtime identity
before hydration. IndexedDB uses monotonic canvas/draft versions and closed-draft
tombstones, so an old save cannot reopen or overwrite the restored state.

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
   presentation; the coordinator ignores a hint the question did not ask for.

Roles: `time`, `category`, `series`, `value`, `measure`, `lat`, `lon`.

## Trace stages

`node`: 1 UI, 2 coordinator, 3 inference, 4 database, 5 renderer, 6 provider.

| Stage | Name | Stamped by |
|---:|---|---|
| 1 | `KEY_INPUT` | UI: the input event's `timeStamp`, converted to Unix ms (for `QUERY`: the pointer or key event of the gesture) |
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
