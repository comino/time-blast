#!/usr/bin/env python3
"""Render each wave-1 view (line, bar, scatter, table) through the Rust/Wasm renderer and check
pixels, then check fencing: stale-request batches change nothing on screen and emit no DRAWN.

Start Vite first (e.g. `pnpm exec vite --port 5199 --strictPort`), then:
  python3 tests/render_views.py --url http://localhost:5199 --software [--backend webgpu|webgl2]
Exit 0 on success, 1 on failure, 2 when the requested backend is unavailable.
"""
import argparse
import io
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

SOFTWARE = ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader"]
BACKGROUND = (0x10, 0x21, 0x2D)  # figure panel colour behind the transparent canvas


def ink(png):
    """Pixels that differ clearly from the panel background, and distinct colours among them."""
    img = Image.open(io.BytesIO(png)).convert("RGB")
    count, colours = 0, set()
    for r, g, b in img.getdata():
        if abs(r - BACKGROUND[0]) + abs(g - BACKGROUND[1]) + abs(b - BACKGROUND[2]) > 60:
            count += 1
            colours.add((r // 32, g // 32, b // 32))
    return count, len(colours)


def check(page, backend):
    failures = []
    page.goto(f"{page.url_base}/render-bench.html?mode=views&backend={backend}")
    page.wait_for_function("() => window.__views || window.__error", timeout=120_000)
    error = page.evaluate("() => window.__error")
    if error:
        if "unavailable" in error:
            print(f"{backend}: unavailable ({error.splitlines()[0]})")
            return None
        return [error]
    summary = page.evaluate("() => window.__views")
    # Judge the GPU's pixels only: hide the DOM axis labels that overlay the canvases.
    page.add_style_tag(content=".labels { display: none !important; }")
    print(backend, summary)
    for slot, view in enumerate(["line", "bar", "scatter", "table"], start=1):
        canvas = page.locator(f'figure[data-card="{summary["backend"]}-{slot}"] canvas')
        pixels, colours = ink(canvas.screenshot())
        print(f"  {view}: {pixels} ink pixels, {colours} colour buckets")
        if view == "table":
            if pixels > 50:
                failures.append(f"{view}: canvas should be clear for table view ({pixels})")
        elif pixels < 400 or colours < 3:
            failures.append(f"{view}: too little ink ({pixels} px, {colours} colours)")
    if summary["views"][:4] != ["line", "bar", "scatter", "table"]:
        failures.append(f"chosen views {summary['views']}")
    if len(summary["drawn"]) < 4:
        failures.append(f"DRAWN for {summary['drawn']}")
    fencing = summary["fencing"]
    if fencing["staleBatchesFramed"] != 0 or fencing["drawnForA"] != 1:
        failures.append(f"fencing {fencing}")
    fence = page.locator(f'figure[data-card="{summary["backend"]}-9"] canvas')
    before = fence.screenshot()
    if ink(before)[0] < 200:
        failures.append("fencing slot: request A not drawn")
    drawn_b = page.evaluate("() => window.__fencing.drawB()")
    after = fence.screenshot()
    if drawn_b != 1:
        failures.append(f"request B DRAWN count {drawn_b}")
    if before == after:
        failures.append("request B did not replace request A's image")
    return failures


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://localhost:5199")
    p.add_argument("--software", action="store_true")
    p.add_argument("--backend", action="append", choices=["webgpu", "webgl2"])
    p.add_argument("--screenshot")
    args = p.parse_args()
    backends = args.backend or ["webgpu", "webgl2"]
    failures, ran = [], 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=SOFTWARE if args.software else [])
        page = browser.new_page(viewport={"width": 1100, "height": 900}, device_scale_factor=1)
        page.url_base = args.url
        page.on("console", lambda m: m.type == "error" and print("console:", m.text, file=sys.stderr))
        for backend in backends:
            result = check(page, backend)
            if result is None:
                continue
            ran += 1
            failures += [f"{backend}: {f}" for f in result]
            if args.screenshot:
                page.screenshot(path=args.screenshot.replace(".png", f"-{backend}.png"), full_page=True)
        browser.close()
    for f in failures:
        print("FAIL", f)
    if not ran:
        return 2
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
