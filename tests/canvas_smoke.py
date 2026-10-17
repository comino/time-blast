"""Persistent-canvas vertical smoke: real application, engine, Wasm and DuckDB.

Only inference is scripted, through a real local tb1 WebSocket server (aiohttp).
Start Vite, then run: python3 tests/canvas_smoke.py http://127.0.0.1:5394 [--keystroke-only]
Requires Python aiohttp and Playwright with Chromium. No provider calls are made.

After the canvas flows, a fresh browser context checks the composer controls and measures the
per-keystroke main-thread cost of our input handler (``__timeBlastUi.costs()``: controller.input
including the canvas document update and the synchronous part of its IndexedDB save;
``costsFull()`` adds the microtasks it queued): the timing panel fills, Escape sends CANCEL, the
latency dial reaches the engine as CONFIG, and Live off sends CONFIG and stops inference.
``--keystroke-only`` runs just that phase.
"""
import asyncio
import json
import struct
import sys
import threading
import time
from pathlib import Path

from aiohttp import WSMsgType, web
from playwright.sync_api import sync_playwright


ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
URL = (ARGS[0] if ARGS else "http://127.0.0.1:5394").rstrip("/")
KEYSTROKE_ONLY = "--keystroke-only" in sys.argv
COST_QUESTION = "compare wave height by vessel over the last week"
HELLO, READY, CONTEXT, CANCEL = 0x01, 0x02, 0x03, 0x12
INFER, SQL, EDIT_CONTEXT, EDIT_INFER = 0x18, 0x1A, 0x1D, 0x1E
QUESTION = "Average speed by day and vessel"
CHANGE = "Use maximum speed instead"
HOLD = "Hold for recovery, then use minimum speed"
FILE_QUESTION = "Totals in the local file"
FILE_SQL = "SELECT category, SUM(amount) AS total FROM tiny GROUP BY category ORDER BY category"
FILE_BYTES = b"category,amount\nA,1\nA,2\nB,4\n"


def query(aggregate="AVG"):
    return (f"SELECT date_trunc('day', ts) AS day, vessel, {aggregate}(speed) AS speed "
            "FROM telemetry GROUP BY day, vessel ORDER BY day, vessel")


def decode(raw):
    version, kind, flags, stamps, size, epoch, request, revision, context = struct.unpack_from("<BBBBIIIII", raw)
    assert version == 1 and len(raw) == 24 + stamps * 16 + size
    return {"kind": kind, "epoch": epoch, "request": request, "revision": revision,
            "context": context, "payload": raw[24 + stamps * 16:]}


def encode(kind, source, payload):
    payload = payload.encode() if isinstance(payload, str) else payload
    return struct.pack("<BBBBIIIII", 1, kind, 0, 0, len(payload), source.get("epoch", 0),
                       source.get("request", 0), source.get("revision", 0), source.get("context", 0)) + payload


class InferenceServer:
    def __init__(self):
        self.frames = []
        self.calls = []
        self.errors = []
        self.port = None
        self.loop = asyncio.new_event_loop()
        self.ready = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()
        assert self.ready.wait(10), "Inference server did not start"

    def run(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self.start())
        self.ready.set()
        self.loop.run_forever()

    async def start(self):
        app = web.Application()
        app.router.add_get("/session", self.session)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await self.site.start()
        self.port = self.site._server.sockets[0].getsockname()[1]

    async def session(self, request):
        ws = web.WebSocketResponse(protocols=("tb1",))
        await ws.prepare(request)
        bases = {}
        async for message in ws:
            if message.type != WSMsgType.BINARY:
                continue
            try:
                frame = decode(message.data)
                self.frames.append({key: value for key, value in frame.items() if key != "payload"})
                kind = frame["kind"]
                if kind == HELLO:
                    await ws.send_bytes(encode(READY, {}, json.dumps({"node": "inference", "name": "canvas-smoke", "capabilities": ["edit-context-v1"]})))
                elif kind == EDIT_CONTEXT:
                    bases[(frame["context"], frame["request"], frame["revision"])] = json.loads(frame["payload"])
                elif kind in (INFER, EDIT_INFER):
                    base = None
                    if kind == EDIT_INFER:
                        slot, generation = struct.unpack_from("<II", frame["payload"])
                        base = bases[(frame["context"], slot, generation)]
                        change = frame["payload"][8:].decode()
                    else:
                        change = frame["payload"].decode()
                    self.calls.append({"kind": kind, "text": change, "base": base})
                    if "hold for recovery" in change.lower():
                        continue  # Preserve an unfinished edit across reload.
                    sql = FILE_SQL if change == FILE_QUESTION else query("MAX" if "maximum" in change.lower() else "MIN" if "minimum" in change.lower() else "AVG")
                    if "surface" in change.lower():
                        sql = "-- view: surface\n" + sql
                    await ws.send_bytes(encode(SQL, frame, sql))
            except Exception as error:
                self.errors.append(str(error))
                await ws.close(code=1011, message=str(error).encode()[:100])
        return ws

    def close(self):
        asyncio.run_coroutine_threadsafe(self.runner.cleanup(), self.loop).result(10)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(10)


TRACE = """(() => {
  window.__canvasWire = [];
  window.__canvasSent = [];
  window.__canvasWorkerErrors = [];
  const OriginalWorker = window.Worker;
  window.Worker = class extends OriginalWorker {
    postMessage(message, transfer) {
      // UI → engine frames, decoded before the transfer detaches them (kind, CONFIG payload).
      if (message?.type === 'frame' && message.bytes instanceof ArrayBuffer && message.bytes.byteLength >= 24) {
        const bytes = new Uint8Array(message.bytes), view = new DataView(message.bytes), kind = bytes[1];
        let config;
        if (kind === 0x06) try { config = JSON.parse(new TextDecoder().decode(bytes.subarray(24 + bytes[3] * 16))); } catch { /* not JSON */ }
        window.__canvasSent.push({ at: performance.now(), kind, revision: view.getUint32(16, true), config });
      }
      return super.postMessage(message, transfer);
    }
    constructor(...args) {
      super(...args);
      this.addEventListener('error', event => window.__canvasWorkerErrors.push({ message: event.message, filename: event.filename, line: event.lineno }));
      this.addEventListener('message', event => {
        const message = event.data;
        if (message?.type !== 'frame') return;
        const bytes = new Uint8Array(message.bytes), view = new DataView(message.bytes);
        const kind = bytes[1], payload = new TextDecoder().decode(bytes.subarray(24 + bytes[3] * 16));
        let value; try { value = JSON.parse(payload); } catch { value = payload; }
        const stamps = Array.from({ length: bytes[3] }, (_, i) => ({ stage: view.getUint16(24 + i * 16, true), at: view.getFloat64(32 + i * 16, true) }));
        window.__canvasWire.push({ at: performance.now(), kind, request: view.getUint32(12, true), revision: view.getUint32(16, true), context: view.getUint32(20, true), stamps, value });
      });
    }
  };
})();"""


def wait(page, expression, timeout=45000):
    page.wait_for_function(expression, timeout=timeout)


def snapshot(page):
    return page.evaluate("__timeBlastUi.controller.model.snapshot()")


def selected(page):
    return page.evaluate("(() => { const m = __timeBlastUi.controller.model; return m.selected(m.state.charts[0].id); })()")


def saved(page):
    wait(page, "window.__timeBlastUi?.controller.session?.saveState.state === 'saved'")


def ready_chart(page):
    wait(page, "window.__canvasWire?.some(f => f.kind === 0x36 && f.value.status === 'succeeded')")
    wait(page, "document.querySelector('.slot-card [data-c=tbody] tr') !== null")


def phase(name):
    print(name, flush=True)


def wait_inference(server, text):
    deadline = time.monotonic() + 10
    while not any(call["text"] == text for call in server.calls):
        assert time.monotonic() < deadline, f"Inference did not receive {text!r}"
        time.sleep(0.02)


def pct(values, q):
    xs = sorted(values)
    return xs[min(len(xs) - 1, int(q * (len(xs) - 1) + 0.5))] if xs else None


def summary_us(values_ms):
    xs = [v * 1000 for v in values_ms if v == v]  # drop NaN (microtask not yet run)
    return {"n": len(xs), "median": pct(xs, 0.5), "p95": pct(xs, 0.95), "p99": pct(xs, 0.99), "max": max(xs) if xs else None}


def keystroke_controls(browser, server, results):
    """Composer controls and per-keystroke main-thread cost, on a fresh canvas (new context)."""
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    context.add_init_script("localStorage.setItem('time-blast.ui.v1', " + json.dumps(json.dumps({
        "inference": {"kind": "remote", "endpoint": f"ws://127.0.0.1:{server.port}/session"},
        "coordinator": {"live": True, "speculate": True},
    })) + ");")
    context.add_init_script(TRACE)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    sent = lambda kind: page.evaluate(f"window.__canvasSent.filter(f => f.kind === {kind}).length")
    configs = lambda: page.evaluate("window.__canvasSent.filter(f => f.config).map(f => f.config)")
    try:
        phase("keystroke cost and composer controls (fresh canvas)")
        page.goto(URL, wait_until="domcontentloaded")
        wait(page, "window.__timeBlastUi?.controller.defaultSourceId && __timeBlastUi.controller.context")
        results["crossOriginIsolated"] = page.evaluate("crossOriginIsolated")
        editor = page.locator('[data-el="input"]')
        editor.click()
        before = len(server.calls)
        # Typed like a person (70 ms between keys), Live on: every keystroke versions the draft,
        # saves it and sends a DRAFT that the real engine translates, runs and draws.
        page.keyboard.type(COST_QUESTION, delay=70)
        wait(page, "document.querySelector('[data-el=timing-headline]').textContent !== '—'")
        wait(page, "document.querySelectorAll('[data-el=timing-stages] li:not([hidden])').length >= 3")
        assert len(server.calls) > before, "typing reached inference"
        results["timingPanel"] = page.locator('[data-el="timing-headline"]').text_content()
        saved(page)
        n = len(COST_QUESTION)
        results["typed_keystrokes_us"] = summary_us(page.evaluate("__timeBlastUi.costs()")[-n:])
        results["typed_keystrokes_with_microtasks_us"] = summary_us(page.evaluate("__timeBlastUi.costsFull()")[-n:])
        assert results["typed_keystrokes_us"]["n"] == n, results["typed_keystrokes_us"]

        phase("Escape sends CANCEL")
        cancels = sent(CANCEL)
        editor.press("Escape")
        wait(page, f"window.__canvasSent.filter(f => f.kind === {CANCEL}).length > {cancels}", 5000)
        results["escapeCancel"] = True

        phase("latency dial reaches the engine")
        page.locator('[data-action="settings"]').first.click()
        page.check('input[name="latencyDialOn"]')
        page.fill('input[name="latencyDialMs"]', "120")
        page.locator('[data-action="close-settings"]').first.click()
        wait(page, "window.__canvasSent.some(f => f.config && f.config.latencyDialMs === 120)", 5000)
        page.locator('[data-action="settings"]').first.click()
        page.uncheck('input[name="latencyDialOn"]')
        page.locator('[data-action="close-settings"]').first.click()
        wait(page, "window.__canvasSent.some(f => f.config && 'latencyDialMs' in f.config && f.config.latencyDialMs === null)", 5000)
        results["latencyDialConfig"] = True

        phase("Live off: CONFIG reaches the engine and typing stops inference")
        page.locator('[data-toggle="live"]').click()
        wait(page, "window.__canvasSent.some(f => f.config && f.config.live === false)", 5000)
        assert page.locator('[data-toggle="live"]').get_attribute("aria-checked") == "false"
        editor.click()
        editor.fill("")
        before, drafts = len(server.calls), sent(0x10)
        page.keyboard.type("max wind per vessel", delay=40)
        page.wait_for_timeout(1500)
        assert sent(0x10) > drafts, "DRAFT frames still flow with Live off"
        assert len(server.calls) == before, server.calls[before:]
        results["liveOffNoInference"] = True

        phase("synthetic per-keystroke handler cost (Live off)")
        synthetic = page.evaluate("""() => {
          const input = document.querySelector('[data-el=input]'), base = 'compare wave height by vessel over the last week ';
          const N = 200, before = __timeBlastUi.costs().length;
          const t0 = performance.now();
          for (let i = 0; i < N; i++) { input.value = base + (i % 2 ? 'x' : 'y') + i; input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'x' })); }
          const total = performance.now() - t0;
          // DraftEncoder alone (post is a no-op): the encode share of a keystroke.
          const Encoder = __timeBlastUi.controller.drafts.constructor, sink = new Encoder(() => {});
          const M = 100000, t1 = performance.now();
          for (let i = 0; i < M; i++) sink.draft(base + i, false, 0);
          return { N, perEventUs: total / N * 1000, handler: __timeBlastUi.costs().slice(-N), encodeUs: (performance.now() - t1) / M * 1000 };
        }""")
        saved(page)
        results["synthetic_dispatch_us_per_event"] = synthetic["perEventUs"]
        results["synthetic_handler_us"] = summary_us(synthetic["handler"])
        results["encode_only_us_per_draft"] = synthetic["encodeUs"]
        page.locator('[data-toggle="live"]').click()
        wait(page, "window.__canvasSent.some(f => f.config && f.config.live === true)", 5000)
        assert not errors, errors
    finally:
        context.close()


def main():
    server = InferenceServer()
    results = {}
    if KEYSTROKE_ONLY:
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True, args=["--enable-unsafe-swiftshader"])
                try:
                    keystroke_controls(browser, server, results)
                    results["browser"] = browser.version
                finally:
                    browser.close()
            print(json.dumps(results, indent=2), flush=True)
        finally:
            server.close()
        return
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--enable-unsafe-swiftshader"])
            context = browser.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
            context.add_init_script("localStorage.setItem('time-blast.ui.v1', " + json.dumps(json.dumps({
                "inference": {"kind": "remote", "endpoint": f"ws://127.0.0.1:{server.port}/session"},
                "coordinator": {"live": True, "speculate": True},
            })) + ");")
            context.add_init_script(TRACE)
            page = context.new_page()
            errors = []
            network_errors, console_errors = [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("requestfailed", lambda request: network_errors.append({"url": request.url, "error": request.failure}))
            page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
            try:
                phase("boot real engine")
                page.goto(URL, wait_until="domcontentloaded")
                wait(page, "window.__timeBlastUi?.controller.defaultSourceId && __timeBlastUi.controller.context")
                assert page.evaluate("crossOriginIsolated"), "Real DuckDB smoke requires Vite isolation headers"
                phase("create and checkpoint")
                editor = page.locator('[data-el="input"]')
                editor.fill(QUESTION)
                editor.press("Enter")
                wait(page, "__timeBlastUi.controller.model.state.charts.length === 1")
                ready_chart(page)
                saved(page)
                original = selected(page)
                assert original["originalQuestion"] == QUESTION and original["sql"] == query(), original
                assert original["presentation"] == {"view": None, "params": {}}
                canvas_id = snapshot(page)["canvas"]["id"]
                assert len(server.calls) == 1, server.calls
                results["createCheckpoint"] = True

                phase("checkpoint layout once at the end of a real drag")
                previous_layout = snapshot(page)["commits"][-1]["state"]["charts"][0]["layout"]
                handle = page.locator('.slot-card .card-header').bounding_box()
                assert handle is not None
                drag_x, drag_y = handle["x"] + 120, handle["y"] + 20
                page.mouse.move(drag_x, drag_y)
                page.mouse.down()
                page.mouse.move(drag_x + 42, drag_y + 18, steps=3)
                page.mouse.up()
                saved(page)
                layout = page.evaluate("__timeBlastUi.controller.model.state.charts[0].layout")
                assert layout["x"] == previous_layout["x"] + 42 and layout["y"] == previous_layout["y"] + 18, layout
                assert selected(page)["id"] == original["id"]

                phase("reload from saved SQL")
                before = len(server.calls)
                page.reload(wait_until="domcontentloaded")
                wait(page, "window.__timeBlastUi?.controller.model?.state.charts.length === 1")
                ready_chart(page)
                saved(page)
                assert snapshot(page)["canvas"]["id"] == canvas_id
                assert selected(page)["id"] == original["id"]
                assert page.evaluate("__timeBlastUi.controller.model.state.charts[0].layout") == layout
                assert len(server.calls) == before, server.calls
                assert page.locator('.slot-card [data-c="sql"]').text_content() == query()
                results["reloadSqlWithoutInference"] = True
                results["layoutReload"] = True

                phase("refine with immutable question, SQL and lineage")
                page.locator('.slot-card [data-a="edit"]').click()
                editor.fill(CHANGE)
                editor.press("Enter")
                wait(page, "__timeBlastUi.controller.model.state.charts[0].revisionId !== " + json.dumps(original["id"]))
                saved(page)
                refined = selected(page)
                assert refined["sql"] == query("MAX") and refined["originalQuestion"] == QUESTION, refined
                edit = server.calls[-1]
                assert edit["kind"] == EDIT_INFER and edit["text"] == CHANGE, edit
                assert edit["base"]["originalQuestion"] == QUESTION and edit["base"]["sql"] == query(), edit
                assert edit["base"]["mode"] == "refine" and edit["base"]["history"], edit
                assert edit["base"]["presentation"] == {"view": None, "params": {}}, edit
                results["refineContext"] = True

                phase("presentation history, Auto and removed parameters")
                picker = page.locator('.slot-card [data-c="view"]')
                picker.select_option("surface")
                page.locator('.slot-card [data-c="rotation"]').evaluate("input => { input.value = '67'; input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); }")
                saved(page)
                surface = selected(page)
                assert surface["presentation"] == {"view": "surface", "params": {"rotation": 67}}, surface
                picker.select_option("")
                saved(page)
                auto = selected(page)
                assert auto["presentation"] == {"view": None, "params": {"rotation": 67}}, auto
                page.locator('[data-canvas-action="undo"]').click()
                wait(page, "__timeBlastUi.controller.model.selected(__timeBlastUi.controller.model.state.charts[0].id).id === " + json.dumps(surface["id"]))
                assert picker.input_value() == "surface"
                assert page.locator('.slot-card [data-c="rotation"]').input_value() == "67"
                page.locator('[data-canvas-action="redo"]').click()
                wait(page, "__timeBlastUi.controller.model.selected(__timeBlastUi.controller.model.state.charts[0].id).id === " + json.dumps(auto["id"]))
                assert picker.input_value() == ""
                page.locator('.slot-card [data-a="history"]').click()
                first_revision = page.locator('.canvas-record').filter(has=page.get_by_role('heading', name='Revision 1 · create', exact=True))
                first_revision.locator('[data-canvas-action="restore-chart"]').click()
                page.locator('[data-canvas-action="close"]').click()
                wait(page, "__timeBlastUi.controller.model.selected(__timeBlastUi.controller.model.state.charts[0].id).id === " + json.dumps(original["id"]))
                saved(page)
                assert selected(page)["presentation"] == {"view": None, "params": {}}
                assert picker.input_value() == "" and page.locator('.slot-card [data-c="rotation"]').input_value() == "-30"
                results["presentationUndoRedoRestore"] = True

                phase("export and import preserve branches without result rows")
                saved(page)
                with page.expect_download() as pending:
                    page.locator('[data-canvas-action="export"]').click()
                raw = Path(pending.value.path()).read_text()
                exported = json.loads(raw)
                assert exported["format"] == "timeblast-canvas"
                assert len(exported["revisions"]) >= 5
                assert all("data" not in r and "rows" not in r for r in exported["revisions"])
                with page.expect_file_chooser() as pending:
                    page.locator('[data-canvas-action="import"]').click()
                pending.value.set_files({"name": "canvas.json", "mimeType": "application/json", "buffer": raw.encode()})
                wait(page, "__timeBlastUi.controller.model.header.id !== " + json.dumps(canvas_id))
                saved(page)
                imported = snapshot(page)
                assert len(imported["revisions"]) == len(exported["revisions"])
                assert len(imported["commits"]) == len(exported["commits"])
                assert selected(page)["sql"] == query()
                results["exportImportBranches"] = True

                phase("recover and resume an unfinished edit after reload")
                page.locator('.slot-card [data-a="edit"]').click()
                editor.fill(HOLD)
                wait(page, "[...__timeBlastUi.controller.model.drafts.values()].some(d => d.state === 'open' && d.text === " + json.dumps(HOLD) + ")")
                wait_inference(server, HOLD)
                saved(page)
                before = len(server.calls)
                page.reload(wait_until="domcontentloaded")
                wait(page, "window.__timeBlastUi?.controller.model && [...__timeBlastUi.controller.model.drafts.values()].some(d => d.state === 'open' && d.text === " + json.dumps(HOLD) + ")")
                ready_chart(page)
                assert len(server.calls) == before, server.calls
                page.locator('[data-canvas-action="drafts"]').click()
                row = page.locator('.canvas-record').filter(has=page.get_by_role('heading', name=HOLD, exact=True))
                row.locator('[data-canvas-action="resume-draft"]').click()
                assert editor.input_value() == HOLD
                editor.fill("Use minimum speed instead")
                editor.press("Enter")
                wait(page, "__timeBlastUi.controller.model.selected(__timeBlastUi.controller.model.state.charts[0].id).sql.includes('MIN(speed)')")
                saved(page)
                assert selected(page)["originalQuestion"] == QUESTION
                results["draftRecoveryResume"] = True

                phase("direct SQL editing and inferred presentation intent")
                before = len(server.calls)
                page.locator('.slot-card .card-sql summary').click()
                page.locator('.slot-card [data-a="edit-sql"]').click()
                assert editor.get_attribute("data-mode") == "sql"
                editor.fill(query("SUM"))
                editor.press("Enter")
                wait(page, "__timeBlastUi.controller.model.selected(__timeBlastUi.controller.model.state.charts[0].id).sql.includes('SUM(speed)')")
                saved(page)
                assert len(server.calls) == before
                page.locator('.slot-card [data-a="edit"]').click()
                editor.fill("Show maximum speed as a surface chart")
                editor.press("Enter")
                wait(page, "__timeBlastUi.controller.model.selected(__timeBlastUi.controller.model.state.charts[0].id).presentation.view === 'surface'")
                saved(page)
                assert server.calls[-1]["base"]["sql"] == query("SUM")
                assert server.calls[-1]["base"]["originalQuestion"] == QUESTION
                assert picker.input_value() == "surface"
                assert selected(page)["sql"] == "-- view: surface\n" + query("MAX")
                results["directSqlAndInferredView"] = True

                phase("mixed sources retain ownership; local file needs reattachment")
                first_chart = selected(page)
                page.get_by_role("button", name="+ New chart", exact=True).click()
                page.locator('[data-canvas-action="choose-source"]').click()
                page.locator('[name="datasetFile"]').set_input_files({"name": "tiny.csv", "mimeType": "text/csv", "buffer": FILE_BYTES})
                wait(page, "__timeBlastUi.controller.model.sources.get(__timeBlastUi.controller.defaultSourceId)?.locator.kind === 'file'")
                page.locator('[data-action="close-settings"]').first.click()
                editor.fill(FILE_QUESTION)
                editor.press("Enter")
                wait(page, "__timeBlastUi.controller.model.state.charts.length === 2")
                saved(page)
                second = page.evaluate("__timeBlastUi.controller.model.selected(__timeBlastUi.controller.model.state.charts[1].id)")
                assert second["sql"] == FILE_SQL and second["sourceRefId"] != first_chart["sourceRefId"]
                before = len(server.calls)
                page.reload(wait_until="domcontentloaded")
                wait(page, "window.__timeBlastUi?.controller.model?.state.charts.length === 2")
                ready_chart(page)
                wait(page, "!__timeBlastUi.controller.runningJob && __timeBlastUi.controller.jobs.length === 0")
                assert len(server.calls) == before
                file_card = page.locator('.slot-card').filter(has=page.get_by_role('heading', name=FILE_QUESTION, exact=True))
                assert file_card.locator('[data-c="sql"]').text_content() == FILE_SQL
                assert "reattach" in file_card.locator('[data-c="subtitle"]').text_content().lower()
                with page.expect_file_chooser() as pending:
                    file_card.locator('[data-a="reattach"]').click()
                pending.value.set_files({"name": "renamed.csv", "mimeType": "text/csv", "buffer": FILE_BYTES})
                wait(page, "[...document.querySelectorAll('.slot-card [data-c=tbody]')].filter(e => e.children.length).length === 2")
                assert file_card.locator('[data-c="tbody"]').evaluate("body => [...body.rows].map(row => [...row.cells].map(cell => cell.textContent))") == [["A", "3"], ["B", "4"]]
                assert selected(page)["id"] == first_chart["id"]
                assert len(server.calls) == before
                results["mixedSourceReattachment"] = True
                page.locator('[data-action="fit"]').click()
                # Fit changes CSS geometry; allow the ResizeObserver/worker redraw to settle.
                page.wait_for_timeout(250)
                page.screenshot(path="/tmp/timeblast-persistent-canvas.png", full_page=True)

                phase("suggested question keeps exact SQL and source through reload")
                previous = page.evaluate("(() => { const m = __timeBlastUi.controller.model; return m.state.charts.map(c => m.selected(c.id)); })()")
                assert page.evaluate("__timeBlastUi.controller.defaultSourceId") != previous[1]["sourceRefId"]
                wait(page, """(() => {
                  const ui = __timeBlastUi, chart = ui.controller.model.state.charts[1];
                  const entry = ui.controller.entries.get(chart.id);
                  return ui.interactions.suggestions.chips.some(chip => chip.from === entry.request && chip.suggestion.kind === 'agg' && chip.status === 'ready');
                })()""")
                chip = page.evaluate("""(() => {
                  const ui = __timeBlastUi, entry = ui.controller.entries.get(ui.controller.model.state.charts[1].id);
                  return ui.interactions.suggestions.chips.find(chip => chip.from === entry.request && chip.suggestion.kind === 'agg' && chip.status === 'ready');
                })()""")
                before = len(server.calls)
                page.locator(f'.suggest-chips button[data-chip="{chip["id"]}"]').click()
                wait(page, "__timeBlastUi.controller.model.state.charts.length === 3")
                saved(page)
                suggested = page.evaluate("__timeBlastUi.controller.model.selected(__timeBlastUi.controller.model.state.charts[2].id)")
                assert suggested["originalQuestion"] == chip["suggestion"]["question"], suggested
                assert suggested["sql"] == chip["suggestion"]["sql"], suggested
                assert suggested["sourceRefId"] == previous[1]["sourceRefId"], suggested
                assert page.locator('.slot-card').nth(2).locator('[data-c="tbody"]').evaluate("body => [...body.rows].map(row => [...row.cells].map(cell => cell.textContent))") == [["A", "1.5"], ["B", "4"]]
                assert page.evaluate("(() => { const m = __timeBlastUi.controller.model; return m.state.charts.slice(0, 2).map(c => m.selected(c.id)); })()") == previous
                assert len(server.calls) == before, server.calls
                page.reload(wait_until="domcontentloaded")
                wait(page, "window.__timeBlastUi?.controller.model?.state.charts.length === 3")
                ready_chart(page)
                wait(page, "!__timeBlastUi.controller.runningJob && __timeBlastUi.controller.jobs.length === 0")
                assert len(server.calls) == before
                with page.expect_file_chooser() as pending:
                    file_card.locator('[data-a="reattach"]').click()
                pending.value.set_files({"name": "tiny-again.csv", "mimeType": "text/csv", "buffer": FILE_BYTES})
                wait(page, "[...document.querySelectorAll('.slot-card [data-c=tbody]')].filter(e => e.children.length).length === 3")
                assert page.evaluate("__timeBlastUi.controller.model.selected(__timeBlastUi.controller.model.state.charts[2].id)") == suggested
                assert page.locator('.slot-card').nth(2).locator('[data-c="tbody"]').evaluate("body => [...body.rows].map(row => [...row.cells].map(cell => cell.textContent))") == [["A", "1.5"], ["B", "4"]]
                assert page.evaluate("(() => { const m = __timeBlastUi.controller.model; return m.state.charts.slice(0, 2).map(c => m.selected(c.id)); })()") == previous
                assert len(server.calls) == before, server.calls
                assert page.evaluate("__timeBlastUi.interactions.suggestions.stats.primed") == 0
                results["suggestedExactSqlSourceReload"] = True
                assert not server.errors, server.errors
                assert not errors, errors
                assert not console_errors, console_errors
                results.update(browser=browser.version, inferenceCalls=len(server.calls), realDuckDB=True, pageErrors=errors, consoleErrors=console_errors)
                keystroke_controls(browser, server, results)
                print(json.dumps(results, indent=2), flush=True)
            except Exception:
                print(json.dumps({"completed": results, "serverErrors": server.errors, "calls": server.calls,
                                  "pageErrors": errors, "body": page.locator('body').inner_text()[-6000:],
                                  "workerErrors": page.evaluate("window.__canvasWorkerErrors"), "networkErrors": network_errors,
                                  "consoleErrors": console_errors,
                                  "snapshot": page.evaluate("window.__timeBlastUi?.controller.model?.snapshot()"),
                                  "entries": page.evaluate("[...(window.__timeBlastUi?.controller.entries?.values() ?? [])].map(({ card, encoder, done, ...entry }) => ({ ...entry, attempts: [...entry.attempts], sent: [...entry.sent] }))"),
                                  "wire": page.evaluate("window.__canvasWire?.slice(-18)")}, indent=2), file=sys.stderr, flush=True)
                raise
            finally:
                browser.close()
    finally:
        server.close()


if __name__ == "__main__":
    main()
