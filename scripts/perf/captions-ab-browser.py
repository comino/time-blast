#!/usr/bin/env python3
"""A/B (docs/plan-captions.md, phase 3, browser level): do chart captions slow the next question?

Production build in headless Chromium against a real inference server (real provider, its SQL
and caption caches off). Each sample types a corpus question into a new chart and presses Enter;
the app's own TIMING ledger gives keystroke -> first draw *submission* (not photons) for the last
typed revision. Arms switch per sample in random paired order with the app's caption setting
(`controller.setCaptions`). With captions on, the previous chart's caption request is still in
flight while the next question is typed (a caption takes ~1 s, typing ~2 s), so the measured
question overlaps caption traffic: the realistic worst case. The in-browser translation cache is
off; questions repeat once per arm.

  python3 scripts/perf/captions-ab-browser.py --url http://127.0.0.1:4174 [--reps 2] [--json out.json]
"""
import argparse
import json
import os
import random
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from e2e import BOOT_MARKS, HOOK, SOFTWARE, drawn_timing, revision, type_question, wait_boot, wait_for  # noqa: E402


def quantile(xs, f):
    s = sorted(x for x in xs if x is not None)
    return s[min(len(s) - 1, int(f * (len(s) - 1) + 0.5))] if s else None


def bootstrap(pairs, f, rounds=2000):
    rng = random.Random(7)
    diffs = []
    for _ in range(rounds):
        sample = [rng.choice(pairs) for _ in pairs]
        diffs.append(quantile([p["on"] for p in sample], f) - quantile([p["off"] for p in sample], f))
    return {"delta": round(quantile([p["on"] for p in pairs], f) - quantile([p["off"] for p in pairs], f), 1),
            "ci95": [round(quantile(diffs, 0.025), 1), round(quantile(diffs, 0.975), 1)]}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://127.0.0.1:4174")
    p.add_argument("--reps", type=int, default=2)
    p.add_argument("--delay", type=int, default=70, help="ms between keystrokes")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--json")
    args = p.parse_args()
    corpus = json.load(open(os.path.join(ROOT, "evals/sql-corpus.json")))
    questions = [c["question"] for c in corpus["cases"]]
    plan = [q for _ in range(args.reps) for q in questions]
    random.Random(11).shuffle(plan)
    if args.limit:
        plan = plan[: args.limit]
    pairs, failures = [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=SOFTWARE)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.add_init_script(BOOT_MARKS)
        page = context.new_page()
        page.on("pageerror", lambda e: print("pageerror:", e, file=sys.stderr))
        page.goto(args.url)
        wait_boot(page, 240)
        page.evaluate(HOOK)
        page.evaluate("() => globalThis.__timeBlastUi.controller.setConfig({ translationCache: false })")
        version = lambda: page.evaluate("() => { const c = globalThis.__timeBlastUi.controller.captions; return { ...c.stats, version: c.version }; }")
        start = version()
        for n, question in enumerate(plan):
            pair = {"question": question}
            if n % 6 == 0:  # keep the canvas small: rendering cost stays flat across the run
                page.evaluate("() => globalThis.__timeBlastUi.controller.clear()")
            for arm in random.Random(n).sample(["off", "on"], 2):
                page.evaluate(f"() => globalThis.__timeBlastUi.controller.setCaptions({str(arm == 'on').lower()})")
                pair.setdefault("first", arm)
                since = page.evaluate("() => window.__e2e.timings.length")
                page.evaluate("() => globalThis.__timeBlastUi.controller.newQuestion()")
                type_question(page, question, args.delay)
                rev = revision(page)
                page.keyboard.press("Enter")
                try:
                    t = wait_for(lambda: drawn_timing(page, rev, since), 45, f"first draw of {question!r}")
                    pair[arm] = t["headline"]
                except AssertionError as e:
                    failures.append({"question": question, "arm": arm, "error": str(e)})
                    pair[arm] = None
                # Leave the caption in flight: the next sample types while it lands.
                time.sleep(0.3)
            pairs.append(pair)
            if n % 10 == 0:
                print(f"{n + 1}/{len(plan)} off {pair.get('off')} on {pair.get('on')} · captions {version()}", file=sys.stderr)
        end = version()
        browser.close()
    ok = [p for p in pairs if p.get("on") is not None and p.get("off") is not None]
    summary = {"pairs": len(ok), "failures": len(failures)}
    for arm in ("off", "on"):
        xs = [p[arm] for p in ok]
        summary[arm] = {"p50": quantile(xs, .5), "p95": quantile(xs, .95), "p99": quantile(xs, .99)}
    summary["p50Delta"], summary["p95Delta"] = bootstrap(ok, .5), bootstrap(ok, .95)
    summary["captions"] = {k: end[k] - start.get(k, 0) for k in ("requested", "received", "cached", "failed", "inherited")}
    summary["captionLastMs"] = end.get("lastMs")
    report = {"kind": "timeblast.captions-ab-browser", "version": 1, "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "url": args.url,
              "measurement": "Headless Chromium (SwiftShader WebGPU) on this host; key -> first draw submitted from the app TIMING ledger for the last typed revision; paired arms in random order; translation cache off; server SQL/caption caches off; real provider.",
              "settings": vars(args), "summary": summary, "pairs": pairs, "failures": failures}
    if args.json:
        json.dump(report, open(args.json, "w"), indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
