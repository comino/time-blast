"""Remote DuckDB in the real application: production build, headless Chromium, the database
server (crates/database-server, DuckDB backend) on a free loopback port, and a scripted tb1
inference node that answers each question with fixed SQL (no provider calls).

For every query: clear the editor, insert the whole question as one input event, wait for the
chart's first draw. Checks that the result (row count and the 50-row table preview) equals the
same SQL in the DuckDB CLI, and reports per stage from the request's TIMING stamps:
key → first draw submitted, EXEC → first BATCH at the server, server-side EXEC → first BATCH /
DONE. Cold = first run of each SQL after open, warm = later runs.

Usage:
  python3 tests/remote_duckdb.py --dist DIR --binary PATH --db FILE --queries FILE.json
         [--warm 5] [--json out.json] [--threads 3] [--memory 1GB]
`--queries`: [{"question": "...", "sql": "..."}]. Requires Python Playwright + aiohttp, the
DuckDB CLI at .cache/duckdb-cli-v1.4.3/duckdb.
"""
import asyncio
import json
import math
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request

from aiohttp import WSMsgType, web
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, ".cache", "duckdb-cli-v1.4.3", "duckdb")
sys.path.insert(0, os.path.join(ROOT, "tests"))
from canvas_smoke import TRACE, decode, encode  # noqa: E402

HELLO, READY, INFER, SQL = 0x01, 0x02, 0x18, 0x1A
TIMING, RESULT, CANDIDATE = 0x34, 0x33, 0x37
KEY_INPUT, EXEC_SENT, EXEC_RECEIVED, DB_FIRST_BATCH, DB_DONE, RENDER_FIRST_BATCH, FIRST_DRAW = 1, 11, 12, 13, 14, 15, 16


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


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
            time.sleep(0.2)
    raise RuntimeError(f"did not start: {url}")


class Inference:
    """Scripted inference node: question → SQL, anything else → SELECT 1."""

    def __init__(self, answers):
        self.answers = answers
        self.loop = asyncio.new_event_loop()
        self.ready = threading.Event()
        threading.Thread(target=self.run, daemon=True).start()
        assert self.ready.wait(10)

    def run(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self.start())
        self.ready.set()
        self.loop.run_forever()

    async def start(self):
        app = web.Application()
        app.router.add_get("/session", self.session)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]

    async def session(self, request):
        ws = web.WebSocketResponse(protocols=("tb1",))
        await ws.prepare(request)
        async for message in ws:
            if message.type != WSMsgType.BINARY:
                continue
            frame = decode(message.data)
            if frame["kind"] == HELLO:
                await ws.send_bytes(encode(READY, {}, json.dumps({"node": "inference", "name": "scripted"})))
            elif frame["kind"] == INFER:
                text = frame["payload"].decode()
                await ws.send_bytes(encode(SQL, frame, self.answers.get(text, "SELECT 1 AS x")))
        return ws


def cli_rows(db, sql):
    out = subprocess.run([CLI, "-readonly", "-json", db, "-c", sql], capture_output=True, text=True, check=True).stdout
    return json.loads(out) if out.strip() else []


def js_number(v):
    """String(Number(v.toPrecision(6))) of src/engine/render/table.ts for a float."""
    if float(v).is_integer():
        return str(int(v))
    x = float(f"{v:.6g}")
    if x.is_integer():
        return str(int(x))
    text = repr(x)
    if "e" in text:
        mant, exp = text.split("e")
        text = f"{mant}e{'+' if not exp.startswith('-') else ''}{int(exp)}"
    return text


def preview(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return js_number(value)
    text = str(value)
    if len(text) == 19 and text[10] == " " and text.endswith(" 00:00:00"):
        return text[:10]  # midnight timestamps print as dates
    return text


def wait_result(page, seen, sql, timeout=60000):
    page.wait_for_function(f"""(() => {{
      const w = window.__canvasWire.slice({seen});
      return w.some(f => f.kind === {CANDIDATE} && f.value?.sql === {json.dumps(sql)});
    }})()""", timeout=timeout)


def pct(values, q):
    xs = sorted(v for v in values if v is not None and not math.isnan(v))
    return xs[min(len(xs) - 1, int(q * (len(xs) - 1) + 0.5))] if xs else None


def main():
    dist, binary, db, queries_path = arg("--dist"), arg("--binary"), arg("--db"), arg("--queries")
    warm = int(arg("--warm", "5"))
    queries = json.load(open(queries_path))
    db_port, web_port = free_port(), free_port()
    origin = f"http://127.0.0.1:{web_port}"
    env = {**os.environ, "TIME_BLAST_DB_BACKEND": "duckdb", "TIME_BLAST_DUCKDB_PATH": db,
           "TIME_BLAST_DB_BIND": f"127.0.0.1:{db_port}", "TIME_BLAST_ALLOWED_ORIGINS": origin,
           "TIME_BLAST_DUCKDB_THREADS": arg("--threads", "3"), "TIME_BLAST_DUCKDB_MEMORY_LIMIT": arg("--memory", "1GB"),
           "TIME_BLAST_DUCKDB_TEMP_DIR": os.path.join(os.path.dirname(os.path.abspath(dist)), "duckdb-spill"),
           "TIME_BLAST_DB_NAME": os.path.splitext(os.path.basename(db))[0]}
    server = subprocess.Popen([binary], env=env, stderr=subprocess.PIPE, text=True)
    preview_proc = subprocess.Popen(["npx", "vite", "preview", "--host", "127.0.0.1", "--port", str(web_port), "--strictPort", "--outDir", dist],
                                    cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    inference = Inference({f"{q['question']} #{n}": f"{q['sql']}\n-- run {n}" for q in queries for n in range(warm + 1)})
    results = {"queries": [], "db": db, "conditions": {}}
    try:
        wait_for(f"http://127.0.0.1:{db_port}/health")
        wait_for(origin)
        health = json.load(urllib.request.urlopen(f"http://127.0.0.1:{db_port}/health"))
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--enable-unsafe-swiftshader"])
            results["conditions"]["chromium"] = browser.version
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            context.add_init_script("localStorage.setItem('time-blast.ui.v1', " + json.dumps(json.dumps({
                "inference": {"kind": "remote", "endpoint": f"ws://127.0.0.1:{inference.port}/session"},
                "coordinator": {"live": True, "speculate": True},
            })) + ");")
            context.add_init_script(TRACE)
            context.add_init_script("""(() => {
              window.__tables = [];
              const W = window.Worker;
              window.Worker = class extends W { constructor(...a) { super(...a);
                this.addEventListener('message', e => { if (e.data?.type === 'table') window.__tables.push(e.data); }); } };
            })();""")
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(origin, wait_until="domcontentloaded")
            page.wait_for_function("window.__timeBlastUi?.controller.defaultSourceId && __timeBlastUi.controller.context", timeout=180000)
            name = env["TIME_BLAST_DB_NAME"]
            t0 = time.perf_counter()
            page.evaluate("([name, endpoint]) => __timeBlastUi.controller.setDataset({kind: 'remote', name, endpoint})",
                          [name, f"ws://127.0.0.1:{db_port}/session"])
            page.wait_for_function(f"__timeBlastUi.controller.context?.name === {json.dumps(name)} && __timeBlastUi.controller.context?.dialect === 'duckdb'", timeout=60000)
            results["openRemoteMs"] = (time.perf_counter() - t0) * 1000
            editor = page.locator('[data-el="input"]')
            editor.click()
            for q in queries:
                expected = cli_rows(db, q["sql"])
                runs = []
                for run in range(warm + 1):
                    editor.press("Control+a")
                    editor.press("Backspace")
                    page.wait_for_timeout(150)
                    seen = page.evaluate("window.__canvasWire.length")
                    question, sql = f"{q['question']} #{run}", f"{q['sql']}\n-- run {run}"
                    page.keyboard.insert_text(question)
                    try:
                        wait_result(page, seen, sql)
                    except Exception:
                        dump = page.evaluate(f"window.__canvasWire.slice({seen}).map(f => [f.kind, f.request, f.revision, JSON.stringify(f.value).slice(0, 200)])")
                        print("wire:", json.dumps(dump)[:3000], "\npage errors:", errors, file=sys.stderr)
                        print("tables:", json.dumps(page.evaluate("window.__tables.map(t => [t.request, t.total, t.rows.length])")), file=sys.stderr)
                        print("all:", json.dumps(page.evaluate("window.__canvasWire.map((f, i) => [i, f.kind, f.request, f.revision, f.kind === 51 ? f.value : f.kind === 52 ? f.stamps.length : 0])")), "seen", seen, file=sys.stderr)
                        page.screenshot(path=os.path.join(os.path.dirname(os.path.abspath(dist)), "remote-duckdb-fail.png"))
                        raise
                    page.wait_for_function(f"""(() => {{
                      const w = window.__canvasWire.slice({seen});
                      const r = w.find(f => f.kind === {CANDIDATE} && f.value?.sql === {json.dumps(sql)});
                      return r && w.some(f => f.kind === {TIMING} && f.request === r.request && f.stamps.some(s => s.stage === {FIRST_DRAW}));
                    }})()""", timeout=60000)
                    if run == 0:  # the preview is posted again at DONE with the total
                        try:
                            page.wait_for_function(f"""(() => {{
                              const r = window.__canvasWire.slice({seen}).find(f => f.kind === {CANDIDATE} && f.value?.sql === {json.dumps(sql)});
                              return window.__tables.some(t => t.request === r.request && t.total === {len(expected)});
                            }})()""", timeout=15000)
                        except Exception:
                            pass
                    info = page.evaluate(f"""(() => {{
                      const w = window.__canvasWire.slice({seen});
                      const r = w.find(f => f.kind === {CANDIDATE} && f.value?.sql === {json.dumps(sql)});
                      const t = w.filter(f => f.kind === {TIMING} && f.request === r.request).pop();
                      const table = window.__tables.filter(x => x.request === r.request).pop();
                      return {{request: r.request, stamps: t.stamps, table}};
                    }})()""")
                    s = {}
                    for st in info["stamps"]:
                        s.setdefault(st["stage"], st["at"])
                    d = lambda a, b: (s[b] - s[a]) if a in s and b in s else None
                    runs.append({"keyToDraw": d(KEY_INPUT, FIRST_DRAW), "execToServerFirst": d(EXEC_SENT, DB_FIRST_BATCH),
                                 "serverFirst": d(EXEC_RECEIVED, DB_FIRST_BATCH), "serverDone": d(EXEC_RECEIVED, DB_DONE),
                                 "serverFirstToRender": d(DB_FIRST_BATCH, RENDER_FIRST_BATCH), "renderToDraw": d(RENDER_FIRST_BATCH, FIRST_DRAW)})
                    table = info["table"]
                    if run == 0:
                        assert table, f"no table preview for {q['sql']}"
                        want = [[preview(v) for v in row.values()] for row in expected[:50]]
                        assert table["total"] == len(expected), (q["sql"], table["total"], len(expected))
                        assert table["rows"] == want, (q["sql"], table["rows"][:3], want[:3])
                summary = {"question": q["question"], "sql": q["sql"], "rows": len(expected), "equal": True, "cold": runs[0]}
                for key in runs[0]:
                    vals = [r[key] for r in runs[1:]]
                    summary[key + "_warm_p50"] = pct(vals, 0.5)
                    summary[key + "_warm_max"] = max((v for v in vals if v is not None), default=None)
                results["queries"].append(summary)
                print(json.dumps(summary), flush=True)
            results["pageErrors"] = errors
            results["health"] = json.load(urllib.request.urlopen(f"http://127.0.0.1:{db_port}/health"))
            results["healthBefore"] = health
            browser.close()
    finally:
        server.terminate()
        preview_proc.terminate()
        try:
            results["serverLog"] = server.communicate(timeout=5)[1][-4000:]
        except Exception:
            server.kill()
    if arg("--json"):
        json.dump(results, open(arg("--json"), "w"), indent=2)
    print(json.dumps({k: v for k, v in results.items() if k != "queries"}, indent=2)[:3000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
