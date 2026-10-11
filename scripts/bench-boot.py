#!/usr/bin/env python3
"""Boot benchmark: navigation start → first question answerable → rollups ready, stage by stage
(docs/batch-3/cold-start.md). Reads the page's boot trace (`globalThis.__timeBlastBoot`,
src/ui/boot-trace.ts) in headless Chromium with a fake inference node (tests/fake_inference.py),
so "inference ready" is our own link setup, not a provider.

  first visit   a fresh browser context per run: empty HTTP cache, code cache and storage
  repeat visit  one context, warmed by one visit, then a new page per run (HTTP cache, V8 code
                cache, Cache API and OPFS persist, as for a returning user)

Right after the first question becomes answerable, one question is typed (a single input event)
and its keystroke → first draw is recorded: the first query, usually before rollups exist.

Start a server first (dev: `pnpm exec vite --port 5199 --strictPort`; production:
`pnpm build && pnpm exec vite preview --port 4199 --strictPort`), then:
  python3 scripts/bench-boot.py --url http://localhost:4199 --software --runs 7 [--json out.json] [--label name]
"""
import argparse
import json
import os
import shutil
import statistics
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests"))
from fake_inference import FakeInference  # noqa: E402

SOFTWARE = ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader"]
QUESTION = "average speed per hour by vessel"

FIRST_QUERY = """async question => {
  const ui = globalThis.__timeBlastUi, boot = globalThis.__timeBlastBoot;
  const rollupsBefore = boot.report().rollups !== null;
  const box = document.querySelector('[data-el="input"]');
  return await new Promise(resolve => {
    const c = ui.controller, orig = c.rail.timing.bind(c.rail);
    const timer = setTimeout(() => resolve({ error: 'timeout' }), 60000);
    c.rail.timing = (t, summary, stats) => {
      orig(t, summary, stats);
      if (t.headline === null) return;
      clearTimeout(timer);
      c.rail.timing = orig;
      const row = label => t.rows.find(r => r.label === label);
      const exec = row('exec received') ?? row('exec sent'), first = row('DB first batch');
      resolve({ headline: t.headline, db: exec && first ? first.offset - exec.offset : null, cacheHit: t.cacheHit, rollupsBefore,
        rows: t.rows.map(r => [r.label, +r.offset.toFixed(2)]) });
    };
    box.value = question;
    box.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: question }));
  });
}"""


def quantiles(values):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    p95 = values[min(len(values) - 1, max(0, round(0.95 * (len(values) - 1))))]
    return {"p50": round(statistics.median(values), 1), "p95": round(p95, 1), "min": round(values[0], 1),
            "max": round(values[-1], 1), "n": len(values)}


def visit(context, url, timeout_s, first_query):
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.goto(url)
    try:
        page.wait_for_function("() => globalThis.__timeBlastBoot && globalThis.__timeBlastBoot.report().answerable !== null",
                               timeout=timeout_s * 1000, polling=20)
        query = page.evaluate(FIRST_QUERY, QUESTION) if first_query else None
        page.wait_for_function("() => globalThis.__timeBlastBoot.report().rollups !== null", timeout=timeout_s * 1000, polling=50)
    except Exception as e:  # noqa: BLE001 - report the partial trace and go on
        partial = page.evaluate("() => globalThis.__timeBlastBoot ? globalThis.__timeBlastBoot.report() : null")
        marks = [(r["stage"], r["endMs"]) for r in (partial or {}).get("rows", [])]
        print(f"visit failed: {str(e).splitlines()[0]}; errors {errors[:3]}; marks {marks}", file=sys.stderr, flush=True)
        page.close()
        return None
    report = page.evaluate("() => globalThis.__timeBlastBoot.report()")
    report["firstQuery"] = query
    report["errors"] = errors
    page.close()
    return report


def summarize(reports):
    stages = {}
    for r in reports:
        seen = set()
        for row in r["rows"]:
            key = f'{row["thread"]}:{row["stage"]}'
            if key in seen:
                continue
            seen.add(key)
            s = stages.setdefault(key, {"end": [], "ms": []})
            s["end"].append(row["endMs"])
            if row["ms"] is not None:
                s["ms"].append(row["ms"])
    out = {
        "answerable": quantiles([r["answerable"] for r in reports]),
        "rollups": quantiles([r["rollups"] for r in reports]),
        "firstQueryHeadline": quantiles([(r["firstQuery"] or {}).get("headline") for r in reports]),
        "firstQueryDb": quantiles([(r["firstQuery"] or {}).get("db") for r in reports]),
        "firstQueryBeforeRollups": sum(1 for r in reports if r["firstQuery"] and not r["firstQuery"].get("rollupsBefore")),
        "stages": {k: {"end": quantiles(v["end"]), "ms": quantiles(v["ms"])} for k, v in
                   sorted(stages.items(), key=lambda kv: statistics.median(kv[1]["end"]))},
        "transfer": reports[-1]["transfer"] if reports else {},
    }
    return out


def print_summary(name, s):
    print(f"\n== {name}: answerable {s['answerable']}  rollups {s['rollups']}")
    print(f"   first query key→draw {s['firstQueryHeadline']}  db {s['firstQueryDb']}  (before rollups: {s['firstQueryBeforeRollups']})")
    for k, v in s["stages"].items():
        ms = v["ms"]
        print(f"   {k:34s} end p50 {v['end']['p50']:9.1f}  p95 {v['end']['p95']:9.1f}" + (f"   dur p50 {ms['p50']:8.1f} p95 {ms['p95']:8.1f}" if ms else ""))
    for k, v in s["transfer"].items():
        print(f"   transfer {k:28s} {v['transferSize']:>10} B on the wire, {v['decodedBodySize']:>10} B decoded")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://localhost:4199")
    p.add_argument("--runs", type=int, default=5)
    p.add_argument("--software", action="store_true")
    p.add_argument("--timeout", type=int, default=180)
    p.add_argument("--no-first-query", action="store_true")
    p.add_argument("--only", choices=["first", "repeat"], default=None)
    p.add_argument("--label", default="")
    p.add_argument("--json")
    args = p.parse_args()

    fake = FakeInference().start()
    settings = {"inference": {"kind": "remote", "endpoint": fake.url}}
    init = f"localStorage.setItem('time-blast.ui.v1', {json.dumps(json.dumps(settings))});"
    out = {"kind": "time-blast.boot-bench", "version": 1, "label": args.label, "url": args.url,
           "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "runs": args.runs,
           "loadavgStart": [round(v, 1) for v in os.getloadavg()]}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=SOFTWARE if args.software else [])
        out["browser"] = browser.version
        first, repeat = [], []
        for i in range(args.runs):
            if args.only != "repeat":
                ctx = browser.new_context(viewport={"width": 1400, "height": 950})
                ctx.add_init_script(init)
                r = visit(ctx, args.url, args.timeout, not args.no_first_query)
                ctx.close()
                if r is None:
                    continue
                first.append(r)
                print(f"first visit {i + 1}: answerable {first[-1]['answerable']} ms, rollups {first[-1]['rollups']} ms, "
                      f"first query {first[-1]['firstQuery']}", file=sys.stderr, flush=True)
        if args.only != "first":
            # A persistent profile: disk HTTP cache, V8 code cache and storage behave as for a
            # returning user (an incognito context keeps its caches in memory, with size limits).
            profile = tempfile.mkdtemp(prefix="tb-boot-")
            ctx = pw.chromium.launch_persistent_context(profile, headless=True, args=SOFTWARE if args.software else [],
                                                        viewport={"width": 1400, "height": 950})
            ctx.add_init_script(init)
            visit(ctx, args.url, args.timeout, False)  # warm-up visit
            for i in range(args.runs):
                r = visit(ctx, args.url, args.timeout, not args.no_first_query)
                if r is None:
                    continue
                repeat.append(r)
                print(f"repeat visit {i + 1}: answerable {repeat[-1]['answerable']} ms, rollups {repeat[-1]['rollups']} ms, "
                      f"first query {repeat[-1]['firstQuery']}", file=sys.stderr, flush=True)
            ctx.close()
            shutil.rmtree(profile, ignore_errors=True)
        browser.close()
    fake.stop()
    out["loadavgEnd"] = [round(v, 1) for v in os.getloadavg()]
    if first:
        out["first"] = summarize(first)
        print_summary("first visit", out["first"])
    if repeat:
        out["repeat"] = summarize(repeat)
        print_summary("repeat visit", out["repeat"])
    out["raw"] = {"first": first, "repeat": repeat}
    errors = [e for r in first + repeat for e in r["errors"]]
    if errors:
        print("page errors:", errors[:5], file=sys.stderr)
    if args.json:
        with open(args.json, "w") as f:
            json.dump(out, f, indent=1)
            f.write("\n")


if __name__ == "__main__":
    main()
