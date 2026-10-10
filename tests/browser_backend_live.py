#!/usr/bin/env python3
"""Paid-provider browser smoke: this script spends real inference-provider tokens.

The configured Rust service owns credentials; this script accepts no API key.
It sends three fixed synthetic-dataset questions with model-plan reuse disabled.
One question uses the two-second live-query pause; the others use Enter. It
checks the complete inferred plans, actual DuckDB results, SQL, and chart modes.

Local frontend and service:
  python3 tests/browser_backend_live.py --url http://127.0.0.1:5173 \
    --endpoint ws://127.0.0.1:8787/session --output /tmp/backend-live.json

Deployment already configured for remote inference:
  python3 tests/browser_backend_live.py \
    --url https://time-blast.46-224-133-201.sslip.io --output /tmp/backend-live.json

Requires Python Playwright/Chromium. There is no template or mock fallback.
The report is saved atomically after each case, including failed runs. This is
a correctness smoke with observed timings, not a latency distribution study.
"""
import argparse
import datetime
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit, urlunsplit

from playwright.sync_api import sync_playwright


CASES = [
    {"id": "waves-minute-week", "question": "Compare vessel wave height by minute over the last 7 days",
     "trigger": "enter", "points": 60_480,
     "plan": {"metric": "wave_height", "aggregate": "avg", "bucketMinutes": 1, "windowHours": 168,
              "splitByVessel": True, "vessel": None, "view": "line"}},
    {"id": "speeds-minute-day", "question": "Compare vessel speeds by minute over the last 24 hours",
     "trigger": "live-after-two-seconds", "points": 8_640,
     "plan": {"metric": "speed", "aggregate": "avg", "bucketMinutes": 1, "windowHours": 24,
              "splitByVessel": True, "vessel": None, "view": "line"}},
    {"id": "waves-hour-one-days-surface", "question": "Compare vessel wave height by hour over the last 1days as a 3D surface",
     "trigger": "enter", "points": 144,
     "plan": {"metric": "wave_height", "aggregate": "avg", "bucketMinutes": 60, "windowHours": 24,
              "splitByVessel": True, "vessel": None, "view": "surface"}},
]


def public_url(value):
    parts = urlsplit(value)
    # Endpoints are public configuration, but never persist query credentials.
    host = parts.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    if parts.port:
        host += f":{parts.port}"
    return urlunsplit((parts.scheme, host, parts.path, "", ""))


def save(report, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    temporary.write_text(json.dumps(report, indent=2) + "\n")
    temporary.replace(output)


def run(arguments, report):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=not arguments.headed, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.set_default_timeout(60_000)
        report["browser"] = browser.version
        sent, received, model_downloads, errors = [], [], [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script("""
          delete Navigator.prototype.gpu;
          window.__backendLiveInputAt = 0;
          window.__backendLiveSends = [];
          document.addEventListener('input', event => {
            if (event.target.matches?.('[data-el=input]')) window.__backendLiveInputAt = performance.now();
          }, true);
          const originalSend = WebSocket.prototype.send;
          WebSocket.prototype.send = function(data) {
            if (this.protocol === 'time-blast.inference.v1' && typeof data === 'string') {
              const message = JSON.parse(data);
              if (message.type === 'INFER') window.__backendLiveSends.push({
                id: message.id, text: message.draft.text, at: performance.now(),
                inputAt: window.__backendLiveInputAt,
              });
            }
            return originalSend.call(this, data);
          };
        """)
        page.on("request", lambda request: model_downloads.append(public_url(request.url))
                if any(marker in request.url for marker in ["huggingface.co", "ndarray-cache.json", "params_shard_"]) else None)

        def socket_opened(connection):
            def frame(target, payload):
                try:
                    value = json.loads(payload)
                except (ValueError, TypeError):
                    return
                if isinstance(value, dict):
                    target.append({"endpoint": public_url(connection.url), "message": value})
            connection.on("framesent", lambda payload: frame(sent, payload))
            connection.on("framereceived", lambda payload: frame(received, payload))

        page.on("websocket", socket_opened)
        try:
            response = page.goto(arguments.url, wait_until="domcontentloaded")
            assert response and response.status == 200, "Frontend document failed to load"
            assert page.evaluate("!('gpu' in navigator)"), "WebGPU must be unavailable in this smoke"
            page.locator('[data-stage="database"][data-state="ready"]').wait_for(state="attached")
            assert "1,209,600" in page.locator('[data-el="dataset-sub"]').inner_text(), "Dense synthetic dataset required"
            page.get_by_role("button", name="Runtime settings", exact=True).click()
            if arguments.endpoint:
                page.locator('[name="inferenceMode"]').select_option("remote")
                page.locator('[name="inferenceEndpoint"]').fill(arguments.endpoint)
            else:
                assert page.locator('[name="inferenceMode"]').input_value() == "remote", "Deployment is not defaulting to backend inference"
            endpoint = page.locator('[name="inferenceEndpoint"]').input_value()
            assert urlsplit(endpoint).scheme in ("ws", "wss"), "This smoke requires the persistent inference socket"
            assert page.locator('[name="databaseMode"]').input_value() == "browser", "Browser DuckDB required"
            assert page.locator('[name="coordinatorMode"]').input_value() == "browser", "Browser coordinator required"
            page.locator('[name="cacheModelPlans"]').uncheck()
            page.locator('[name="liveQuery"]').check()
            page.locator('[name="liveTranslation"]').check()
            page.get_by_role("button", name="Apply runtime").click()
            page.locator('[data-stage="coordinator"][data-state="ready"]').wait_for(state="attached")
            page.locator('[data-stage="model"][data-state="ready"]').wait_for(state="attached")
            assert page.locator('[data-action="live-query"]').get_attribute("aria-checked") == "true"
            report.update({"endpoint": public_url(endpoint), "planCacheEnabled": False,
                           "sourceRows": 1_209_600, "webgpuAvailable": False,
                           "providerWarmth": "unknown; service readiness is not provider warmup"})
            save(report, arguments.output)

            for index, case in enumerate(CASES):
                result = {"id": case["id"], "question": case["question"], "trigger": case["trigger"],
                          "expectedPlan": case["plan"], "expectedPoints": case["points"], "correct": False}
                report["cases"].append(result)
                save(report, arguments.output)
                sent_start, received_start = len(sent), len(received)
                page.locator('[data-el="input"]').fill(case["question"])
                if case["trigger"] == "enter":
                    page.locator('[data-el="input"]').press("Enter")
                card = page.locator('.result-card').nth(index)
                card.wait_for(state="attached")
                page.wait_for_function("""index => {
                  const card = document.querySelectorAll('.result-card')[index];
                  return ['COMPLETE','QUERY ERROR','CANCELED','SUPERSEDED','DRAFT CHANGED'].includes(
                    card?.querySelector('[data-card-el=result-state]')?.textContent.trim());
                }""", arg=index, timeout=45_000)
                fields = card.evaluate("""card => {
                  const get = name => card.querySelector('[data-card-el="'+name+'"]')?.textContent.trim();
                  return {state:get('result-state'),source:get('source'),points:get('points'),
                    representation:card.querySelector('[data-card-el=representation]').value,
                    queryMeta:get('query-meta'),sql:get('sql'),inferenceDetail:get('inference-detail'),
                    latencyDetail:get('latency-detail'),error:get('empty-detail'),
                    timing:{runToDraw:get('latency'),inference:get('inference-latency'),
                      databaseFirst:get('database-first-latency'),databaseTotal:get('database-latency'),
                      dataToDraw:get('render-latency')}};
                }""")
                result["card"] = fields
                requests = [frame["message"] for frame in sent[sent_start:]
                            if frame["endpoint"] == public_url(endpoint)
                            and frame["message"].get("type") == "INFER"
                            and frame["message"].get("draft", {}).get("text") == case["question"]]
                result["inferenceRequests"] = [{"id": item["id"], "revision": item["draft"]["revision"],
                                                  "cachePlans": item.get("cachePlans")} for item in requests]
                assert len(requests) == 1, f"Expected exactly one uncached inference request: {requests}"
                request = requests[0]
                assert request.get("cachePlans") is False, "Cache must be disabled on the actual request"
                replies = [frame["message"] for frame in received[received_start:]
                           if frame["endpoint"] == public_url(endpoint) and frame["message"].get("id") == request["id"]
                           and frame["message"].get("type") in ("RESULT", "ERROR")]
                assert len(replies) == 1, f"Expected one identified terminal provider response: {replies}"
                result["response"] = replies[0]
                browser_request = page.evaluate("id => __backendLiveSends.find(item => item.id === id)", request["id"])
                assert browser_request, "Missing same-clock dispatch measurement"
                result["inputToInferenceDispatchMs"] = browser_request["at"] - browser_request["inputAt"]
                save(report, arguments.output)
                assert replies[0]["type"] == "RESULT", f"Backend inference failed: {replies[0]}"
                actual = replies[0]["result"]
                assert actual["plan"] == case["plan"], f"Wrong meaning: {actual['plan']}"
                assert actual.get("model"), "Model identity not reported"
                assert not actual.get("diagnostics", {}).get("cacheHit"), "A cached answer is not a generation test"
                assert fields["state"] == "COMPLETE", fields
                assert fields["source"] == "REMOTE MODEL", "Templates or cache must never satisfy this smoke"
                assert int(fields["points"].replace(",", "")) == case["points"], fields
                assert fields["representation"] == case["plan"]["view"], fields
                contexts = [frame["message"]["context"] for frame in sent
                            if frame["endpoint"] == public_url(endpoint) and frame["message"].get("type") == "HELLO"]
                assert contexts, "Session did not transmit dataset context"
                context = contexts[-1]
                plan = case["plan"]
                bucket_ms = plan["bucketMinutes"] * 60_000
                start = max(context["start"], context["end"] - plan["windowHours"] * 3_600_000)
                expected_sql = [f"floor(t / {bucket_ms}) * {bucket_ms}", f"avg({plan['metric']})::DOUBLE AS y",
                                "vessel::INTEGER AS series", "FROM telemetry",
                                f"WHERE t >= {start} AND t < {context['end']}", "GROUP BY 1, 3", "ORDER BY 1, 3"]
                result["expectedSqlFragments"] = expected_sql
                sql = " ".join(fields["sql"].split())
                assert all(fragment in sql for fragment in expected_sql), f"SQL does not match inferred intent: {sql}"
                assert all(value and value != "—" for value in fields["timing"].values()), fields["timing"]
                if case["trigger"] == "live-after-two-seconds":
                    assert result["inputToInferenceDispatchMs"] >= 2000, "Live inference bypassed the two-second pause"
                    assert card.get_attribute("data-live-preview") == "true"
                    page.locator('[data-el="input"]').press("Enter")
                    assert card.get_attribute("data-live-preview") is None, "Enter did not keep the existing preview"
                result["correct"] = True
                save(report, arguments.output)
            page.locator('[data-el="input"]').fill("")
            page.locator('[data-action="fit"]').click()
            if arguments.screenshot:
                # Fit can change visibility and backing sizes. Let the layout /
                # ResizeObserver cycle run before testing renderer completion,
                # otherwise the screenshot can capture an earlier COMPLETE label
                # immediately before the resized chart starts drawing again.
                page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                page.wait_for_function("""count => {
                  const cards = [...document.querySelectorAll('.result-card')];
                  const viewport = document.querySelector('[data-el=board-viewport]').getBoundingClientRect();
                  return cards.length === count && cards.every(card => {
                    const rect = card.getBoundingClientRect();
                    return rect.right > viewport.left && rect.left < viewport.right &&
                      rect.bottom > viewport.top && rect.top < viewport.bottom &&
                      card.querySelector('[data-card-el=result-state]')?.textContent.trim() === 'COMPLETE';
                  });
                }""", arg=len(CASES), timeout=15_000)
                arguments.screenshot.parent.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(arguments.screenshot), full_page=True)
                report["screenshot"] = str(arguments.screenshot)
                report["screenshotAllCardsComplete"] = True
            assert not errors, errors
            assert not model_downloads, model_downloads
            assert sum(frame["message"].get("type") == "INFER" for frame in sent) == len(CASES), "Unexpected extra inference requests"
            report["success"] = True
        finally:
            report["pageErrors"] = errors
            report["webgpuModelDownloads"] = model_downloads
            report["inferenceRequestCount"] = sum(frame["message"].get("type") == "INFER" for frame in sent)
            save(report, arguments.output)
            browser.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:5173")
    parser.add_argument("--endpoint", help="Select this WS(S) inference endpoint; otherwise require deployed remote default")
    parser.add_argument("--output", type=Path, default=Path("/tmp/time-blast-backend-live.json"))
    parser.add_argument("--screenshot", type=Path)
    parser.add_argument("--headed", action="store_true")
    arguments = parser.parse_args()
    report = {"startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "url": public_url(arguments.url), "kind": "real-provider browser correctness smoke",
              "limit": "Three fixed questions, model-plan cache disabled; correction can add provider generations.",
              "timingLimit": "Observed software timings only; no distribution, GPU isolation, or photon measurement.",
              "success": False, "cases": []}
    print("This smoke spends real provider tokens for three questions (plus corrections if needed).", file=sys.stderr)
    status = 0
    try:
        run(arguments, report)
    except Exception as error:
        report["failure"] = f"{type(error).__name__}: {error}"
        status = 1
    finally:
        save(report, arguments.output)
        print(json.dumps(report, indent=2))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
