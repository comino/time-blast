#!/usr/bin/env python3
"""End-to-end chart-as-query and steady-chart test: the full app with the fake inference node.

A. Chart as query (no model on the path): type a question, then
   1. brush a few hours of the hourly line → the card shows those hours at a finer bucket;
   2. click a legend entry → one vessel;
   3. Escape and double-click → back to the previous SQL;
   4. click a bar of a per-vessel bar chart → that vessel;
   each asserting the SQL on the card, ink on the canvas, and a TIMING that runs from the pointer
   (KEY_INPUT) through SQL_COMPLETE (rewrite in the engine worker), EXEC, first batch to the first
   draw, with no INFER. Then measures pointer → first draw over repeated brushes/clicks/backs.
B. Steady charts: the fake model answers each keystroke with an alias/case/layout variant of the
   same SQL (identical data, different bytes, as in the prefix replay). Counts results that were
   adopted by the image on screen (DRAWN with FIRST_PRESENTED == FIRST_DRAW_SUBMITTED) versus
   real redraws, and last keystroke → first draw.

Draw submission, not photons. Start Vite first (`pnpm exec vite --port 5199 --strictPort`; add
`VITE_TB_STEADY=0` for the steady-off comparison), then:
  python3 tests/e2e_manipulate.py --url http://localhost:5199 --software [--samples 10] [--json out.json]
"""
import argparse
import json
import os
import statistics
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_inference import FakeInference  # noqa: E402
from e2e_fake_inference import SOFTWARE, ink, revision, type_question, wait_for  # noqa: E402

HOOK = """async () => {
  const { decode, Kind } = await import('/src/protocol/frame.ts');
  const { breakdown } = await import('/src/ui/timing.ts');
  const c = globalThis.__timeBlastUi.controller, orig = c.receive.bind(c);
  window.__e2e = { timings: [], errors: [], manipulated: [], axes: {} };
  c.receive = m => {
    if (m.type === 'frame') {
      try {
        const f = decode(new Uint8Array(m.bytes.slice(0)));
        if (f.kind === Kind.TIMING) window.__e2e.timings.push({ request: f.request, revision: f.revision,
          stages: f.stamps.map(s => s.stage), stamps: f.stamps.map(s => [s.stage, s.at]), b: breakdown(f.stamps, f.request, f.revision) });
        if (f.kind === Kind.ERROR) window.__e2e.errors.push(new TextDecoder().decode(f.payload));
      } catch (e) { window.__e2e.errors.push(String(e)); }
    } else if (m.type === 'manipulated') window.__e2e.manipulated.push(m);
    else if (m.type === 'axes') window.__e2e.axes[m.slot] = m.ticks;
    return orig(m);
  };
}"""

LIVE = 'article.slot-card[data-live="true"]'


def summary(xs):
    xs = sorted(xs)
    if not xs:
        return None
    q = lambda f: xs[min(len(xs) - 1, int(f * (len(xs) - 1) + 0.5))]
    return {"n": len(xs), "median": round(statistics.median(xs), 2), "p95": round(q(0.95), 2), "min": round(xs[0], 2), "max": round(xs[-1], 2)}


def stamp(t, stage):
    found = [at for s, at in t["stamps"] if s == stage]
    return found[0] if found else None


def card_geometry(page, card):
    """Canvas box (page px), board scale and the plot rect (canvas CSS px) of `card`."""
    slot = int(card.get_attribute("data-slot"))
    box = card.locator("canvas").bounding_box()
    css_width = card.locator("canvas").evaluate("c => c.clientWidth")
    plot = page.evaluate(f"() => window.__e2e.axes[{slot}] && window.__e2e.axes[{slot}].plot")
    return slot, box, box["width"] / css_width, plot


def to_page(box, scale, x, y):
    return box["x"] + x * scale, box["y"] + y * scale


def sql_of(card):
    return card.locator('[data-c="sql"]').text_content()


def wait_manipulation(page, since_timings, since_manip, what, timeout=30):
    """The TIMING of the request a gesture caused: drawn, no INFER stage."""
    def found():
        m = page.evaluate(f"() => window.__e2e.manipulated.slice({since_manip})")
        if m and m[-1]["sql"] is None:
            raise AssertionError(f"{what}: engine did nothing ({m[-1]['reason']})")
        ts = page.evaluate(f"() => window.__e2e.timings.slice({since_timings}).filter(t => t.b.headline !== null && !t.stages.includes(4))")
        return (m[-1], ts[-1]) if m and ts else None
    return wait_for(found, timeout, what)


def counts(page):
    return page.evaluate("() => [window.__e2e.timings.length, window.__e2e.manipulated.length]")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://localhost:5199")
    p.add_argument("--software", action="store_true")
    p.add_argument("--samples", type=int, default=10)
    p.add_argument("--delay", type=int, default=70, help="ms between keystrokes")
    p.add_argument("--json")
    p.add_argument("--screenshot")
    p.add_argument("--skip-a", action="store_true")
    args = p.parse_args()
    fake = FakeInference().start()
    failures, report = [], {"fake": fake.url, "measured": "pointer/keystroke event → FIRST_DRAW_SUBMITTED (draw submission, not photons)"}

    def check(cond, message):
        print(("ok   " if cond else "FAIL ") + message, flush=True)
        if not cond:
            failures.append(message)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=SOFTWARE if args.software else [])
        report["browser"] = browser.version
        report["gpu"] = "SwiftShader (software)" if args.software else "default"
        context = browser.new_context(viewport={"width": 1400, "height": 950}, device_scale_factor=1)
        settings = {"inference": {"kind": "remote", "endpoint": fake.url}}
        context.add_init_script(f"localStorage.setItem('time-blast.ui.v1', {json.dumps(json.dumps(settings))});")
        page = context.new_page()
        page.on("console", lambda m: m.type == "error" and print("console:", m.text, file=sys.stderr))
        page.on("pageerror", lambda e: print("pageerror:", e, file=sys.stderr))
        page.goto(args.url)
        page.wait_for_function("() => globalThis.__timeBlastUi", timeout=60_000)
        wait_for(lambda: fake.contexts, 240, "CONTEXT at the fake inference node", 0.2)
        page.wait_for_function("() => globalThis.__timeBlastUi", timeout=60_000)
        page.evaluate(HOOK)
        # Rollups build in the background after load; give them a moment (measured paths use them).
        time.sleep(3)

        def settle(text):
            since = page.evaluate("() => window.__e2e.timings.length")
            type_question(page, text, args.delay)
            rev = revision(page)
            wait_for(lambda: page.evaluate(f"() => window.__e2e.timings.slice({since}).some(t => t.revision === {rev} && (t.b.headline !== null || (t.stages.includes(10) && !t.stages.includes(11))))"), 60, f"answer to {text!r}")
            wait_for(lambda: page.locator(LIVE).count() == 1, 10, "live card")
            card = page.locator(LIVE)
            wait_for(lambda: page.evaluate(f"() => !!window.__e2e.axes[{card.get_attribute('data-slot')}]"), 10, "axes")
            time.sleep(0.3)
            return card

        def gesture_timing(name, action, card):
            t0, m0 = counts(page)
            action()
            m, t = wait_manipulation(page, t0, m0, name)
            time.sleep(0.25)
            return m, t

        stages_needed = {1, 2, 3, 9, 11, 13, 16}
        if not args.skip_a:
            # ── A1. brush ──
            card = settle("average speed per hour by vessel")
            hourly_sql = sql_of(card)
            slot, box, scale, plot = card_geometry(page, card)
            x0 = plot["left"] + plot["width"] * 0.40
            x1 = plot["left"] + plot["width"] * 0.42
            y = plot["top"] + plot["height"] * 0.5

            def brush(a=x0, b=x1):
                page.mouse.move(*to_page(box, scale, a, y))
                page.mouse.down()
                page.mouse.move(*to_page(box, scale, (a + b) / 2, y), steps=3)
                page.mouse.move(*to_page(box, scale, b, y), steps=3)
                page.mouse.up()
            m, t = gesture_timing("brush", brush, card)
            sql = sql_of(card)
            check(m["method"] == "rewrite" and "ts >=" in sql and ("minute" in sql or "time_bucket" in sql),
                  f"brush rewrites with raw bounds and a finer bucket ({m['method']}: {m['reason']}; {m['ms']:.1f} ms)")
            check(stages_needed <= set(t["stages"]) and 4 not in t["stages"], f"brush TIMING pointer → draw, no INFER (stages {sorted(set(t['stages']))})")
            px, col = ink(card.locator("canvas").screenshot())
            check(px > 300 and col >= 3, f"brushed chart drew ({px} ink px, {col} colours); pointer → first draw {t['b']['headline']:.1f} ms")
            if args.screenshot:
                page.screenshot(path=args.screenshot.replace(".png", "-brush.png"))
            # ── A2. legend click = series ──
            legend = card.locator('.legend span[data-i="1"]')
            label = legend.text_content()
            m, t = gesture_timing("legend click", lambda: legend.click(), card)
            sql = sql_of(card)
            check(f"vessel = '{label}'" in sql, f"legend click filters the series ({label!r}; {m['method']})")
            legend_entries = card.locator(".legend span").count()
            check(legend_entries == 1, f"one series left in the legend ({legend_entries})")
            # ── A3. back: Escape, then double-click ──
            m, t = gesture_timing("Escape", lambda: (card.locator('[data-c="plot"]').focus(), page.keyboard.press("Escape")), card)
            check(m["method"] == "as-is" and "vessel = " not in sql_of(card), "Escape goes back to the brushed SQL")
            slot, box, scale, plot = card_geometry(page, card)
            # Double-click on an empty corner (nothing to drill there): back to the typed SQL.
            m, t = gesture_timing("double-click", lambda: page.mouse.dblclick(*to_page(box, scale, plot["left"] + 3, plot["top"] + 3)), card)
            check(sql_of(card) == hourly_sql, "double-click goes back to the typed question's SQL")
            # ── A4. bar click ──
            card = settle("max speed per vessel")
            slot, box, scale, plot = card_geometry(page, card)
            labels = page.evaluate(f"() => window.__e2e.axes[{slot}].x.map(t => [t.at, t.label])")
            at, vessel = labels[len(labels) // 2]
            m, t = gesture_timing("bar click", lambda: page.mouse.click(*to_page(box, scale, at, plot["top"] + plot["height"] - 4)), card)
            check(f"vessel = '{vessel}'" in sql_of(card), f"bar click drills into {vessel!r} ({m['method']}: {m['reason']})")
            check(stages_needed <= set(t["stages"]), f"bar click TIMING complete; pointer → first draw {t['b']['headline']:.1f} ms")
            page.keyboard.press("Escape")
            time.sleep(0.4)

            # ── A5. measurement ──
            card = settle("average speed per hour by vessel")
            slot, box, scale, plot = card_geometry(page, card)
            per = {"brush": [], "legend": [], "back": []}
            per_stage = {}
            rewrite_ms = []
            for k in range(args.samples):
                f = 0.1 + 0.07 * k
                a = plot["left"] + plot["width"] * f
                b = a + plot["width"] * 0.02
                for name, act in (("brush", lambda: brush(a, b)), ("legend", lambda: card.locator(f'.legend span[data-i="{k % 6}"]').click()),
                                  ("back", lambda: (card.locator('[data-c="plot"]').focus(), page.keyboard.press("Escape"))),
                                  ("back", lambda: (card.locator('[data-c="plot"]').focus(), page.keyboard.press("Escape")))):
                    try:
                        m, t = gesture_timing(f"{name} sample {k}", act, card)
                    except AssertionError as e:
                        failures.append(str(e))
                        continue
                    per[name].append(t["b"]["headline"])
                    if name != "back":
                        rewrite_ms.append(m["ms"])
                    for row in t["b"]["rows"]:
                        per_stage.setdefault(name, {}).setdefault(row["label"], []).append(row["delta"])
                slot, box, scale, plot = card_geometry(page, card)
            report["chartAsQuery"] = {k: summary(v) for k, v in per.items()}
            report["chartAsQuery"]["engineHitAndRewriteMs"] = summary(rewrite_ms)
            report["chartAsQueryStageDeltaMs"] = {g: {k: summary(v) for k, v in d.items()} for g, d in per_stage.items()}

        # ── B. steady charts ──
        fake.variants = True
        steady, redraws, finals, finals_steady = 0, 0, [], 0
        questions = ["average speed per hour by vessel", "max speed per vessel", "wind every ten minutes"]
        for k in range(args.samples):
            q = questions[k % len(questions)]
            # Settle on the question first (its chart is on screen), then retype a variant of it.
            settle(q)
            since = page.evaluate("() => window.__e2e.timings.length")
            type_question(page, q + " " + "abcdefghijklmnopqrstuvwxyz"[k], args.delay)
            rev = revision(page)
            try:
                wait_for(lambda: page.evaluate(f"() => window.__e2e.timings.slice({since}).some(t => t.revision === {rev} && (t.b.headline !== null || (t.stages.includes(10) && !t.stages.includes(11))))"), 60, f"steady sample {k}")
            except AssertionError as e:
                failures.append(str(e))
                continue
            time.sleep(0.3)
            ts = page.evaluate(f"() => window.__e2e.timings.slice({since}).filter(t => t.b.headline !== null)")
            # One entry per request (DRAWN, the presented DRAWN and DONE each send a TIMING).
            by_request = {}
            for t in ts:
                by_request[t["request"]] = t
            for t in by_request.values():
                if stamp(t, 17) is not None and stamp(t, 17) == stamp(t, 16):
                    steady += 1
                else:
                    redraws += 1
            last = [t for t in by_request.values() if t["revision"] == rev]
            if last:
                finals.append(last[-1]["b"]["headline"])
                finals_steady += int(stamp(last[-1], 17) == stamp(last[-1], 16))
        report["steady"] = {"variantsPerKeystroke": True, "drawnRequests": steady + redraws, "adoptedSteady": steady, "redrawn": redraws,
                            "finalKeystrokeHeadlineMs": summary(finals), "finalKeystrokeSteady": finals_steady, "samples": args.samples,
                            "infers": len(fake.infers)}
        errors = page.evaluate("() => window.__e2e.errors")
        check(not errors, f"no ERROR frames ({errors[:2]})")
        browser.close()
    fake.stop()
    print(json.dumps(report, indent=1))
    if args.json:
        with open(args.json, "w") as f:
            json.dump(report, f, indent=1)
    for f in failures:
        print("FAIL", f)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
