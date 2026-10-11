#!/usr/bin/env python3
"""Heatmap and surface through the Rust/Wasm renderer in headless Chromium: pixels and choices.

Starts its own Vite dev server (cross-origin isolated, vite.render-bench.config.ts) on a free
port, opens tests/render-matrix.html and checks, per backend (WebGPU, then WebGL2):

- every case draws (DRAWN) and leaves ink with several colours on its canvas;
- the chosen views: hinted heatmap/surface, auto → heatmap for 20 series, auto → line for 6;
- the heatmap posts a colour-scale legend; the surface posts projected ticks and lane legend;
- a rotated surface differs from the default one; rotating uploads only the uniform block.

  python3 tests/render_matrix.py [--software] [--backend webgpu|webgl2] [--screenshot out.png]
  python3 tests/render_matrix.py --software --bench [--reps 5] [--out bench.json]

--software adds SwiftShader flags (Chromium here has no GPU): software GPU, not hardware timings.
Exit 0 on success, 1 on failure, 2 when no requested backend is available.
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
BACKGROUND = (0x10, 0x21, 0x2D)  # figure panel colour behind the transparent canvas
EXPECT = ["heatmap", "surface", "surface", "heatmap", "line", "heatmap"]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return port if port != 5173 else free_port()


def wait_for(url: str, timeout: float = 90) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=2).read(1)
            return
        except Exception:
            time.sleep(0.3)
    raise RuntimeError(f"dev server did not start: {url}")


def ink(png):
    """Pixels that differ clearly from the panel background, and distinct colours among them."""
    img = Image.open(io.BytesIO(png)).convert("RGB")
    count, colours = 0, set()
    for r, g, b in img.getdata():
        if abs(r - BACKGROUND[0]) + abs(g - BACKGROUND[1]) + abs(b - BACKGROUND[2]) > 60:
            count += 1
            colours.add((r // 32, g // 32, b // 32))
    return count, len(colours)


def check(page, base, backend):
    failures = []
    page.goto(f"{base}/tests/render-matrix.html?mode=views&backend={backend}")
    page.wait_for_function("() => window.__views || window.__error", timeout=180_000)
    error = page.evaluate("() => window.__error")
    if error:
        if "unavailable" in error:
            print(f"{backend}: unavailable ({error.splitlines()[0]})")
            return None
        return [error]
    summary = page.evaluate("() => window.__views")
    page.add_style_tag(content=".labels { display: none !important; }")
    kind = summary["backend"]
    print(f"{backend}: {summary['label']}")
    shots = {}
    for case in summary["cases"]:
        slot = case["slot"]
        png = page.locator(f'figure[data-card="{kind}-{slot}"] canvas').screenshot()
        shots[slot] = png
        pixels, colours = ink(png)
        print(f"  {slot} {case['title']}: chosen {case['chosen']}, {pixels} ink px, {colours} colour buckets, ticks {case['ticks'] and {k: v for k, v in case['ticks'].items() if k != 'legendColors'}}")
        if case["chosen"] != case["expect"]:
            failures.append(f"{case['title']}: chose {case['chosen']}, expected {case['expect']}")
        if not case["drawn"]:
            failures.append(f"{case['title']}: no DRAWN")
        if pixels < 2000 or colours < 4:
            failures.append(f"{case['title']}: too little ink ({pixels} px, {colours} colours)")
        ticks = case["ticks"] or {}
        if case["expect"] == "heatmap":
            if ticks.get("legend", 0) < 2 or len(set(ticks.get("legendColors", []))) < 2:
                failures.append(f"{case['title']}: no colour-scale legend {ticks}")
            if ticks.get("y", 0) < 2 or ticks.get("x", 0) < 2:
                failures.append(f"{case['title']}: missing row/x labels {ticks}")
        if case["expect"] == "surface" and (ticks.get("x", 0) < 2 or ticks.get("y", 0) < 2 or ticks.get("legend", 0) != 6):
            failures.append(f"{case['title']}: surface ticks/legend {ticks}")
    if shots.get(2) == shots.get(3):
        failures.append("rotation 120° renders the same pixels as the default rotation")
    rotate = summary["rotate"]
    print(f"  rotate: {rotate}")
    # 15 draws (6 floors, 2 edges, 6 ribbons, 1 axis) → 15 uniform blocks of 256 bytes, no vertices.
    if rotate["frames"] < 1 or rotate["uploadedBytes"] > 16 * 256:
        failures.append(f"rotation should redraw from uniforms only: {rotate}")
    return failures


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--software", action="store_true")
    p.add_argument("--backend", action="append", choices=["webgpu", "webgl2"])
    p.add_argument("--screenshot")
    p.add_argument("--bench", action="store_true")
    p.add_argument("--reps", default="5")
    p.add_argument("--sizes", default="6x1440,50x2000")
    p.add_argument("--out")
    args = p.parse_args()
    backends = args.backend or ["webgpu", "webgl2"]
    port = free_port()
    server = subprocess.Popen(
        ["pnpm", "exec", "vite", "--config", "vite.render-bench.config.ts", "--port", str(port), "--strictPort", "--host", "127.0.0.1"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
    )
    failures, ran = [], 0
    try:
        base = f"http://127.0.0.1:{port}"
        wait_for(base + "/tests/render-matrix.html")
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, args=SOFTWARE if args.software else [])
            page = browser.new_page(viewport={"width": 1400, "height": 1000}, device_scale_factor=1)
            page.on("console", lambda m: m.type == "error" and print("console:", m.text, file=sys.stderr))
            page.on("pageerror", lambda e: failures.append(f"page error: {e}"))
            if args.bench:
                page.goto(f"{base}/tests/render-matrix.html?mode=bench&reps={args.reps}&sizes={args.sizes}&backends={','.join(backends)}")
                page.wait_for_function("() => window.__bench || window.__error", timeout=1_800_000)
                error = page.evaluate("() => window.__error")
                if error:
                    print(error, file=sys.stderr)
                    return 1
                result = page.evaluate("() => window.__bench")
                result["browserVersion"] = browser.version
                result["software"] = args.software
                text = json.dumps(result, indent=1)
                if args.out:
                    with open(args.out, "w") as f:
                        f.write(text + "\n")
                print(text)
                browser.close()
                return 0
            for backend in backends:
                result = check(page, base, backend)
                if result is None:
                    continue
                ran += 1
                failures += [f"{backend}: {f}" for f in result]
                if args.screenshot:
                    page.screenshot(path=args.screenshot.replace(".png", f"-{backend}.png"), full_page=True)
            browser.close()
    finally:
        os.killpg(server.pid, signal.SIGTERM)
        server.wait(timeout=10)
    for f in failures:
        print("FAIL", f)
    if not ran:
        return 2
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
