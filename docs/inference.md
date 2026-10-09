# Inference before Enter

Status: proposed design; no inference adapter or measured speedup is implemented.
Primary references checked on **2026-10-09**. Capabilities must be verified against the
exact engine, model and deployment version selected for an experiment.

The inference objective is the earliest **validated executable query for the committed
request**, with enough machine-readable chart semantics to draw its first correct point.
First generated token is a useful diagnostic; it is not the product finish line.

## Spend typing time on useful work

| Trigger | Proposed work | Retain after a changed draft |
| --- | --- | --- |
| Dataset selected | Load relevant catalog, model and tokenizer; establish remote connection | Versioned catalog and compatible engine |
| Input focused | Warm grammar/compiler, acquire reusable context, prepare chart surface | Stable context and allocated resources |
| Text edited | Mirror revision, resolve names, update likely query templates | Validated reusable prefix and template artifacts |
| Natural pause | Complete one likely request; optionally execute a bounded read | Candidate tagged with its exact assumptions |
| Enter | Freeze revision/context, promote matching candidate, cancel competitors | Only artifacts valid for this commit |

Transmit edits immediately, but do not run a new full generation for every keystroke.
Use a cheap predictor to identify stable intent and pause opportunities; let a budgeted
scheduler decide when expensive speculation is justified. Sending text and doing inference
are separate operations.

Do not send unsubmitted text to a remote provider unless the user has enabled that behavior.
Local draft analysis can still warm templates and resolve schema names without remote drafts.

## A session is not necessarily a suspended model

The application session owns draft revisions and resources. An inference session, when
supported, owns reusable model state. A warm network connection owns neither of those.
Keep these lifetimes explicit.

vLLM's automatic prefix caching reuses KV state for a matching prompt prefix. Its documented
benefit is avoiding repeated **prefill**, not making the remaining output tokens decode
faster. This makes a stable schema/instruction prefix valuable, but does not remove SQL
generation time. [vLLM prefix caching](https://docs.vllm.ai/en/v0.15.0/features/automatic_prefix_caching/)

Streaming output alone does not establish support for appending input, pausing after
prefill, branching KV state, or resuming an unfinished request. For example, WebLLM's
documented streaming example submits a messages array and then consumes output chunks;
we must separately establish any lower-level mutable-context capability.
[WebLLM basic usage](https://webllm.mlc.ai/docs/user/basic_usage.html)

Use three implementation tiers:

1. **Portable baseline:** mirror text to the coordinator, warm connections/resources,
   issue a complete immutable generation request at commit, use provider prefix caching
   when available. Pre-Enter generations are ordinary bounded requests, not fake sessions.
2. **Cache-aware engine:** report cache identity and usable prefix; issue new generations
   that reuse cached tokens. Learn retention and eviction behavior through measurements.
3. **Controllable engine:** explicitly prefill, checkpoint, fork, truncate and resume
   supported state. These are adapter capabilities, not universal API assumptions.

Avoid dummy generations solely to populate a cache until experiments establish that their
cost, cache lifetime and actual cache-hit rate improve commit latency.

## Negotiate capabilities, not provider names

The following is a proposed adapter descriptor, not an existing provider API:

```ts
type InferenceCapabilities = {
  placement: "browser" | "remote";
  inputMode: "immutable-request" | "append-with-truncate";
  output: "text" | "json-schema" | "grammar";
  prefixCache: "none" | "opaque" | "observable";
  prefillOnly: boolean;
  forkState: boolean;
  cancel: "discard-only" | "best-effort" | "acknowledged-stop";
  priority: "none" | "queue" | "preemptive";
  modelIdentity: string;
  tokenizerIdentity?: string;
  contextLimit: number;
};
```

Each adapter should also disclose supported schema subsets, minimum cacheable prefix,
retention hints, routing affinity, observed cancellation lag and resource limits where
known. Unknown values stay unknown. Never expose an inferred property as a guarantee.

All adapters must accept an immutable commit identity and emit bounded output plus usage
and timing events. Optional operations can fail or lose their state; the complete-request
path remains the recovery route. Model context is local to a compatible engine; do not
put raw KV tensors into the placement-independent application protocol.

## The mutable suffix is the difficult part

Text that only grows is not necessarily a token sequence that only grows. Subword
tokenizers split and merge pieces of words; therefore appending characters can change
the tokenization of an earlier suffix. This is an engineering inference from the tokenizer
algorithms, not a promise that a fixed number of trailing tokens always suffices.
[Hugging Face tokenization](https://huggingface.co/docs/transformers/tokenizer_summary)

For a controllable engine, use this correctness-first procedure:

1. Construct the complete rendered prompt for the current revision, including role
   delimiters, chat template, normalization and generation suffix.
2. Tokenize it with the exact deployed tokenizer.
3. Compare token IDs with the previous rendered prompt; compute their longest common prefix.
4. Keep only engine state that is reusable through that prefix; truncate or restart the rest.
5. Re-prefill the changed suffix. Decode only against a recorded immutable revision.

Do not append after an old end-of-user delimiter or generated assistant answer. Draft
prefill should stop before closing delimiters when the engine allows it; otherwise only
the actual common prefix can survive. Middle edits, pasted text, IME composition and
changes to retrieved schema must follow the same rule.

Optimize incremental tokenization only after proving equivalence to the complete tokenizer.
If token IDs or state truncation are unavailable, send a complete new request and let the
engine perform its supported prefix reuse.

vLLM documents full-block prefix caching, with identity including earlier prefix blocks
and additional inputs such as adapter IDs. It also supports cache isolation with salts.
Accordingly, do not count every unchanged character as saved prefill; record **actual
cached tokens** when available, and isolate cache namespaces by authorized tenant/context.
[vLLM cache design](https://docs.vllm.ai/en/latest/design/prefix_caching/)

## Make the model generate less

Prefer a small typed query intent over verbose SQL plus explanation. For common requests,
select a vetted template and fill typed slots; a deterministic compiler emits the target
dialect. Generate prose and chart captions after data is visible, if wanted.

Illustrative intent, not a finalized wire schema:

```json
{
  "template": "metric_over_time",
  "dataset": "events_v7",
  "metric": "revenue_sum",
  "time": "event_time",
  "range": {"start": "2026-10-01T00:00:00Z", "end": "2026-10-08T00:00:00Z"},
  "bucket": "1h",
  "filters": [],
  "series": []
}
```

The catalog supplies metric semantics, currency, timezone, allowed dimensions and null
handling. The compiler owns quoting, bound values, dialect functions and authorization.
The model chooses catalog IDs; it does not invent executable identifiers or expressions.
Use an explicit unsupported/ambiguous outcome when the template cannot express the ask.
A broader SQL path can handle the long tail after parsing and semantic validation.

SGLang documents JSON Schema, regex and EBNF constraints. That makes constrained output a
real adapter option, but well-formed output still needs application validation for correct
columns, units, joins, time boundaries and authorization.
[SGLang structured output](https://github.com/sgl-project/sglang/blob/main/docs/docs/advanced_features/structured_outputs.mdx)

Precompile recurring grammar variants when supported. Compare terse enums with readable
names using the selected tokenizer: fewer characters do not automatically mean fewer tokens.
Avoid model-generated chain-of-thought or explanations on the latency path; choose a model
and supported inference mode appropriate to a short semantic parsing task.

Resolve metric/table/time candidates as soon as their fields arrive, and warm corresponding
compiler or database artifacts. Do not execute a half-decoded SQL statement or treat an
unfinished JSON object as validated intent. Streamed metadata is preparatory until all
required semantics and the committed request are fixed.

## Arrange context for reuse and accuracy

Proposed prompt order:

```text
stable task contract + output grammar version
stable dataset catalog + metric definitions + authorization scope version
compact reusable examples, only if they improve measured accuracy
request-specific retrieved schema subset / conversation state
current draft or committed request
generation boundary
```

Keep volatile values near the end. Avoid injecting a fresh timestamp into the beginning
of every prompt. If relative dates matter, resolve them with a recorded commit-time anchor
and timezone; a prediction made before midnight is not automatically valid after midnight.

Version schema and semantic catalogs separately. Keep useful names and descriptions even
when compressing context; blindly shrinking schema can create wrong joins and metrics.
Compare a small stable catalog against dynamic retrieval: retrieval can save model work
but add a dependency and invalidate previously warmed suffixes.

## Promote speculation only with proof of applicability

A candidate record includes the draft/assumed completed text, context and catalog versions,
authorization scope, model/prompt versions, temporal anchor, typed intent, validated SQL,
parameter values, dataset snapshot/freshness policy and any fetched result identity.

At Enter, promotion has two acceptable routes:

- Exact committed prompt bytes/revision and context match, with an accepted query
  interpretation, query validation and data snapshot/freshness still valid.
- A deterministic parser proves the final request maps to the same typed intent, parameters
  and context under the same semantic rules.

A similarity score, a model's confidence or agreement between two guesses is insufficient.
When the final text differs and equivalence cannot be established, retain reusable caches
but generate/validate against the final text. Verification itself belongs in the latency trace.
Relative dates, tenant changes, negation and added filters are deliberate invalidation cases.

Speculative results may be shown as a clearly marked preview, but they must not count as
the first correct committed point. Speculative/committed identity is independent of whether
the point itself is provisional or exact. A candidate query must be a bounded, authorized read
even before Enter; speculative execution is not permission for writes or external side effects.

## Keep speculation from delaying the foreground

Use a preemptible speculative queue beneath committed work. Cap concurrent candidates,
decode tokens, total generated tokens, retained KV memory and speculative database work
per user. Stop admitting work when the user edits rapidly or the committed queue is busy.

On commit, request cancellation of losers and immediately ignore their future events.
An aborted client request is not proof that remote computation stopped. The adapter must
distinguish output discard, best-effort cancellation and acknowledged engine stop; record
time until resources actually become available when observable.

For browser placement, WebLLM supports worker-based inference to move generation work off
the UI thread. Its service-worker documentation also warns that worker lifetime is controlled
by the browser. A retained app handle is therefore not proof the model is still resident.
[WebLLM workers](https://webllm.mlc.ai/docs/user/advanced_usage.html#using-workers)

Treat GPU contention as a benchmark hypothesis: moving work into another worker does not
reserve GPU capacity for drawing. Try a tiny CPU/template route, shorter speculative GPU
bursts, or pausing new model work until the first chart submission. Avoid per-point CPU/GPU
synchronization. Prefer the placement with the best observed end-to-end latency, including
chart delay, rather than simply the best inference throughput.

Local model download, initialization and weight residency are separate cold-start costs;
WebLLM explicitly documents an asynchronous first model load that may download weights.
Show cold-start results separately from resident-model results.
[WebLLM model loading](https://webllm.mlc.ai/docs/user/basic_usage.html#creating-an-mlcengine)

## Experiments that decide the architecture

Record commit-to-validated-intent, cached/uncached prefill, output token count, cancellation
lag, queue delay, accepted/discarded speculative work and final correct-point presentation.
Track accuracy, p50/p95/p99, bytes, cost and power across realistic typing traces.

Compare no speculation, static-prefix warming, one paused-draft prediction, template routing,
and a controllable prefill engine. Include wrong predictions, middle edits, rapid Enter,
long pauses, cache eviction, changing schemas, stale data and concurrent users.

Measure the marginal rule: expected saved foreground latency must exceed added scheduling,
verification and contention costs. Adopt an optimization only when the whole chain improves
under a fixed correctness target and resource budget. No absolute latency claim follows
from choosing a particular model runtime, quantization level or protocol.
