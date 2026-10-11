# Batch 2 · chart as query, steady charts

Status: implemented and measured on branch (2026-10-11). Owner: direct-manipulation agent.
Workstream 5 of [plan-batch-2.md](../plan-batch-2.md), part "chart-as-query", plus result-level
stability while typing.

## Result

Full app in headless Chromium 145, SwiftShader (software GPU), fake inference, shared 4-core ARM
host at load 7–13. Draw *submission*, not photons. [e2e-manipulate-2026-10-11.json](e2e-manipulate-2026-10-11.json),
[e2e-steady-2026-10-11.json](e2e-steady-2026-10-11.json), `python3 tests/e2e_manipulate.py --software`.

| Gesture (no model call) | n | pointer → first draw p50 / p95 ms |
|---|---:|---:|
| **Brush** 2 % of a 14-day hourly × 6-vessel line → 5-minute buckets | 12 | **38.1 / 45.7** |
| **Legend click** → one vessel | 12 | **27.7 / 42.2** |
| **Back** (Esc) → previous SQL (result-cache replay) | 24 | **2.3 / 5.5** |
| engine hit-test + SQL rewrite, inside the above | 24 | 5.0 / 10.5 |

Where a brush's ~38 ms goes (p50): UI → engine 0.4, hit-test + rewrite 6.4, DuckDB first batch
27.0 (of which the database node's own rollup rewrite of the new statement is ~4–10 ms, Node
measurement), first draw 1.1. The database is the cost again; a gesture adds ~6 ms.

| Steady charts, typing with a model that re-words the same SQL each keystroke | results drawn | adopted, no redraw | redrawn | last keystroke → first draw p50 / p95 ms |
|---|---:|---:|---:|---:|
| on (default) | 293 | **277 (95 %)** | 16 | 6.3 / 24.6 |
| off (`VITE_TB_STEADY=0`) | 300 | 0 | 300 | 6.8 / 9.2 |

12 questions each. With steady charts a typed question costs ~1.3 GPU redraws instead of ~25: the
16 are genuine changes (early prefixes the fake answers with another chart). Latency is unchanged within noise (n = 9
final keystrokes, loaded host); the win is that the image never changes when the answer does not,
and the renderer does no ingest or GPU work for those results.

## A. Chart as query

```
pointer (UI)                 engine worker                                             coordinator
drag / click / legend ──► manipulate{slot, request, sql, gesture, keyAt}
                             renderer.hit(slot, request, gesture)   Rust, last frame's scales
                             manipulate.ts: restriction → rewrite (DuckDB parser) | wrap
                             QUERY{u32 slot + SQL} on the UI link ─────────────────►  BIND (4-byte) + EXEC
                          ◄─ manipulated{sql, method, reason, ms} (history, card note)
```

- **Gestures** (`src/ui/slot-card.ts`): drag on the plot = brush the x range; click = the point
  under the pointer (line/scatter/map: nearest point within 20 px; bar: the bar's category or time
  bucket; heatmap: the row's series); legend click = that series; double-click, Esc (card focused)
  or the card's Back button = previous SQL. A double-click's first click may drill; the back undoes
  it too. Board zoom is divided out of pointer coordinates.
- **Hit-testing** (`crates/tb-render/src/hit.rs`): CSS px → exact data using the axis model and
  plot rectangle of the slot's last drawn frame (kept per slot, refreshed when the axes change).
  Values are the rows on screen, never interpolated pixels: a brush returns min/max x of the rows
  inside the span (time in µs), a text axis the categories inside it. Maps use the geo family's
  own fit (`Family::nearest`). The renderer answers only for the request on screen and only once
  its result is complete; otherwise the gesture does nothing (correctness first).
- **SQL** (`src/engine/manipulate.ts`), restriction = "output column c in range / = value / in set
  / IS NULL":
  - **Rewrite** with DuckDB's own parser/printer when the statement is one plain SELECT over one
    table (no CTE, subquery, window, LIMIT, QUALIFY, grouping sets, `*`) and column c is a
    deterministic non-aggregate expression E over table columns: AND the restriction into WHERE.
    Each output row's key E is fixed, so this is exactly the original result filtered. For time
    buckets (`date_trunc`, `time_bucket`, `CAST(ts AS DATE)`) the filter is on the raw column,
    `ts >= first AND ts < last + width`, with first/last the bucket starts on screen: the same
    rows, and zone maps and the rollup rewrite still apply (brushed queries ran on `minute+edges`).
  - **Bucket refinement**, only on that path and only when E names the groups (top-level select
    item / GROUP BY / ORDER BY, no HAVING): if the selected window holds < 48 buckets, E becomes the
    coarsest of 1 day, 6 h, 1 h, 15 min, 5 min, 1 min that gives ≥ 48 (else 1 min). A click on a
    time bar = a one-bucket brush: an hour opens in minutes.
  - **Wrap** otherwise (and for ClickHouse): `SELECT * FROM (\n<sql>\n) AS tb_drill WHERE …` —
    always exactly the filtered result, never refines. Leading `-- view:` comments stay in front;
    trailing comments and semicolons are dropped.
  - Cost: a memo in front of the parser (`CachedTools`) keeps parsed trees by text, including the
    tree of every statement it printed, and value literals are patched into cached templates. A
    gesture on a chart a gesture produced costs one DuckDB print (~5 ms browser); the first
    gesture on a typed question adds one parse. The parser runs on its own DuckDB connection, so a
    streaming query or a rollup build is never disturbed.
- **Placement: same card.** The drilled result replaces the card's chart and the card keeps a
  history (up to 64 steps per question). Exploration is a sequence of narrowings of one question;
  a new card per brush would bury it. Enter on the live card keeps what is shown (the QUERY
  request inherits the live question's text and revision); a kept card's manipulation is a
  committed request in that slot. Typing replaces a live manipulation like any older answer.
- **Timing.** `KEY_INPUT` is reused as the user-intent stamp: the pointer-up (brush), click,
  dblclick or keydown event's `timeStamp`. `DRAFT_SENT` = the UI's post, `SQL_COMPLETE` (node 2) =
  end of hit-test + rewrite in the engine worker, then the usual `COORD_RECEIVED`, `EXEC_SENT`, DB
  and render stamps. The card's "KEY → FIRST DRAW" shows pointer → first draw.

### Correctness evidence

- `tests/engine-manipulate.test.ts` (DuckDB-Wasm, `vessels`, rollups and cache on): every corpus
  reference statement (101 with ≥ 2 rows) × every restriction a gesture can produce on its result
  (x range, single bucket, text value, text set, NULL): **246 restrictions, rewrite and wrap both
  equal the original result filtered in JS** (names, types, rows, order); 231 rewritten, 15 wrapped
  (11 LIMIT, 4 aggregate column). 50 chained gestures (range, then value) on rewritten SQL, 46 of
  them rewritten again from the memo, equal the doubly filtered original. Refinement checked
  against hand-written SQL (3 shapes); must-wrap shapes (LIMIT, window, CTE, subquery, aggregate,
  select-alias reference) run.
- Rust: scale inversion, category rounding, point/range/legend/bar hits (`hit.rs`, `renderer.rs`).
- Coordinator: QUERY on the live slot (fencing of the old request, TIMING stages, Enter keeps),
  replacement by the next keystroke, kept slots, rejected free slot / stale context / bad payloads.
- `tests/e2e_manipulate.py`: brush → finer bucket with raw bounds (ink on canvas, TIMING from the
  pointer with no INFER), legend click → one series, Esc and double-click back, bar click → vessel.

## B. Steady charts

The renderer holds a new result for a slot while it equals the result on screen: same column
count, types and roles, and the same canonical values row by row (bit-equal floats, so NULLs match;
text by first-seen ids plus the label table). A held result is not ingested into its view family
and not drawn. As soon as it has as many rows as the shown result and all matched, it is
**adopted**: the shown result takes its identity (request, column names) and keeps its geometry
and GPU buffers; no frame is built. Column names only reach DOM text: a renamed value column
(an alias variant) refreshes the legend via AXES, without a frame. Any difference — a value, more
or fewer rows at DONE, a different view — ends the hold, and the result ingests and draws as usual.
Comparison is exact and positional; a reordered but equal result is redrawn.

**DRAWN/TIMING for an adopted result:** one DRAWN with `FIRST_DRAW_SUBMITTED` = `FIRST_PRESENTED`
= the instant the equality was proven (the batch that completed it). The image for this request is
on screen from that instant; nothing was submitted, so there is no later presentation. A real draw
always has `FIRST_PRESENTED` strictly later (it waits for the GPU), which is how measurements tell
the two apart. The coordinator's byte-identical SQL dedup still comes first (no EXEC at all).

## Protocol and contract changes

- New frame kind **`0x13 QUERY`** (UI → coordinator): header revision/context/epoch, payload
  `u32 slot` + UTF-8 SQL. Both codecs, golden vector `query`, coordinator, protocol-v1.
- Renderer DRAWN semantics for adopted results (above); no new kind or flag.
- `src/engine/contracts.ts`: `RendererNode.hit()`, `PointerGesture`/`Gesture`/`Hit*` types,
  `UiToEngine` `manipulate`, `EngineToUi` `manipulated`.
- Outside the listed ownership, minimal: `DuckDatabaseNode.sqlTools()` (parser on its own
  connection) and its pass-through in `PlacedDatabase`.

## Known gaps

- Brush is x-only; no y-range or 2-D (scatter) selection, no brush on maps.
- Clicking a bar of a grouped (per-series) bar chart selects the x category, not the series bar.
- Refinement stops at 1 minute; brushing inside a minute only filters.
- The database node re-parses each new manipulated statement for its rollup rewrite (~4–10 ms):
  the AST we already hold cannot be handed over without a protocol change.
- Steady comparison is positional: results whose row order varies between plans redraw.
- No hardware-GPU or photon measurement; e2e numbers are from a loaded shared host.
