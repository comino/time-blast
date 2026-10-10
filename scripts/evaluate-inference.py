#!/usr/bin/env python3
"""Reproducible semantic evaluation against an OpenAI-compatible chat endpoint.

This is an offline reference evaluator, not the browser inference adapter. It
does not execute SQL. Its JSON artifacts keep the exact prompt/schema/settings
and bounded raw replies so results can be independently inspected.
"""
from __future__ import annotations

import argparse
import collections
import datetime
import hashlib
import json
import math
import os
import pathlib
import platform
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parents[1]
MAX_TEXT = 16_384
MAX_REPAIR_TEXT = 2048
MAX_HTTP_BODY = 1_048_576
MAX_WINDOW_HOURS = 0xFFFFFFFF
KEYS = {"metric", "aggregate", "bucketMinutes", "windowHours", "splitByVessel", "vessel", "view"}
METRICS = {"speed", "wind", "wave_height", "water_temp"}
VIEWS = {"line", "bar", "scatter", "table", "heatmap", "surface", "map", "density", "tracks", "seasons"}
REFUSAL = {"error": "unsupported_request"}
JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


class PlanError(ValueError):
    pass


def text_length(value):
    # JavaScript limits count UTF-16 code units, including astral characters.
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def trim(value):
    return value.strip(JS_WHITESPACE)


def reject_json_constant(value):
    raise ValueError(f"Invalid JSON constant: {value}")


def integer(value):
    # Python considers bool an int; the application does not.
    return type(value) is int or (type(value) is float and math.isfinite(value) and value.is_integer())


def validate_plan(plan, context):
    if not isinstance(plan, dict) or set(plan) != KEYS:
        raise PlanError("The query plan has missing or unsupported fields.")
    if not isinstance(plan["metric"], str) or plan["metric"] not in METRICS:
        raise PlanError("Unsupported metric.")
    if not isinstance(plan["aggregate"], str) or plan["aggregate"] not in {"avg", "min", "max"}:
        raise PlanError("Unsupported aggregation.")
    if not integer(plan["bucketMinutes"]) or plan["bucketMinutes"] not in {1, 5, 15, 60, 360, 1440}:
        raise PlanError("Unsupported time bucket.")
    if not integer(plan["windowHours"]) or not 1 <= plan["windowHours"] <= MAX_WINDOW_HOURS:
        raise PlanError(f"The time window must be a whole number of hours between 1 and {MAX_WINDOW_HOURS}.")
    if type(plan["splitByVessel"]) is not bool:
        raise PlanError("Invalid vessel grouping.")
    vessel = plan["vessel"]
    if vessel is not None and (not integer(vessel) or not 0 <= vessel < min(6, len(context["vessels"]))):
        raise PlanError("Unknown vessel.")
    if not isinstance(plan["view"], str) or plan["view"] not in VIEWS:
        raise PlanError("Unsupported chart view.")
    if plan["view"] in {"map", "density", "tracks"} and not plan["splitByVessel"]:
        raise PlanError("Geographic views require separate vessel positions. Set splitByVessel to true.")
    return plan


def quantity(value, units, label):
    if not isinstance(value, dict) or set(value) != {"count", "unit"}:
        raise PlanError(f"The model returned an invalid {label} quantity or unit.")
    count, unit = value["count"], value["unit"]
    if type(count) not in (int, float) or not isinstance(unit, str) or unit not in units or not 0 < count <= MAX_WINDOW_HOURS:
        raise PlanError(f"The model returned an invalid {label} quantity or unit.")
    result = count * units[unit]
    if not math.isfinite(result) or not float(result).is_integer() or not 1 <= result <= 2 ** 53 - 1:
        units_label = "minutes" if label == "time bucket" else "hours"
        raise PlanError(f"The requested {label} must convert to a positive whole number of {units_label}.")
    return int(result)


def normalize(text, encoding, context, finish_reason=None):
    if finish_reason in {"length", "max_tokens"}:
        raise PlanError("The local model did not complete its query plan. Output reached the token limit.")
    if not isinstance(text, str) or text_length(text) > MAX_TEXT:
        raise PlanError("The model response exceeded the plan size limit.")
    try:
        value = json.loads(text, parse_constant=reject_json_constant)
    except (ValueError, TypeError):
        raise PlanError("The model returned incomplete or invalid JSON. Try a more specific request.") from None
    if not isinstance(value, dict):
        raise PlanError("Inference did not return a query plan.")
    if "error" in value:
        # The existing full-plan adapter treats any error-bearing object as a
        # refusal. Compact/semantic decoders additionally validate its shape.
        if encoding == "full":
            return REFUSAL.copy()
        if value != REFUSAL:
            raise PlanError("Invalid model refusal.")
        return REFUSAL.copy()
    if encoding == "compact":
        if set(value) != {"m", "a", "b", "h", "s", "v", "c"}:
            raise PlanError("The query plan has missing or unsupported fields.")
        value = dict(zip(
            ["metric", "aggregate", "bucketMinutes", "windowHours", "splitByVessel", "vessel", "view"],
            [value[k] for k in ["m", "a", "b", "h", "s", "v", "c"]],
        ))
    elif encoding in {"semantic", "semantic-v2", "semantic-v3", "semantic-v4"}:
        semantic_keys = {"metrics", "aggregate", "bucket", "window", "splitByVessel", "vessel", "view"}
        if encoding in {"semantic-v2", "semantic-v3", "semantic-v4"}:
            semantic_keys = (semantic_keys - {"splitByVessel"}) | {"grouping", "unsupported"}
        if encoding == "semantic-v4":
            semantic_keys.add("timeScope")
        if set(value) != semantic_keys:
            raise PlanError("The query plan has missing or unsupported fields.")
        if encoding == "semantic-v4":
            scope = value["timeScope"]
            if not isinstance(scope, str) or scope not in {"trailing", "absolute", "future"}:
                raise PlanError("Invalid time scope.")
            if scope != "trailing":
                raise PlanError(f"The model classified the time scope as {scope}. The current query contract supports only trailing historical windows. Re-check the original request; do not replace absolute dates or future predictions with historical data.")
        metrics = value["metrics"]
        if not isinstance(metrics, list) or not 1 <= len(metrics) <= 4 or any(not isinstance(v, str) or not trim(v) or text_length(v) > 64 for v in metrics):
            raise PlanError("The model returned an invalid metric list.")
        if encoding in {"semantic-v2", "semantic-v3", "semantic-v4"}:
            unsupported = value["unsupported"]
            if not isinstance(unsupported, list) or len(unsupported) > 8 or any(not isinstance(v, str) or not trim(v) or text_length(v) > 160 for v in unsupported):
                raise PlanError("The model returned invalid unsupported requirements.")
            if unsupported:
                if encoding in {"semantic-v3", "semantic-v4"}:
                    raise PlanError("The model marked these requirements as unsupported: " + "; ".join(unsupported) + ". Re-check the supported capabilities against the original request. Remove an item only if the complete plan represents it; otherwise return unsupported_request. Do not discard any requested meaning.")
                raise PlanError("This request includes unsupported requirements: " + "; ".join(unsupported) + ". Preserve these requirements; do not silently discard them.")
            if len(metrics) != 1:
                raise PlanError("This request asks for multiple metrics. The current query contract supports one metric; do not silently discard the others.")
            grouping, view = value["grouping"], value["view"]
            if grouping is not None and (not isinstance(grouping, str) or grouping not in {"vessel", "fleet"}):
                raise PlanError("Invalid vessel grouping.")
            view = "line" if view is None else view
            if not isinstance(view, str) or view not in VIEWS:
                raise PlanError("Unsupported chart view.")
            split = grouping == "vessel" if grouping is not None else view in {"heatmap", "surface", "map", "density", "tracks"}
        else:
            view, split = value["view"], value["splitByVessel"]
        if len(metrics) != 1:
            raise PlanError("This request asks for multiple metrics. The current query contract supports one metric; do not silently discard the others.")
        vessel = value["vessel"]
        if vessel is not None:
            if not isinstance(vessel, str) or not trim(vessel) or text_length(vessel) > 128:
                raise PlanError("Unknown vessel.")
            matches = [i for i, name in enumerate(context["vessels"][:6]) if trim(name).lower() == trim(vessel).lower()]
            if len(matches) != 1:
                raise PlanError("Unknown or ambiguous vessel.")
            vessel = matches[0]
        bucket_minutes = quantity(value["bucket"], {"minute": 1, "hour": 60, "day": 1440}, "time bucket")
        if bucket_minutes not in {1, 5, 15, 60, 360, 1440}:
            raise PlanError("Unsupported time bucket.")
        window_hours = quantity(value["window"], {"hour": 1, "day": 24, "week": 168}, "time window")
        value = {
            "metric": metrics[0], "aggregate": value["aggregate"],
            "bucketMinutes": bucket_minutes, "windowHours": window_hours,
            "splitByVessel": split, "vessel": vessel, "view": view,
        }
    elif encoding != "full":
        raise PlanError(f"Unknown encoding: {encoding}")
    return validate_plan(value, context)


def classify(expected, actual, error=None):
    if error:
        return "rejected_unsupported" if expected == REFUSAL else "invalid_output"
    if actual == expected:
        return "correct_refusal" if expected == REFUSAL else "correct_plan"
    if expected == REFUSAL:
        return "false_accept"
    return "false_refusal" if actual == REFUSAL else "wrong_plan"


def equivalent_named_grouping(expected, actual):
    """A single named-vessel filter compiles identically with either grouping flag."""
    return (
        isinstance(expected, dict) and isinstance(actual, dict) and set(expected) == KEYS and set(actual) == KEYS
        and expected["vessel"] is not None and expected["splitByVessel"] != actual["splitByVessel"]
        and all(expected[key] == actual[key] for key in KEYS - {"splitByVessel"})
    )


def summarize(results):
    counts = collections.Counter(r["outcome"] for r in results)
    supported = sum(r["expected"] != REFUSAL for r in results)
    unsupported = len(results) - supported
    scorable = [r for r in results if r["outcome"] not in {"endpoint_error", "generation_mode_error"}]
    scorable_supported = sum(r["expected"] != REFUSAL for r in scorable)
    scorable_unsupported = len(scorable) - scorable_supported
    correct = counts["correct_plan"] + counts["correct_refusal"]
    equivalent = sum(r["outcome"] == "wrong_plan" and equivalent_named_grouping(r["expected"], r["actual"]) for r in results)
    cached_tokens = []
    for result in results:
        for attempt in result["attempts"]:
            usage = attempt.get("usage")
            details = usage.get("prompt_tokens_details") if isinstance(usage, dict) else None
            cached = details.get("cached_tokens") if isinstance(details, dict) else None
            if integer(cached) and cached >= 0:
                cached_tokens.append(cached)
    def rate(n, d):
        return round(n / d, 6) if d else None
    return {
        "cases": len(results), "supported_cases": supported, "unsupported_cases": unsupported,
        "outcomes": dict(sorted(counts.items())), "strict_accuracy": rate(correct, len(results)),
        "supported_exact_plan_accuracy": rate(counts["correct_plan"], supported),
        "equivalent_named_grouping_only": equivalent,
        "supported_exact_or_equivalent_accuracy": rate(counts["correct_plan"] + equivalent, supported),
        "scorable_model_cases": len(scorable),
        "availability_or_mode_error_cases": len(results) - len(scorable),
        "scorable_supported_cases": scorable_supported,
        "scorable_unsupported_cases": scorable_unsupported,
        "scorable_supported_exact_plan_accuracy": rate(counts["correct_plan"], scorable_supported),
        "scorable_supported_exact_or_equivalent_accuracy": rate(counts["correct_plan"] + equivalent, scorable_supported),
        "scorable_unsupported_false_accept_rate": rate(counts["false_accept"], scorable_unsupported),
        "scorable_unsupported_non_executable_rate": rate(counts["correct_refusal"] + counts["rejected_unsupported"], scorable_unsupported),
        "attempts_reporting_cached_prompt_tokens": len(cached_tokens),
        "reported_cached_prompt_tokens": sum(cached_tokens) if cached_tokens else None,
        "false_accept_rate": rate(counts["false_accept"], unsupported),
        "false_refusal_rate": rate(counts["false_refusal"], supported),
        "unsupported_non_executable_rate": rate(counts["correct_refusal"] + counts["rejected_unsupported"], unsupported),
        "first_attempt_outcomes": dict(sorted(collections.Counter(r["attempts"][0]["outcome"] for r in results).items())),
        "repairs": sum(len(r["attempts"]) > 1 for r in results),
        "repair_transitions": dict(sorted(collections.Counter(
            r["attempts"][0]["outcome"] + " -> " + r["outcome"] for r in results if len(r["attempts"]) > 1
        ).items())),
        "repair_introduced_false_accepts": sum(
            len(r["attempts"]) > 1 and r["attempts"][0]["outcome"] != "false_accept" and r["outcome"] == "false_accept" for r in results
        ),
        "repair_fixed_supported_plans": sum(
            len(r["attempts"]) > 1 and r["attempts"][0]["outcome"] != "correct_plan" and r["outcome"] == "correct_plan" for r in results
        ),
        "field_mismatches": dict(sorted(collections.Counter(
            key for r in results if r["outcome"] == "wrong_plan" for key in KEYS if r["actual"].get(key) != r["expected"].get(key)
        ).items())),
    }


def bounded(value, limit=MAX_TEXT):
    data = value.encode("utf-16-le", errors="surrogatepass")
    return {"text": data[:limit * 2].decode("utf-16-le", errors="surrogatepass"), "truncated": len(data) > limit * 2}


def request_completion(endpoint, payload, timeout, api_key=None):
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    request = urllib.request.Request(endpoint, data=json.dumps(payload).encode(), headers=headers)
    start = time.monotonic()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read(MAX_HTTP_BODY + 1)
    elapsed = (time.monotonic() - start) * 1000
    if len(data) > MAX_HTTP_BODY:
        raise ValueError("Endpoint response exceeded the 1 MiB diagnostic limit.")
    output = json.loads(data)
    if not isinstance(output, dict) or not isinstance(output.get("choices"), list) or not output["choices"]:
        raise ValueError("Endpoint did not return a completion choice.")
    choice = output["choices"][0]
    if not isinstance(choice, dict) or not isinstance(choice.get("message"), dict):
        raise ValueError("Endpoint did not return a completion message.")
    message = choice["message"]
    content = message.get("content")
    if not isinstance(content, str):
        raise ValueError("Endpoint did not return textual message content.")
    finish_reason = choice.get("finish_reason")
    if finish_reason is not None and (not isinstance(finish_reason, str) or len(finish_reason) > 40):
        raise ValueError("Endpoint returned an invalid finish reason.")
    return {
        "output": bounded(content), "finish_reason": finish_reason,
        "model": output.get("model"), "usage": output.get("usage"),
        "system_fingerprint": output.get("system_fingerprint"),
        "reasoning_present": bool(message.get("reasoning_content") or message.get("reasoning")),
        "endpoint_wall_ms": round(elapsed, 3),
    }


def correction(error, truncated=False):
    return (
        f"Your previous response failed validation: {error}\n"
        + ("The previous assistant response was truncated for this correction.\n" if truncated else "")
        +
        "Re-check the supported capabilities in the system instructions and correct the response for the original complete request. "
        "Preserve its metric, aggregation, grouping, time bucket, time window, filters and view. "
        "Do not simplify or silently drop any requirement. If the entire request is supported, return its correct JSON plan. "
        "If it is truly unsupported, return the unsupported_request JSON response. Return only the JSON response, with no explanation."
    )


def evaluate_case(case, artifact, context, args, api_key):
    messages = [{"role": "system", "content": artifact["systemPrompt"]}, {"role": "user", "content": case["question"]}]
    attempts = []
    for attempt_index in range(2 if args.repair else 1):
        payload = {
            "model": args.model, "messages": messages, "temperature": 0, "seed": args.seed,
            "max_tokens": args.max_tokens,
            "response_format": {"type": "json_schema", "json_schema": {"name": "plan", "strict": True, "schema": artifact["schema"]}},
        }
        if args.source in {"native", "fixture"}:
            payload["cache_prompt"] = args.prefix_cache
        if args.disable_thinking:
            payload["chat_template_kwargs"] = {"enable_thinking": False}
        actual, error = None, None
        try:
            reply = request_completion(args.endpoint, payload, args.timeout, api_key)
        except (urllib.error.URLError, OSError, ValueError, KeyError, IndexError, TypeError) as exc:
            # Exception messages can echo Authorization values or server content.
            # Keep diagnostic categories, never arbitrary exception text.
            if isinstance(exc, urllib.error.HTTPError):
                detail = f"The completion endpoint returned HTTP {exc.code}."
            elif isinstance(exc, TimeoutError):
                detail = "The completion request timed out."
            elif isinstance(exc, (urllib.error.URLError, OSError)):
                detail = "The completion endpoint could not be reached."
            else:
                detail = "The completion endpoint returned an invalid response."
            reply = {"transport_error": detail, "error_type": type(exc).__name__, "outcome": "endpoint_error", "actual": None}
            attempts.append(reply)
            break
        if attempt_index:
            reply["correction_feedback"] = messages[-1]["content"]
        if args.disable_thinking and reply["reasoning_present"]:
            reply.update(actual=None, outcome="generation_mode_error", validation_error="The endpoint emitted reasoning despite enable_thinking:false.")
            attempts.append(reply)
            break
        try:
            if reply["output"]["truncated"]:
                raise PlanError("The model response exceeded the plan size limit.")
            actual = normalize(reply["output"]["text"], artifact["encoding"], context, reply["finish_reason"])
        except PlanError as exc:
            error = str(exc)
        incomplete = reply["finish_reason"] not in {"stop", "length"}
        if incomplete:
            actual, error = None, "The endpoint did not return a completed model response."
        reply.update(actual=actual, validation_error=error, outcome=classify(case["expected"], actual, error))
        attempts.append(reply)
        needs_repair = error is not None or actual == REFUSAL
        if not needs_repair or incomplete or attempt_index == 1:
            break
        # Only validation/refusal drives correction, never the semantic oracle.
        previous = bounded(reply["output"]["text"], MAX_REPAIR_TEXT)
        messages.extend([
            {"role": "assistant", "content": previous["text"]},
            {"role": "user", "content": correction(error or "The model marked this request as unsupported.", previous["truncated"])},
        ])
    final = attempts[-1]
    return {**case, "actual": final.get("actual"), "outcome": final["outcome"], "attempts": attempts}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def save(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2) + "\n")
    temporary.replace(path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=pathlib.Path, required=True, help="JSON with systemPrompt, schema, encoding, optional metadata")
    parser.add_argument("--corpus", type=pathlib.Path, default=ROOT / "evals/inference-corpus.json")
    parser.add_argument("--endpoint", default="http://127.0.0.1:18081/v1/chat/completions")
    parser.add_argument("--model", required=True)
    parser.add_argument("--source", choices=["native", "remote", "fixture"], required=True)
    parser.add_argument("--runtime", required=True, help="Runtime build, hardware/backend, quantization; do not imply browser equivalence")
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--split", choices=["all", "regression", "heldout"], default="all")
    parser.add_argument("--cases", help="Comma-separated case IDs")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--repair", action="store_true", help="One correction for refusal/invalid output; never repair based on expected answer")
    parser.add_argument("--disable-thinking", action="store_true", help="Set native chat_template_kwargs.enable_thinking=false and reject reasoning-bearing replies")
    parser.add_argument("--prefix-cache", action="store_true", help="Enable native prefix reuse; record requested policy and reported cached tokens")
    parser.add_argument("--api-key-env", default="TIME_BLAST_EVAL_API_KEY", help="Read credentials from this environment variable; never persist them")
    args = parser.parse_args(argv)
    if args.max_tokens < 1 or args.timeout <= 0:
        parser.error("--max-tokens and --timeout must be positive")
    if args.disable_thinking and args.source not in {"native", "fixture"}:
        parser.error("--disable-thinking is a native llama.cpp template option")
    if args.prefix_cache and args.source not in {"native", "fixture"}:
        parser.error("--prefix-cache is a native llama.cpp option")
    endpoint = urllib.parse.urlsplit(args.endpoint)
    if endpoint.scheme not in {"http", "https"} or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        parser.error("--endpoint must be an HTTP(S) completion URL without credentials, query or fragment")
    api_key = os.environ.get(args.api_key_env)
    if api_key and any(not 33 <= ord(character) <= 126 for character in api_key):
        parser.error("The API key must contain printable ASCII characters without whitespace.")
    artifact_bytes, corpus_bytes = args.artifact.read_bytes(), args.corpus.read_bytes()
    artifact, corpus = json.loads(artifact_bytes), json.loads(corpus_bytes)
    if artifact.get("encoding") not in {"full", "compact", "semantic", "semantic-v2", "semantic-v3", "semantic-v4"} or not isinstance(artifact.get("systemPrompt"), str) or not isinstance(artifact.get("schema"), dict):
        parser.error("Artifact requires systemPrompt, schema and full/compact/semantic/semantic-v2/semantic-v3/semantic-v4 encoding")
    if artifact.get("context") is not None and artifact["context"] != corpus["context"]:
        parser.error("Artifact and corpus contexts differ")
    cases = corpus["cases"]
    if len({case["id"] for case in cases}) != len(cases):
        parser.error("Corpus IDs must be unique")
    for case in cases:
        if case["expected"] != REFUSAL:
            validate_plan(case["expected"], corpus["context"])
    if args.split != "all":
        cases = [case for case in cases if case["split"] == args.split]
    if args.cases:
        selected = set(args.cases.split(","))
        missing = selected - {case["id"] for case in cases}
        if missing:
            parser.error("Unknown/excluded cases: " + ", ".join(sorted(missing)))
        cases = [case for case in cases if case["id"] in selected]
    if not cases:
        parser.error("Selection contains no cases")
    report = {
        "version": 1, "status": "running", "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source": args.source, "runtime": args.runtime, "requested_model": args.model,
        "evaluator_platform": platform.platform(), "python": platform.python_version(),
        "endpoint": args.endpoint, "artifact_sha256": sha256(artifact_bytes), "corpus_sha256": sha256(corpus_bytes),
        "evaluator_sha256": sha256(pathlib.Path(__file__).read_bytes()),
        "artifact": artifact, "context": corpus["context"],
        "settings": {"temperature": 0, "seed": args.seed, "max_tokens": args.max_tokens, "request_timeout_seconds": args.timeout, "repair": args.repair, "schema_constrained": True, "native_cache_prompt": args.prefix_cache if args.source in {"native", "fixture"} else None,
                     "chat_template_kwargs": {"enable_thinking": False} if args.disable_thinking else None},
        "selection": {"split": args.split, "ids": [case["id"] for case in cases]},
        "limitations": [
            "Native/remote reference evaluation is not browser WebGPU accuracy or latency.",
            "Recorded endpoint wall time includes transport and is diagnostic only; stages are not measured.",
            "Temperature zero and a fixed seed request repeatability; different runtimes/hardware can still differ.",
            "Native prefix reuse changes prefill work and can change floating-point execution. Compare its policy separately; it is not browser KV-cache evidence.",
            "The Python reference decoder is independent of the browser decoder; inspect bounded raw responses.",
            "After failures inform tuning, these examples are development data, not fresh heldout evidence.",
            "Correct refusals and invalid non-executable outputs are reported separately.",
        ], "results": [],
    }
    save(args.output, report)
    for case in cases:
        result = evaluate_case(case, artifact, corpus["context"], args, api_key)
        report["results"].append(result)
        report["summary"] = summarize(report["results"])
        save(args.output, report)
        print(case["id"], result["outcome"], json.dumps(result["actual"]), flush=True)
    report["status"] = "complete"
    report["completed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save(args.output, report)
    print(json.dumps(report["summary"], indent=2), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
