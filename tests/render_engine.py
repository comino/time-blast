#!/usr/bin/env python3
"""Renderer through the real engine data path: DuckDB-Wasm database node + tb-render in one
module worker on transferred OffscreenCanvases (tests/render-engine.*).

Starts its own Vite dev server (cross-origin isolated via vite.render-bench.config.ts) on a free
port, runs headless Chromium (--software: SwiftShader WebGPU, CPU emulation — not hardware
timings) and checks: views chosen per query shape, DRAWN with points, pixels on the drawn
canvases, CSV export. Prints the JSON.

Usage: python3 tests/render_engine.py [--software] [--json out.json] [--screenshot shot.png]
"""
import argparse
import io
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOFTWARE = ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader"]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return port if port != 5173 else free_port()


def wait_for(url, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=2).read(1)
            return
        except Exception:
            time.sleep(0.3)
    raise RuntimeError(f"dev server did not start: {url}")


def ink(png):
    img = Image.open(io.BytesIO(png)).convert("RGB")
    return sum(1 for r, g, b in img.getdata() if abs(r - 0x10) + abs(g - 0x21) + abs(b - 0x2D) > 60)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--software", action="store_true")
    p.add_argument("--json")
    p.add_argument("--screenshot")
    args = p.parse_args()
    port = free_port()
    server = subprocess.Popen(["pnpm", "exec", "vite", "--config", "vite.render-bench.config.ts", "--port", str(port), "--strictPort", "--host", "127.0.0.1"],
                              cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        base = f"http://127.0.0.1:{port}"
        wait_for(base + "/tests/render-engine.html")
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, args=SOFTWARE if args.software else [])
            try:
                page = browser.new_page(viewport={"width": 520, "height": 1040})
                errors = []
                page.on("console", lambda m: m.type == "error" and errors.append(m.text))
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(base + "/tests/render-engine.html")
                page.wait_for_function("window.__renderEngine !== undefined", timeout=300_000)
                result = page.evaluate("window.__renderEngine")
                pixels = {slot: ink(page.locator(f'canvas[data-slot="{slot}"]').screenshot()) for slot in (1, 2, 3, 4)}
                if args.screenshot:
                    page.screenshot(path=args.screenshot, full_page=True)
                result["browser"] = browser.version
                result["software"] = args.software
                result["pixels"] = pixels
                result["consoleErrors"] = errors
            finally:
                browser.close()
    finally:
        os.killpg(server.pid, signal.SIGTERM)
        server.wait(timeout=10)
    print(json.dumps(result, indent=1))
    if args.json:
        with open(args.json, "w") as f:
            f.write(json.dumps(result, indent=1) + "\n")
    failures = []
    if not result.get("ok"):
        failures.append(f"worker: {result.get('error')}")
    else:
        r = result["result"]
        for name in ("minute-avg-60k", "count-by-vessel", "hourly-two-measures", "raw-table"):
            q = r[name]
            if q["chosen"] != q["expected"]:
                failures.append(f"{name}: chose {q['chosen']}, expected {q['expected']}")
            if not q["points"]:
                failures.append(f"{name}: no DRAWN points")
        for slot in (1, 2, 3):
            if result["pixels"][slot] < 300:
                failures.append(f"slot {slot}: {result['pixels'][slot]} ink pixels")
        if not r.get("exportCsv") or r["exportCsv"][0] != "vessel,n":
            failures.append(f"export {r.get('exportCsv')}")
    if result.get("consoleErrors"):
        failures.append(f"console errors: {result['consoleErrors'][:3]}")
    for f in failures:
        print("FAIL", f, file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
