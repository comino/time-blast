#!/usr/bin/env python3
"""Headless test of /measure.html (the real-hardware measurement page) on SwiftShader.

Opens measure.html?auto=1 with a short run, points its RTT probe and live pass at
tests/fake_inference.py (a real tb1 WebSocket), waits for the report and checks that it has boot
stages, typing → first draw / GPU done / frame for the echo and vary passes, network RTT, hardware
info labelled as a software GPU, and no errors. Saves the downloadable JSON with --json.

Start a server first (`pnpm exec vite --port 5199 --strictPort`, or `vite preview` of a build), then:
  python3 tests/measure_page.py --url http://localhost:5199 [--reps 2] [--json out.json]
SwiftShader is software rasterization: these numbers say nothing about a real GPU.
"""
import argparse
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_inference import FakeInference  # noqa: E402

SOFTWARE = ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader"]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://localhost:5199")
    p.add_argument("--reps", type=int, default=2)
    p.add_argument("--timeout", type=float, default=600)
    p.add_argument("--json")
    args = p.parse_args()
    fake = FakeInference().start()
    fake.echo = True  # the live pass: every final keystroke runs the pipeline
    failures = []

    def check(cond, message):
        print(("ok   " if cond else "FAIL ") + message, flush=True)
        if not cond:
            failures.append(message)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=SOFTWARE)
        page = browser.new_page(viewport={"width": 1200, "height": 900}, device_scale_factor=1)
        page.on("pageerror", lambda e: print("pageerror:", e, file=sys.stderr))
        page.on("console", lambda m: m.type == "error" and print("console:", m.text, file=sys.stderr))
        started = time.time()
        page.goto(f"{args.url}/measure.html?auto=1&reps={args.reps}&passes=echo,vary,live&rtt=3&endpoint={fake.url}")
        try:
            page.wait_for_function("() => window.__measure && window.__measure.report", timeout=args.timeout * 1000)
        except Exception:
            print("state:", page.locator("#state").text_content(), file=sys.stderr)
            print("errors:", page.evaluate("() => window.__measure && window.__measure.errors"), file=sys.stderr)
            raise
        report = page.evaluate("() => window.__measure.report")
        wall = round(time.time() - started, 1)
        # The page renders a readable summary and enables the download.
        check(page.locator("#metrics tbody tr").count() >= 8, f"summary table rendered ({page.locator('#metrics tbody tr').count()} rows)")
        check(page.locator("#download").is_enabled(), "Download JSON is enabled")
        with page.expect_download() as d:
            page.locator("#download").click()
        downloaded = json.loads(open(d.value.path()).read())
        check(downloaded["kind"] == "time-blast.measure" and downloaded["metrics"].keys() == report["metrics"].keys(), "downloaded JSON equals the report")
        browser.close()
    fake.stop()

    m = report["metrics"]
    reps3 = 3 * args.reps
    for key in ["hw.boot.answerable", "hw.first_query_after_boot", "hw.net.ws_connect", "hw.net.hello_ready"]:
        check(key in m and len(m[key]["samples"]) >= 1, f"{key}: {m.get(key, {}).get('samples', [])[:3]}")
    check(len(m.get("hw.echo.keystroke_to_draw", {}).get("samples", [])) == reps3, f"echo pass: {reps3} final keystroke → draw samples")
    check(len(m.get("hw.vary.keystroke_to_frame", {}).get("samples", [])) >= reps3 - 1, f"vary pass: final keystroke → frame for ≥ {reps3 - 1} of {reps3} questions")
    check(len(m.get("hw.live.keystroke_to_draw", {}).get("samples", [])) >= 1, "live pass over a real tb1 WebSocket draws")
    for a, b in [("hw.vary.keystroke_to_draw", "hw.vary.keystroke_to_gpu_done"), ("hw.vary.keystroke_to_gpu_done", "hw.vary.keystroke_to_frame")]:
        xs, ys = sorted(m[a]["samples"]), sorted(m[b]["samples"])
        check(xs[len(xs) // 2] <= ys[len(ys) // 2], f"median {a} ≤ {b} ({xs[len(xs) // 2]:.1f} ≤ {ys[len(ys) // 2]:.1f} ms)")
    gpu = report["hardware"]["gpu"]
    check(gpu.get("software") is True, f"SwiftShader is labelled a software GPU ({gpu.get('engineRenderer')}; {gpu.get('description') or gpu.get('architecture')})")
    check(report["hardware"].get("refreshHz") is not None, f"refresh rate measured ({report['hardware'].get('refreshHz')} Hz)")
    stage_labels = [s["label"] for s in report["stages"].get("hw.vary.keystroke_to_draw", [])]
    check("GPU work done" in stage_labels and "next animation frame" in stage_labels, f"vary stage breakdown ends GPU done → frame ({stage_labels[-3:]})")
    errors = [n for n in report["notes"] if n.startswith("error")]
    check(not errors, f"no errors ({errors[:2]})")
    print(json.dumps({k: (lambda s: {"n": len(s), "median": sorted(s)[len(s) // 2]})(v["samples"]) for k, v in m.items()}, indent=1))
    print(f"wall {wall} s; notes: {report['notes']}")
    if args.json:
        with open(args.json, "w") as f:
            json.dump(report, f, indent=1)
    for f in failures:
        print("FAIL", f)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
