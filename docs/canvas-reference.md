# Learning from the existing Data Canvas

Status: source inspection and design ideas, **2026-10-09**. This is not a build plan
or an implementation. The reference is the private
[comino/clickhouse-data-canvas repository](https://github.com/comino/clickhouse-data-canvas)
at commit `55cec81d39380105b8fed69523137977f5b75e9f`.
Links below require access to that repository and identify the inspected code.

An unauthenticated GET of the supplied
[demo](https://taxi-1a20d2bb.2-28-109-132.sslip.io/canvas/) returned HTTP 200 and an
HTML application shell with the title “Data Canvas — Explore” and a login form.
An unauthenticated browser load also reached the sign-in screen. No authenticated
data request or latency measurement was run.
The deployed commit was not verified. Runtime conclusions below are hypotheses
derived from source dependencies, not measurements of the demo.

## Preserve the product idea

The canvas is a spatial **workspace of persistent views**, with conversation beside
it. It is not one HTML `<canvas>`. The shell has a DOM board and SVG connections;
cards host Plotly charts, Leaflet maps, ordinary DOM tables and photo galleries,
and specialized Canvas 2D views. That composition is compatible with Time-Blast:
optimize each view's first meaningful output while preserving the shared workspace.
[Shell, lines 12–24](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/static/index.html#L12-L24),
[renderer dispatch, lines 153–190](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/static/app.js#L153-L190).

Useful interaction patterns to retain:

- A selected view gives follow-up questions a concrete target; “Add alongside”
  distinguishes comparison from replacement. Preserve the old result during edits.
- Marks and geographic regions become explicit query scope, not just chat prose.
- Cards can reuse existing data when only representation or color changes.
- Derived views retain their relationship to the source; SQL/provenance and history
  remain available without occupying the first-render path.
- Saved chats preserve separate workspaces and dataset context.

These are implemented through the intent resolver, scoped planning, local commands,
and card history/provenance UI.
[Intent, lines 15–37](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/domain.py#L15-L37),
[scope, lines 228–240](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/app.py#L228-L240),
[local commands, lines 321–330](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/static/app.js#L321-L330),
[history/provenance, lines 240–246](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/static/app.js#L240-L246).

## What the inspected request path actually does

```text
submit → try local representation command → flush dirty workspace
       → authenticated paint request → generate complete canvas plan
       → validate operations → execute SQL operations serially through MCP
       → enrich gallery metadata if needed → apply and save workspace
       → one result SSE carrying workspace → render cards → reveal views
```

The application streams status messages, but the paint endpoint sends data only
after collecting the requested results and persisting the updated workspace.
The browser then replaces its workspace state from that result. Status streaming
therefore does not mean record-batch streaming in this path.
[Paint endpoint, lines 338–411](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/app.py#L338-L411),
[submission/result handling, lines 255–286](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/static/app.js#L255-L286).

Specific dependencies worth measuring before changing them:

| Source observation | Why it can delay useful output | Time-Blast experiment |
| --- | --- | --- |
| `send()` awaits `flush()` before starting its request timer | Dirty-state persistence may precede both query and measured interval | Separate interaction snapshot from durable workspace save; measure from input |
| `owner()` awaits a separate user-service lookup | Authorization lookup is on each API path | Prepare a scoped session before typing; retain expiry/revocation checks |
| `plan_canvas()` concatenates tool argument deltas and parses at stream end | SQL waits for the complete multi-operation plan | Short validated query representation first; presentation details later |
| Gateway holds a shared lock through the inference stream | Other requests can queue behind one generation | Bound concurrency and reserve a committed-request lane |
| `query()` awaits MCP output, parses full JSON, then validates all rows | No database batch can render through this function | Incremental direct adapter with the same query policy |
| Paint executes operations in a serial loop and emits one saved result | Independent views wait for every requested result | Admit independent queries concurrently within a shared resource budget |
| `render()` awaits all draw jobs and two animation frames before reveal | A slow view can delay visibility of another view | Reveal each meaningful result independently; settle workspace layout later |

Evidence for the table:
[flush and request timer, lines 255–261](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/static/app.js#L255-L261),
[authorization, lines 66–77](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/app.py#L66-L77),
[plan accumulation, lines 241–266](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/app.py#L241-L266),
[gateway admission/release, lines 96–157](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/gateway/app.py#L96-L157),
[materialized query, lines 269–280](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/app.py#L269-L280),
[render barrier, lines 226–238](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/static/app.js#L226-L238).

There is already no post-query LLM round in the canvas paint path: the server
constructs its summary deterministically. A separate LibreChat gateway fast mode
also recognizes completed visual-tool results and skips another inference request.
Do not propose removing a model loop that this canvas has already removed. The
remaining experiment is to shorten planning and replace MCP/full-result JSON on
the latency-critical route when direct integration is appropriate; retain MCP as
an interoperability adapter where useful.
[Deterministic canvas summary, lines 400–411](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/app.py#L400-L411),
[separate fast-mode recognition, lines 37–83](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/gateway/fast_mode.py#L37-L83).

## First meaningful output depends on the view

| View | First meaningful result | What can follow later |
| --- | --- | --- |
| Time-series chart | A bound timestamp/value marker with a usable scale | Connected segments, remaining series, legend, complete extent |
| Map | A valid data marker/cell in a declared geographic frame | Basemap detail, labels, more geometry, imagery |
| Table | A typed, correctly bound row with column meanings | More visible rows, scroll pages, full-result sorting |
| Photo gallery | A decoded visible image tied to a matching observation | Remaining thumbnails, high-resolution image, expanded details |
| Track playback | A measured position at a known time | Adjacent samples, interpolation where permitted, full playback range |

A card outline, loading animation, table header, coast map without query marks,
photo URL, or empty axes are useful feedback but are not the first data result.
Track first meaningful output per view and for the workspace; separately measure
when all requested views are useful. Otherwise one cheap card can hide a stalled
map or gallery. Keep exactness, coverage, snapshot, and speculative binding
independent as defined in the [protocol](protocol.md).

The reference gallery performs a second database lookup after the primary query
to obtain permitted image metadata. The browser eagerly loads its first six
thumbnails and lazily loads the rest; image readiness has separate telemetry.
Preserve authoritative metadata and attribution, but experiment with returning
the first eligible image reference early and progressively enriching the rest.
Reserve thumbnail geometry; do not wait for all image dimensions to lay out cards.
[Metadata lookup, lines 283–314](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/app.py#L283-L314),
[gallery loading, lines 39–66](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/static/media.js#L39-L66).

Both inspected basemap paths await `world.json` before returning control to the
data-marker renderer. A possible improvement is a persistent prepared geographic
frame with markers independent of coastline readiness. Track playback additionally
fetches a separate result after card creation; its server runs extent, vessel-batch,
and storm queries before returning JSON. Treat these as a dependency graph and
send independent layers as they become useful. Satellite tiles are optional in
the source; they should remain outside the query-mark completion gate.
[Wildlife map, lines 5–18](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/static/media.js#L5-L18),
[shared basemap, lines 74–121](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/static/explore-viz.js#L74-L121),
[playback queries, lines 473–527](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/app.py#L473-L527),
[optional imagery, lines 311–328](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/static/explore-viz.js#L311-L328).

## Ideas for the next design pass

1. **Make views materialize progressively.** Create a stable card slot and binding
   before data, deliver its first exact/provisional mark, then refine it. Separate
   query commitment, visible result state, and durable workspace commitment. If a
   multi-card edit must remain atomic, label progressive previews and promote the
   group only when its declared completion policy is satisfied.
2. **Make the view specification an execution input.** Give the planner the visible
   time/geographic window, pixel dimensions, projection, and requested resolution.
   Query a bounded overview appropriate to those pixels, then request details on
   zoom. A low-resolution exact bucket is not the same as an approximate statistic.
3. **Move typed columns directly to renderers.** Avoid repeated row-array JSON,
   per-row objects, whole-workspace serialization, and repeated full-data reshaping.
   Virtualize table rows; use persistent column/geometry buffers for charts/maps.
   Persist query/view manifests separately from large result buffers. The target is
   zero avoidable copies from database output to chart consumption: pass buffer
   ownership, reuse views, and account for every unavoidable engine/transport/GPU
   conversion. Start decoding as bytes arrive and draw as soon as a complete
   timestamp/value tuple plus its schema and mapping are available.
4. **Turn selections into stable data references.** Bind marks to result generation,
   observation IDs or predicates, and snapshot. Stream arrival, sorting, or
   downsampling must not change what “these points” means. Keep source-card lineage.
5. **Keep warm visual components.** Preload likely renderer code, a reusable map
   frame, fonts, and a small image working set. Keep image decode and cold tile
   requests independently observable. Prefer speculative thumbnail fetches over
   full-size images, with a cap and cancellation when the predicted question changes.
6. **Separate movement from first visibility.** Paint the real first mark at its
   final opacity immediately, then animate optional decoration/camera changes.
   Avoid requiring whole-board auto-fit, legend measurement, or another card's
   renderer to finish first. Fix a sensible initial slot and refine layout later.
7. **Share query work between views.** A map, table, and chart may consume one
   validated typed result or compatible aggregate states. Share only when filters,
   snapshot, precision, and semantics match; a thumbnail list is not a universal
   source for an exact histogram. Schedule the currently visible view first.

The first prototype should use **browser + embedded DuckDB**: a warm worker,
validated query representation, incremental Arrow results, and view adapters.
**ClickHouse is the primary production target.** DuckDB is the controlled starting
point for data ownership and copy/paint experiments, not a reason to design a
DuckDB-only result protocol. Keep inference placement independent.
Local operations such as recolor or switching representation should keep the
reference's deterministic fast path without invoking SQL or inference.

The later **Rust service** can implement the same logical adapter contract around
ClickHouse, with sessions, cancellation, admission, and binary streaming. Preserve
incremental columnar buffers through this bridge; do not reconstruct full JSON
results. Keep local work off HTTP when it needs no network. Compare the same query,
result semantics, visible marks, and cold/warm conditions in both placements.
Rust is an implementation candidate, not evidence that this path is faster.

Finally, the reference's `paint` timing begins after workspace flushing and is
recorded before reveal animation completes. It is useful application telemetry,
but not Enter-to-photon measurement. Extend the measurement model to include input,
first bound payload, first view mark, image decode where applicable, and actual
display validation described in [experiments](experiments.md).
[Timing/reveal sequence, lines 255–286](https://github.com/comino/clickhouse-data-canvas/blob/55cec81d39380105b8fed69523137977f5b75e9f/canvas/static/app.js#L255-L286).
