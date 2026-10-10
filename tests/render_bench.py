#!/usr/bin/env python3
"""Run render-bench.html headless and save its JSON.

Start Vite first (e.g. `pnpm exec vite --port 5199 --strictPort`), then:
  python3 tests/render_bench.py --url http://localhost:5199 [--software] [--out file.json]
--software enables SwiftShader WebGPU/WebGL: CPU emulation, not hardware timings.
"""
import argparse
import json
import sys
import time

from playwright.sync_api import sync_playwright

SOFTWARE = ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader"]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://localhost:5199")
    p.add_argument("--software", action="store_true")
    p.add_argument("--points", default="8640,60480")
    p.add_argument("--reps", default="7")
    p.add_argument("--timeout", type=float, default=600)
    p.add_argument("--out")
    args = p.parse_args()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=SOFTWARE if args.software else [])
        page = browser.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
        page.on("console", lambda m: m.type == "error" and print("console:", m.text, file=sys.stderr))
        started = time.time()
        page.goto(f"{args.url}/render-bench.html?mode=bench&points={args.points}&reps={args.reps}")
        page.wait_for_function("() => window.__bench || window.__error", timeout=args.timeout * 1000)
        error = page.evaluate("() => window.__error")
        if error:
            print(error, file=sys.stderr)
            return 1
        result = page.evaluate("() => window.__bench")
        result["browserVersion"] = browser.version
        result["software"] = args.software
        result["wallSeconds"] = round(time.time() - started, 1)
        browser.close()
    text = json.dumps(result, indent=1)
    if args.out:
        with open(args.out, "w") as f:
            f.write(text + "\n")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
