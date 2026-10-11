#!/usr/bin/env python3
"""Browser test + measurement for next-question chips and voice input (full app, fake inference).

index.html → app → engine worker (coordinator, DuckDB, renderer) → tb1 WebSocket →
tests/fake_inference.py in echo mode (every question gets distinct SQL, so nothing is reused from
the result cache by accident). Software GPU (SwiftShader) with --software; draw submission, not photons.

Chips: per sample, type a question, wait for its first draw, wait for the chips, click one, and
measure click → first draw of the follow-up (KEY_INPUT = the click event). Modes, one page load each:
  prepared   PRIME + WARM (default): no inference call, result-cache replay
  primed     PRIME only: no inference call, the database runs the query
  off        neither: the click goes to (fake, zero-latency) inference and runs cold
Typing interference: last keystroke → first draw while typing, with suggestions on vs disabled.
Voice: window.webkitSpeechRecognition is stubbed; Ctrl+Space is held while the stub speaks.

Start Vite first (`pnpm exec vite --port 5199 --strictPort`), then:
  python3 tests/e2e_suggest_voice.py --url http://localhost:5199 --software [--samples 12] [--json out.json]
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
from e2e_fake_inference import HOOK, SOFTWARE, final_timing, revision, type_question, wait_for  # noqa: E402

QUESTIONS = ["average speed per hour by vessel", "wind every ten minutes", "max speed per vessel"]

STUB = """(() => {
  class FakeRecognition {
    constructor() { window.__rec = this; this.results = []; this.continuous = false; this.interimResults = false; this.lang = ''; }
    start() { window.__recStarts = (window.__recStarts || 0) + 1; setTimeout(() => this.onstart && this.onstart({ timeStamp: performance.now() }), 0); }
    stop() { setTimeout(() => this.onend && this.onend({ timeStamp: performance.now() }), 5); }
    abort() {}
  }
  window.webkitSpeechRecognition = FakeRecognition;
  window.SpeechRecognition = FakeRecognition;
  window.__say = (text, isFinal) => {
    const rec = window.__rec, last = rec.results[rec.results.length - 1];
    const index = last && !last.isFinal ? rec.results.length - 1 : rec.results.length;
    rec.results[index] = Object.assign([{ transcript: text }], { isFinal });
    const at = performance.now();
    window.__lastSpeech = at;
    rec.onresult && rec.onresult({ resultIndex: index, results: rec.results, timeStamp: at });
  };
})();"""


def summary(xs):
    if not xs:
        return None
    xs = sorted(xs)
    q = lambda f: xs[min(len(xs) - 1, int(f * (len(xs) - 1) + 0.5))]
    return {"n": len(xs), "median": round(statistics.median(xs), 2), "p95": round(q(0.95), 2), "min": round(xs[0], 2), "max": round(xs[-1], 2)}


def offset(timing, stage):
    rows = [r for r in timing["b"]["rows"] if r.get("stage") == stage]
    return rows[0]["offset"] if rows else None


def db_first_batch(timing):
    """EXEC_RECEIVED → DB_FIRST_BATCH (ms), from the TIMING ledger."""
    a, b = offset(timing, 12), offset(timing, 13)
    return round(b - a, 3) if a is not None and b is not None else None


def open_page(browser, fake, suggest=None, stub=False):
    context = browser.new_context(viewport={"width": 1400, "height": 950}, device_scale_factor=1)
    settings = {"inference": {"kind": "remote", "endpoint": fake.url}}
    script = f"localStorage.setItem('time-blast.ui.v1', {json.dumps(json.dumps(settings))});"
    script += f"localStorage.setItem('time-blast.suggest', {json.dumps(json.dumps(suggest or {}))});"
    context.add_init_script(script)
    if stub:
        context.add_init_script(STUB)
    page = context.new_page()
    page.on("console", lambda m: m.type == "error" and print("console:", m.text, file=sys.stderr))
    page.on("pageerror", lambda e: print("pageerror:", e, file=sys.stderr))
    before = fake.hellos
    page.goto(args.url)
    page.wait_for_function("() => globalThis.__timeBlastUi", timeout=60_000)
    wait_for(lambda: fake.hellos > before and fake.contexts, 240, "HELLO + CONTEXT at the fake inference node", 0.2)
    page.wait_for_function("() => globalThis.__timeBlastUi && globalThis.__timeBlastUi.controller.context", timeout=240_000)
    page.evaluate(HOOK)
    # Rollups build in the background after load: give them a moment so all modes see the same database.
    time.sleep(3)
    return context, page


def chips(page):
    return page.evaluate("""() => globalThis.__timeBlastUi.interactions.suggestions.chips.map(c =>
      ({ id: c.id, from: c.from, label: c.suggestion.label, kind: c.suggestion.kind, status: c.status, warmMs: c.warmMs ?? null, source: c.source ?? null }))""")


def run_chip_mode(browser, fake, name, suggest, samples, report, check):
    context, page = open_page(browser, fake, suggest)
    out = {"clicks": [], "inferCalls": 0, "kinds": {}}
    fake.echo = True
    for k in range(samples):
        question = QUESTIONS[k % len(QUESTIONS)] + " " + "abcdefghijklmnopqrstuvwxyz"[k]
        type_question(page, question, 30)
        rev = revision(page)
        drawn = wait_for(lambda: final_timing(page, rev, True), 60, f"{name}: first draw for sample {k}")
        want_ready = suggest.get("warm", True)
        try:
            wait_for(lambda: (lambda cs: cs and cs[0]["from"] == drawn["request"] and (not want_ready or all(c["status"] == "ready" for c in cs)))(chips(page)), 20, f"{name}: chips for sample {k}")
        except AssertionError as e:
            check(False, str(e))
            continue
        cs = chips(page)
        chip = cs[k % len(cs)]
        infers_before = len(fake.infers)
        page.locator(f'[data-el="suggest-chips"] button[data-chip="{chip["id"]}"]').click()
        rev = revision(page)
        t = wait_for(lambda: final_timing(page, rev), 60, f"{name}: follow-up draw for sample {k}")
        # Let a late inference request (if any) arrive before counting.
        time.sleep(0.05)
        calls = len(fake.infers) - infers_before
        out["inferCalls"] += calls
        out["clicks"].append({"headline": t["b"]["headline"], "kind": chip["kind"], "warmSource": chip["source"], "warmMs": chip["warmMs"],
                              "inferCalls": calls, "stages": {r["label"]: round(r["delta"], 3) for r in t["b"]["rows"]}, "dbFirstBatchMs": db_first_batch(t)})
        out["kinds"][chip["kind"]] = out["kinds"].get(chip["kind"], 0) + 1
    stats = page.evaluate("() => { const s = globalThis.__timeBlastUi.interactions.suggestions.stats; return { ...s, warmMs: undefined, generateUs: undefined, warm: s.warmMs, gen: s.generateUs }; }")
    out["suggestStats"] = {k: v for k, v in stats.items() if k not in ("warm", "gen", "warmMs", "generateUs")}
    out["warmMs"] = summary(stats["warm"])
    out["generateUs"] = summary(stats["gen"])
    out["headlineMs"] = summary([c["headline"] for c in out["clicks"]])
    out["dbFirstBatchMs"] = summary([c["dbFirstBatchMs"] for c in out["clicks"] if c["dbFirstBatchMs"] is not None])
    # Refused warm-ups (queue_full: superseded suggestions) are expected and never reach a card.
    errors = [e for e in page.evaluate("() => window.__e2e.errors") if "warm-ups" not in e and "not_cacheable" not in e]
    check(not errors, f"{name}: no ERROR frames for real requests ({errors[:2]})")
    report["chips"][name] = out
    print(name, json.dumps({k: out[k] for k in ("headlineMs", "dbFirstBatchMs", "inferCalls", "warmMs")}), flush=True)
    context.close()


def run_typing(browser, fake, name, suggest, samples, report):
    context, page = open_page(browser, fake, suggest)
    fake.echo = True
    xs = []
    for k in range(samples):
        type_question(page, QUESTIONS[k % len(QUESTIONS)] + " " + "zyxwvutsrqponmlkjihgfedcba"[k], 70)
        rev = revision(page)
        t = wait_for(lambda: final_timing(page, rev), 60, f"{name}: typing sample {k}")
        xs.append(t["b"]["headline"])
        time.sleep(0.4)  # let warm-ups of this result run, as a user would pause
    report["typing"][name] = {"headlineMs": summary(xs)}
    print(name, json.dumps(report["typing"][name]), flush=True)
    context.close()


def run_voice(browser, fake, report, check):
    # Without a stub: what headless Chromium offers.
    context, page = open_page(browser, fake)
    state = page.evaluate("""() => ({ api: typeof (window.SpeechRecognition || window.webkitSpeechRecognition),
      button: document.querySelector('[data-el="voice"]').dataset.state, label: document.querySelector('[data-el="voice-status"]').textContent })""")
    report["voice"]["unstubbed"] = state
    context.close()

    context, page = open_page(browser, fake, stub=True)
    fake.echo = False
    rev0 = revision(page)
    timings0 = page.evaluate("() => window.__e2e.timings.length")
    sent0 = page.evaluate("() => globalThis.__timeBlastUi.framesSent()")
    page.keyboard.down("Control")
    page.keyboard.down("Space")
    try:
        wait_for(lambda: page.evaluate("() => document.querySelector('[data-el=\"voice\"]').dataset.state") == "listening", 5, "listening")
    except AssertionError:
        print("voice debug", page.evaluate("() => ({ state: document.querySelector('[data-el=\"voice\"]').dataset.state, label: document.querySelector('[data-el=\"voice-status\"]').textContent, starts: window.__recStarts, api: typeof window.webkitSpeechRecognition })"), report["voice"])
        raise
    words = "max speed per vessel".split()
    for i in range(1, len(words) + 1):
        page.evaluate("([t, f]) => window.__say(t, f)", [" ".join(words[:i]), False])
        time.sleep(0.12)
    page.evaluate("([t, f]) => window.__say(t, f)", [" ".join(words), True])
    page.keyboard.up("Space")
    page.keyboard.up("Control")
    rev = revision(page)
    t = wait_for(lambda: final_timing(page, rev, True), 60, "voice: committed draw")
    kept = page.locator('article.slot-card[data-live="false"][data-idle="false"]')
    wait_for(lambda: kept.count() >= 1, 30, "voice: kept card")
    frames = page.evaluate("() => globalThis.__timeBlastUi.framesSent()") - sent0
    box = page.locator('[data-el="input"]').input_value()
    report["voice"]["stubbed"] = {"revisions": rev - rev0, "framesSent": frames, "box": box, "keptCards": kept.count(),
                                  "finalWasAlreadyOnScreen": t["b"]["headline"] is None,
                                  "speechEventToFirstDrawMs": page.evaluate("""n => window.__e2e.timings.slice(n).filter(t => t.b.headline !== null).map(t => t.b.headline)""", timings0),
                                  "state": page.evaluate("() => document.querySelector('[data-el=\"voice\"]').dataset.state")}
    check(rev - rev0 == len(words) and box == "max speed per vessel", f"voice: {len(words)} interim DRAFTs + final COMMIT (revisions {rev - rev0}, box '{box}')")
    check(kept.count() >= 1, "voice: the final transcript keeps a card (COMMIT)")
    print("voice", json.dumps(report["voice"]), flush=True)
    context.close()


def main():
    global args
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://localhost:5199")
    p.add_argument("--software", action="store_true")
    p.add_argument("--samples", type=int, default=12)
    p.add_argument("--json")
    args = p.parse_args()
    fake = FakeInference().start()
    failures = []
    report = {"fake": "echo, 0 ms", "chips": {}, "typing": {}, "voice": {}}

    def check(cond, message):
        print(("ok   " if cond else "FAIL ") + message, flush=True)
        if not cond:
            failures.append(message)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=SOFTWARE if args.software else [])
        report["browser"] = browser.version
        run_voice(browser, fake, report, check)
        for name, suggest in [("prepared", {}), ("primed", {"warm": False}), ("off", {"prime": False, "warm": False})]:
            run_chip_mode(browser, fake, name, suggest, args.samples, report, check)
        prepared = report["chips"]["prepared"]
        check(prepared["inferCalls"] == 0, f"prepared clicks never call inference ({prepared['inferCalls']} calls)")
        check(report["chips"]["off"]["inferCalls"] >= args.samples, "unprimed clicks go to inference")
        for name, suggest in [("suggestions-off", {"enabled": False}), ("suggestions-on", {}), ("suggestions-every-result", {"settleMs": 0})]:
            run_typing(browser, fake, name, suggest, args.samples, report)
        browser.close()
    fake.stop()
    print(json.dumps({k: v for k, v in report.items() if k != "chips"}, indent=1))
    if args.json:
        with open(args.json, "w") as f:
            json.dump(report, f, indent=1)
    for f in failures:
        print("FAIL", f)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
