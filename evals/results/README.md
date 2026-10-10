# Native model screening, 2026-10-09

These are CPU reference experiments, not browser WebGPU measurements. They use llama.cpp b11538 (`79e2e74eb`), Linux aarch64, a 4,096-token context and one active request per endpoint. Main trials use three CPU threads; Qwen3.5 and matched Qwen2.5 screens use a separately owned one-thread endpoint. Some run concurrently, so timings are diagnostic rather than controlled performance comparisons. Weights are GGUF Q4_K_M, distinct from browser MLC q4f16/q4f32 weights. Each JSON report embeds the exact prompt, schema, expected plans, bounded actual replies, attempt outcomes, runtime and model hashes.

Nested model-asset metadata describes the earlier download/verification step. Its “no generation” caveat applies to that staging step; the surrounding report records the later model run.

The eight public regressions are screening cases, not an independent benchmark. Several are examples in the full prompt. The 54-case corpus was independently authored before examining the semantic candidate; subsequent analysis and candidate selection make repeat use development evidence. These small targeted sets cannot establish general natural-language accuracy.

## Public regressions

All runs request temperature zero, seed one, schema-constrained output and at most one validation-driven correction. Valid but wrong plans receive no correction. Native Qwen3 uses `enable_thinking:false` and `--reasoning off`; no reasoning-bearing replies occurred. Prefix reuse is enabled except for the first Qwen2.5 semantic run. The cache-policy difference prevents treating that earlier run as an otherwise identical runtime comparison.

| Model | Output contract | Exact plans / 8 | First-attempt output tokens | Report |
| --- | --- | ---: | ---: | --- |
| Qwen2.5-1.5B-Instruct | Semantic v4 | 6 | 77–93 | [JSON](2026-10-09-qwen1.5-semantic-v4-regression.json) |
| Qwen3-0.6B | Semantic v4.1 | 1 | 85–94 | [JSON](2026-10-09-qwen3-0.6-semantic-v4.1-regression.json) |
| Qwen3-0.6B | Compact keys | 1 | 56–60 | [JSON](2026-10-09-qwen3-0.6-compact-regression.json) |
| Qwen3-1.7B | Compact keys | 3 | 32–57 | [JSON](2026-10-09-qwen3-1.7-compact-regression.json) |
| Qwen3-1.7B | Full keys | 6 | 38–42 | [JSON](2026-10-09-qwen3-1.7-full-regression.json) |
| Qwen2.5-1.5B-Instruct | Full keys | 7 | 58–62 | [JSON](2026-10-09-qwen2.5-1.5-full-regression.json) |
| Qwen3-4B | Full keys | 7 | 38–42 | [JSON](2026-10-09-qwen3-4-full-regression.json) |
| Qwen3-4B | Semantic v4.1 | 7 | 49–52 | [JSON](2026-10-09-qwen3-4-semantic-v4.1-regression.json) |
| Qwen3-4B | Semantic v5 | 8 | 49–52 | [JSON](2026-10-09-qwen3-4-semantic-v5-regression.json) |
| Qwen3-4B | Semantic v6 (not selected) | 8 | 55–58 | [JSON](2026-10-09-qwen3-4-semantic-v6-regression.json) |
| Qwen2.5-1.5B-Instruct | Semantic v5 | 5 | 77–92 | [JSON](2026-10-09-qwen2.5-1.5-semantic-v5-regression.json) |
| Qwen3.5-2B | Semantic v5 | 3 | 100–113 | [JSON](2026-10-09-qwen35-2-semantic-v5-regression.json) |
| Qwen3-4B | Semantic without examples | 3 | 50–84 | [JSON](2026-10-09-qwen3-4-semantic-noexamples-v1-regression.json) |
| Qwen2.5-1.5B-Instruct | Semantic v5 (one CPU thread) | 5 | 77–92 | [Public JSON](2026-10-09-qwen2.5-1.5-semantic-v5-regression.json) · [Mixed gate](2026-10-09-qwen2.5-1.5-semantic-v5-development-gate.json) |
| Qwen3.5-0.8B | Full keys | 6 | 66–70 | [JSON](2026-10-09-qwen35-0.8-full-regression.json) |
| Qwen3.5-0.8B | Semantic v4.1 | 1 | 106–113 | [JSON](2026-10-09-qwen35-0.8-semantic-v4.1-regression.json) |
| Qwen3.5-0.8B | Semantic without examples | 0 | 109–159 | [JSON](2026-10-09-qwen35-0.8-semantic-noexamples-v1-regression.json) |
| Qwen3.5-2B | Semantic v5 (one CPU thread) | 3 | 100–113 | [JSON](2026-10-09-qwen35-2-semantic-v5-regression.json) |
| Qwen2.5-0.5B-Instruct | Compact keys (shipped baseline) | 1 | 32–59 | [JSON](2026-10-09-qwen2.5-0.5-compact-regression.json) |
| Qwen2.5-0.5B-Instruct | Full keys | 3 | 37–42 | [JSON](2026-10-09-qwen2.5-0.5-full-regression.json) |

Qwen3-4B preserved every numerical query field across these eight cases. Its one strict mismatch selected a heatmap instead of the instructed default line for the user's minute/week wave comparison. Qwen2.5-1.5B's failure on that same question changed the requested minute bucket to hourly and selected geographic density. The equal strict score therefore hides a material difference in the failed result. Neither observation proves reliability on new questions.

Full keys generated only a few more tokens than compact keys on Qwen3-1.7B while improving this screening score. The full prompt is longer: roughly 1,070 native input tokens versus 600 for compact. These counts identify optimization candidates; they do not establish browser latency. Whitespace and token counts also vary by model.

## Earlier semantic candidate: broader evaluation

[Qwen2.5-1.5B semantic v4, 54 cases](2026-10-09-qwen1.5-semantic-v4-heldout.json) returned 13 exact plans among 28 supported requests. Three further plans differ only in grouping under an identical single-vessel filter, which compiler/renderer tests establish as equivalent; they remain strict failures and are reported separately (16/28 exact or equivalent).

Of 26 unsupported requests, 13 were falsely accepted, five ended in decoder rejection, and eight could not complete because the server disconnected and then refused connections. The completed-model denominator is therefore 18 unsupported cases: 13/18 false accepts. The report retains all eight availability errors rather than counting them as semantic rejections. The process exit cause is unknown; the preserved log contained no context-overflow error, and no contemporaneous OOM event was found.

Six validation-driven repairs did not recover a supported plan. Five remained rejections and one encountered the server disconnect. No repair introduced a false accept in this run, but the existing first-attempt false accepts remained executable. Error correction cannot detect a well-formed plan that quietly changes the question.

## Qwen3-4B full keys: broader evaluation

[The full 54-case report](2026-10-09-qwen3-4-full-heldout.json) disproves the impression of reliability from the public eight. Only 14/28 supported plans matched exactly; another four differ only by equivalent named-vessel grouping. Ten supported requests still changed substantive requirements. Overlapping mismatches included five buckets, seven windows and one vessel ID. Examples include five-minute buckets becoming 360 minutes, three weeks becoming one week, and 42 days becoming the 710-day duration present in the prompt.

Among unsupported requests, 22/26 were falsely accepted and four were explicitly refused. All four corrections repeated their refusal; the well-formed wrong plans triggered no correction. The model dropped exclusions, additional metrics, unsupported aggregations and other requirements. This full-key candidate is not a reliable replacement on these cases.

Collection was interrupted after eight cases when the attached evaluator received SIGTERM (exit 143); the server stayed healthy. The remaining 46 completed under a detached supervisor with the same artifact, corpus, decoder, generation and repair settings. The combined report retains both segments' provenance and all 54 model outcomes. The termination cause is unknown. Part of collection overlapped a separate one-thread native model trial, so elapsed endpoint times must not be treated as controlled performance results.

`tests/eval-decoder-parity.test.ts` replays every completed saved response through both the Python reference normalizer and the actual TypeScript decoder, comparing exact plans and repair errors. This checks scoring consistency; it does not make incorrect model outputs correct.

## Mixed development gate and example ablation

The [12-case gate](../development-gates.json) deliberately targets failures already observed. Qwen3-4B semantic v4.1 produces 2/6 exact supported plans plus two named-vessel grouping equivalents. The remaining two lose explicit bucket multipliers (15 minutes becomes one minute; six hours becomes one hour). It preserves four of six unsupported requests sufficiently for decoder rejection, but median and total requests become executable averages. See the [complete gate report](2026-10-09-qwen3-4-semantic-v4.1-development-gate.json).

For comparison, the shipped Qwen2.5-0.5B with full keys yields 1/6 exact supported plans and 6/6 false accepts on that same gate ([report](2026-10-09-qwen2.5-0.5-full-development-gate.json)). These comparisons guide candidate development; they do not establish generalization.

Removing the semantic prompt's examples while preserving schema and instructions made the public screen worse: Qwen3-4B fell from 7/8 to 3/8 and Qwen3.5-0.8B from 1/8 to 0/8. The no-examples reports preserve this unsuccessful ablation rather than silently replacing earlier results.

The separately frozen v5 experiment keeps the examples, clarifies explicit bucket multipliers, avoids duplicating represented fields in unsupported requirements, and allows literal aggregate names for deterministic validation. Its correction feedback says the model marked a feature unsupported and asks it to reassess without dropping meaning. Qwen3-4B v5 produces 8/8 exact public plans on the first attempt and, on the [mixed gate](2026-10-09-qwen3-4-semantic-v5-development-gate.json), 4/6 exact supported plans plus the two narrow grouping equivalents. All six unsupported requests preserve their unsupported meaning and remain non-executable after correction. Median and sum stay literal instead of becoming averages.

## Qwen3-4B v5: independently authored audit

The [first frozen-candidate audit](2026-10-09-qwen3-4-semantic-v5-independent-audit.json) contains 24 questions authored without seeing previous prompts, corpora or reports. Candidate selection preceded evaluator/coordinator access to its questions. Of 16 supported requests, eight match exactly and five have only the established single-vessel grouping equivalence. Two produce no executable plan because the model labels built-in map/seasonal presentation as unsupported, even though all other extracted fields match. They remain failures, with separate diagnostic annotations. The final supported failure changes quarter-hour buckets to one minute.

Of eight unsupported requests, six remain non-executable: five through decoder rejection and one through an explicit refusal after correction. Two are falsely accepted: an absolute date range is replaced with the default last 24 hours, and a next-day forecast becomes a historical query. This is 13/16 supported exact-or-equivalent and 6/8 unsupported non-executable, not universal reliability or fail-closed behavior.

All 24 cases completed without endpoint or generation-mode errors. Eight corrections recovered no supported failure and changed one unsupported extraction into an explicit refusal. No correction introduced a false accept. Future use of these now-inspected questions is development evidence, not another fresh audit.

The same frozen v5 contract did not transfer equally across smaller candidates. Qwen2.5-1.5B achieved 5/8 public exact plans and, on the mixed gate, 2/6 exact supported plus two grouping equivalents and 3/6 false accepts. Qwen3.5-2B achieved 3/8 public exact plans, so its mixed-gate run was skipped. Their one-thread native screens preserve the same prompt/schema, greedy generation, correction and prefix-cache policy, but different model weights and architectures; these are quality screens, not device speed comparisons.

## V6 development experiment, not selected

V6 adds explicit trailing/absolute/future time scope, permits literal unit names for strict decoder rejection, and clarifies fractional multipliers and built-in chart descriptions. It preserves 8/8 exact public regressions, adding roughly six output tokens per plan. However, the [mixed gate](2026-10-09-qwen3-4-semantic-v6-development-gate.json) regresses to 1/6 exact supported plans plus three grouping equivalents: a requested table becomes a line and 15-minute buckets become one minute. All six unsupported gate cases remain non-executable.

The experiment was not selected because it lost supported meaning on the existing gate. Its intended improvements to temporal requests were not tested on the consumed 24-case audit, and no claim is made that they fix those failures. The unchanged v5 artifact and original frozen evaluator were selected for the final independently authored 20-case audit.

## Final blind audit of unchanged V5

The [final 20-case report](2026-10-09-qwen3-4-semantic-v5-final-blind-audit.json) preserves 10/12 exact supported plans and 6/8 non-executable unsupported requests. One supported failure changes requested 24-hour buckets to one hour. The other strict mismatch is a reference ambiguity: the author was not given the application's bare-request grouping default, and expected separate vessels for “Show speed.” The response follows the existing combined default. Independent review confirmed the omission, but the authored reference, strict mismatch and scores remain unchanged; this is not the named-vessel numerical equivalence adjustment.

Both false accepts repeat the earlier audit's limitation: an explicit September date range becomes the last 24 hours, and a forecast becomes a historical query. Of six corrections, one changes an unsupported extraction to an explicit refusal; five remain decoder rejections. No correction fixes a supported failure or introduces a false accept. All 20 requests finish without endpoint or generation-mode errors.

Collection overlaps browser functional checks and builds, so endpoint wall times are not controlled latency measurements. Native generation is complete: the owned model server exits cleanly after SIGTERM, port 18081 closes, and its evaluator exits successfully. No further prompt tuning or model runs use this audit.
