# Inference evaluation audit — 2026-10-09

Independent read-only audit of the native evaluation path. No model generations,
model downloads, application changes or performance benchmarks were performed.
The four controlled HTTP/decoder tests in `evals/test_evaluate_inference.py` passed.
This audit does not certify native results as browser WebGPU results.

## Confirmed checks

- **Identity and template:** the live process on port 18081 and its `/props`
  response identify llama.cpp `b11538-79e2e74eb`, Qwen3-4B Q4_K_M, CPU, three
  threads, one slot and context 4096. The process has `--jinja --reasoning off
  --chat-template-kwargs {"enable_thinking":false}`. The template SHA256 is
  `5595e8741bb5500f9d395e05a0aefe6ca1e8d54c5dd8b98bcf7760d895fdc6e6`, matching
  the previously inspected model metadata. Its nonthinking generation prefix
  contains the closed, empty thinking block. The model file was not rehashed
  during this audit; the curated report preserves its earlier pinned publisher
  revision and verified LFS hash.
- **Independent requests:** `scripts/evaluate-inference.py:296` creates fresh
  system/user messages for every case. It sends the selected artifact's schema,
  temperature zero, seed 1 by default, a 256-token limit, explicit native cache
  policy and the requested nonthinking flag. Repairs contain only the actual
  previous output and decoder/refusal feedback. Expected answers never enter
  model messages, and a valid but semantically wrong plan receives no repair.
- **Cache behavior:** the pinned server source computes the longest identical
  token prefix, keeps only that prefix, removes subsequent KV entries and resets
  sampling state. Logs show prefix reuse and fresh question processing, with no
  evidence of prior answers being appended as conversation history. A controlled
  cache-on/off generation comparison was not performed, so numerical effects of
  different prefill execution remain untested. See the pinned
  [server implementation](https://github.com/ggml-org/llama.cpp/blob/79e2e74eb/tools/server/server-context.cpp#L3589),
  especially `init_sampler`, `keep_first(n_past)` and subsequent `seq_rm`.
- **No truncation explanation:** the 54-case full-plan report contains 58 attempts
  with 1,069–1,192 prompt tokens and 7–42 completion tokens. Every attempt ended
  with `stop`. The server log reports no context truncation. Context exhaustion
  and the output-token cap do not explain these wrong slots.
- **Scoring:** decoded dictionaries are compared by field values, independent of
  JSON key order or whitespace. Named-vessel grouping equivalence is reported
  separately: strict supported accuracy is 14/28, or 18/28 when that equivalence
  is included. Refusals, invalid non-executable output and false acceptance have
  separate outcomes. The full report's 22/26 unsupported false accepts are real
  executable plans that discarded requirements, not parser failures.
- **Corpus:** vessel IDs, unit conversions and unsupported capabilities match
  the declared contract. Unspecified chart type defaults to line by product
  convention; the public minute/week case returning heatmap is therefore a
  view-only strict mismatch. Five minutes becoming 360 minutes, two weeks
  becoming 168 hours, or Atlas becoming Nomad are substantive errors. Corpus
  examples used in prompt tuning are correctly described as reused development
  evidence. The eight public regressions overlap prompt examples and are not a
  generalization test.
- **Grammar:** the full artifact uses the ordinary JSON schema, not the separate
  minified EBNF experiment. The pinned converter emits required fields in schema
  order and offers both root alternatives; successful refusals demonstrate the
  refusal branch is reachable. See the
  [schema converter](https://github.com/ggml-org/llama.cpp/blob/79e2e74eb/common/json-schema-to-grammar.cpp#L699).

## Actionable hypotheses, not established causes

1. **Early commitment can hide unsupported requirements.** In
   `src/inference/plan.ts:23`, emitting the first `metric` key commits generation
   to a valid-plan branch. Later it cannot preserve an unknown vessel, unsupported
   bucket or extra metric literally, nor switch to the refusal branch. This
   follows from the schema; its contribution to failure rates needs a controlled
   comparison. Literal extraction with retained unsupported requirements is a
   plausible alternative, but must improve supported precision as well as
   refusal handling before adoption.
2. **Prompt examples may dominate slot extraction.** The full prompt has seven
   positive examples and no negative example. The 42-day request produced 17,040
   hours, exactly the prominently illustrated 710-day value; several longer
   windows produced the illustrated 168 hours. This is consistent with copying
   familiar examples, not proof of cache contamination. A shorter balanced prompt
   or literal quantities merits a small fixed-case comparison, followed by a
   fresh corpus before accuracy claims.
3. **Sampling is an untested variable.** The evaluator and current browser worker
   hardcode temperature zero. Qwen's official nonthinking recommendation is
   temperature 0.7, top-p 0.8, top-k 20 and min-p 0. The card's explicit warning
   against greedy decoding is stated for thinking mode, so it does not establish
   that greedy nonthinking caused these failures. If tested, specify every
   sampler parameter and several fixed seeds; changing only temperature leaves
   llama.cpp defaults top-k 40/top-p 0.95/min-p 0.05. See
   [Qwen3-4B best practices](https://huggingface.co/Qwen/Qwen3-4B#best-practices).
4. **Native/browser parity is not established.** Native Q4_K_M and llama.cpp
   grammar are different from MLC q4f16/q4f32 and WebLLM/XGrammar. Browser replay
   tests prove captured plans execute correctly, not that browser inference will
   produce those plans. Native timings also include unrelated concurrent CPU
   work and must not be presented as inference latency benchmarks.

## Evidence

- [Curated full 54-case report](../../evals/results/2026-10-09-qwen3-4-full-heldout.json):
  exact artifact, bounded raw replies, scoring, model/runtime provenance,
  server arguments, collection interruption and workload caveat.
- [Public full-plan regressions](../../evals/results/2026-10-09-qwen3-4-full-regression.json).
- [Evaluator](../../scripts/evaluate-inference.py),
  [controlled tests](../../evals/test_evaluate_inference.py),
  [corpus](../../evals/inference-corpus.json).
- Session-local log: `/tmp/time-blast-model-eval/qwen3-4-heldout-server.log`.

No evaluation implementation fault was found that explains the large model's
simple-slot failures. The bounded diagnostic comparisons above remain hypotheses
to test, not reasons to discount the observed errors.
