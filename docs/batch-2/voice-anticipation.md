# Batch 2 · voice and next-question anticipation

Status: prototype implemented and measured, 2026-10-11 (workstream 5). Not deployed. Direction:
[vision.md](../vision.md). Protocol additions: `PRIME`, `EXEC`/`DONE` flag `WARM`
([protocol-v1.md](../protocol-v1.md), "Suggestions").

## Result

| What | Result |
|---|---|
| **Click on a suggestion → first draw** (prepared: primed + warmed) | **9.8 ms p50, 14.5 ms p95** (n = 12); 0 inference calls; DB first batch 0.30 / 0.55 ms (result-cache replay, 12/12 hits) |
| Same, primed only (no warm-up) | 22.6 / 52.7 ms; DB first batch 16.8 / 55.6 ms (rollup or raw) |
| Same, neither (click = ordinary COMMIT) | 49.7 / 81.8 ms **with a zero-latency fake model**; a real model adds its own time (default gpt-oss-120b: SQL 364–463 ms p50, [inference.md](inference.md)) |
| Suggestion validity | 2177 / 2177 deterministic variants of 836 executable corpus + saved model statements execute and keep their label's invariant; 771 / 836 statements get ≥ 1 suggestion, 2.6 on average |
| Extra cost per shown result | **$0** (deterministic). Generation 0.7 ms p50 in the page (p95 7.8 ms, JIT); warm-ups 57.6 ms p50 / 169 ms p95 of background database time, at most 4 per settled or kept result |
| Typing while suggestions prepare (last key → first draw) | off 31.9 / 52.1 ms, on (settled) 24.5 / 57.8 ms: within noise. Preparing *every* keystroke's result: 32.4 / **104.5** ms p95, hence the settle rule |
| Voice | Speech events → DRAFT/COMMIT through the same encoder; stubbed recognizer in Chromium: 4 interim DRAFTs + 1 COMMIT, kept card, the chart for the last interim words drew 189 ms after that speech event, and the final result was already on screen when the final event came |
| Model follow-ups (experiment, not wired) | gpt-oss-120b on Groq: 970 ms p50 / 1719 ms p95 per complete reply, **$0.00032 per call**, 55 / 60 SQL execute, only 6 / 60 match a deterministic variant |

All browser numbers: headless Chromium 145, SwiftShader software GPU, Vite dev server, fake tb1
inference in echo mode (every question gets distinct SQL, so nothing is reused by accident),
`vessels` fixture (1.2 M rows), this shared ARM host under load. **Draw submission, not photons.**
Raw: [e2e-suggest-voice-2026-10-11.json](e2e-suggest-voice-2026-10-11.json),
[suggest-sweep-2026-10-11.json](suggest-sweep-2026-10-11.json),
[followups-model-2026-10-11.json](followups-model-2026-10-11.json).

## Anticipation: how it works

1. A live result draws (TIMING with `FIRST_DRAW_SUBMITTED`) and the editor stays quiet for 250 ms,
   or the result is kept (KEEP, immediately).
2. `src/ui/suggest.ts` derives ≤ 4 follow-ups from the SQL on screen, each **one exact edit**, so
   the chip label says precisely what the SQL does:
   - **split** by a text column with 2–12 known values (from the DatasetContext);
   - **bucket**: minute ↔ hour ↔ day on `time_bucket`/`date_trunc`, only for grouped series;
   - **window**: last 24 hours (7 days for long data), counted back from the data's latest
     timestamp, the prompt's own convention for "now"; never stacked on an existing time filter;
   - **agg**: swap the single aggregate (avg → max, max/min/sum/median → avg), with its alias;
   - **view**: the same SQL with a `-- view:` hint the follow-up question asks for (heatmap for
     time × series, else table). Same cache key, so it is always an instant replay.

   A small tokenizer (strings, quoted identifiers, comments, parentheses) finds the top-level
   clauses of one plain SELECT. WITH, set operations, subqueries in the result clauses, window
   functions, an alias that shadows a grouped column (`… AS ts … GROUP BY ts`), FROM with
   SAMPLE/joins: fewer or no variants, never a guess. Nothing is vessel-specific.
3. Per suggestion the UI sends **`PRIME {question, sql}`** and **`EXEC` flag `WARM`**. The engine
   host keeps primed pairs at its end of the inference link; the database runs warm-ups newest
   first, only when no real EXEC waits, preempted by real work, into its result cache. Chips show
   at once ("warming") and turn ready on DONE; a variant that fails or returns no rows is withdrawn.
4. A click puts the question (`"<question>, <change>"`) into the input and sends a normal
   **COMMIT**. The coordinator translates (the primed answer comes back from the host in µs: SQL
   flag CACHED, INFER_STATS `model: "primed"`, cost 0), binds, keeps, EXECs; the database replays
   the cached result. Identities, fencing and the TIMING ledger are those of any committed question.
   Typing the same question (case and spacing aside) hits the same primed answer.

### Design choices and why

- **Deterministic, not model, by default.** Free, ~1 ms, and correct by construction (2177/2177
  valid). The model experiment proposes richer questions ("which vessel had the highest…",
  "temperature vs speed") but costs ~1 s and $0.00032 per result, 8 % of its SQL fails, and its
  meaning is unverified (it invented a vessel name). It overlaps little with the variants (6/60), so
  the two are complements. **Next:** one model call per *kept* result (well inside the budget:
  1000 kept results/day ≈ $0.32), shown below the deterministic chips once warmed. That needs a
  follow-up mode in the inference server (Rust + TS prompt builders, golden fixtures); the server
  would prime its own cache, and with a remote database could warm it directly.
- **PRIME + COMMIT, not QUERY.** Chart-as-query's `QUERY` executes SQL into an existing slot and
  keeps that request's text. A suggestion is a new question: it needs its own text (card title,
  translation-cache entry, typed matches) and its own kept card. The primed answer never leaves
  the engine worker, so it costs the same as QUERY would.
- **Warm into the result cache, not into a hidden slot.** No renderer work, no slot or canvas per
  suggestion, the coordinator untouched; the cache already exists and is exact.
- **Settle rule (a debounce with a measured reason).** Preparing every keystroke's result raised
  typing p95 from ~55 to 104.5 ms (warm-ups compete for the single DuckDB thread). Waiting 250 ms
  without a newer draft, or a KEEP, removed that cost. Chips are for the *next* question, so the
  delay is off the current question's critical path.
- **Sender request ids with bit 31.** Lets a UI number its WARM EXECs without a coordinator round
  trip; the host routes every frame of such a request back to the UI only.

## Voice: how it works

- `src/ui/voice.ts`: Web Speech API, `continuous` + `interimResults`. Each changed transcript is a
  DRAFT through the normal encoder with **KEY_INPUT = the recognizer event's `timeStamp`** (a speech
  event, delivered after the recognizer's own latency, not a keystroke); a final result is a
  COMMIT. Within one listening session phrases accumulate ("max wind" … "by vessel"); a new session
  starts empty. A transcript that never became final is committed on `end`.
- `src/ui/voice-button.ts`: mic button left of the composer footer. Hold to talk (or hold
  **Ctrl+Space** / Ctrl+M); a short tap toggles hands-free. Escape drops the session.
- **Availability:** Chrome/Edge stream audio to the vendor's speech service, so it needs the
  network (error `network` → "Speech service unreachable"). Firefox has no API. Chromium 145
  exposes the unprefixed `SpeechRecognition` even headless, but nothing starts there: after 5 s
  without a `start` event the button reports an error. Microphone permission errors are shown.
- The chip and voice paths reuse the typed path exactly: per-keystroke translation, dedup, KEEP.

### Server-side streaming STT (not built)

Worth it only if it beats the browser's recognizer: Chrome's interim results arrive in ~100–300 ms
chunks and finals ~0.5–1 s after speech ends (vendor-side; not measured here, no microphone on this
host). A `speech` node would take Opus/PCM frames over the same tb1 WebSocket (new kinds `AUDIO`
UI → speech, `TRANSCRIPT` speech → coordinator as DRAFT/COMMIT with KEY_INPUT = the audio
timestamp of the last word), so a remote coordinator gets transcripts without a browser hop.
Budget: ≤ 150 ms from end of word to interim text to keep pace with typing. Candidates: Deepgram
Nova streaming, AssemblyAI Universal-Streaming, OpenAI realtime transcription, Groq Whisper
(batch, too slow per word), self-hosted Whisper streaming / Moonshine on the inference box.

## How to reproduce

```sh
pnpm test                                     # tests/ui-suggest, ui-voice, engine-host, engine-database
node scripts/suggest-sweep.mjs --json out.json                # validity of every variant, DuckDB
OPENROUTER_API_KEY=… node scripts/followups-model.mjs --n 15  # model experiment (~$0.005)
pnpm exec vite --port 5199 --strictPort --host 127.0.0.1      # restart it after edits: its file watcher missed changes here
python3 tests/e2e_suggest_voice.py --url http://127.0.0.1:5199 --software --samples 12 --json out.json
```

Measurement switches: `localStorage['time-blast.suggest'] = '{"enabled":…, "prime":…, "warm":…, "settleMs":…}'`.

## Spend

Model experiment: $0.0049 + $0.0048 (one rerun after a timing bug) + $0.0010 trial = **$0.011**.
Cap was $0.50.

## Known gaps

- Remote database (ClickHouse node): WARM is refused (`unsupported`); chips still prime, so clicks
  skip inference but run cold. `crates/database-server` needs a result cache first.
- The Rust inference server ignores `PRIME`; only the browser engine host answers primed questions.
- Stale warm-ups are not cancelled, only bounded (8 waiting, oldest refused with `queue_full`).
- No real microphone or vendor speech service was measured; voice latency above is the pipeline
  after a (stubbed) speech event.
- Chip wording appends the change to the question (`"…, per day instead"`); chains of clicks get
  long. Model follow-ups would phrase whole questions.
- Software GPU, loaded shared host, n = 12 per mode: treat ±10 ms p50 as noise.
