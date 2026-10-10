#!/usr/bin/env python3
"""Small, frozen semantic acceptance audit against the real Rust HTTP service.

  python3 tests/backend_meaning.py --endpoint http://127.0.0.1:8788/infer \
      --output /tmp/time-blast-backend-meaning.json
  python3 tests/backend_meaning.py --dry-run  # print cases; make no requests
  python3 tests/backend_meaning.py --self-test  # exercise scoring without a service

The eight questions and complete expected plans below are fixed before inference.
Only questions/context go to the service; expected answers are never transmitted.
No templates, browser, database, prompt edits, or model selection happen here.
HTTP bypasses the session plan cache. A service may make one correction attempt;
the unmodified diagnostics and error responses are retained in the report.

Exit 0: all selected cases match; 1: mismatch, transport error or incomplete run.
This is a small acceptance check, not an estimate of general model accuracy.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


CONTEXT = {
    "id": "backend-meaning-frozen-2026-10-10",
    "label": "North Atlantic synthetic telemetry acceptance context",
    "rowCount": 1_209_600,
    "start": 1788220800000,
    "end": 1789430400000,
    "vessels": ["Aurora", "Meridian", "Kestrel", "Solstice", "Atlas", "Nomad"],
    "description": "Six fictional vessels, one reading every six seconds, 1–14 September 2026 UTC. Synthetic data.",
}

CASES = [
    {
        "id": "named-vessel-max-wind-five-minutes",
        "question": "Show Meridian's maximum wind speed in 5-minute buckets over the last 48 hours.",
        "expected": {"metric": "wind", "aggregate": "max", "bucketMinutes": 5,
                     "windowHours": 48, "splitByVessel": False, "vessel": 1, "view": "line"},
    },
    {
        "id": "pooled-water-temperature-six-hours",
        "question": "Show average water temperature across all vessels together in 6-hour buckets over the last 7 days.",
        "expected": {"metric": "water_temp", "aggregate": "avg", "bucketMinutes": 360,
                     "windowHours": 168, "splitByVessel": False, "vessel": None, "view": "line"},
    },
    {
        "id": "vessel-density-hourly-day",
        "question": "Show a density map of vessel speeds in hourly buckets over the last 24 hours.",
        "expected": {"metric": "speed", "aggregate": "avg", "bucketMinutes": 60,
                     "windowHours": 24, "splitByVessel": True, "vessel": None, "view": "density"},
    },
    {
        "id": "wide-wave-surface-710-days",
        "question": "Compare vessel wave heights by hour over the last 710 days as a 3D surface.",
        "expected": {"metric": "wave_height", "aggregate": "avg", "bucketMinutes": 60,
                     "windowHours": 17040, "splitByVessel": True, "vessel": None, "view": "surface"},
    },
    {
        "id": "unsupported-value-filter",
        "question": "Show hourly average vessel speed over the last 24 hours, but only include readings where wind is above 20 knots.",
        "expected": {"error": "unsupported_request"},
    },
    {
        "id": "unsupported-correlation",
        "question": "Plot correlation between vessel speed and wave height over the last 7 days.",
        "expected": {"error": "unsupported_request"},
    },
    {
        "id": "unsupported-forecast",
        "question": "Forecast vessel wave height for the next 24 hours.",
        "expected": {"error": "unsupported_request"},
    },
    {
        "id": "unsupported-photo-and-speed",
        "question": "Show photos of Aurora alongside her average speed over the last 24 hours.",
        "expected": {"error": "unsupported_request"},
    },
]

REFUSAL = {"error": "unsupported_request"}
MAX_RESPONSE_BYTES = 65_536


def canonical(value):
    # JSON distinguishes true from 1, unlike Python's ordinary dictionary equality.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def classify(case, status, response, transport_error=None):
    if transport_error:
        return {"correct": False, "classification": "transport_error", "error": transport_error}
    if not isinstance(response, dict):
        return {"correct": False, "classification": "invalid_response", "error": "Expected a JSON object response"}
    wants_refusal = case["expected"] == REFUSAL
    if status == 200 and "plan" in response:
        if not wants_refusal and canonical(response["plan"]) == canonical(case["expected"]):
            return {"correct": True, "classification": "correct_plan"}
        return {"correct": False, "classification": "incorrect_plan", "error": "Returned plan does not match the frozen expected meaning"}
    failure = response.get("response")
    if status == 422 and isinstance(failure, dict) and failure.get("truncated") is False:
        try:
            generated = json.loads(failure.get("text", ""))
        except (ValueError, TypeError):
            generated = None
        # A failed HTTP request alone is never counted as a correct refusal.
        if generated == {"result": REFUSAL}:
            return {"correct": wants_refusal,
                    "classification": "correct_refusal" if wants_refusal else "incorrect_refusal",
                    **({} if wants_refusal else {"error": "The model refused a supported question"})}
    return {"correct": False, "classification": "inference_error",
            "error": response.get("message", f"Unexpected HTTP status {status}")}


def request_case(endpoint, case, revision, timeout):
    draft = {"text": case["question"], "revision": revision, "contextId": CONTEXT["id"], "sentAt": 0}
    payload = {"text": draft["text"], "revision": revision, "draft": draft,
               "context": CONTEXT, "cachePlans": False}
    request = Request(endpoint, data=json.dumps(payload).encode(),
                      headers={"Content-Type": "application/json", "Accept": "application/json"})
    started = time.perf_counter()
    status, response, error = None, None, None
    try:
        try:
            connection = urlopen(request, timeout=timeout)
        except HTTPError as http_error:
            connection = http_error
        with connection:
            status = connection.status
            raw = connection.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("Service response exceeded 64 KiB")
        try:
            response = json.loads(raw)
        except (ValueError, UnicodeError):
            response = {"invalidResponseText": raw[:2048].decode("utf-8", errors="replace")}
            error = "Service response was not valid JSON"
    except (URLError, TimeoutError, OSError, ValueError) as cause:
        error = f"{type(cause).__name__}: {cause}"
    return {"id": case["id"], "question": case["question"], "expected": case["expected"],
            "httpStatus": status, "wallMs": (time.perf_counter() - started) * 1000,
            "response": response, **classify(case, status, response, error)}


def write_report(report, destination):
    if destination:
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        temporary.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        temporary.replace(destination)


def self_test():
    for case in CASES:
        if case["expected"] == REFUSAL:
            response = {"response": {"text": canonical({"result": REFUSAL}), "truncated": False}}
            assert classify(case, 422, response)["correct"]
            assert not classify(case, 502, response)["correct"]
            assert not classify(case, 422, {"message": "Request failed"})["correct"]
        else:
            assert classify(case, 200, {"plan": case["expected"]})["correct"]
            malformed = {**case["expected"], "splitByVessel": int(case["expected"]["splitByVessel"])}
            assert not classify(case, 200, {"plan": malformed})["correct"]
        assert not classify(case, None, None, "Timed out")["correct"]
    assert not classify(CASES[0], 422, {"response": {"text": canonical({"result": REFUSAL}), "truncated": False}})["correct"]
    assert not classify(CASES[-1], 200, {"plan": CASES[0]["expected"]})["correct"]
    print(json.dumps({"selfTest": "passed", "networkRequests": 0, "cases": len(CASES)}))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", default="http://127.0.0.1:8788/infer")
    parser.add_argument("--output", type=Path, help="Write the frozen manifest before requests, then update after every response")
    parser.add_argument("--timeout", type=float, default=40, help="Per-request timeout in seconds")
    parser.add_argument("--dry-run", action="store_true", help="Print fixed expectations without contacting the backend")
    parser.add_argument("--self-test", action="store_true", help="Check audit scoring without network requests")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    endpoint = urlsplit(args.endpoint)
    if endpoint.scheme not in {"http", "https"} or not endpoint.netloc or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        parser.error("Use an HTTP(S) endpoint without embedded credentials, query parameters or fragments")
    if not 0 < args.timeout <= 300:
        parser.error("--timeout must be greater than 0 and at most 300 seconds")
    frozen = {"context": CONTEXT, "cases": CASES}
    report = {"audit": "eight-case-backend-meaning-v1", "endpoint": args.endpoint,
              "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "limitations": "Eight fixed acceptance cases; not a general accuracy estimate. HTTP has no plan cache. Model corrections remain enabled by the service.",
              "manifestSha256": hashlib.sha256(canonical(frozen).encode()).hexdigest(),
              "frozenBeforeRequests": frozen, "results": [], "complete": False}
    write_report(report, args.output)
    if args.dry_run:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0
    try:
        for revision, case in enumerate(CASES, 1):
            result = request_case(args.endpoint, case, revision, args.timeout)
            report["results"].append(result)
            write_report(report, args.output)
            print(f'{case["id"]}: {result["classification"]} ({result["wallMs"]:.1f} ms)', file=sys.stderr, flush=True)
    except KeyboardInterrupt:
        report["interrupted"] = True
        write_report(report, args.output)
        return 1
    report["complete"] = True
    report["summary"] = {"correct": sum(result["correct"] for result in report["results"]), "total": len(CASES),
                         "correctSupported": sum(result["classification"] == "correct_plan" for result in report["results"]),
                         "correctUnsupported": sum(result["classification"] == "correct_refusal" for result in report["results"])}
    write_report(report, args.output)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["summary"]["correct"] == len(CASES) else 1


if __name__ == "__main__":
    sys.exit(main())
