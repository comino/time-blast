#!/usr/bin/env python3
"""Automatic view choice on real results of the public datasets (docs/batch-3/generality.md).

1. Export executed results as Arrow IPC (reference SQL of every corpus case, plus model SQL from
   saved eval reports):
     node scripts/eval-sql.mjs --export-arrow .cache/render-generality --dataset all [--reports a.json,b.json]
2. Run this: it starts its own Vite dev server, feeds every result through the Rust/Wasm renderer in
   headless Chromium (tests/render-generality.html) and compares the chosen view with what a reader
   would expect from the result's shape (the `expect` rules below, written independently of the
   renderer's ranking). Prints every disagreement and writes a JSON report.

  python3 tests/render_generality.py [--software] [--backend webgpu|webgl2] [--dir .cache/render-generality] [--out report.json]
Exit 0 when every result drew and every choice is acceptable, 1 otherwise.
"""
import argparse
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOFTWARE = ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader"]
GEO_LAT = re.compile(r"^(lat|latitude)$|_(lat|latitude)$", re.I)
GEO_LON = re.compile(r"^(lon|lng|long|longitude)$|_(lon|lng|long|longitude)$", re.I)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(url: str, timeout: float = 180) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=2).read(1)
            return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"dev server did not start: {url}")


def expect(item, columns):
    """Views a reader would accept for this result shape (judgment, not the renderer's rules)."""
    if item["hint"]:
        return {item["hint"]}
    kinds = [c["kind"] for c in columns]
    names = [c["name"] for c in columns]
    lat = any(GEO_LAT.search(n) and k == "numeric" for n, k in zip(names, kinds))
    lon = any(GEO_LON.search(n) and k == "numeric" for n, k in zip(names, kinds))
    if lat and lon:
        return {"tracks", "map"} if kinds[0] == "temporal" else {"map"}
    if item["rows"] == 1 and kinds[0] != "temporal":
        return {"table", "bar"}
    numeric = [k for k in kinds if k == "numeric"]
    if not numeric:
        return {"table"}
    text_after_x = sum(1 for k in kinds[1:] if k in ("text", "boolean"))
    if kinds[0] == "temporal":
        return {"line", "heatmap"} if text_after_x else {"line", "bar"}
    if kinds[0] in ("text", "boolean"):
        return {"bar", "heatmap", "table"} if text_after_x else {"bar"}
    # numeric first column: integer-like buckets (hour, month, band) or a measure pair
    return {"bar", "line", "scatter"} if len(numeric) >= 2 else {"table", "bar"}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--software", action="store_true")
    p.add_argument("--backend", default="webgpu", choices=["webgpu", "webgl2"])
    p.add_argument("--dir", default=".cache/render-generality")
    p.add_argument("--out")
    args = p.parse_args()
    exports = sorted(f for f in os.listdir(os.path.join(ROOT, args.dir)) if f.endswith(".json"))
    port = free_port()
    server = subprocess.Popen(
        ["pnpm", "exec", "vite", "--config", "vite.render-bench.config.ts", "--port", str(port), "--strictPort", "--host", "127.0.0.1"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
    )
    report, problems = {"backend": args.backend, "datasets": {}}, []
    try:
        base = f"http://127.0.0.1:{port}"
        wait_for(base + "/tests/render-generality.html")
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, args=SOFTWARE if args.software else [])
            page = browser.new_page(viewport={"width": 1400, "height": 900})
            page.on("pageerror", lambda e: problems.append(f"page error: {e}"))
            for name in exports:
                exported = json.load(open(os.path.join(ROOT, args.dir, name)))
                columns = {(i["id"], i["origin"], i["sql"]): i["columns"] for i in exported["items"]}
                page.goto(f"{base}/tests/render-generality.html?backend={args.backend}&file=/{args.dir}/{name}")
                page.wait_for_function("() => window.__generality || window.__error", timeout=900_000)
                error = page.evaluate("() => window.__error")
                if error:
                    problems.append(f"{name}: {error}")
                    continue
                result = page.evaluate("() => window.__generality")
                rows = []
                for r in result["results"]:
                    ok_views = expect(r, columns[(r["id"], r["origin"], r["sql"])])
                    r["acceptable"] = sorted(ok_views)
                    r["ok"] = r["drawn"] and r["chosen"] in ok_views
                    rows.append(r)
                    if not r["ok"]:
                        problems.append(f"{exported['dataset']}/{r['id']} ({r['origin']}): chose {r['chosen']} (drawn {r['drawn']}), "
                                        f"acceptable {sorted(ok_views)}; roles {r['roles']}; rows {r['rows']}")
                bad = sum(1 for r in rows if not r["ok"])
                print(f"{exported['dataset']}: {len(rows)} results on {result['backend']}, {bad} questionable choices")
                report["datasets"][exported["dataset"]] = {"n": len(rows), "questionable": bad, "results": rows}
            browser.close()
    finally:
        os.killpg(server.pid, signal.SIGTERM)
    for line in problems:
        print("  " + line)
    if args.out:
        with open(args.out, "w") as f:
            json.dump(report, f, indent=1)
            f.write("\n")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
