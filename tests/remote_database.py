"""Remote database placement in a real browser: DuckDB-Wasm vs ClickHouse over tb1.

Loads the vessels fixture into ClickHouse if needed (scripts/clickhouse-vessels.sh), builds
and starts the database server (crates/database-server, release), starts its own Vite dev
server on a free port (never 5173) and opens tests/remote-database.html in headless
Chromium. The worker runs the real EngineHost with the real placed database factory and a
scripted coordinator/recording renderer, runs the same queries on both placements, compares
every cell and measures EXEC → first batch / DONE (cold + warm).

Usage:  python3 tests/remote_database.py [--json out.json] [--warm 20] [--debug]
Env:    CLICKHOUSE_URL (default http://127.0.0.1:18123), CLICKHOUSE_DATABASE (time_blast_dev),
        TIME_BLAST_CLICKHOUSE_SETTINGS / TIME_BLAST_CLICKHOUSE_MAX_BLOCK_SIZE (passed through)
Exits non-zero if a check fails; skips (exit 0) if ClickHouse is unreachable.
"""
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CRATE = os.path.join(ROOT, "crates", "database-server")
CLICKHOUSE = os.environ.get("CLICKHOUSE_URL", "http://127.0.0.1:18123")
DATABASE = os.environ.get("CLICKHOUSE_DATABASE", "time_blast_dev")
DESCRIPTION = ("Synthetic vessel telemetry: six fictional vessels, one reading every six seconds, "
               "1–14 September 2026 UTC. Speed and wind in knots, wave height in metres, water temperature in °C, lat/lon in degrees.")


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
    raise RuntimeError(f"did not start: {url}")


def main() -> int:
    out_path = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
    warm = int(sys.argv[sys.argv.index("--warm") + 1]) if "--warm" in sys.argv else 20
    profile = "debug" if "--debug" in sys.argv else "release"
    try:
        urllib.request.urlopen(CLICKHOUSE + "/ping", timeout=3).read()
    except Exception as error:
        print(f"SKIP: ClickHouse not reachable at {CLICKHOUSE}: {error}")
        return 0
    subprocess.run([os.path.join(ROOT, "scripts", "clickhouse-vessels.sh")], check=True,
                   env={**os.environ, "CLICKHOUSE_URL": CLICKHOUSE, "CLICKHOUSE_DATABASE": DATABASE})
    build = ["cargo", "build", "--locked", "-j", "2", "--manifest-path", os.path.join(CRATE, "Cargo.toml")]
    subprocess.run(build + (["--release"] if profile == "release" else []), check=True)
    binary = os.path.join(CRATE, "target", profile, "time-blast-database")

    vite_port, db_port = free_port(), free_port()
    origin = f"http://127.0.0.1:{vite_port}"
    env = {**os.environ, "TIME_BLAST_DB_BIND": f"127.0.0.1:{db_port}", "TIME_BLAST_CLICKHOUSE_URL": CLICKHOUSE,
           "TIME_BLAST_CLICKHOUSE_DATABASE": DATABASE, "TIME_BLAST_ALLOWED_ORIGINS": origin,
           "TIME_BLAST_DB_NAME": "vessels", "TIME_BLAST_DB_DESCRIPTION": DESCRIPTION}
    database = subprocess.Popen([binary], env=env, start_new_session=True)
    server = subprocess.Popen(
        ["pnpm", "exec", "vite", "--port", str(vite_port), "--strictPort", "--host", "127.0.0.1"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
    )
    from playwright.sync_api import sync_playwright
    try:
        wait_for(f"http://127.0.0.1:{db_port}/health")
        wait_for(origin + "/tests/remote-database.html")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                errors: list[str] = []
                log: list[str] = []
                page.on("console", lambda m: (errors.append(m.text) if m.type == "error" else None, log.append(m.text)))
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(f"{origin}/tests/remote-database.html?db=ws://127.0.0.1:{db_port}/session&warm={warm}")
                try:
                    page.wait_for_function("window.__remoteDatabase !== undefined", timeout=600_000, polling=500)
                except Exception:
                    print("\n".join(log[-20:]), file=sys.stderr)
                    raise
                result = page.evaluate("window.__remoteDatabase")
                result["browser"] = browser.version
                result["consoleErrors"] = errors
            finally:
                browser.close()
        health = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{db_port}/health").read())
        result["serverHealth"] = health
    finally:
        os.killpg(server.pid, signal.SIGTERM)
        os.killpg(database.pid, signal.SIGTERM)
        server.wait(timeout=10)
        database.wait(timeout=10)

    text = json.dumps(result, indent=2)
    print(text)
    if out_path:
        with open(out_path, "w") as f:
            f.write(text + "\n")

    if not result.get("ok"):
        print(f"FAILED: worker: {result.get('error')}", file=sys.stderr)
        return 1
    r = result["result"]
    checks = {
        "duckdb rows": r["duckdbOpen"]["rows"] == 1_209_600,
        "clickhouse rows": r["clickhouseOpen"]["rows"] == 1_209_600,
        "clickhouse dialect": r["clickhouseOpen"]["dialect"] == "clickhouse",
        "60k rows": r["clickhouse"]["aggregate60k"]["rows"] == 60_480,
        "same results": all(e.get("mismatches") == 0 and e.get("rows", 0) > 0 for e in r["equal"].values()),
        "same error codes": r["duckdb"]["errors"] == r["clickhouse"]["errors"],
        "header-only copies to coordinator": r["headerOnlyToCoordinator"],
        "contexts announced": r["contextsSeen"] == [1, 2],
    }
    failures = [name for name, ok in checks.items() if not ok]
    if failures:
        print("FAILED: " + ", ".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
