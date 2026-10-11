#!/usr/bin/env python3
"""Render the seasons view (seasonal wheel) through the Rust/Wasm renderer and check pixels,
labels and cycle choice, then report first-draw cost for 14 days × 1-minute buckets.

Start Vite first (e.g. `pnpm exec vite --port 5199 --strictPort`), then:
  python3 tests/render_calendar.py --url http://localhost:5199 --software [--backend webgpu|webgl2]
Exit 0 on success, 1 on failure, 2 when no requested backend is available.
"""
import argparse
import io
import json
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

SOFTWARE = ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader"]
BACKGROUND = (0x10, 0x21, 0x2D)

EXPECT = {
    "1": ("Weekly wheel", 2000, 6),
    "2": ("Yearly wheel", 2000, 6),
    "3": ("24 h clock", 1000, 5),
    "4": ("24 h clock", 9, 1),
}


def ink(img):
    img = img.convert("RGB")
    count, colours = 0, set()
    for r, g, b in img.getdata():
        if abs(r - BACKGROUND[0]) + abs(g - BACKGROUND[1]) + abs(b - BACKGROUND[2]) > 60:
            count += 1
            colours.add((r // 32, g // 32, b // 32))
    return count, len(colours)


def check(page, base, backend, reps, screenshot=None):
    page.goto(f"{base}/tests/render-calendar.html?backend={backend}&reps={reps}")
    page.wait_for_function("() => window.__calendar || window.__error", timeout=300_000)
    error = page.evaluate("() => window.__error")
    if error:
        if "unavailable" in error.lower():
            print(f"{backend}: unavailable ({error.splitlines()[0]})")
            return None, None
        return [error], None
    summary = page.evaluate("() => window.__calendar")
    failures = []
    if screenshot:
        page.screenshot(path=screenshot.replace(".png", f"-{backend}.png"), full_page=True, timeout=300_000)
    page.add_style_tag(content=".labels { display: none !important; }")
    # One page screenshot, cropped per canvas: software WebGL2 readback of several contexts can
    # take tens of seconds on a loaded host, longer than per-element screenshot timeouts.
    shot = Image.open(io.BytesIO(page.screenshot(timeout=300_000)))
    for slot, (cycle, min_ink, min_colours) in EXPECT.items():
        case = summary["cases"][slot]
        box = page.locator(f'figure[data-card="{slot}"] canvas').bounding_box()
        pixels, colours = ink(shot.crop((int(box["x"]), int(box["y"]), int(box["x"] + box["width"]), int(box["y"] + box["height"]))))
        print(f"  slot {slot}: {pixels} ink px, {colours} colours, {case['labels']} labels, caption {case['caption']!r}")
        if case["chosen"] != "seasons":
            failures.append(f"slot {slot}: chosen {case['chosen']}")
        if not case["drawn"]:
            failures.append(f"slot {slot}: no FIRST_DRAW_SUBMITTED")
        if not (case["caption"] or "").startswith(cycle):
            failures.append(f"slot {slot}: caption {case['caption']!r}, want {cycle}")
        if pixels < min_ink or colours < min_colours:
            failures.append(f"slot {slot}: too little ink ({pixels} px, {colours} colours)")
        if "seasons" not in case["available"] or case["available"][0] == "seasons":
            failures.append(f"slot {slot}: available {case['available']}")
    return failures, summary


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://localhost:5199")
    p.add_argument("--software", action="store_true")
    p.add_argument("--backend", action="append", choices=["webgpu", "webgl2"])
    p.add_argument("--reps", type=int, default=9)
    p.add_argument("--screenshot")
    p.add_argument("--json")
    args = p.parse_args()
    failures, ran, results = [], 0, {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=SOFTWARE if args.software else [])
        results["browser"] = browser.version
        for backend in args.backend or ["webgpu", "webgl2"]:
            print(backend)
            # A fresh browser per backend: queued software-WebGPU work must not stall the next run.
            if ran or results.get("webgpu") is not None:
                browser.close()
                browser = pw.chromium.launch(headless=True, args=SOFTWARE if args.software else [])
            page = browser.new_page(viewport={"width": 1100, "height": 900}, device_scale_factor=1)
            page.on("console", lambda m: m.type == "error" and print("console:", m.text, file=sys.stderr))
            result, summary = check(page, args.url, backend, args.reps, args.screenshot)
            if result is None:
                continue
            ran += 1
            failures += [f"{backend}: {f}" for f in result]
            if summary:
                results[backend] = {"label": summary["label"], "weekly20160": summary["weekly20160"]}
                print(json.dumps(results[backend], indent=1))
        browser.close()
    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=1)
    for f in failures:
        print("FAIL", f)
    if not ran:
        return 2
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
