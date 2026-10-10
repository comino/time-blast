# Inference meaning checks

`inference-corpus.json` contains 62 questions: eight public regressions and 54 independently authored heldout examples. Expected values are full `QueryPlan` objects or explicit refusals. The corpus spans the four metrics, all aggregates and supported buckets, ten views, six named vessels, long windows, adjacent units such as `1days`, and unsupported combinations. A successful SQL query alone does not pass: every plan field must match the requested meaning.

The heldout questions were written before inspecting the new semantic prompt. Once their failures inform a prompt change, use that set as development evidence. Do not present another pass over the same questions as a fresh heldout evaluation. The set is small and intentionally targeted; it is not a representative estimate of all user questions.

An independent review against the compiler and renderers found no incompatible expected plan or refusal. It identified one wording ambiguity: `week_speed_split` says “Compare the fleet,” which can also suggest one combined fleet series. Its expected vessel grouping stays frozen; interpret any grouping mismatch with that caveat, since combined and separate values are not equivalent. Geographic cases check query and view selection, not metric-colored positions: current maps and tracks color vessel identity. Long requested windows remain exact even if different windows overlap the same available data, because the requested duration appears in the UI.

Recorded native comparisons and their limitations are indexed in [results/README.md](results/README.md).

`development-gates.json` selects a small mixed capability gate from the same corpus: named-vessel/unit regressions and unsupported requests. Pass its `caseIds` as the comma-separated `--cases` argument. These IDs were chosen after examining failures and are explicitly development selection data. They do not replace a freshly authored unseen audit of a selected candidate.

`independent-audit-2026-10-09.json` contains 24 additional questions (16 supported, eight unsupported) authored by a separate agent without access to candidate prompts, previous corpora or model reports. The author froze its source before the selected Qwen3-4B/v5 run; the evaluator and coordinator did not inspect questions before candidate selection. The exact original bytes remain in `independent-audit-2026-10-09.source.json`. The runnable corpus only adds the unchanged dataset context and provenance; authored cases remain identical. Its first frozen-candidate run is an independent audit. Once observed failures inform changes, future reuse becomes development evidence.

`final-blind-audit-2026-10-09.json` adds 20 independently authored questions (12 supported, eight unsupported), withheld until candidate selection following the v6 development gate. It evaluates the unchanged v5 candidate chosen over v6; no prompt was tuned against this set. Its `.source.json` preserves exact authored bytes. Harness conversion only renames `prompt` to `question`, maps unsupported `expected:null` to the refusal object, and adds context/split/tags. Supported plans and every question remain unchanged. Both audit transformations have source-hash and case-preservation tests.

Final case `blind-01` has a documented reference ambiguity: the author was not given the application's grouping default for a bare request. Its “Show speed.” expectation selects separate vessels, while the existing prompt/decoder and `default_speed` regression specify the combined line default. Independent review confirmed this omission. The source, expected plan, strict mismatch and summary scores remain unchanged; reports annotate it separately and do not count it as a correct plan or numerical grouping equivalence.

Run a recorded prompt/schema artifact against a local native or remote OpenAI-compatible completion endpoint:

```sh
python3 scripts/evaluate-inference.py \
  --artifact /path/to/prompt-artifact.json \
  --endpoint http://127.0.0.1:18081/v1/chat/completions \
  --model qwen --source native \
  --runtime 'llama.cpp BUILD; CPU ARCH; MODEL QUANTIZATION; threads N; context N' \
  --repair --output /tmp/time-blast-eval.json
```

The artifact has `systemPrompt`, `schema`, and `encoding` (`full`, legacy `compact`, or experimental `semantic` through `semantic-v4`). `semantic-v2` preserves the v4/v4.1 extraction and correction contract. `semantic-v3` selects the separately versioned v5 experiment: unsupported aggregate names can be generated literally but remain non-executable, and correction feedback distinguishes the model's unsupported classification from an established limitation. `semantic-v4` selects v6, adding explicit temporal scope and literal unit names: absolute/future scope and unknown units cannot execute when captured. This does not guarantee that the model captures them correctly. The schema/prompt versions stay embedded in each report; historical results retain their original decoder feedback.

An artifact may include `context` and descriptive `metadata`. When context is present it must exactly match the corpus context. Otherwise the operator must verify that the prompt uses the same dataset metadata, including vessel names. A completed report embeds the artifact and context, so it is sufficient to reconstruct the inputs. To export its prompt for another run:

```sh
python3 -c 'import json; p=json.load(open("/tmp/time-blast-eval.json")); json.dump(p["artifact"], open("/tmp/prompt-artifact.json", "w"), indent=2)'
```

Remote evaluation transmits the selected corpus and system prompt to the specified endpoint. Authentication is read from `TIME_BLAST_EVAL_API_KEY`, or the environment variable named by `--api-key-env`. Credentials are not written into reports. Do not put secrets into prompts or use private user questions in a committed corpus. The evaluator does not download weights, launch a model server, or execute SQL.

`--split regression|heldout`, `--cases id1,id2`, and `--seed` select reproducible subsets. Compare models using the same corpus, prompt, schema, generation limits, correction policy, and seed; report each runtime and quantization separately. Temperature is zero and grammar uses JSON schema. These request repeatability but cannot guarantee identical behavior across engines or devices.

Wait for a healthy endpoint before starting collection. `--timeout` bounds each HTTP request (120 seconds by default); the timeout is recorded in new reports. A slow CPU prefill may need a larger bound, which changes collection availability rather than the requested generation. Do not infer model accuracy from a startup `503` or timeout.

For a native Qwen3 nonthinking trial, add `--disable-thinking`. This sends the actual `chat_template_kwargs: {"enable_thinking": false}` option; adding words to the prompt is not a substitute. The option and whether any reasoning field appeared are recorded. A reasoning-bearing response is a `generation_mode_error`, receives no correction, and cannot count as a successful nonthinking trial. Reasoning text itself is not retained. Inspect the first actual completion before extending a trial, since native template behavior differs from WebLLM's fixed empty-header handling.

Native prefix reuse is off by default. `--prefix-cache` explicitly enables it to avoid repeatedly processing an identical system prefix during qualitative evaluations. Reports record this requested policy and actual cached prompt-token counts when supplied by the engine. Keep one policy through a run, and compare policy-matched runs separately: reused prefixes can change floating-point execution and therefore exact outputs. Native cache reuse is not evidence that the browser adapter reuses its KV prefix. None of these endpoint timings establish browser latency.

The optional correction gets only the original question, previous response, and validation error. It cannot see expected answers. The previous response is capped at 2,048 characters, matching the browser correction path. Valid but wrong plans are not repaired by the evaluator, matching the limitation of runtime validation. Endpoint failures and incomplete non-length finishes do not retry. Reports retain each attempt's bounded raw completion, finish reason, token usage, normalized plan, and outcome, with artifact hashes and full settings. Up to 16,384 completion characters per attempt are retained. Reports are saved atomically after every case, and an interrupted run remains marked `running`.

Read these outcomes separately:

- `correct_plan`: every full plan field matches.
- `correct_refusal`: the model explicitly refuses an unsupported request.
- `wrong_plan`: a supported request produced a valid plan with different reference fields. Inspect the recorded field differences: grouping a result already filtered to one vessel can preserve its numeric values, while dropping a requested view or time bucket changes the result presentation or data.
- `false_refusal`: a supported request was declined.
- `false_accept`: an unsupported request produced a valid plan, usually dropping a requirement.
- `rejected_unsupported`: the reference decoder rejected output for an unsupported request. It is non-executable but does not count as an exact correct refusal.
- `invalid_output`: a supported request produced unusable output.
- `endpoint_error`: transport/runtime/endpoint response failed. It does not count as a successful safe rejection.
- `generation_mode_error`: the endpoint generated reasoning despite an explicitly disabled thinking mode. It is an experiment configuration failure.

Strict accuracy counts only `correct_plan` and `correct_refusal`. Supported exact-plan accuracy and unsupported false-accept rate use their respective denominators. The separate unsupported non-executable rate includes decoder rejection; inspect raw output to distinguish faithful capture of unsupported meaning from a broken response. Summary counts also retain first-attempt outcomes and repairs so a second model call cannot hide first-attempt failures.

Collection-wide rates retain endpoint and generation-mode failures in their denominators. Separate `scorable_*` rates exclude those failures when analyzing model meaning; both the excluded count and supported/unsupported denominators are explicit. Report availability failures alongside those rates, especially when the endpoint disappears partway through a run. A successful CLI exit means collection finished, not that every question was interpreted correctly.

`equivalent_named_grouping_only` separately counts valid plans whose only difference is `splitByVessel` under the same single named-vessel filter. Compiler and renderer tests establish equivalence for that narrow case. `supported_exact_or_equivalent_accuracy` adds those cases to exact supported matches; strict outcomes stay unchanged. A changed vessel, time bucket, metric, aggregation, window or view is never hidden by this adjustment. This secondary analysis was added after initial native observations, and should be reported separately from the original strict score.

The evaluator uses a Python reference decoder, separately from production TypeScript. Native CPU results are useful comparative evidence about model behavior, not WebGPU accuracy or browser latency. Endpoint wall time includes transport and is diagnostic only. Browser/runtime integration, cancellation, stale-result rejection, and SQL execution need the application tests as well.

Python 3 (standard library only) is required for the evaluator and the `pnpm test` decoder parity check. That check sends identical JSON through the actual production TypeScript decoder and Python reference normalizer, including literal fractions, model refusals, unsupported requirements, invalid fields, and numerical boundaries. It compares exact plans and correction feedback, so native evaluation cannot silently accept an output that production rejects.

Check the evaluator itself with a controlled HTTP endpoint. This test exercises the CLI, schema settings, actual repair conversation, semantic mismatch detection, unsupported requests, truncation, bounded output, endpoint errors, and credential omission without downloading or running a model:

```sh
python3 -m unittest discover -s evals -p 'test_*.py' -v
```
