# Vision

This is the canonical statement of what time-blast is for. When another document,
a code comment or an old design note disagrees with this page, this page wins.

## In one sentence

**time-blast is research into one loop — natural language → SQL → execute → see
it — and into making that loop so fast that the answer is there the moment you
stop thinking about what you want.**

## The two research questions

1. **What does it take to make the loop as fast as physically possible?** Every
   stage counts: typing, transport, inference, SQL generation, execution, data
   movement, drawing, presentation.
2. **What new kinds of data interaction become possible once it is that fast?**
   Results that update on every keystroke. Anticipating the next question before
   it is asked. Brushing or clicking a chart as a query. Speaking instead of
   typing. Whatever else we discover.

Both questions matter equally. A faster pipeline that enables no new interaction
is half the point. A clever interaction on a slow pipeline is the other half
missing.

## The metric: thought → result

The thing we minimize is **the gap between knowing what you want and seeing the
correct result.** Typing, pressing Enter, waiting on inference: these are all
just steps in between, and every one of them is a candidate for removal.

- "Enter → first point" is a useful sub-measurement, not the goal. A design that
  makes Enter unnecessary beats one that makes Enter fast.
- Optimistic prefetching and speculation are welcome **if the result shown is
  correct for what the user means.** A wrong chart shown early is not a success.
- Idle-time debounces, confirmation steps and "wait until the user is done" logic
  work *against* the metric. Each one needs a measured reason to exist.

## Design for the future, not the present

**Assume inference will be ~10× faster soon.** Design the system for that world
today:

- Don't shape the architecture around today's ~500 ms model latency. When
  inference takes ~50 ms, database, transport and drawing become the bottleneck,
  and microseconds there decide the experience.
- Make future speeds tangible now: use the fastest available providers, cache
  and replay translations, and offer a latency dial that simulates faster
  inference so new interactions can be tried before the hardware exists.

## Excellence for its own sake

This is a deliberate pursuit of the fastest possible system. We squeeze out
microseconds not because a user needs them but because pursuing excellence needs
no justification. Micro-optimizations — zero-copy paths, binary framing, frame
deadlines, allocation discipline — are explicitly in scope.

The discipline that keeps this honest:

- **Measure everything.** A speedup is a measurement, not a belief. Record cold
  vs warm, tails (p95/p99), not just medians, and the resources speculation burns.
- **Every change needs a concrete reason.** Rewrites are fine; changes made out of
  taste or habit are not. "It removes X µs from stage Y, measured" is a reason.
  "It might be cleaner" is not.

## Architecture principles

### 1. NL → SQL directly

The model translates natural language straight into SQL, and the SQL is executed.
The surrounding implementation exists only to serve that loop. Safety comes from
the execution environment (read-only connections, resource and time limits,
cancellation), not from shrinking what the model may say.

The current seven-field `QueryPlan` (metric/aggregate/bucket/window/vessel/view)
is a **legacy artifact** of the first demo. It limits what can be asked and is
not the direction. Don't extend it; replace it.

### 2. Generic data

time-blast is a generic data-exploration engine. Any table, any schema: Parquet,
CSV, DuckDB, ClickHouse. The synthetic vessel dataset is a test fixture, not the
product. Nothing on the hot path may assume vessel-specific columns.

### 3. One uniform protocol, any placement

Every component — **coordinator, inference, database** (and future ones like
speech or prediction) — can run **in the browser or remotely** without rewriting
anything. This is a hard requirement.

- **One message vocabulary** and **one binary frame format** for every component
  and every placement. Identities (session, revision, request, epoch) live in the
  shared header, so cancellation and stale-result rejection work identically
  everywhere.
- **Only the transport changes with placement:** MessagePort/worker in the
  browser, binary WebSocket remotely, WebTransport later.
- **Local means zero-copy:** in the browser, buffers move by ownership transfer,
  never by serializing for a network that isn't there.
- **Remote components talk directly.** If inference and the database both run on
  a server, SQL goes straight between them; only results come to the browser.
- **Results are Arrow IPC bytes,** identical locally and on the wire, streamed
  batch by batch into drawing with no per-row objects and no whole-result waits.
- **Timing is built into the frames,** so every placement combination gets the
  same per-stage measurements.
- **One definition, two implementations.** TypeScript and Rust share one spec
  for the frame codec and are tested against each other.

Inference placement to explore: in-browser WebGPU (research interest), hosted
APIs such as OpenRouter, and self-hosted server models (likely most practical).
The database: DuckDB-Wasm in the browser today; DuckDB and ClickHouse servers
remotely.

### 4. Speculate cheaply

Speculative inference on every keystroke is in scope, within a budget of
**a few dollars per day.** Use small, fast models, prompt-prefix caching,
aggressive cancellation and change detection to stay inside it. Report the cost
alongside latency.

## What to unlearn from the first prototype

The first prototype (2026-10-09/10, built by an earlier agent) was careful about
correctness and honest about what was measured. Several of its choices conflict
with this vision. Treat them as things to remove, not constraints to respect:

| Prototype choice | Why it conflicts | Direction |
|---|---|---|
| 7-field vessel `QueryPlan`, "never execute generated SQL" | Caps what can be asked; ties everything to one dataset | Model writes SQL; sandbox the execution |
| 2-second idle pause before live queries | The single largest delay in the loop | Run on every keystroke with cancellation |
| Enter → first point as the headline metric | Measures a step we want to eliminate | Thought → result; Enter is a sub-measurement |
| Separate wire protocol per component and placement (3–4 JSON protocols) | Moving a component means a new protocol and server | One binary protocol, pluggable transport |
| Vessel-shaped `ColumnBatch {x, y, series, lat, lon}` | Not generic | Arbitrary Arrow schemas; chart choice from column types |
| Long, heavily hedged documentation | Slows every future reader down | Short, decisive, current docs |

Keep what serves the vision: the DuckDB worker, Arrow-to-canvas streaming without
row objects, the chart renderers, the persistent Rust WebSocket service, and the
identity/epoch/cancellation machinery for stale-result rejection.

## Who uses it

Primarily a research vehicle. TimeFuse will be one consumer of what it learns
and builds. That never justifies narrowing the engine to one product's data.
