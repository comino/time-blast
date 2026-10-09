# Rendering review and implementation

Reviewed 2026-10-09. Baseline: repository commit `dc792b5` (HEAD before this review). Scope: `src/ui/**`, browser input/first-marker presentation, retained columns, ordering, drawing, visibility and cancellation. No model download or database benchmark was used for this review.

## Confirmed findings

1. **P1: marker submission did not release the main thread for presentation.** Baseline `StreamChart.append` submitted a marker, indexed every row, and scanned every value for bounds synchronously. The batch UI handler scanned every row again for statistics. Full chart and track drawing then ran in the next animation frame, before that frame could paint. Prepared batch draining in the coordinator compounded this issue; the coordinator's separate review addresses that drain.
2. **P2: ordered streaming repainted all retained points.** Both charts walked every prior reference on each rendered batch; the track also rescanned every coordinate for bounds and reset its canvas dimensions every time. For batches arriving in separate frames, total drawing grew quadratically with batch count, even when the domains never changed.
3. **P2: hidden chart work continued.** The Data tab hid the time-series canvas, but did not stop scheduling or executing its full drawing loop.

The existing commit-to-draw label accurately described draw submission, not physical presentation. The problem was substantial subsequent work still preventing presentation of that submitted marker.

## Changes

- `StreamChart.append` retains the producer batch by reference and submits its first valid leading point. It does no row indexing or statistics scan on that handler's path. Invalid leading test data is handled by the subsequent bounded scan; production batches have already passed adapter validation.
- `FrameWork` leaves the next animation frame free of bulk work. Subsequent chart, track, and statistics work shares a four-millisecond target budget per frame. Indexing and painting have an additional 2,048-row/reference slice bound. This is cooperative scheduling, not a hard execution-time guarantee: browser calls and one indivisible slice can exceed a target deadline.
- Statistics and coordinate bounds are collected while processing those slices. Track bounds are updated from these summaries, so old coordinates are not rescanned.
- Ordered points append to retained canvas paths while domains remain unchanged. Domain changes, reordered results, visibility restoration and actual size/DPR changes invalidate the drawing and trigger a sliced redraw. Canvas size assignments now happen only for actual size/DPR changes.
- Small transparent marker canvases keep the latest endpoint dots separate from retained line/bar geometry. This prevents obsolete endpoint dots accumulating as paths extend. Marker overlays were checked to match their base canvas bounds exactly.
- Reordered references use a cooperative stable merge. Numeric producer columns are unchanged. Temporary numeric-reference arrays are used only for reordered streams; references remain intact until a sorted series is published. New batches wait for an active sort to finish indexing, and cancellation can discard a sort without damaging published references.
- Query replacement, stop and destruction cancel scheduled work. Hidden time-series canvases retain data and process summaries needed by the track, but submit no geometry; showing the chart schedules its redraw.
- UI submission preserves exact raw input text, including outer whitespace; trimming is used only to reject empty questions. This preserves speculative identity with the draft snapshot.

## Controlled evidence

Browser: Chromium **145.0.7632.0**, headless, viewport 1440 × 1000, device scale factor 1. UI-only harness; no database or inference initialization. A baseline run served TypeScript-transpiled UI modules read from repository HEAD, using the same fixture and harness. HMR was disabled in the isolated harness to avoid unrelated concurrent source edits navigating the page.

These are individual software observations, not latency distributions, cross-machine speed claims, or input-to-photon measurements. The before and after runs were separated; other review work was held during this check.

The first-marker fixture contained 100,000 valid points with coordinates (3.6 MiB of logical numeric columns). Time starts immediately before the UI start event, rather than at a physical key event.

| Observation | Before | After |
| --- | ---: | ---: |
| First marker callback | 4.7 ms | 3.9 ms |
| Batch handler returned | 23.2 ms | 4.1 ms |
| Work after marker callback before handler return | 18.5 ms | 0.2 ms |
| First animation-frame tail | 157.2 ms | 37.5 ms |
| Rows indexed before first frame tail | 100,000 | 0 |
| Rows indexed after cancellation at that first frame | 100,000 | 0 |

The meaningful scheduling assertion is deterministic: **zero rows were indexed before the first rendering opportunity**. The frame-tail timings also include browser scheduling, layout and other work; they do not establish when pixels reached a display.

The command-count fixture contained 4,000 points within unchanged chart domains. Track coordinates repeat over an established range, so the comparison does not require track rescaling. Streams deliver 40 batches of 100 points, allowing scheduled UI work to settle between arrivals. Counts include grid `lineTo` calls.

| Canvas / delivery | Before `lineTo` calls | After `lineTo` calls |
| --- | ---: | ---: |
| Time series, one batch | 4,009 | 3,999 |
| Time series, 40 batches | 82,165 | 3,999 |
| Track, one batch | 4,015 | 4,015 |
| Track, 40 batches | 82,600 | 4,015 |
| Hidden time series, one batch | 4,004 | 0 |

This removes the repeated-history drawing cost for ordered, stable-domain streams. A changing domain still requires redrawing old geometry; that work is now sliced. Pathological reordered inputs likewise require sorting and redraw, rather than becoming a constant-time append.

## Verification

Reproduce the implemented-state browser assertions against a running Vite server:

```sh
python3 tests/ui_rendering.py --base-url http://127.0.0.1:5173
pnpm exec vitest run tests/ui-rendering.test.ts tests/ui-order.test.ts tests/ui-bars.test.ts
```

The browser harness asserts the free first frame, cancellation, equal single/streamed command counts, zero hidden-chart drawing, correct aggregate mean, exact outer-whitespace commitment and overlay alignment. A screenshot was also inspected.

Unit regressions cover retained batch identity, bounded indexing, incremental chart and track drawing, hide/show, query replacement, bars and domain changes, batches arriving during a yielded sort, and abandoning/restarting sorting without reference corruption. The parent review runs repository-wide tests/build and production smoke separately.

## Remaining limits

- The first grid, small DOM changes and bounded trace/history updates still execute around request start. This review avoids the duplicate first-marker grid draw when its domain is unchanged, but does not claim those remaining operations are free.
- A frame budget is shared across these drawing components; it does not reserve time from unrelated scripts, style/layout or browser rendering.
- Full result drawing and statistics complete asynchronously after database completion. The first valid point remains prioritized.
- Drawing metadata and marker backing surfaces consume memory in addition to retained column buffers. This implementation preserves column-buffer identity; it does not claim zero browser/GPU copies or that the column byte budget measures all browser memory.
