#!/usr/bin/env python3
"""End-to-end browser test of the full app with a fake remote inference node.

index.html → src/ui/app.ts → engine worker (coordinator, DuckDB, renderer) → WebSocket `tb1` →
tests/fake_inference.py (canned SQL, no model). Asserts that typing alone draws a chart, that
TIMING carries KEY_INPUT → FIRST_DRAW_SUBMITTED, that a new question rebinds, that Enter keeps
the card, and that line/bar/scatter/table/seasons view switching works. Then measures
last keystroke → first draw per stage over several questions; with no model in the loop the
number isolates our own pipeline.

Start Vite first (e.g. `pnpm exec vite --port 5199 --strictPort`), then:
  python3 tests/e2e_fake_inference.py --url http://localhost:5199 --software [--samples 12] [--json out.json]
"""
import argparse
import io
import json
import os
import statistics
import sys
import time

from PIL import Image
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_inference import FakeInference  # noqa: E402

SOFTWARE = ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader"]
QUESTIONS = ["average speed per hour by vessel", "wind every ten minutes", "max speed per vessel"]

HOOK = """async () => {
  const { decode, Kind } = await import('/src/protocol/frame.ts');
  const { breakdown } = await import('/src/ui/timing.ts');
  const c = globalThis.__timeBlastUi.controller, orig = c.receive.bind(c);
  window.__e2e = { timings: [], errors: [] };
  c.receive = m => {
    if (m.type === 'frame') {
      try {
        const f = decode(new Uint8Array(m.bytes.slice(0)));
        if (f.kind === Kind.TIMING) window.__e2e.timings.push({ request: f.request, revision: f.revision,
          stages: f.stamps.map(s => s.stage), b: breakdown(f.stamps, f.request, f.revision) });
        if (f.kind === Kind.ERROR) window.__e2e.errors.push(new TextDecoder().decode(f.payload));
      } catch (e) { window.__e2e.errors.push(String(e)); }
    }
    return orig(m);
  };
}"""


def ink(png):
    """Pixels clearly different from the dominant (background) colour, and colour buckets."""
    img = Image.open(io.BytesIO(png)).convert("RGB")
    data = list(img.getdata())
    counts = {}
    for p in data:
        counts[p] = counts.get(p, 0) + 1
    bg = max(counts, key=counts.get)
    n, colours = 0, set()
    for r, g, b in data:
        if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 60:
            n += 1
            colours.add((r // 32, g // 32, b // 32))
    return n, len(colours)


def wait_for(fn, timeout, what, interval=0.05):
    end = time.time() + timeout
    while time.time() < end:
        value = fn()
        if value:
            return value
        time.sleep(interval)
    raise AssertionError(f"timed out waiting for {what}")


def revision(page):
    return page.evaluate("() => globalThis.__timeBlastUi.controller.drafts.revision")


def final_timing(page, rev, dedup_ok=False):
    """The TIMING with a first draw for revision `rev`, if any. With `dedup_ok`, also a TIMING
    for `rev` that ends at SQL_RECEIVED (SQL dedup: the answer was already on screen)."""
    return page.evaluate("""([rev, dedupOk]) => { const t = window.__e2e.timings.filter(t => t.revision === rev
        && (t.b.headline !== null || (dedupOk && t.stages.includes(10) && !t.stages.includes(11))));
      return t.length ? t[t.length - 1] : null; }""", [rev, dedup_ok])


def settle(page, text, delay, what):
    """Type `text`, wait until its final revision is answered (drawn or deduplicated against
    what is already on screen), and return the newest drawn TIMING since typing began."""
    since = page.evaluate("() => window.__e2e.timings.length")
    type_question(page, text, delay)
    rev = revision(page)
    wait_for(lambda: final_timing(page, rev, True), 60, what)
    return page.evaluate("""since => { const t = window.__e2e.timings.slice(since).filter(t => t.b.headline !== null);
      return t.length ? t[t.length - 1] : null; }""", since)


def live_canvas(page):
    return page.locator('article.slot-card[data-live="true"] canvas')


def type_question(page, text, delay):
    box = page.locator('[data-el="input"]')
    box.click()
    page.keyboard.press("Control+A")
    page.keyboard.type(text, delay=delay)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://localhost:5199")
    p.add_argument("--software", action="store_true")
    p.add_argument("--samples", type=int, default=12)
    p.add_argument("--delay", type=int, default=70, help="ms between keystrokes")
    p.add_argument("--json")
    p.add_argument("--screenshot")
    args = p.parse_args()
    fake = FakeInference().start()
    failures, report = [], {"fake": fake.url}

    def check(cond, message):
        print(("ok   " if cond else "FAIL ") + message, flush=True)
        if not cond:
            failures.append(message)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=SOFTWARE if args.software else [])
        report["browser"] = browser.version
        context = browser.new_context(viewport={"width": 1400, "height": 950}, device_scale_factor=1)
        settings = {"inference": {"kind": "remote", "endpoint": fake.url}}
        context.add_init_script(f"localStorage.setItem('time-blast.ui.v1', {json.dumps(json.dumps(settings))});")
        page = context.new_page()
        page.on("console", lambda m: m.type == "error" and print("console:", m.text, file=sys.stderr))
        page.on("pageerror", lambda e: print("pageerror:", e, file=sys.stderr))
        t0 = time.time()
        page.goto(args.url)
        page.wait_for_function("() => globalThis.__timeBlastUi", timeout=60_000)
        wait_for(lambda: fake.contexts, 240, "CONTEXT at the fake inference node", 0.2)
        # After boot: Vite may reload the page once while optimizing dependencies on a cold cache.
        page.wait_for_function("() => globalThis.__timeBlastUi", timeout=60_000)
        page.evaluate(HOOK)
        report["bootToContextS"] = round(time.time() - t0, 2)
        check(fake.hellos >= 1, f"HELLO→READY with the fake node; context ready after {report['bootToContextS']} s")

        # 1. Typing alone draws.
        timing = settle(page, QUESTIONS[0], args.delay, "TIMING with a first draw")
        assert timing, "no drawn TIMING"
        pixels, colours = ink(live_canvas(page).screenshot())
        check(pixels > 500 and colours >= 3, f"chart drew without Enter ({pixels} ink px, {colours} colours)")
        stages = set(timing["stages"])
        check({1, 16} <= stages, f"TIMING has KEY_INPUT and FIRST_DRAW_SUBMITTED (stages {sorted(stages)})")
        check(timing["b"]["headline"] is not None and timing["b"]["headline"] > 0, f"key → first draw {timing['b']['headline']:.1f} ms")
        first_request = timing["request"]

        # 2. A new question rebinds the live card.
        timing = settle(page, QUESTIONS[1], args.delay, "TIMING for the second question")
        assert timing, "no drawn TIMING for the second question"
        sql = page.locator('article.slot-card[data-live="true"] [data-c="sql"]').text_content()
        check(timing["request"] != first_request and "wind" in sql, f"changed question rebinds (request {first_request} → {timing['request']})")

        # 3. Enter keeps the card.
        page.keyboard.press("Enter")
        kept = page.locator('article.slot-card[data-live="false"][data-idle="false"]')
        wait_for(lambda: kept.count() >= 1, 30, "a kept card")
        check(kept.count() >= 1 and "wind" in kept.first.locator('[data-c="sql"]').text_content(), "Enter keeps the card")

        # 4. View switching on a kept card: an hourly per-vessel time series fits every view.
        settle(page, QUESTIONS[0], args.delay, "TIMING for the view-switching question")
        page.keyboard.press("Enter")
        wait_for(lambda: kept.count() >= 2, 30, "a second kept card")
        card = kept.last
        select = card.locator('select[data-c="view"]')
        options = select.locator("option").evaluate_all("os => os.map(o => o.value)")
        check(all(v in options for v in ["line", "bar", "scatter", "table", "seasons"]), f"view picker offers {options}")
        canvas = card.locator("canvas")
        images = {}
        for view in ["line", "bar", "scatter", "seasons", "table"]:
            select.select_option(view)
            time.sleep(0.6)
            png = canvas.screenshot()
            images[view] = png
            if args.screenshot:
                with open(args.screenshot.replace(".png", f"-{view}.png"), "wb") as f:
                    f.write(png)
            px, col = ink(png)
            if view == "table":
                check(px < 200, f"table view clears the canvas ({px} ink px)")
            else:
                check(px > 500 and col >= 3, f"{view} view draws ({px} ink px, {col} colours)")
        check(len({images[v] for v in ["line", "bar", "scatter", "seasons"]}) == 4, "each chart view draws something different")
        select.select_option("seasons")
        time.sleep(0.6)
        labels = card.locator(".axis-free").evaluate_all("ls => ls.filter(l => !l.hidden).map(l => l.textContent)")
        check(any(l.startswith("Weekly wheel") for l in labels) and "Mon" in labels, f"seasons labels in DOM ({labels[:3]}…)")
        if args.screenshot:
            page.screenshot(path=args.screenshot)

        # 5. Measurement: last keystroke → first draw, over alternating questions.
        #    a) canned SQL as a model would answer: prefixes often already give the final SQL,
        #       so the final keystroke is frequently a dedup (answer already on screen);
        #    b) echo mode: every keystroke yields new SQL, so the final one runs the whole
        #       pipeline. (b) is the headline: our own pipeline, keystroke → first draw.
        realistic, dedups = [], 0
        for k in range(args.samples):
            type_question(page, QUESTIONS[k % len(QUESTIONS)] + " " + "abcdefghijklmnopqrstuvwxyz"[k], args.delay)
            rev = revision(page)
            try:
                t = wait_for(lambda: final_timing(page, rev, True), 60, f"TIMING for sample {k}")
            except AssertionError as e:
                failures.append(str(e))
                continue
            if t["b"]["headline"] is None:
                dedups += 1
            else:
                realistic.append(t["b"])
        report["realistic"] = {"samples": args.samples, "finalKeystrokeDedup": dedups,
                               "drawnHeadlineMs": [round(b["headline"], 1) for b in realistic]}
        fake.echo = True
        samples = []
        for k in range(args.samples):
            type_question(page, QUESTIONS[k % len(QUESTIONS)] + " " + "zyxwvutsrqponmlkjihgfedcba"[k], args.delay)
            rev = revision(page)
            try:
                t = wait_for(lambda: final_timing(page, rev), 60, f"TIMING for echo sample {k}")
            except AssertionError as e:
                failures.append(str(e))
                continue
            samples.append(t["b"])
        errors = page.evaluate("() => window.__e2e.errors")
        check(not errors, f"no ERROR frames ({errors[:2]})")
        browser.close()
    fake.stop()

    if samples:
        def summary(xs):
            xs = sorted(xs)
            q = lambda f: xs[min(len(xs) - 1, int(f * (len(xs) - 1) + 0.5))]
            return {"n": len(xs), "median": round(statistics.median(xs), 2), "p95": round(q(0.95), 2), "min": round(xs[0], 2), "max": round(xs[-1], 2)}
        report["headlineMs"] = summary([s["headline"] for s in samples])
        report["presentedMs"] = summary([s["presented"] for s in samples if s["presented"] is not None]) if any(s["presented"] is not None for s in samples) else None
        per_stage = {}
        for s in samples:
            for row in s["rows"]:
                per_stage.setdefault(row["label"], []).append(row["delta"])
        report["stageDeltaMs"] = {k: summary(v) for k, v in per_stage.items()}
        report["infers"] = len(fake.infers)
        print(json.dumps(report, indent=1))
    if args.json:
        with open(args.json, "w") as f:
            json.dump(report, f, indent=1)
    for f in failures:
        print("FAIL", f)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
