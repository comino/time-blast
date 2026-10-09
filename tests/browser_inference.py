#!/usr/bin/env python3
"""Check an actual local WebLLM generation, never the deterministic template path.

Start Vite, then run: python3 tests/browser_inference.py --url http://localhost:5173
Requires installed Python Playwright and Chromium. --software explicitly enables
SwiftShader, which is CPU emulation and provides no hardware performance evidence.
Weights download into an ephemeral browser profile, never the repository.
Exit 0: exact expected plan; 1: error/mismatch/timeout; 2: no WebGPU adapter.
"""

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright


EXPECTED = {"metric": "wind", "aggregate": "max", "bucketMinutes": 60,
            "windowHours": 48, "splitByVessel": False, "vessel": None, "view": "line"}
PROMPT = "Please plot the highest recorded wind speed each hour for the past two days."
ADAPTER = """async () => {
  if (!navigator.gpu) return { available: false, reason: 'navigator.gpu is absent' };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { available: false, reason: 'requestAdapter() returned null' };
  const info = adapter.info;
  return { available: true, info: info && { vendor: info.vendor,
    architecture: info.architecture, device: info.device, description: info.description },
    features: [...adapter.features], limits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize } };
}"""
START = """async (text) => {
  const { createInferenceAdapter } = await import('/src/inference/index.ts');
  const context = { id: 'gpu-test', label: 'Fleet telemetry', rowCount: 1000,
    start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 8, 15),
    vessels: ['Aurora', 'Borealis', 'Calypso', 'Discovery', 'Endeavour', 'Fjord'],
    description: 'Fixed data' };
  window.probe = { done: false, loaded: false, status: null, requests: 0 };
  window.inference = createInferenceAdapter('webgpu', {
    onStatus: status => { window.probe.status = status; },
  });
  void window.inference.prepare(context).then(async () => {
    window.probe.loaded = true;
    const draft = { revision: 1, text, contextId: context.id, sentAt: performance.now() };
    window.inference.observeDraft(draft);
    window.probe.requests++;
    window.probe.result = await window.inference.resolve(draft, new AbortController().signal);
    window.probe.done = true;
  }).catch(error => { window.probe.error = error.message; window.probe.done = true; });
}"""


def package_version():
    path = Path(__file__).resolve().parents[1] / "node_modules/@mlc-ai/web-llm/package.json"
    return json.loads(path.read_text())["version"] if path.exists() else "unknown"


async def run(args):
    report = {"software_requested": args.software, "prompt": PROMPT, "expected": EXPECTED,
              "timeout_seconds": args.timeout, "webllm_version": package_version(),
              "success": False, "completed_generations": 0, "page_errors": []}
    started = time.monotonic()
    code = 1
    async with async_playwright() as playwright:
        flags = ["--no-sandbox"]
        if args.software:
            flags += ["--enable-unsafe-webgpu", "--use-angle=swiftshader",
                      "--enable-features=Vulkan", "--use-vulkan=swiftshader"]
        launch = {"headless": True, "args": flags}
        if args.chromium:
            launch["executable_path"] = args.chromium
        browser = await playwright.chromium.launch(**launch)
        report["chromium_version"] = browser.version
        try:
            page = await browser.new_page()
            page.on("pageerror", lambda error: report["page_errors"].append(str(error)))
            # Isolate inference from the app's database, chart, and background work.
            await page.route("**/__inference_smoke", lambda route: route.fulfill(
                status=200, content_type="text/html", body="<!doctype html><title>Inference smoke</title>"))

            async def probe():
                await page.goto(args.url.rstrip("/") + "/__inference_smoke")
                report["adapter"] = await page.evaluate(ADAPTER)
                print(json.dumps({"adapter": report["adapter"]}), flush=True)
                if not report["adapter"]["available"]:
                    return 2
                await page.evaluate(START, PROMPT)
                previous = None
                while True:
                    state = await page.evaluate("window.probe")
                    report["probe"] = state
                    status = state.get("status") or {}
                    key = (status.get("state"), int(status.get("progress", 0) * 20),
                           state["loaded"], state["done"])
                    if key != previous:
                        print(json.dumps({"progress": state}), flush=True)
                        previous = key
                    if state["done"]:
                        result = state.get("result") or {}
                        report["completed_generations"] = int(bool(result))
                        report["success"] = (result.get("source") == "webgpu"
                                             and result.get("plan") == EXPECTED
                                             and not report["page_errors"])
                        return 0 if report["success"] else 1
                    await asyncio.sleep(1)

            remaining = max(0.001, args.timeout - (time.monotonic() - started))
            try:
                code = await asyncio.wait_for(probe(), timeout=remaining)
            except TimeoutError:
                report["error"] = "Overall probe timeout; no validated generation was observed."
            except Exception as error:
                report["error"] = str(error)
        finally:
            # Closing the browser also terminates the worker and any GPU work.
            await browser.close()
    report["elapsed_seconds"] = round(time.monotonic() - started, 2)
    print(json.dumps(report, indent=2), flush=True)
    return code


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://localhost:5173", help="Running Vite development origin")
    parser.add_argument("--chromium", help="Optional Chromium executable path")
    parser.add_argument("--software", action="store_true", help="Explicitly enable CPU SwiftShader emulation")
    parser.add_argument("--timeout", type=float, default=600, help="Overall timeout in seconds, at most 600")
    options = parser.parse_args()
    if not 0 < options.timeout <= 600:
        parser.error("--timeout must be greater than zero and at most 600 seconds")
    sys.exit(asyncio.run(run(options)))
