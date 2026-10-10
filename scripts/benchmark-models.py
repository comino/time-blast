#!/usr/bin/env python3
"""Compare OpenRouter models through isolated copies of the real Rust service.

Requires OPENROUTER_API_KEY in the environment; never passes credentials in argv.
No deployed service is reconfigured. Every question is sent sequentially with
plan caching disabled; model order rotates for each of 12 reused development
and acceptance cases. These are not held-out model-selection questions.

  python3 scripts/benchmark-models.py --binary /path/to/time-blast-inference \
      --catalog /path/to/openrouter-models.json --output /path/to/report.json

Use --model MODEL[:EFFORT[:TEMPERATURE]] repeatedly to replace the shortlist.
EFFORT is omitted, none, minimal, low, medium or high. TEMPERATURE is 0
or provider (omit temperature). A model identifier may not contain a colon.
The default Google 3.5 profile omits temperature, which that model disallows.
Exit 0 means the run completed, not that every model passed every question.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import statistics
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


meaning = load_module("backend_meaning", ROOT / "tests/backend_meaning.py")
known = load_module("benchmark_backend", ROOT / "scripts/benchmark-backend.py")
DEFAULT_MODELS = [
    "google/gemini-2.5-flash-lite:omitted:0",
    "google/gemini-3.5-flash-lite:minimal:provider",
    "qwen/qwen3.5-flash-02-23:none:0",
    "google/gemma-4-26b-a4b-it:none:0",
    "mistralai/ministral-3b-2512:omitted:0",
]


def profile(spec):
    fields = spec.split(":")
    if not 1 <= len(fields) <= 3 or not fields[0] or len(fields[0]) > 200:
        raise argparse.ArgumentTypeError("Expected MODEL[:EFFORT[:TEMPERATURE]]")
    model = fields[0]
    effort = fields[1] if len(fields) > 1 else "omitted"
    temperature = fields[2] if len(fields) > 2 else "0"
    if effort not in {"omitted", "none", "minimal", "low", "medium", "high"}:
        raise argparse.ArgumentTypeError("Invalid reasoning effort")
    if temperature not in {"0", "provider"}:
        raise argparse.ArgumentTypeError("Temperature must be 0 or provider")
    return {"model": model, "reasoningEffort": effort, "temperature": temperature,
            "maxCompletionTokens": 256, "timeoutSeconds": 25}


def cases():
    development = []
    for index, (question, metric, bucket, hours, view) in enumerate(known.CASES, 1):
        development.append({"id": f"known-{index}-{metric}-{view}", "question": question,
                            "source": "scripts/benchmark-backend.py",
                            "expected": {"metric": metric, "aggregate": "avg", "bucketMinutes": bucket,
                                         "windowHours": hours, "splitByVessel": True, "vessel": None, "view": view}})
    return development + [{**case, "source": "tests/backend_meaning.py"} for case in meaning.CASES]


def catalog_metadata(path, profiles):
    if path is None:
        return None
    raw = path.read_bytes()
    document = json.loads(raw)
    models = document.get("data", []) if isinstance(document, dict) else document
    selected = {p["model"] for p in profiles}
    return {"snapshotSha256": hashlib.sha256(raw).hexdigest(),
            "source": "https://openrouter.ai/api/v1/models",
            "pricingCaveat": "Catalog prices are indicative, not measured charges. Latency routing can select a more expensive endpoint.",
            "models": [{key: model[key] for key in ("id", "name", "created", "pricing", "supported_parameters", "default_parameters", "reasoning") if key in model}
                       for model in models if isinstance(model, dict) and model.get("id") in selected]}


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def start_service(binary, selected):
    # Remove ambient prototype settings, including alternate API keys/endpoints.
    environment = {key: value for key, value in os.environ.items() if not key.startswith("TIME_BLAST_")}
    environment.update({"TIME_BLAST_MODEL": selected["model"], "TIME_BLAST_OPENROUTER": "true",
                        "TIME_BLAST_PROVIDER_URL": "https://openrouter.ai/api/v1/chat/completions",
                        "TIME_BLAST_ALLOWED_ORIGINS": "http://127.0.0.1:5173",
                        "TIME_BLAST_TIMEOUT_SECONDS": "25", "TIME_BLAST_MAX_CONCURRENT": "1",
                        "TIME_BLAST_REQUESTS_PER_MINUTE": "1000", "TIME_BLAST_REQUESTS_PER_DAY": "10000",
                        "TIME_BLAST_TEMPERATURE": selected["temperature"]})
    if selected["reasoningEffort"] != "omitted":
        environment["TIME_BLAST_REASONING_EFFORT"] = selected["reasoningEffort"]
    for _ in range(5):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        environment["TIME_BLAST_BIND"] = f"127.0.0.1:{port}"
        endpoint = f"http://127.0.0.1:{port}"
        # The actual service can log provider errors. Never capture inherited
        # environment or provider output in generic startup diagnostics.
        process = subprocess.Popen([str(binary)], env=environment, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and process.poll() is None:
                try:
                    with urlopen(endpoint + "/health", timeout=0.5) as response:
                        health = json.load(response)
                    if health.get("model") == selected["model"] and process.poll() is None:
                        return process, endpoint + "/infer", health
                except (URLError, TimeoutError, OSError, ValueError):
                    pass
                time.sleep(0.05)
        except BaseException:
            stop(process)
            raise
        stop(process)
    raise RuntimeError(f"Isolated service did not become ready for {selected['model']}")


def median(values):
    return round(statistics.median(values), 3) if values else None


def summaries(profiles, rows):
    summaries = []
    for selected in profiles:
        results = [row for row in rows if row["profile"] == selected]
        supported = [row for row in results if row["expected"] != meaning.REFUSAL]
        correct = [row for row in supported if row["classification"] == "correct_plan"]
        diagnostics = []
        for row in results:
            response = row.get("response")
            data = response.get("diagnostics") if isinstance(response, dict) else None
            diagnostics.append(data if isinstance(data, dict) else {})
        counts = {}
        for row in results:
            label = row["classification"]
            counts[label] = counts.get(label, 0) + 1
        summaries.append({"profile": selected, "completedRequests": len(results),
                          "supportedRequests": len(supported), "unsupportedRequests": len(results) - len(supported),
                          "correctSupported": len(correct), "correctRefusals": counts.get("correct_refusal", 0),
                          "classifications": counts,
                          "medianAllSupportedWallMs": median([row["wallMs"] for row in supported]),
                          "medianCorrectSupportedWallMs": median([row["wallMs"] for row in correct]),
                          "requestsWithCorrections": sum((d.get("attempts") or 0) > 1 for d in diagnostics),
                          "reportedGenerationAttempts": sum(d.get("attempts") or 0 for d in diagnostics),
                          "requestsWithReportedAttempts": sum("attempts" in d for d in diagnostics),
                          "reportedPromptTokens": sum(d.get("promptTokens") or 0 for d in diagnostics),
                          "reportedCompletionTokens": sum(d.get("completionTokens") or 0 for d in diagnostics),
                          "requestsWithReportedCompletionTokens": sum("completionTokens" in d for d in diagnostics)})
    return summaries


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--catalog", type=Path)
    parser.add_argument("--model", action="append", type=profile, help="Repeat to replace the default shortlist")
    parser.add_argument("--self-test", action="store_true", help="Verify scoring and summaries without any network requests")
    args = parser.parse_args()
    profiles = args.model or [profile(spec) for spec in DEFAULT_MODELS]
    if args.self_test:
        meaning.self_test()
        expected = cases()[0]["expected"]
        sample = [{"profile": profiles[0], "expected": expected, "classification": "correct_plan", "wallMs": 100,
                   "response": {"diagnostics": {"attempts": 2, "completionTokens": 5}}},
                  {"profile": profiles[0], "expected": expected, "classification": "inference_error", "wallMs": 900,
                   "response": None},
                  {"profile": profiles[0], "expected": meaning.REFUSAL, "classification": "correct_refusal", "wallMs": 1,
                   "response": {}}]
        summary = summaries(profiles[:1], sample)[0]
        assert len(cases()) == 12
        assert summary["medianAllSupportedWallMs"] == 500
        assert summary["medianCorrectSupportedWallMs"] == 100
        assert summary["correctRefusals"] == 1 and summary["requestsWithCorrections"] == 1
        assert profile("test/model")["reasoningEffort"] == "omitted"
        assert profile("test/model:none")["temperature"] == "0"
        assert profile("test/model:minimal:provider")["temperature"] == "provider"
        print(json.dumps({"selfTest": "passed", "networkRequests": 0, "matrixCases": 12}))
        return 0
    if args.binary is None or args.output is None:
        parser.error("--binary and --output are required")
    binary = args.binary.resolve()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        parser.error("--binary must be an executable file")
    if not os.environ.get("OPENROUTER_API_KEY"):
        parser.error("Set OPENROUTER_API_KEY in the environment")
    if len({meaning.canonical(p) for p in profiles}) != len(profiles):
        parser.error("Duplicate profiles are not allowed")
    frozen = {"context": meaning.CONTEXT, "cases": cases(), "profiles": profiles,
              "order": "For case index i, rotate profiles left by i modulo model count; requests are sequential.",
              "requestsPerModel": 12, "applicationPlanCache": False}
    with binary.open("rb") as executable:
        binary_sha256 = hashlib.file_digest(executable, "sha256").hexdigest()
    report = {"benchmark": "rust-openrouter-model-matrix-v1", "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "binarySha256": binary_sha256,
              "manifestSha256": hashlib.sha256(meaning.canonical(frozen).encode()).hexdigest(),
              "frozenBeforeRequests": frozen, "catalog": catalog_metadata(args.catalog, profiles),
              "limits": "Twelve reused development/acceptance cases, not held-out accuracy or a latency distribution. "
                        "Same Rust prompt/schema, 256-token completion budget and one correction attempt; reasoning may consume the budget. "
                        "HTTP connections to Rust are new per request; each model has its own reusable provider pool. "
                        "Startup only warms transport. Provider route, queue, cache and model cold/warm state are uncontrolled. "
                        "Medians include errors for all-supported results and are separately shown for correct supported plans. "
                        "Unsupported refusals are excluded from both latency medians. No browser, database, photons or p95 measured.",
              "services": [], "results": [], "summary": [], "complete": False}
    # Freeze the complete comparison before starting any service/provider warmup.
    meaning.write_report(report, args.output)
    services = []
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    previous_sigterm = signal.signal(signal.SIGTERM, interrupted)
    try:
        for selected in profiles:
            process, endpoint, health = start_service(binary, selected)
            services.append((process, endpoint))
            report["services"].append({"profile": selected, "endpoint": endpoint, "health": health})
            meaning.write_report(report, args.output)
            print(f"Ready: {selected['model']} ({selected['reasoningEffort']}, temperature {selected['temperature']})", flush=True)
        revision = 0
        for case_index, case in enumerate(frozen["cases"]):
            for offset in range(len(profiles)):
                model_index = (case_index + offset) % len(profiles)
                revision += 1
                selected = profiles[model_index]
                row = meaning.request_case(services[model_index][1], case, revision, timeout=35)
                row.update({"profile": selected, "sequence": revision, "caseIndex": case_index,
                            "recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()})
                report["results"].append(row)
                report["summary"] = summaries(profiles, report["results"])
                meaning.write_report(report, args.output)
                print(f"{revision}/{12 * len(profiles)} {selected['model']} {case['id']}: "
                      f"{row['classification']} ({row['wallMs']:.1f} ms)", flush=True)
        report["complete"] = True
    except KeyboardInterrupt:
        report["interrupted"] = True
    except Exception as error:
        report["runnerError"] = f"{type(error).__name__}: {error}"
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        for process, _ in services:
            stop(process)
        report["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        meaning.write_report(report, args.output)
        signal.signal(signal.SIGTERM, previous_sigterm)
    print(json.dumps({"complete": report["complete"], "output": str(args.output), "summary": report["summary"]}, indent=2))
    return 0 if report["complete"] else 1


if __name__ == "__main__":
    sys.exit(main())
