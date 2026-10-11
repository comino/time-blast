#!/usr/bin/env python3
"""Geo views (map, density, tracks) through the Rust/Wasm renderer: pixels and timings.

Starts its own Vite dev server (vite.render-bench.config.ts, cross-origin isolated) on a free
port and runs tests/render-geo.html in headless Chromium for each backend. Checks: the
automatic view choice, DRAWN with points, ink on every canvas, more than a background's worth
of colours, the playback cut removing ink, and no console errors. Prints the JSON (timings).
--software: SwiftShader WebGPU/WebGL (CPU emulation: not hardware timings).

Usage: python3 tests/render_geo.py [--software] [--backend webgpu|webgl2] [--reps N]
       [--timings-only] [--json out.json] [--screenshot shot.png]
Pixel check: default (1 rep). Timings: --reps 5 --timings-only.
"""
import argparse
import io
import json
import os
import signal
import subprocess
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render_engine import ROOT, SOFTWARE, free_port, wait_for  # noqa: E402

BACKGROUND = (0x10, 0x21, 0x2D)


def ink(png):
    img = Image.open(io.BytesIO(png)).convert("RGB")
    count, colours = 0, set()
    for r, g, b in img.getdata():
        if abs(r - BACKGROUND[0]) + abs(g - BACKGROUND[1]) + abs(b - BACKGROUND[2]) > 60:
            count += 1
            colours.add((r // 32, g // 32, b // 32))
    return count, len(colours)


def shot(page, slot):
    """Canvas pixels via a clipped page screenshot (no element-stability wait, which a busy
    software GPU can starve)."""
    box = page.evaluate(f"(() => {{ const r = document.querySelector('canvas[data-slot=\"{slot}\"]').getBoundingClientRect(); return {{x: r.x, y: r.y, width: r.width, height: r.height}}; }})()")
    return page.screenshot(clip=box, timeout=180_000)


def check(page, base, backend, reps, screenshot, timings_only=False):
    errors = []
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{base}/tests/render-geo.html?backend={backend}&reps={reps}")
    page.wait_for_function("window.__geo !== undefined", timeout=600_000)
    out = page.evaluate("window.__geo")
    if not out.get("ok"):
        if "unavailable" in out.get("error", ""):
            print(f"{backend}: unavailable")
            return None, []
        return out, [out.get("error")]
    r = out["result"]
    if timings_only:
        return out, []
    # Idle check: once streaming is over no view may keep requesting frames.
    f0 = page.evaluate("window.__frames()")
    page.wait_for_timeout(1500)
    idle = page.evaluate("window.__frames()") - f0
    print(f"{backend}: {idle} frames while idle", file=sys.stderr)
    pixels = {}
    for slot in (1, 2, 3, 4):
        pixels[slot] = ink(shot(page, slot))
    page.evaluate("window.__playback(1)")
    pixels["4@1.0"] = ink(shot(page, 4))
    if screenshot:
        page.evaluate("window.__playback(0.4)")
        page.screenshot(path=screenshot.replace(".png", f"-{backend}.png"), full_page=True)
    out["pixels"] = {str(k): v for k, v in pixels.items()}
    failures = []
    expect = {"mapPorts": "map", "tracks": "tracks", "density": "density", "mapShips": "map"}
    for name, view in expect.items():
        if r[name]["chosen"] != view:
            failures.append(f"{name}: chose {r[name]['chosen']}")
        if not r[name]["points"]:
            failures.append(f"{name}: no DRAWN points")
    for slot, (count, colours) in pixels.items():
        if count < 400 or colours < 3:
            failures.append(f"slot {slot}: {count} ink px, {colours} colours")
    if not pixels[4][0] < pixels["4@1.0"][0]:
        failures.append(f"playback 0.4 should show less ink than 1.0: {pixels[4][0]} vs {pixels['4@1.0'][0]}")
    if idle > 1:
        failures.append(f"{idle} frames while idle")
    out["idleFrames"] = idle
    if errors:
        failures.append(f"console errors: {errors[:3]}")
    return out, failures


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--software", action="store_true")
    p.add_argument("--backend", action="append", choices=["webgpu", "webgl2"])
    p.add_argument("--reps", type=int, default=1)
    p.add_argument("--timings-only", action="store_true",
                   help="skip pixel checks: with many reps a software GPU's queue gets too deep to screenshot")
    p.add_argument("--json")
    p.add_argument("--screenshot")
    args = p.parse_args()
    port = free_port()
    server = subprocess.Popen(["pnpm", "exec", "vite", "--config", "vite.render-bench.config.ts", "--port", str(port), "--strictPort", "--host", "127.0.0.1"],
                              cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    results, failures, ran = {}, [], 0
    try:
        base = f"http://127.0.0.1:{port}"
        wait_for(base + "/tests/render-geo.html")
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, args=SOFTWARE if args.software else [])
            try:
                for backend in args.backend or ["webgpu", "webgl2"]:
                    page = browser.new_page(viewport={"width": 1020, "height": 620}, device_scale_factor=1)
                    out, fails = check(page, base, backend, args.reps, args.screenshot, args.timings_only)
                    page.close()
                    if out is None:
                        continue
                    ran += 1
                    results[backend] = out
                    failures += [f"{backend}: {f}" for f in fails]
                results["browser"] = browser.version
                results["software"] = args.software
            finally:
                browser.close()
    finally:
        os.killpg(server.pid, signal.SIGTERM)
        server.wait(timeout=10)
    text = json.dumps(results, indent=1)
    print(text)
    if args.json:
        with open(args.json, "w") as f:
            f.write(text + "\n")
    for f in failures:
        print("FAIL", f, file=sys.stderr)
    if not ran:
        return 2
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
