#!/usr/bin/env python3
"""Browser part of the perf harness (docs/perf/README.md). Driven by scripts/perf/run.mjs.

Runs the production build (`vite preview`) in headless Chromium against tests/fake_inference.py
(echo mode: every keystroke yields new SQL, so the final keystroke runs the whole pipeline; no
model in the loop) and records raw samples:

  boot      per page load: navigation → engine STATUS ready per component → CONTEXT → answerable;
            first visit (fresh browser context) and repeat visit (reload, same context);
            plus the first question typed right after boot (cold database, rollups building)
  rounds    interleaved, R times: type a question → first draw; click a next-question chip →
            first draw; type the hourly question, then brush / legend click / Escape twice →
            first draw (chart-as-query)

Every number is a software timestamp from the app's own TIMING ledger (src/ui/timing.ts
`breakdown`, read through the controller): draw *submission*, not photons. `presented` is the
renderer's best effort (WebGPU onSubmittedWorkDone). Frames are decoded without importing app
sources, so this works against the production bundle.

  python3 scripts/perf/e2e.py --url http://127.0.0.1:4173 [--rounds 10] [--boots 2] [--json out.json]
"""
import argparse
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "tests"))
from fake_inference import FakeInference  # noqa: E402

SOFTWARE = ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader"]
QUESTIONS = ["average speed per hour by vessel", "wind every ten minutes", "max speed per vessel"]
HOURLY = "average speed per hour by vessel"
LIVE = 'article.slot-card[data-live="true"]'
LETTERS = "abcdefghijklmnopqrstuvwxyz"

# Runs before any page script: timestamps engine messages from the first Worker on.
BOOT_MARKS = """(() => {
  const boot = window.__perfBoot = { marks: [] };
  const mark = (name, extra) => boot.marks.push({ name, at: performance.now(), ...extra });
  const Original = window.Worker;
  window.Worker = class extends Original {
    constructor(url, options) {
      super(url, options);
      mark('worker-created', { url: String(url) });
      this.addEventListener('message', event => {
        const m = event.data;
        if (!m) return;
        if (m.type === 'context') { mark('context'); return; }
        if (m.type !== 'frame') return;
        const b = new Uint8Array(m.bytes);
        if (b[1] !== 0x04) return; // STATUS
        const view = new DataView(m.bytes), n = b[3], len = view.getUint32(4, true);
        try {
          const s = JSON.parse(new TextDecoder().decode(b.subarray(24 + 16 * n, 24 + 16 * n + len)));
          mark(`status:${s.component}:${s.state}`, { label: s.label, detail: s.detail });
        } catch (e) { /* not ours to judge */ }
      });
    }
  };
})();"""

# After boot: collect TIMING breakdowns exactly as the app computes them (UiController → rail),
# gesture outcomes and axes (for pointer geometry).
HOOK = """() => {
  const ui = globalThis.__timeBlastUi, c = ui.controller, rail = c.rail;
  window.__e2e = { timings: [], errors: [], manipulated: [], axes: {} };
  const timing = rail.timing.bind(rail), error = rail.error.bind(rail), receive = c.receive.bind(c);
  rail.timing = (t, summary, stats) => {
    window.__e2e.timings.push({ request: t.request, revision: t.revision, headline: t.headline, presented: t.presented,
      stages: t.rows.map(r => r.stage), rows: t.rows.map(r => [r.label, r.delta, r.stage]) });
    return timing(t, summary, stats);
  };
  rail.error = (e, request) => { window.__e2e.errors.push(`${e.code}: ${e.message}`); return error(e, request); };
  c.receive = m => {
    if (m.type === 'manipulated') window.__e2e.manipulated.push({ sql: m.sql, method: m.method, reason: m.reason, ms: m.ms });
    else if (m.type === 'axes') window.__e2e.axes[m.slot] = m.ticks;
    return receive(m);
  };
}"""


def wait_for(fn, timeout, what, interval=0.03):
    end = time.time() + timeout
    while time.time() < end:
        value = fn()
        if value:
            return value
        time.sleep(interval)
    raise AssertionError(f"timed out waiting for {what}")


def revision(page):
    return page.evaluate("() => globalThis.__timeBlastUi.controller.drafts.revision")


def type_question(page, text, delay):
    box = page.locator('[data-el="input"]')
    box.click()
    page.keyboard.press("Control+A")
    page.keyboard.type(text, delay=delay)


def drawn_timing(page, rev, since=0):
    """Newest TIMING with a first draw for revision `rev` (after index `since`)."""
    return page.evaluate("""([rev, since]) => { const t = window.__e2e.timings.slice(since)
      .filter(t => t.revision === rev && t.headline !== null); return t.length ? t[t.length - 1] : null; }""", [rev, since])


def settled(page, rev, since=0):
    """Revision `rev` answered: drawn, or deduplicated against what is on screen."""
    return page.evaluate("""([rev, since]) => window.__e2e.timings.slice(since).some(t => t.revision === rev
      && (t.headline !== null || (t.stages.includes(10) && !t.stages.includes(11))))""", [rev, since])


def boot_page(context, url, timeout):
    page = context.new_page()
    page.on("pageerror", lambda e: print("pageerror:", e, file=sys.stderr))
    page.goto(url)
    return page, wait_boot(page, timeout)


def wait_boot(page, timeout):
    """Boot stages of the page's latest navigation, ms since navigation start."""
    def answerable():
        return page.evaluate("""() => { const m = window.__perfBoot && window.__perfBoot.marks || [];
          return m.some(x => x.name === 'context') && m.some(x => x.name === 'status:inference:ready') && !!globalThis.__timeBlastUi; }""")
    wait_for(answerable, timeout, "boot: CONTEXT and inference READY", 0.1)
    marks = page.evaluate("() => window.__perfBoot.marks")
    nav = page.evaluate("""() => { const n = performance.getEntriesByType('navigation')[0];
      return n ? { responseEnd: n.responseEnd, domInteractive: n.domInteractive, domContentLoaded: n.domContentLoadedEventEnd,
        load: n.loadEventEnd, transferSize: n.transferSize, type: n.type } : {}; }""")
    first = {}
    for m in marks:
        first.setdefault(m["name"], m)
    stages = {
        "response end": nav.get("responseEnd"),
        "DOM content loaded": nav.get("domContentLoaded"),
        "engine worker created": first.get("worker-created", {}).get("at"),
        "coordinator ready": first.get("status:coordinator:ready", {}).get("at"),
        "renderer ready": first.get("status:renderer:ready", {}).get("at"),
        "inference ready": first.get("status:inference:ready", {}).get("at"),
        "database ready": first.get("status:database:ready", {}).get("at"),
        "context": first.get("context", {}).get("at"),
    }
    ready = [stages[k] for k in ("coordinator ready", "renderer ready", "inference ready", "context") if stages[k] is not None]
    stages["answerable"] = max(ready) if ready else None
    renderer = first.get("status:renderer:ready", {})
    return {"stages": stages, "renderer": {"api": renderer.get("label"), "adapter": renderer.get("detail")}, "navigationType": nav.get("type")}


def chips(page):
    return page.evaluate("""() => globalThis.__timeBlastUi.interactions.suggestions.chips.map(c =>
      ({ id: c.id, from: c.from, kind: c.suggestion.kind, status: c.status }))""")


def card_geometry(page, card):
    slot = int(card.get_attribute("data-slot"))
    box = card.locator("canvas").bounding_box()
    css_width = card.locator("canvas").evaluate("c => c.clientWidth")
    plot = page.evaluate(f"() => window.__e2e.axes[{slot}] && window.__e2e.axes[{slot}].plot")
    return box, box["width"] / css_width, plot


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://127.0.0.1:4173")
    p.add_argument("--gpu", choices=["software", "default"], default="software")
    p.add_argument("--rounds", type=int, default=10)
    p.add_argument("--boots", type=int, default=2)
    p.add_argument("--delay", type=int, default=70, help="ms between keystrokes")
    p.add_argument("--boot-timeout", type=float, default=240)
    p.add_argument("--json")
    args = p.parse_args()
    fake = FakeInference().start()
    fake.echo = True
    out = {"boot": {"firstVisit": [], "repeatVisit": []}, "samples": {}, "stages": {}, "failures": [], "settings": vars(args).copy()}
    samples, stage_rows = out["samples"], out["stages"]

    def add(metric, value, rows=None):
        if value is None:
            return
        samples.setdefault(metric, []).append(round(value, 3))
        if rows is not None:
            stage_rows.setdefault(metric, []).append([[label, round(delta, 3)] for label, delta, _ in rows])

    def fail(message):
        print("FAIL", message, file=sys.stderr, flush=True)
        out["failures"].append(message)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=SOFTWARE if args.gpu == "software" else [])
        out["browser"] = {"name": "chromium", "version": browser.version}
        settings = {"inference": {"kind": "remote", "endpoint": fake.url}}
        page = None
        for b in range(args.boots):
            if page is not None:
                page.context.close()
            context = browser.new_context(viewport={"width": 1400, "height": 950}, device_scale_factor=1)
            context.add_init_script(f"localStorage.getItem('time-blast.ui.v1') || localStorage.setItem('time-blast.ui.v1', {json.dumps(json.dumps(settings))});")
            context.add_init_script(BOOT_MARKS)
            page, boot = boot_page(context, args.url, args.boot_timeout)
            out["boot"]["firstVisit"].append(boot)
            out["renderer"] = boot["renderer"]
            print("boot (first visit)", json.dumps(boot["stages"]), flush=True)
            # The first question right after boot: cold caches, rollups possibly still building.
            page.evaluate(HOOK)
            since = 0
            type_question(page, QUESTIONS[b % len(QUESTIONS)] + " " + LETTERS[b], args.delay)
            rev = revision(page)
            try:
                t = wait_for(lambda: drawn_timing(page, rev, since), 60, f"boot {b}: first question")
                add("e2e.first_query_after_boot", t["headline"])
            except AssertionError as e:
                fail(str(e))
            page.reload()
            boot = wait_boot(page, args.boot_timeout)
            out["boot"]["repeatVisit"].append(boot)
            print("boot (repeat visit)", json.dumps(boot["stages"]), flush=True)
        for kind, metric in (("firstVisit", "boot.first_visit"), ("repeatVisit", "boot.repeat_visit")):
            for boot in out["boot"][kind]:
                s = boot["stages"]
                add(f"{metric}.answerable", s["answerable"])
                # Chronological deltas from navigation start (stage order differs between loads).
                rows, previous = [], 0.0
                for label, at in sorted(((k, v) for k, v in s.items() if k != "answerable" and v is not None), key=lambda kv: kv[1]):
                    rows.append([label, round(at - previous, 3)])
                    previous = at
                stage_rows.setdefault(metric, []).append(rows)
                for label in ("engine worker created", "inference ready", "renderer ready"):
                    if s.get(label) is not None:
                        add(f"{metric}.{label.replace(' ', '_')}", s[label])

        # ── interleaved rounds on the last (repeat-visit) page ──
        page.evaluate(HOOK)
        time.sleep(3)  # let background rollups finish, as in the batch-2 e2e runs

        def gesture(name, action):
            # Requests are monotonic: the gesture's request is newer than every one seen so far
            # (late TIMINGs of the previous gesture must not count).
            r0, m0 = page.evaluate("() => [Math.max(0, ...window.__e2e.timings.map(t => t.request)), window.__e2e.manipulated.length]")
            action()

            def found():
                m = page.evaluate(f"() => window.__e2e.manipulated.slice({m0})")
                if m and m[-1]["sql"] is None:
                    raise AssertionError(f"{name}: engine did nothing ({m[-1]['reason']})")
                ts = page.evaluate(f"() => window.__e2e.timings.filter(t => t.request > {r0} && t.headline !== null && !t.stages.includes(4))")
                return ts[-1] if m and ts else None
            t = wait_for(found, 30, name)
            time.sleep(0.2)
            return t

        for k in range(args.rounds):
            letter = LETTERS[k % 26]
            # a. typing → first draw
            since = page.evaluate("() => window.__e2e.timings.length")
            type_question(page, QUESTIONS[k % len(QUESTIONS)] + " " + letter, args.delay)
            rev = revision(page)
            try:
                t = wait_for(lambda: drawn_timing(page, rev, since), 60, f"round {k}: typing")
                add("e2e.keystroke_to_draw", t["headline"], t["rows"])
                drawn_request = t["request"]
                # Requests drawn while typing that put a new image up (presented after submit;
                # a steady adoption stamps both at once): keystroke → submit and → GPU done.
                time.sleep(0.3)
                for r in page.evaluate("""since => { const by = {};
                    for (const t of window.__e2e.timings.slice(since)) if (t.headline !== null)
                      by[t.request] = { headline: t.headline, presented: t.presented ?? by[t.request]?.presented ?? null };
                    return Object.values(by); }""", since):
                    if r["presented"] is not None and r["presented"] > r["headline"]:
                        add("e2e.redraw_keystroke_to_draw", r["headline"])
                        add("e2e.redraw_keystroke_to_presented", r["presented"])
            except AssertionError as e:
                fail(str(e))
                continue
            # b. chip click → first draw
            try:
                cs = wait_for(lambda: (lambda cs: cs if cs and cs[0]["from"] == drawn_request and all(c["status"] == "ready" for c in cs) else None)(chips(page)),
                              20, f"round {k}: chips")
                chip = cs[k % len(cs)]
                since = page.evaluate("() => window.__e2e.timings.length")
                page.locator(f'[data-el="suggest-chips"] button[data-chip="{chip["id"]}"]').click()
                rev = revision(page)
                t = wait_for(lambda: drawn_timing(page, rev, since), 60, f"round {k}: chip draw")
                add("e2e.chip_to_draw", t["headline"], t["rows"])
            except AssertionError as e:
                fail(str(e))
            # c. chart as query on the hourly per-vessel line
            since = page.evaluate("() => window.__e2e.timings.length")
            type_question(page, HOURLY + " " + LETTERS[25 - k % 26], args.delay)
            rev = revision(page)
            try:
                wait_for(lambda: settled(page, rev, since), 60, f"round {k}: hourly question")
                wait_for(lambda: page.locator(LIVE).count() == 1, 10, "live card")
                card = page.locator(LIVE)
                slot = card.get_attribute("data-slot")
                wait_for(lambda: page.evaluate(f"() => !!window.__e2e.axes[{slot}]"), 10, "axes")
                time.sleep(0.3)
                box, scale, plot = card_geometry(page, card)
                y = plot["top"] + plot["height"] * 0.5
                a = plot["left"] + plot["width"] * (0.1 + 0.07 * (k % 10))
                b = a + plot["width"] * 0.02

                def at(x):
                    return box["x"] + x * scale, box["y"] + y * scale

                def brush():
                    page.mouse.move(*at(a))
                    page.mouse.down()
                    page.mouse.move(*at((a + b) / 2), steps=3)
                    page.mouse.move(*at(b), steps=3)
                    page.mouse.up()

                def back():
                    card.locator('[data-c="plot"]').focus()
                    page.keyboard.press("Escape")
                t = gesture(f"round {k}: brush", brush)
                add("e2e.gesture_brush_to_draw", t["headline"], t["rows"])
                t = gesture(f"round {k}: legend", lambda: card.locator(f'.legend span[data-i="{k % 6}"]').click())
                add("e2e.gesture_legend_to_draw", t["headline"], t["rows"])
                for _ in range(2):
                    t = gesture(f"round {k}: back", back)
                    add("e2e.gesture_back_to_draw", t["headline"], t["rows"])
            except AssertionError as e:
                fail(str(e))
            print(f"round {k + 1}/{args.rounds}: " + ", ".join(f"{m.split('.', 1)[1]} {v[-1]}" for m, v in samples.items() if m.startswith("e2e.") and v), flush=True)
        errors = page.evaluate("() => window.__e2e.errors")
        # Refused warm-ups of superseded suggestions are expected; they never reach a card.
        errors = [e for e in errors if "warm-ups" not in e and "not_cacheable" not in e]
        if errors:
            fail(f"ERROR frames: {errors[:3]}")
        out["infers"] = len(fake.infers)
        browser.close()
    fake.stop()
    text = json.dumps(out)
    if args.json:
        with open(args.json, "w") as f:
            f.write(text + "\n")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
