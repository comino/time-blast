# Second rendering and settlement review

Reviewed `b478037` and the cooperative renderer, ordering index, settlement UI, and existing regressions. This pass looked for new failures after the earlier indexing, repeated-history drawing, hidden-chart, and premature-completion fixes. It used UI-only fixtures; no model or database initialization was needed.

## Findings and fixes

1. **P2: database completion removed the only stop control while rendering was pending.** In `src/ui/index.ts`, the `complete` handler called `setBusy(false)` before evaluating chart settlement. A 60,480-point fixture therefore showed `DRAWING`, an unset mean, and a hidden Stop query button immediately after database completion. The previous cancellation regression called the DOM element's `.click()` method, which also activates a hidden button and missed the real interaction failure. The main runtime also cleared busy on the same event. Busy state now follows the existing primary-chart settlement decision, with the existing request-identity, cancellation, error, and pending-start guards. A redraw restores the control; final settlement removes it. The browser regression now exits its JavaScript harness and uses Playwright to click the visible button.

2. **P2: a canceled reference sort could leave the track scheduling frames forever after resize.** `TrackChart.render` returned `true` whenever `order.needsSort`, even when cancellation had removed the primary chart's sorter. To reproduce, append 4,096 descending timestamps with coordinates, advance through the first indexing slice, cancel both charts, hide the primary chart on the Data tab, and resize the track. The hidden primary has zero width and does not restart sorting from its resize observer; the track then waits indefinitely. The controlled browser fixture still had one scheduled callback after 100 frames before the fix and zero afterward. The track now stops its work loop while references need sorting. The existing `indexed` notification wakes it when sorted references become available. Regressions check both ordinary reordered drawing and restoring a canceled partial result after resize.

Neither fix changes the immediate first-marker path, producer buffers, index ordering, or database `completedAt` timestamps.

## Verification

Chromium **145.0.7632.0**, headless, viewport 1440 × 1000. Frame-controlled checks are functional scheduling and geometry evidence, not wall-clock latency measurements or presentation benchmarks.

```sh
pnpm exec vitest run tests/ui-rendering.test.ts tests/ui-order.test.ts tests/ui-bars.test.ts
python3 tests/ui_completion.py --base-url http://127.0.0.1:5173
python3 tests/ui_rendering.py --base-url http://127.0.0.1:5173
```

- All **19** focused unit tests passed. New cases cover canceled sorting plus track-only resize, notification-driven resumption, and ordinary reordered tracks.
- The 60,480-point settlement browser regression passed: immediate first marker; intermediate `DRAWING`; final statistics and full horizontal coverage; unchanged database completion timestamp; stale-result, error, pending-start, cancellation, and hide/show behavior. A real Playwright click stopped drawing before its pending statistics were indexed.
- The existing 100,000-point first-frame fixture still indexed **zero rows** at batch-handler return, at the first rendering opportunity, and after cancellation at that opportunity.
- The stable-domain 4,000-point fixture still submitted **3,999** time-series line commands whether delivered in one batch or 40 batches. The track submitted **4,015** in either case, including its grid. The hidden primary submitted **zero** line commands. Overlay alignment and exact raw input commitment also passed.
- An independent fixture with **60,480 points across six interleaved series** produced exactly **10,079 line segments per series** on each chart, six final endpoint markers, six legend entries, mean **12.5**, final `COMPLETE`, and no pending callbacks. This check is retained in `tests/ui_rendering.py` using native animation frames. It checks multi-series coverage in addition to the single-series settlement fixture.

No additional concrete regression was found in stable ordering, final multi-series geometry, endpoint replacement, statistics, visibility restoration, or first-marker deferral. The first-draw metric still measures draw submission; useful coverage and final settlement remain separate. Changing domains and reordered streams still require cooperative redraw/sorting, and the shared four-millisecond target is not a hard frame-time guarantee. Those are existing documented limits, not newly discovered failures.
