"""DuckDB-Wasm threads experiment (docs/batch-2/database.md, experiment 1).

Starts a Vite dev server on a free port, opens tests/engine-threads.html in headless Chromium and
prints EXEC → first batch for the engine's blocking in-worker DuckDB (eh build, no threads) vs
the async API over a worker hop: eh build and the COI/pthreads build at several thread counts.

Usage:  python3 tests/engine_threads.py [--json out.json] [--repeats 9] [--threads 1,2,4]
"""
import json
import os
import signal
import subprocess
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engine_smoke import ROOT, free_port, wait_for  # noqa: E402


def arg(name: str, default: str) -> str:
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def main() -> int:
    port = free_port()
    server = subprocess.Popen(
        ["pnpm", "exec", "vite", "--port", str(port), "--strictPort", "--host", "127.0.0.1"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
    )
    try:
        base = f"http://127.0.0.1:{port}"
        wait_for(base + "/tests/engine-threads.html")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                log: list[str] = []
                page.on("console", lambda m: log.append(m.text))
                page.on("pageerror", lambda e: log.append(str(e)))
                page.goto(f"{base}/tests/engine-threads.html?repeats={arg('--repeats', '9')}&threads={arg('--threads', '1,2,4')}")
                try:
                    page.wait_for_function("window.__engineThreads !== undefined", timeout=900_000)
                except Exception:
                    print("\n".join(log[-30:]), file=sys.stderr)
                    raise
                result = page.evaluate("window.__engineThreads")
                result["browser"] = browser.version
                result["log"] = log[-10:]
            finally:
                browser.close()
    finally:
        os.killpg(server.pid, signal.SIGTERM)
        server.wait(timeout=10)
    text = json.dumps(result, indent=1)
    print(text)
    if "--json" in sys.argv:
        with open(arg("--json", ""), "w") as f:
            f.write(text + "\n")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
