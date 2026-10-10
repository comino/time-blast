# Protocol draft

Status: proposed `tb/0` semantics, October 9, 2026. This is a design for a prototype, not a published or implemented wire standard. Binary framing and codec selection remain benchmark decisions.

The implemented contracts are documented in the [browser prototype](prototype.md) and [Rust backend](backend-prototype.md). In particular, the deployed inference socket uses `time-blast.inference.v1`, not this proposed `tb/0` protocol. See [current status](status.md) for the placement and capability boundary.

The protocol separates mutable drafts, immutable committed requests, speculative candidates, and incremental results. It describes the same behavior for local calls, worker messages, WebSocket, or WebTransport. It does not require a network serialization step for local execution.

## Identities

| Field | Meaning |
| --- | --- |
| `session_id`, `session_epoch` | Authenticated session and its current connection lifecycle |
| `editor_id`, `revision` | One draft stream and its monotonically increasing revision |
| `context_id` | Immutable schema/catalog, conversation, authorization, and source configuration reference |
| `candidate_id` | One speculative interpretation/execution, never reused |
| `commit_id` | Idempotency identity for an immutable submitted request |
| `query_id` | Validated query representation, parameters, and consistency contract |
| `result_generation` | One renderer-visible result instance; changes on replacement |
| `schema_id`, `sequence` | Result schema identity and ordered event position within a generation |

The server derives authorization from the session, not from a client-supplied identity. A `context_id` is a scoped reference, not a permission grant. Revalidate authorization when committing and invalidate affected caches on policy changes.

IDs are opaque strings in the readable control encoding. Revisions and sequence counters must fit JavaScript safe integers; create a new epoch before overflow. A future binary encoding can use fixed-width IDs without changing the state machine.

## Session negotiation

Before the Enter path, `HELLO → READY` selects a protocol version and declares limits and capabilities:

```json
{
  "type": "HELLO",
  "versions": ["tb/0"],
  "result_codecs": ["arrow-ipc"],
  "features": ["draft-snapshot", "candidate-promotion", "point-upsert"],
  "limits": {"max_control_bytes": 65536, "max_frame_bytes": 262144}
}
```

The numbers are proposed negotiation examples. `READY` returns accepted values, `session_id`, a fresh `session_epoch`, and the supported inference/database capabilities. Result byte credits and decoded-memory limits are negotiated separately. Optional capabilities such as mutable prefill, datagrams, query resume, and shared snapshot identity must be explicitly available; ordinary response streaming does not imply them.

Bootstrap the renderer, query catalog, and stable model context during this phase. A `CONTEXT_READY` event means the named context is prepared to the adapter's declared level; it does not mean every engine has materialized KV state.

## Draft transmission

`DRAFT` carries a complete text snapshot in v0. New snapshots supersede older drafts. Use input events, including paste and composition completion, rather than treating the keyboard as an append-only stream.

```json
{
  "type": "DRAFT",
  "session_epoch": "epoch-4",
  "editor_id": "main",
  "revision": 42,
  "context_id": "context-7",
  "text": "average temperature by minute over the last hour",
  "composition": false
}
```

`DRAFT_ACK {editor_id, revision, context_id}` acknowledges stored text, not inference completion. The receiver ignores lower revisions. Snapshots with the same revision must be byte-identical or cause a protocol error. An ACK can be piggybacked on another control message.

The initial transport uses reliable ordered messages. An optional datagram mode can carry self-contained snapshots within negotiated datagram size; never send dependent patches over an unreliable channel without a recovery design. Overlarge drafts use the reliable channel. Enter never relies on a datagram having arrived.

Bound draft sending by queue size and a short configurable coalescing interval. Keep only the newest unsent snapshot. The committed request bypasses that interval. Do not serialize every obsolete edit into a queue that Enter must wait behind.

`DRAFT` permits preparation and bounded speculation under the workspace's preselected policy. It does not authorize visible committed results. A changed context invalidates candidates even if the text is unchanged.

## Commit without a repair round trip

On Enter, the browser creates an immutable commit, freezes the input snapshot, and sends it immediately:

```json
{
  "type": "COMMIT",
  "session_epoch": "epoch-4",
  "commit_id": "commit-9",
  "editor_id": "main",
  "revision": 42,
  "context_id": "context-7",
  "text": "average temperature by minute over the last hour",
  "parameters": {"timezone": "UTC"},
  "time_anchor": {"source": "coordinator-first-acceptance"},
  "consistency": {"mode": "at-commit"},
  "candidate_hint": "candidate-18"
}
```

Full text is intentionally included in the baseline. It avoids a `missing revision → resend` round trip and covers the final unsent edit. It still benefits from all previously transmitted work. A compact reference-only commit is a later experiment, permitted only when the exact revision and immutable context are acknowledged and retained. Never wait for an ACK to send a normal full commit.

Repeated identical `commit_id` messages return the same accepted identity within the session's advertised retention window. A different payload under that ID is rejected. Validate payload equality or a canonical digest; never silently treat a collision as a new request. Deduplication is a coordinator guarantee within that window, not a promise of global exactly-once database execution after a crash.

Freeze relative-time resolution exactly once. The default `time_anchor.source` is `coordinator-first-acceptance`: record the coordinator's UTC wall-clock instant when first accepting this commit, return it in `COMMIT_ACCEPTED` or `COMMITTED`, and reuse it for all retries and query parameters. It defines query meaning, not a latency clock or a database snapshot. A negotiated `explicit` anchor can instead carry an RFC 3339 instant captured by the browser at Enter; label its client-clock authority and validate it against the workspace policy. Never silently switch anchor sources. A reconnect/recommit is a new request; include the original explicit anchor when preserving the old window is required and supported.

`COMMITTED` reports `commit_id`, `query_id`, `result_generation`, resolved time parameters, accepted consistency/data epoch, and any promoted `candidate_id`. If interpretation is still being resolved, first send `COMMIT_ACCEPTED`, and send `COMMITTED` after the complete query is validated. Data cannot become committed-visible before that binding exists. Unsupported consistency requirements fail explicitly; do not silently weaken them.

“At commit” means the selected backend's documented consistency at committed execution, not a magically synchronized global instant across engines. In v0 it normally prevents promotion of precommit data unless the adapter can prove that its epoch is still valid. A fixed immutable dataset or explicitly selected snapshot offers a stronger promotion opportunity. Return the actual contract and query boundaries to the client.

The client need not wait for a remote acknowledgment to draw a locally prepared result whose complete query binding, authority, and immutable data epoch can be validated locally. Otherwise any immediate image is a labeled provisional preview until the required validation arrives.

## Candidate lifecycle

```text
draft revision → candidate → preparing → executing → staged
                         ↘ obsolete/canceled
staged + matching validated commit → explicit promotion → committed generation
staged + mismatched commit         → discard or keep as unrelated cache entry
```

Candidate messages are `CANDIDATE`, `CANDIDATE_SCHEMA`, `CANDIDATE_BATCH`, `CANDIDATE_COVERAGE`, and `CANDIDATE_END`, all bound to `candidate_id`, revision, context, and data epoch. The schema, batch, coverage, and end events carry contiguous candidate sequences starting at zero. The end event states success, error, or cancellation; only a successful end maps to `COMPLETE` on promotion. They enter a bounded staging area, not the active chart reducer. Speculative previews, if enabled, use a separately labeled layer.

Promotion validates exact submitted text or a separately proven interpretation, resolved parameters, source identity, authorization epoch, and freshness/snapshot requirements. The receiver can then remap staged immutable buffers into the accepted `result_generation`. Promotion preserves the accepted interpretation; it does not prove semantic accuracy against the user's intent.

The coordinator performs an atomic cutover: `COMMITTED` includes `promoted_candidate_id` and `promoted_through_sequence = p`, the last event emitted in the candidate stream. Candidate events `0..p` map one-to-one to the same sequence numbers in the new result generation, with their schema/data/terminal semantics preserved. All subsequent producer events use the committed generation starting at `p+1`. If no candidate schema/data event has been emitted, `p` is null and committed events start at zero. The receiver accepts late candidate events only within this explicit promoted prefix, deduplicates by sequence, and consumes a contiguous prefix before any higher sequence. It can display an early valid point before the rest of that prefix arrives. A buffered continuation cannot jump a missing schema or batch. Missing events trigger stream failure/restart in v0, never an assumed empty gap. Candidate events beyond the declared cutover are rejected.

Promotion therefore does not depend on sender and receiver having identical instantaneous staging state. A fully received candidate is the cheapest case; an in-flight prefix remains reliable, bounded, and identity-checked. A locally validated promotion uses the same atomic cursor rule without a network message.

Preparing the right table for the wrong predicted question is still useful partial work. Reuse compatible schema/model/data caches without pretending that the predicted answer is valid.

## Result stream

Each committed generation has an ordered logical stream:

```text
SCHEMA → (BATCH | COVERAGE)* → COMPLETE
                            ↘ ERROR
                            ↘ CANCELED
```

Every result event identifies `commit_id`, `query_id`, and `result_generation`, with a monotonically increasing `sequence` starting at zero. The renderer accepts only its active binding. A duplicate identical sequence is ignored; conflicting duplicates fail the stream. Reassemble the ordered logical sequence before reducing it. Future sequences arriving across transport streams or a promotion cutover wait in a bounded reorder buffer with a negotiated deadline; an unrecoverable gap, missing predecessor after stream end, timeout, or buffer overflow fails the stream. Bind and buffer within strict limits before activation; transport arrival order is not a global ordering guarantee.

`SCHEMA` includes:

- Time encoding: signed 64-bit integer epoch timestamp, explicit unit and display timezone.
- Series IDs, units, value types, nullability, and aggregation semantics.
- Requested time domain, bucket width/origin, and whether ordering is guaranteed.
- Resolution: raw, bucketed, or sampled, including sampling method where relevant.
- Consistency/data epoch and point-quality semantics supported by the adapter.

Epoch nanoseconds must not pass through a JavaScript `Number`. Preserve int64/BigInt or high/low representation; subtract a nearby origin before converting a plot coordinate to float. Preserve exact values separately from GPU display coordinates. Decimals likewise need an explicit conversion policy.

`BATCH` carries columns, not one object and message per point on the bulk path. Arrow IPC is the initial binary candidate; a separately negotiated JSON-array encoding may be used for diagnostics, outside the intended low-latency data path. A batch has a schema reference, point count, payload size, and operation (`append`, `upsert`, or `retract`). Nulls and missing values must not become zeroes. Consumers retain or transfer buffer ownership and update the chart incrementally rather than collecting or reconstructing the full result. The [representation contract](streaming-without-repacking.md) defines the zero-avoidable-copy objective.

Point identity is `(series_id, timestamp, bucket_width, resolution_id, observation_id)` within a generation. Bucketed points omit `observation_id`; raw data with multiple observations at the same series/timestamp requires a stable disambiguator. Revisions are monotonic per identity. Upsert replaces that point at a higher revision; retract removes it with a higher revision tombstone. An adapter can use cheaper append mode only when it guarantees no duplicate/revised identities. A renderer must not connect out-of-order points as if they were time-ordered.

Point quality is `provisional` or `exact` for the accepted query and data epoch. Each batch can use one quality value or a per-point column. An exact point cannot later change inside the same query/data epoch; discovering such a violation fails the generation. A correction requiring a new snapshot creates a new generation. Provisional points may become exact through explicit higher-revision upserts, never merely because time elapsed.

Coverage is separate from quality. `COVERAGE` names completed time ranges/series and its guarantee. Only the producer can assert that no more matching data can revise a bucket. A maximum observed timestamp is not a completeness watermark. Arbitrary aggregates, joins, and sorts may emit nothing exact until enough input has been processed.

`COMPLETE` states final row/point counts, coverage, and whether the final result is exact or an explicitly requested approximation. It means successful query completion, including a valid empty result. An ordinary execution/transport `ERROR` leaves any still-supported points visibly marked incomplete; receiving a point or HTTP 200 never implies successful completion. An error carries `validity: retained | invalidated`. A correctness or binding violation uses `invalidated` and removes the affected generation from the valid chart immediately; v0 invalidates the whole generation rather than guessing which points remain trustworthy. A replacement requires `RESET` and a new binding.

## First point and bulk data

The renderer needs schema, a timestamp **and value**, series semantics, and a usable plot mapping. Send that dependency set early. Draw an isolated marker immediately; add the line and subsequent points as data arrives.

Three formats should be compared with identical data:

1. Arrow schema plus the smallest useful record batch, then larger batches.
2. A self-contained `FIRST_POINT` carrying the schema subset and one or a few points, then Arrow bulk data.
3. A fixed specialized columnar point format throughout.

`FIRST_POINT` is an optional experimental extension, not required v0 behavior. It must preserve the same types and quality semantics as bulk data. Either exclude its identities from subsequent append batches or use idempotent upsert; never double-count the bootstrap point. An Arrow dictionary dependency must be delivered before any batch that needs it.

For byte-stream transports, define explicit message framing and incremental parsing in the implementation RFC: reads can split or join frames. Never assume an HTTP read equals a database batch. WebSocket preserves message boundaries, but the application still needs bounded sizes and distinct control/data types. No binary header layout is frozen by this document.

## Flow control and scheduling

Reserve initial receive credit so the first schema and point do not wait for an extra credit request. `CREDIT {stream: {kind, id}, grant_id, bytes}` grants encoded payload capacity to either a `candidate` or a committed `generation`. Grants are additive; duplicate `grant_id` values within the epoch have no additional effect and conflicting reuse is an error. Candidate bootstrap windows come from a bounded session-wide speculative budget negotiated before typing, not a fresh unbounded allowance for every new candidate. A producer fragments or selects batches to fit available credit and the maximum frame size. If one value exceeds a limit, report a bounded error or negotiate a supported chunking extension.

Promotion aliases the candidate and new generation to one credit ledger atomically. Outstanding/in-flight bytes, unused grants, and decoded-memory ownership transfer without resetting or granting a second bootstrap window. Late candidate grants apply to that same ledger, with grant-ID deduplication preserved; no new candidate output beyond the promotion cursor is permitted. Keep the alias until in-flight buffers and grants are settled, then retire it. Cancellation revokes unused credit and prevents new production; already-sent buffers remain accounted for until consumed or discarded. Distinct nonpromoted generations receive separate ledgers, all bounded by the session memory cap.

Maintain a separate decoded-memory cap, because compression or variable-width values can expand. Release buffer ownership deliberately when returning credit. Transferable worker buffers detach from the sender; shared buffers require an ownership protocol rather than optimistic simultaneous mutation.

Record-batch assembly needs its own bounded reservation. Transport fragmentation alone cannot prevent a credit deadlock when the decoder needs a whole IPC message before it can release any buffer. Before admitting an active stream, reserve assembly capacity under the session cap and negotiate a maximum encoded IPC message and decoded size. Bootstrap credit must permit reading its bounded metadata. Once that metadata declares a permitted message size, grant enough completion credit from the reserved pool without waiting for that same message to decode or render. Account for retained dictionaries and previous batches separately. Reject/cancel an over-cap message or unsupported expansion instead of accepting an unbounded size or waiting forever. These grants consume existing reservation; they do not create additional memory capacity. Fragmenting transport bytes never implies splitting or repacking an Arrow record batch.

Priority is commit/cancel/error, then the first useful data, then continuation data, then speculative work and diagnostic telemetry. Reserve bounded space for critical control messages. Transport multiplexing does not create CPU/GPU/database priority automatically: each adapter must also enforce admission and scheduling.

Coalesce provisional updates for the same point by retaining the newest revision, including any newer tombstone or transition to exact quality. Do this before assigning outbound event sequences, or only in renderer state after consuming the ordered stream; never create sequence gaps by dropping encoded events. Never discard exact data silently to make rendering appear faster. Under overload, slow the producer, spill within declared limits, or fail explicitly. Drawing at most once per display opportunity can coalesce paint work while preserving accepted state updates.

## Cancellation and recovery

`CANCEL` names a candidate or commit. It immediately prevents further UI activation, but does not claim the engine has stopped. `CANCEL_ACK` reports whether execution stopped, was already finished, or cannot be interrupted. Track time and resource consumption after cancellation; obsolete work must not starve a committed request.

For a new visible request, the browser selects a new active `commit_id` immediately. Late batches from the previous request are ignored regardless of their arrival order. A renderer replacement within one commit uses `RESET` to establish a new generation and binding before any new data can activate; it retires the previous generation atomically.

V0 does not promise result resume. A disconnected stream becomes incomplete. Reconnect with a new session epoch, renegotiate, and recommit under a new identity after reconciling/canceling old work where possible. Never concatenate a new query's batches to the old generation. A later resume extension requires retained generation identity, identical query/data epoch, acknowledged sequence offsets, and deduplication.

An unknown epoch, context, schema, or generation is not guessed into existence. Reject or request the missing metadata outside the fast path. Size, ordering, type, and authorization checks are part of the contract and should be cheap, bounded operations.

## Example successful speculative trace

```text
t < 0    DRAFT rev 42 reaches coordinator; inference resolves candidate 18
t < 0    candidate 18 runs against selected immutable dataset epoch D7
t < 0    CANDIDATE_SCHEMA + CANDIDATE_BATCH arrive and are staged
t = 0    Enter freezes rev 42; full COMMIT is sent
t > 0    coordinator validates identity/authority; COMMITTED promotes candidate 18
t > 0    browser activates staged buffers under the new result generation
t > 0    draw is submitted; remaining exact points stream; COMPLETE arrives
```

If all validation is local for an immutable local dataset, promotion can occur in the Enter handler without network acknowledgment. If the user changed “average” to “maximum,” the candidate cannot promote. If the current snapshot changed, exact promotion needs proof of validity or a fresh execution. These miss paths are first-class benchmark cases.
