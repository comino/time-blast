"""Engine smoke: the database node on DuckDB-Wasm's blocking API in a real browser worker.

Starts its own Vite dev server on a free port (never 5173), opens tests/engine-smoke.html in
headless Chromium, and waits for the worker's measurements:

  boot (instantiate, LOAD parquet), vessels fixture load + context statistics, guard cost,
  MessageChannel yield cost, a 60,480-row aggregate (cold + 20 warm: EXEC → schema, first
  batch, done; polls/yields), a streaming scan, CANCEL latency, guard rejections, the Parquet
  fixture and a dropped CSV. The page checks crossOriginIsolated, timer resolution and CORS
  reachability of model/extension hosts under COEP credentialless.

Usage:  python3 tests/engine_smoke.py [--json out.json]
Prints the result JSON; exits non-zero if a check fails.
"""
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return port if port != 5173 else free_port()


def wait_for(url: str, timeout: float = 60) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=2).read(1)
            return
        except Exception:
            time.sleep(0.3)
    raise RuntimeError(f"dev server did not start: {url}")


def main() -> int:
    out_path = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
    port = free_port()
    server = subprocess.Popen(
        ["pnpm", "exec", "vite", "--port", str(port), "--strictPort", "--host", "127.0.0.1"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
    )
    try:
        base = f"http://127.0.0.1:{port}"
        wait_for(base + "/tests/engine-smoke.html")
        headers = urllib.request.urlopen(base + "/tests/engine-smoke.html").headers
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                errors: list[str] = []
                log: list[str] = []
                page.on("console", lambda m: (errors.append(m.text) if m.type == "error" else None, log.append(m.text)))
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(base + "/tests/engine-smoke.html")
                try:
                    page.wait_for_function("window.__engineSmoke !== undefined", timeout=300_000)
                except Exception:
                    print("\n".join(log[-20:]), file=sys.stderr)
                    raise
                result = page.evaluate("window.__engineSmoke")
                result["browser"] = browser.version
                result["headers"] = {k: headers.get(k) for k in ("Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy")}
                result["consoleErrors"] = errors
            finally:
                browser.close()
    finally:
        os.killpg(server.pid, signal.SIGTERM)
        server.wait(timeout=10)

    text = json.dumps(result, indent=2)
    print(text)
    if out_path:
        with open(out_path, "w") as f:
            f.write(text + "\n")

    worker = result["worker"]
    failures = []
    if not worker.get("ok"):
        failures.append(f"worker failed: {worker.get('error')}")
    else:
        r = worker["result"]
        checks = {
            "page crossOriginIsolated": result["page"]["crossOriginIsolated"],
            "worker crossOriginIsolated": r["crossOriginIsolated"],
            "vessels rows": r["openVessels"]["rows"] == 1_209_600,
            "60k rows": r["aggregate60k"]["warm"]["rows"] == 60_480,
            "arrow classes shared": r["arrowObjectsAreSharedClasses"],
            "all rejected": all(code != "NOT REJECTED" for code in r["rejected"].values()),
            "cancels stopped": all(c["outcome"] == "canceled" for c in r["cancel"]),
            "csv loaded": r["openCsv"]["rows"] == 5000,
        }
        failures += [name for name, ok in checks.items() if not ok]
    if failures:
        print("FAILED: " + ", ".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
