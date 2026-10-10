"""Exercise the Rust backend through real WebSocket/HTTP/SSE and browser DuckDB.

Start Vite separately, compile crates/inference-server, then run this file with
--binary pointing to time-blast-inference. The script owns an ephemeral loopback
mock provider and Rust process. No API key, WebGPU weights, or external model is
used. Timings below describe this fixture, not real-provider performance.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from playwright.sync_api import sync_playwright


WAVES = "Compare vessel wave height by minute over the last 7 days"
WIND = "Compare vessel wind by hour over the last 24 hours"
SLOW = "Compare vessel speeds by hour over the last 24 hours slow fixture"


class ProviderFixture:
    def __init__(self):
        self.lock = threading.Lock()
        self.calls = []

    def snapshot(self):
        with self.lock:
            return [dict(call) for call in self.calls]

    def handler(self):
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def do_POST(self):
                size = int(self.headers.get("Content-Length", "0"))
                if self.path != "/v1/chat/completions" or not 0 < size <= 65_536:
                    self.send_error(400)
                    return
                request = json.loads(self.rfile.read(size))
                messages = request.get("messages", [])
                user = next((m.get("content", "") for m in messages if m.get("role") == "user"), "")
                record = {"request": request, "started": time.monotonic(),
                          "question": user, "disconnected": False, "complete": False}
                with fixture.lock:
                    fixture.calls.append(record)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True

                def event(payload):
                    raw = payload if isinstance(payload, str) else json.dumps(payload)
                    self.wfile.write(("data: " + raw + "\n\n").encode())
                    self.wfile.flush()

                try:
                    event({"choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})
                    if "slow fixture" in user.lower():
                        # Heartbeats expose an actually closed upstream socket;
                        # cancellation must not just hide the result in the UI.
                        for _ in range(200):
                            self.wfile.write(b": fixture still working\n\n")
                            self.wfile.flush()
                            time.sleep(0.025)
                        with fixture.lock:
                            record["complete"] = True
                        return
                    question = user.lower()
                    plan = {"metric": "wave_height" if "wave" in question else "wind" if "wind" in question else "speed",
                            "aggregate": "avg", "bucketMinutes": 1 if "minute" in question else 60,
                            "windowHours": 168 if "7 days" in question else 24,
                            "splitByVessel": True, "vessel": None,
                            "view": "surface" if "surface" in question else "line"}
                    if "repair fixture" in question and not any(m.get("role") == "assistant" for m in messages):
                        plan["bucketMinutes"] = 2  # Well-formed JSON that violates the independent allowlist.
                    text = json.dumps({"result": plan}, separators=(",", ":"))
                    # Include role-only and usage-only events and split the JSON
                    # across provider tokens. No partial plan may run as SQL.
                    for start in range(0, len(text), 23):
                        time.sleep(0.005)
                        event({"choices": [{"index": 0, "delta": {"content": text[start:start + 23]},
                                             "finish_reason": None}]})
                    event({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
                    event({"choices": [], "usage": {"prompt_tokens": 321, "completion_tokens": 47,
                                                       "total_tokens": 368}})
                    event("[DONE]")
                    with fixture.lock:
                        record["complete"] = True
                except (BrokenPipeError, ConnectionResetError):
                    with fixture.lock:
                        record["disconnected"] = True

        return Handler


def unused_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


@contextlib.contextmanager
def backend(binary, browser_url, fixture):
    provider = ThreadingHTTPServer(("127.0.0.1", 0), fixture.handler())
    provider.daemon_threads = True
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    port = unused_port()
    origin = urlsplit(browser_url)
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith("TIME_BLAST_") and key != "OPENROUTER_API_KEY"}
    environment.update({"TIME_BLAST_BIND": f"127.0.0.1:{port}",
                        "TIME_BLAST_PROVIDER_URL": f"http://127.0.0.1:{provider.server_port}/v1/chat/completions",
                        "TIME_BLAST_MODEL": "test-model", "TIME_BLAST_OPENROUTER": "false",
                        "TIME_BLAST_ALLOWED_ORIGINS": f"{origin.scheme}://{origin.netloc}"})
    with tempfile.TemporaryFile(mode="w+t") as log:
        process = subprocess.Popen([str(binary)], env=environment, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 20
            while True:
                if process.poll() is not None:
                    log.seek(0)
                    raise AssertionError("Rust backend exited during startup:\n" + log.read())
                try:
                    with urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                        health = json.load(response)
                    break
                except (URLError, TimeoutError):
                    if time.monotonic() >= deadline:
                        raise AssertionError("Rust backend did not become healthy")
                    time.sleep(0.05)
            yield f"ws://127.0.0.1:{port}/session", health
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            provider.shutdown()
            provider.server_close()


def run(url, binary):
    fixture = ProviderFixture()
    with backend(binary, url, fixture) as (endpoint, health), sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.set_default_timeout(60_000)
        errors, model_assets, sockets, sent, received = [], [], [], [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script("delete Navigator.prototype.gpu;")
        page.on("request", lambda request: model_assets.append(request.url)
                if any(marker in request.url for marker in ["huggingface.co", "ndarray-cache.json", "params_shard_"]) else None)

        def socket_opened(connection):
            if connection.url != endpoint:
                return
            sockets.append(connection.url)

            def frame(target, payload):
                target.append({"at": time.monotonic(), "message": json.loads(payload)})

            connection.on("framesent", lambda payload: frame(sent, payload))
            connection.on("framereceived", lambda payload: frame(received, payload))

        page.on("websocket", socket_opened)
        page.goto(url, wait_until="domcontentloaded")
        page.locator('[data-stage="database"][data-state="ready"]').wait_for(state="attached")
        assert "1,209,600" in page.locator('[data-el="dataset-sub"]').inner_text()
        page.get_by_role("button", name="Runtime settings", exact=True).click()
        page.locator('[name="inferenceMode"]').select_option("remote")
        page.locator('[name="inferenceEndpoint"]').fill(endpoint)
        page.locator('[name="cacheModelPlans"]').check()
        page.get_by_role("button", name="Apply runtime").click()
        page.locator('[data-stage="coordinator"][data-state="ready"]').wait_for(state="attached")
        page.locator('[data-stage="model"][data-state="ready"]').wait_for(state="attached")
        assert len(sockets) == 1, sockets
        assert fixture.snapshot() == [], "Connection readiness must not generate a paid model request"
        assert page.locator('[data-action="live-query"]').get_attribute("aria-checked") == "true"
        page.evaluate("""() => {
          window.__lastTypedAt = 0; window.__inferenceSentAt = [];
          document.querySelector('[data-el=input]').addEventListener('input', () => {
            window.__lastTypedAt = performance.now();
          }, true);
          const send = WebSocket.prototype.send;
          WebSocket.prototype.send = function(data) {
            if (this.protocol === 'time-blast.inference.v1' && typeof data === 'string' && JSON.parse(data).type === 'INFER')
              window.__inferenceSentAt.push(performance.now());
            return send.call(this, data);
          };
        }""")

        def complete(points, cached=False):
            try:
                page.wait_for_function("""expected =>
                  document.querySelector('[data-el="result-state"]')?.textContent.trim()==='COMPLETE' &&
                  document.querySelector('[data-el="points"]')?.textContent.replaceAll(',','')===String(expected.points) &&
                  document.querySelector('[data-el="source"]')?.textContent.trim()===expected.source
                """, arg={"points": points, "source": "CACHED MODEL PLAN" if cached else "REMOTE MODEL"}, timeout=20_000)
            except Exception as error:
                cards = page.locator('.result-card').evaluate_all("""cards => cards.map(card => ({
                  prompt: card.getAttribute('aria-label'), selected: card.dataset.selected,
                  state: card.querySelector('[data-card-el=result-state]')?.textContent,
                  points: card.querySelector('[data-card-el=points]')?.textContent,
                  source: card.querySelector('[data-card-el=source]')?.textContent,
                  detail: card.querySelector('[data-card-el=empty-detail]')?.textContent
                }))""")
                raise AssertionError(json.dumps({"expectedPoints": points, "cards": cards,
                                                  "received": received[-4:], "errors": errors}, indent=2)) from error

        # The typing channel transmits immediately, but model work waits 2s.
        page.locator('[data-el="input"]').fill(WAVES)
        complete(60_480)
        calls = fixture.snapshot()
        assert len(calls) == 1, calls
        delay_ms = page.evaluate("__inferenceSentAt[0] - __lastTypedAt")
        assert delay_ms >= 2000, ("Live inference ignored the 2s quiet period", delay_ms)
        draft_times = [item["at"] for item in sent if item["message"].get("type") == "DRAFT"
                       and item["message"].get("draft", {}).get("text") == WAVES]
        assert draft_times and min(draft_times) < calls[0]["started"], sent
        assert page.locator('.result-card[data-live-preview="true"]').count() == 1
        for name in ["inference-latency", "database-first-latency", "database-latency", "render-latency"]:
            assert page.locator(f'[data-el="{name}"]').inner_text() != "—", name
        detail = page.locator('[data-el="inference-detail"]').text_content()
        assert "First token:" in detail and "Generation wall time:" in detail, detail
        assert "Input: 321 tokens" in detail and "Output: 47 tokens" in detail, detail
        assert "test-model" in page.locator('[data-el="query-meta"]').text_content()
        assert "read-only DuckDB snapshot" in page.locator('[data-el="sql"]').text_content()
        page.locator('[data-el="input"]').press("Enter")
        assert page.locator('.result-card[data-live-preview="true"]').count() == 0
        assert len(fixture.snapshot()) == 1, "Keeping a complete live preview regenerated the model"

        # A different committed question uses the same session/context immediately.
        page.locator('[data-el="input"]').fill(WIND)
        page.locator('[data-el="input"]').press("Enter")
        complete(144)
        assert len(fixture.snapshot()) == 2
        assert len(sockets) == 1
        hello = [item["message"] for item in sent if item["message"].get("type") == "HELLO"]
        assert len(hello) == 1 and hello[0]["context"]["rowCount"] == 1_209_600, hello
        infer = [item["message"] for item in sent if item["message"].get("type") == "INFER"]
        assert len(infer) == 2 and all("context" not in item for item in infer), infer

        # Repeated exact question uses the service's bounded session plan cache.
        page.locator('[data-el="input"]').fill(WAVES)
        page.locator('[data-el="input"]').press("Enter")
        complete(60_480, cached=True)
        assert len(fixture.snapshot()) == 2, "Exact repeated question regenerated the provider"
        assert "cache hit" in page.locator('[data-el="inference-detail"]').text_content()
        assert any(item["message"].get("type") == "RESULT"
                   and item["message"].get("result", {}).get("diagnostics", {}).get("cacheHit")
                   for item in received), "Cache hit was not reported by the backend"

        # Cancel a live stream and verify upstream disconnect, not just UI silence.
        page.locator('[data-el="input"]').fill(SLOW)
        deadline = time.monotonic() + 15
        while not any("slow fixture" in call["question"] for call in fixture.snapshot()):
            assert time.monotonic() < deadline, "Slow fixture request did not start"
            page.wait_for_timeout(25)
        page.locator('[data-card-action="cancel"]:visible').last.click()
        page.locator('[data-el="input"]').fill("")
        deadline = time.monotonic() + 3
        while not any(call["disconnected"] for call in fixture.snapshot()):
            assert time.monotonic() < deadline, "Cancel did not close the provider stream"
            page.wait_for_timeout(25)
        slow = next(call for call in fixture.snapshot() if "slow fixture" in call["question"])
        assert slow["disconnected"] and not slow["complete"], slow
        assert any(item["message"].get("type") == "CANCEL" for item in sent), sent

        # The ordinary HTTP adapter contract also reaches the same validator and
        # one-correction path. A caller's schema cannot authorize a 2-minute bucket.
        http_url = endpoint.replace("ws://", "http://").removesuffix("/session") + "/infer"
        question = WIND + " repair fixture"
        payload = {"text": question, "revision": 1,
                   "draft": {"text": question, "revision": 1, "contextId": hello[0]["context"]["id"], "sentAt": 0},
                   "context": hello[0]["context"], "schema": {"allowArbitrarySql": True}}
        request = Request(http_url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=10) as response:
            repaired = json.load(response)
        assert repaired["plan"]["bucketMinutes"] == 60, repaired
        assert repaired["diagnostics"]["attempts"] == 2, repaired
        assert repaired["diagnostics"]["completionTokens"] == 94, repaired
        repair_calls = [call for call in fixture.snapshot() if "repair fixture" in call["question"]]
        assert len(repair_calls) == 2
        assert "Unsupported time bucket" in repair_calls[1]["request"]["messages"][-1]["content"]
        count_before_rejection = len(fixture.snapshot())
        request = Request(http_url, data=json.dumps(payload).encode(),
                          headers={"Content-Type": "application/json", "Origin": "https://untrusted.example"})
        try:
            urlopen(request, timeout=5)
            raise AssertionError("Unlisted browser origin was admitted")
        except HTTPError as error:
            assert error.code == 403, error.code
        assert len(fixture.snapshot()) == count_before_rejection
        assert not errors, errors
        assert not model_assets, model_assets
        result = {"browser": browser.version, "backendHealth": health,
                  "provider": "local deterministic HTTP/SSE fixture; no real model",
                  "sourceRows": 1_209_600, "chartPoints": [60_480, 144, 60_480],
                  "sessionConnections": len(sockets), "contextTransmissions": len(hello),
                  "providerGenerations": len(fixture.snapshot()), "cacheHit": True,
                  "upstreamCancellation": True, "httpValidationRepair": True,
                  "unlistedOriginRejected": True, "liveQuietPeriodObservedMs": delay_ms,
                  "firstQueryDiagnostics": detail, "webgpuModelDownloads": len(model_assets),
                  "errors": errors}
        browser.close()
        return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:5173")
    parser.add_argument("--binary", type=Path,
                        default=Path("crates/inference-server/target/debug/time-blast-inference"))
    arguments = parser.parse_args()
    assert arguments.binary.is_file(), f"Compile the Rust backend first: {arguments.binary}"
    print(json.dumps(run(arguments.url, arguments.binary.resolve()), indent=2))
