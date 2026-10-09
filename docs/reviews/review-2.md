# Second independent review

Three fresh reviewers examined the current rendering, control/inference, and data
paths. The integration review also checked runtime initialization. The review
started at `b478037bc5516fed9cc4c726e610f0c54cfcf6e1` on 2026-10-09.

## Reproduced findings

| Area | Failure | Correction |
| --- | --- | --- |
| Runtime initialization | A draft entered during IME composition was replayed as finalized after database warmup or coordinator replacement. This could start unwanted speculative work. | Retain and replay the composition flag with the draft text. |
| Drawing cancellation | Database completion hid Cancel while primary chart geometry and statistics were still pending. | Let the UI keep Cancel available until drawing settles; remove the runtime's unconditional busy-state override. |
| Track scheduling | Resizing a canceled, unsorted track while the primary chart was hidden could schedule animation frames indefinitely. | Resume track rendering from indexing notifications instead of polling for a sorter that may have stopped. |
| Remote coordination | A delayed ACCEPT for an older committed request discarded preparation authorized for a newer draft. | Retain the newer draft and its authorization, start the committed request first, then admit the still-current preparation. |
| Model recovery | A model unloaded after device loss could remain marked ready, making subsequent preparation falsely succeed. | Invalidate readiness for fatal engine-loss errors and allow preparation to retry. |
| Arrow batches | Record-batch row counts were checked, but inconsistent field lengths and buffer metadata could reach the decoder. | Validate the bounded numeric layout before decoding record-batch fields. |
| Arrow byte order | The pinned Arrow decoder ignored a big-endian schema and silently interpreted its numeric values in the wrong byte order. | Explicitly require little-endian streams before schema decoding. |

All seven are P2 correctness or performance issues. Detailed reproductions and
regressions are recorded in [rendering](review-2-rendering.md),
[control and inference](review-2-control.md), and [data](review-2-data.md).
`tests/lifecycle.test.ts` reproduces the two IME initialization cases; both failed
before the fix and pass afterward.

## Integrated verification

- **198 tests passed** across 10 files; TypeScript and the production Vite build passed.
- Chromium **145.0.7632.0** passed the browser UI and live-translation checks:
  real queries, chart/table/CSV/trace, responsive settings, IME, cancellation,
  stale events and independent SQL/result preparation controls.
- The controlled settlement check confirmed a visible, clickable Cancel button
  during drawing, immediate first-marker submission and unchanged database timing.
- The six-series **60,480-point** rendering fixture drew exactly **10,079 segments
  per series on each chart**, with six endpoint markers, correct statistics and no
  pending frames. A 4,000-point ordered stream still drew only 3,999 primary line
  segments across 40 batches; hidden primary charts drew none.
- Valid 64-byte-padded Arrow buffers decoded through the remote adapter while
  retaining the incoming backing buffer. Inconsistent batch layouts and unsupported
  byte order were rejected.
- The deployed HTTPS build passed its public smoke check with **1,209,600 source
  rows** and **60,480 chart points**, SQL-only preparation and promotion, no database
  reload on inference changes, native HTTP engine decoding and no page errors.

```sh
pnpm test
pnpm build
python3 tests/browser_ui.py --base-url http://127.0.0.1:5173
python3 tests/ui_live_translation.py --base-url http://127.0.0.1:5173
python3 tests/ui_completion.py --base-url http://127.0.0.1:5173
python3 tests/ui_rendering.py --base-url http://127.0.0.1:5173
python3 tests/browser_production.py --url https://time-blast.46-224-133-201.sslip.io
```

## Scope of evidence

These fixes preserve the immediate first marker, column-buffer ownership,
database completion timestamps, and separate foreground/speculative jobs. No new
latency distribution or physical display measurement was taken in this review.
Browser functional tests use templates; engine-loss recovery uses a controlled
model double. Successful hardware-WebGPU inference and deployed remote services
remain unverified here.

The synthetic source is smooth by construction. More samples therefore create
denser line geometry without necessarily creating more visible wiggles. Endpoint
markers are not a sample counter.
