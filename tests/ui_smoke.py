"""UI smoke: the batch-1 main thread against a scripted fake engine worker.

Starts nothing itself: run a Vite dev server first, e.g.
    pnpm exec vite --port 5391 --strictPort
    python3 tests/ui_smoke.py http://127.0.0.1:5391/

The real engine worker (src/engine/engine.worker.ts) is replaced through request interception
by FAKE_ENGINE below, which decodes tb1 frames and answers like coordinator + renderer would:
STATUS, context, BIND, RESULT, views, axes, table, TIMING, KEEP. It also draws on each
transferred OffscreenCanvas with 2D so canvas transfer is exercised.

Checks: no console errors; boot sends attach×2 + CONFIG; typing sends DRAFT frames and the
live card shows the question; Enter keeps the card and the pool is replenished; timing panel
fills; settings CONFIG reaches the engine. Then measures main-thread cost per keystroke.
The page is served cross-origin isolated (COOP/COEP added here) so performance.now() has
fine resolution.
"""
import json
import statistics
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5391/"

FAKE_ENGINE = r"""
const K = {STATUS:0x04, ERROR:0x05, CONFIG:0x06, DRAFT:0x10, COMMIT:0x11, CANCEL:0x12, INFER_STATS:0x1b, BIND:0x30, UNBIND:0x31, RESULT:0x33, TIMING:0x34, KEEP:0x35};
const enc = new TextEncoder(), dec = new TextDecoder();
const log = {boot:0, attach:[], frames:{}, configs:[], drafts:[], commits:0, cancels:0, resizes:0};
const pool = [], canvases = new Map();
let request = 0, live = null, liveOn = true, lastDraft = null, context = 3;
const now = () => performance.timeOrigin + performance.now();
function frame(kind, {request=0, revision=0, flags=0}={}, payload=new Uint8Array(0), stamps=[]) {
  const len = 24 + stamps.length*16 + payload.byteLength, out = new Uint8Array(len), v = new DataView(out.buffer);
  out[0]=1; out[1]=kind; out[2]=flags; out[3]=stamps.length; v.setUint32(4,payload.byteLength,true);
  v.setUint32(12,request,true); v.setUint32(16,revision,true); v.setUint32(20,context,true);
  stamps.forEach((s,i)=>{ const at=24+i*16; v.setUint16(at,s[0],true); v.setUint16(at+2,s[1],true); v.setFloat64(at+8,s[2],true); });
  out.set(payload, 24+stamps.length*16);
  postMessage({type:'frame', bytes:out.buffer}, [out.buffer]);
}
const u32 = n => new Uint8Array(new Uint32Array([n]).buffer);
const js = o => enc.encode(JSON.stringify(o));
function parse(buf) {
  const b = new Uint8Array(buf), v = new DataView(buf), n = b[3], stamps = [];
  for (let i=0;i<n;i++) stamps.push([v.getUint16(24+i*16,true), v.getUint16(26+i*16,true), v.getFloat64(32+i*16,true)]);
  return {kind:b[1], flags:b[2], epoch:v.getUint32(8,true), revision:v.getUint32(16,true), context:v.getUint32(20,true), stamps, payload:b.subarray(24+n*16)};
}
function paint(slot, text) {
  const c = canvases.get(slot); if (!c) return;
  const g = c.getContext('2d'); g.fillStyle = '#0d1f29'; g.fillRect(0,0,c.width,c.height);
  g.strokeStyle = '#61dfbf'; g.lineWidth = 2; g.beginPath();
  for (let x=0;x<c.width;x+=8) g.lineTo(x, c.height/2 + Math.sin((x+text.length*13)/40)*c.height/4);
  g.stroke();
}
function answer(f, text) {
  if (live === null) live = pool[0];
  const slot = live, req = ++request;
  frame(K.BIND, {request:req, revision:f.revision}, u32(slot));
  frame(K.RESULT, {request:req, revision:f.revision}, js({slot, sql:`SELECT ts, avg(speed) FROM t -- ${text}`, columns:[{name:'ts',type:'TIMESTAMP',role:'time'},{name:'speed',type:'DOUBLE',role:'value'}], view:'line', cached:false}));
  postMessage({type:'views', slot, available:['line','bar','scatter','table','surface','tracks'], chosen:'line'});
  postMessage({type:'axes', slot, ticks:{x:[{at:80,label:'Jan 1'},{at:260,label:'Jan 8'}], y:[{at:40,label:'20'},{at:160,label:'10'}], plot:{left:48,top:10,width:400,height:200}, legend:[{label:'Aurora',color:'#61dfbf'}]}});
  postMessage({type:'table', slot, columns:['ts','speed'], rows:[['2026-01-01','12.3'],['2026-01-02','11.9']], total:2});
  paint(slot, text);
  const key = f.stamps.find(s=>s[0]===1), t = now();
  frame(K.INFER_STATS, {request:req}, js({model:'fake-model', promptTokens:900, cachedTokens:800, completionTokens:30, costUsd:0.00004, attempts:1}));
  frame(K.TIMING, {request:req, revision:f.revision}, new Uint8Array(0), [...f.stamps, [3,2,t-3], [10,2,t-2], [16,5,t]]);
  return {slot, req};
}
let bound = null;
onmessage = e => {
  const m = e.data;
  if (m.type === 'boot') {
    log.boot++;
    for (const c of ['database','inference','renderer','coordinator']) frame(K.STATUS, {}, js({component:c, state:'ready', label:`fake ${c}`}));
    postMessage({type:'context', context:{id:context, name:'vessels', dialect:'duckdb', description:'Fake fixture', tables:[{name:'telemetry', rows:1209600, columns:[{name:'ts',type:'TIMESTAMP'},{name:'speed',type:'DOUBLE'}]}]}});
  } else if (m.type === 'attach') { log.attach.push(m.slot); canvases.set(m.slot, m.canvas); m.canvas.width = Math.round(m.size.width*m.size.devicePixelRatio); m.canvas.height = Math.round(m.size.height*m.size.devicePixelRatio); }
  else if (m.type === 'resize') { log.resizes++; const c = canvases.get(m.slot); if (c) { c.width = Math.round(m.size.width*m.size.devicePixelRatio); c.height = Math.round(m.size.height*m.size.devicePixelRatio); } }
  else if (m.type === 'detach') canvases.delete(m.slot);
  else if (m.type === 'debug') postMessage({type:'debug', log, pool});
  else if (m.type === 'frame') {
    const f = parse(m.bytes);
    log.frames[f.kind] = (log.frames[f.kind]||0) + 1;
    if (f.kind === K.CONFIG) {
      const c = JSON.parse(dec.decode(f.payload)); log.configs.push(c);
      if (c.freeSlots) pool.push(...c.freeSlots);
      if (c.live !== undefined) liveOn = c.live;
    } else if (f.kind === K.DRAFT) {
      const text = dec.decode(f.payload); log.drafts.push([f.revision, text, f.context, f.stamps.length]);
      if (liveOn && text.trim().length >= 3) bound = answer(f, text);
    } else if (f.kind === K.COMMIT) {
      log.commits++;
      if (!bound) bound = answer(f, dec.decode(f.payload));
      const {slot, req} = bound; pool.splice(pool.indexOf(slot), 1); live = null; bound = null;
      frame(K.KEEP, {request:req, revision:f.revision}, u32(slot));
    } else if (f.kind === K.CANCEL) log.cancels++;
  }
};
"""

ISOLATION = {"Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp"}


def main() -> int:
    failures: list[str] = []
    errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--disable-gpu"])
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        def isolate(route):
            if "engine.worker" in route.request.url:
                route.fulfill(status=200, body=FAKE_ENGINE, headers={"content-type": "text/javascript", **ISOLATION})
                return
            response = route.fetch()
            route.fulfill(response=response, headers={**response.headers, **ISOLATION})

        page.route("**/*", isolate)
        page.goto(URL)
        page.wait_for_selector('[data-stage="database"][data-state="ready"]', timeout=20000)
        isolated = page.evaluate("crossOriginIsolated")

        # The worker is reachable only through the controller's port; ask it for its log.
        page.evaluate("""() => {
          const ui = window.__timeBlastUi, port = ui.controller.port;
          window.__engineLog = () => new Promise(resolve => {
            const on = e => { if (e.data && e.data.type === 'debug') { port.removeEventListener('message', on); resolve(e.data); } };
            port.addEventListener('message', on); port.postMessage({type:'debug'});
          });
        }""")
        log = page.evaluate("window.__engineLog()")
        def check(cond, message):
            if not cond:
                failures.append(message)
        check(log["log"]["boot"] == 1, "boot message")
        check(log["log"]["attach"] == [1, 2], f"attach slots {log['log']['attach']}")
        check(log["log"]["configs"][0].get("freeSlots") == [1, 2], f"initial CONFIG {log['log']['configs'][0]}")
        check(page.text_content('[data-el="dataset-title"]') == "vessels", "context reached the rail")

        box = page.locator("#query-input")
        box.click()
        question = "average speed by hour"
        page.keyboard.type(question, delay=25)
        page.wait_for_function("() => document.querySelector('.slot-card[data-idle=false] .card-title')?.textContent === 'average speed by hour'", timeout=5000)
        log = page.evaluate("window.__engineLog()")["log"]
        drafts = log["drafts"]
        check([d[0] for d in drafts] == list(range(1, len(question) + 1)), f"revisions {[d[0] for d in drafts]}")
        check(drafts[-1][1] == question and drafts[-1][2] == 3 and drafts[-1][3] == 2, f"last draft {drafts[-1]}")
        check(page.text_content('[data-el="timing-headline"]') not in ("—", None), "timing headline")
        check(page.locator('.slot-card[data-idle=false] .axis-x').count() == 2, "axis labels drawn in DOM")
        check(page.locator('.slot-card[data-idle=false] select[aria-label="Visualization type"] option').count() == 7, "view picker populated")
        page.select_option('.slot-card[data-idle=false] select[aria-label="Visualization type"]', "surface")
        check(page.locator('.slot-card[data-idle=false] [data-c="rotation-wrap"]').is_visible(), "surface controls shown")

        page.keyboard.press("Enter")
        page.wait_for_function("() => document.querySelectorAll('.slot-card[data-idle=false]').length === 1 && document.querySelector('.history-question')", timeout=5000)
        log = page.evaluate("window.__engineLog()")
        check(log["log"]["commits"] == 1, "COMMIT sent")
        check(log["log"]["attach"] == [1, 2, 3], f"pool replenished {log['log']['attach']}")
        check(sorted(log["pool"]) == [2, 3], f"engine pool {log['pool']}")
        check(page.text_content('.slot-card[data-live=false][data-idle=false] [data-c="state-label"]') == "KEPT", "kept card")

        page.keyboard.type("max wind", delay=25)
        page.wait_for_function("() => document.querySelectorAll('.slot-card[data-idle=false]').length === 2", timeout=5000)
        page.screenshot(path="/tmp/claude-1001/-home-fred-time-blast/39930af6-fed0-47df-ad0c-023b5b710069/scratchpad/ui-smoke.png")

        page.keyboard.press("Escape")
        page.click('[data-action="settings"] >> nth=0')
        page.check('input[name="latencyDialOn"]')
        page.fill('input[name="latencyDialMs"]', "120")
        page.click('[data-action="close-settings"] >> nth=0')
        page.wait_for_timeout(100)
        log = page.evaluate("window.__engineLog()")["log"]
        check(log["cancels"] >= 1, "CANCEL sent on Escape")
        check(any(c.get("latencyDialMs") == 120 for c in log["configs"]), f"latency dial CONFIG {log['configs']}")

        # ── per-keystroke main-thread cost ──
        # Live off so the fake engine does not answer during measurement (answers are async anyway).
        page.click('[data-toggle="live"]')
        box.fill("")
        page.keyboard.type("compare wave height by vessel over the last week", delay=15)
        typed = page.evaluate("window.__timeBlastUi.costs()")[-40:]
        synthetic = page.evaluate("""() => {
          const input = document.querySelector('#query-input'), base = 'compare wave height by vessel over the last week ';
          const N = 5000, samples = new Float64Array(N);
          const t0 = performance.now();
          for (let i = 0; i < N; i++) { input.value = base + (i % 2 ? 'x' : 'y') + i; input.dispatchEvent(new InputEvent('input', {inputType:'insertText', data:'x'})); }
          const total = performance.now() - t0;
          const costs = window.__timeBlastUi.costs();
          // Encoder alone (post is a no-op): our share of the per-keystroke cost.
          const Encoder = window.__timeBlastUi.controller.drafts.constructor;
          const sink = new Encoder(() => {});
          const M = 100000, t1 = performance.now();
          for (let i = 0; i < M; i++) sink.draft(base + i, false, 0);
          const encodeUs = (performance.now() - t1) / M * 1000;
          return {N, totalMs: total, perEventUs: total / N * 1000, handlerSamples: costs, encodeUs};
        }""")
        browser.close()

    handler = sorted(synthetic["handlerSamples"])
    report = {
        "crossOriginIsolated": isolated,
        "typed_keystrokes_us": {
            "n": len(typed),
            "median": statistics.median(typed) * 1000,
            "p95": sorted(typed)[int(0.95 * (len(typed) - 1))] * 1000,
            "max": max(typed) * 1000,
        },
        "synthetic_dispatch_us_per_event": synthetic["perEventUs"],
        "encode_only_us_per_draft": synthetic["encodeUs"],
        "synthetic_handler_us": {
            "n": len(handler),
            "median": statistics.median(handler) * 1000,
            "p95": handler[int(0.95 * (len(handler) - 1))] * 1000,
        },
    }
    print(json.dumps(report, indent=2))
    real_errors = [e for e in errors if "favicon" not in e]
    if real_errors:
        failures.append(f"console errors: {real_errors}")
    for f in failures:
        print("FAIL:", f)
    print("OK" if not failures else f"{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
