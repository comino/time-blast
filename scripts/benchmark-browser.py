#!/usr/bin/env python3
"""Measure the live UI's warm template commit-to-first-draw trace.

Start Vite, then run:
  python3 scripts/benchmark-browser.py --output docs/benchmark-browser.json
Requires Python Playwright and an installed Chromium (--chromium selects one).
This measures Canvas draw submission, not display presentation or photons.
"""

import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess

from playwright.async_api import async_playwright


ROOT = Path(__file__).resolve().parents[1]
QUESTION = "Compare vessel speeds by hour over the last 24 hours"
INPUT = '[data-el="input"]'
TRACE_OBSERVER = """() => {
  window.__timeBlastBenchmark = { draws: [], databaseReloads: 0 };
  const state = window.__timeBlastBenchmark;
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.firstElementChild?.textContent !== 'first_draw_submitted') continue;
      const detail = node.lastElementChild.textContent;
      const match = /^([0-9]+(?:\\.[0-9]+)?) ms after commit$/.exec(detail);
      if (!match) throw new Error(`Unexpected draw trace: ${detail}`);
      state.draws.push({ ms: Number(match[1]), detail });
    }
  }).observe(document.querySelector('[data-el="trace-list"]'), { childList: true });
  new MutationObserver(() => {
    if (document.querySelector('[data-stage="database"]').dataset.state === 'loading')
      state.databaseReloads++;
  }).observe(document.querySelector('[data-stage="database"]'), {
    attributes: true, attributeFilter: ['data-state'],
  });
}"""


def versions():
    result = {}
    for package in ("@duckdb/duckdb-wasm", "apache-arrow", "vite"):
        path = ROOT / "node_modules" / package / "package.json"
        result[package] = json.loads(path.read_text())["version"] if path.exists() else "unknown"
    return result


def source_hashes():
    files = sorted(str(path.relative_to(ROOT)) for path in (ROOT / "src").rglob("*") if path.is_file())
    files += ["public/wasm/query-core.wasm", "public/data/context.json", "pnpm-lock.yaml", "vite.config.ts", "scripts/benchmark-browser.py"]
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files}


def summarize(samples):
    ordered = sorted(samples)
    return {"sample_count": len(samples), "median_ms": round(statistics.median(samples), 3),
            "p95_ms": ordered[math.ceil(0.95 * len(ordered)) - 1],
            "min_ms": ordered[0], "max_ms": ordered[-1], "samples_ms": samples}


async def trial(page, speculation):
    button = page.locator('[data-action="speculation"]')
    desired = "true" if speculation else "false"
    if await button.get_attribute("aria-checked") != desired:
        await button.click()
    await page.wait_for_function("""expected =>
      document.querySelector('[data-action="speculation"]').getAttribute('aria-checked') === expected &&
      document.querySelector('[data-stage="coordinator"]').dataset.state === 'ready' &&
      document.querySelector('[data-stage="database"]').dataset.state === 'ready'""", arg=desired)
    await page.locator(INPUT).fill(QUESTION)
    if speculation:
        await page.wait_for_function("""() =>
          document.querySelector('[data-el="draft-dot"]').dataset.state === 'ready' &&
          document.querySelector('[data-el="draft-state"]').textContent.includes('144 points staged')""")
    before = await page.evaluate("window.__timeBlastBenchmark.draws.length")
    await page.locator(INPUT).press("Enter")
    await page.wait_for_function("count => window.__timeBlastBenchmark.draws.length > count", arg=before)
    await page.wait_for_function("""() =>
      document.querySelector('[data-el="result-state"]').textContent.trim() === 'COMPLETE'""")
    observed = await page.evaluate("""() => ({
      trace: window.__timeBlastBenchmark.draws.at(-1),
      source: document.querySelector('[data-el="source"]').textContent,
      points: document.querySelector('[data-el="points"]').textContent,
      detail: document.querySelector('[data-el="latency-detail"]').textContent,
    })""")
    if observed["source"] != "LOCAL TEMPLATE" or observed["points"] != "144":
        raise AssertionError(f"Unexpected execution path/result: {observed}")
    promoted = observed["detail"] == "Prepared result promoted"
    if promoted != speculation:
        raise AssertionError(f"Unexpected promotion state: {observed}")
    return observed["trace"]["ms"]


async def benchmark(args):
    before_hashes = source_hashes()
    async with async_playwright() as playwright:
        launch = {"headless": True, "args": ["--no-sandbox", "--disable-gpu"]}
        if args.chromium:
            launch["executable_path"] = args.chromium
        browser = await playwright.chromium.launch(**launch)
        try:
            page = await browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
            page.set_default_timeout(args.timeout * 1000)
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            await page.goto(args.url, wait_until="domcontentloaded")
            await page.wait_for_selector('[data-stage="database"][data-state="ready"]', state="attached")
            await page.locator('[data-action="settings"]').click()
            await page.locator('[name="inferenceMode"]').select_option("templates")
            await page.locator('[name="datasetProfile"]').select_option(args.dataset_profile)
            await page.locator('[name="liveTranslation"]').uncheck()
            await page.locator('[name="speculation"]').uncheck()
            await page.locator('[data-el="runtime-form"] button[type="submit"]').click()
            await page.wait_for_function("""() =>
              document.querySelector('[data-stage="coordinator"]').dataset.state === 'ready' &&
              document.querySelector('[data-stage="database"]').dataset.state === 'ready' &&
              document.querySelector('[data-stage="model"] small').textContent === 'Deterministic templates'""")
            dataset = json.loads((ROOT / "public/data/context.json").read_text())
            if args.dataset_profile == "large":
                dataset.update(id="synthetic-vessels-2026-09-6s-v1", rowCount=1_209_600,
                               label="North Atlantic · dense synthetic telemetry",
                               description="Six fictional vessels sampled every six seconds from the original continuous-time formulas.")
            dataset_text = await page.locator('[data-el="dataset-sub"]').inner_text()
            if f"{dataset['rowCount']:,}" not in dataset_text:
                raise AssertionError(f"Wrong dataset profile: {dataset_text}")
            await page.evaluate(TRACE_OBSERVER)
            for _ in range(args.warmup):
                await trial(page, False)
                await trial(page, True)
            samples = {False: [], True: []}
            # Alternate pair order to reduce a systematic first/second-condition bias.
            for index in range(args.trials):
                for speculation in ((False, True) if index % 2 == 0 else (True, False)):
                    samples[speculation].append(await trial(page, speculation))
            reloads = await page.evaluate("window.__timeBlastBenchmark.databaseReloads")
            if reloads:
                raise AssertionError(f"Warm benchmark unexpectedly reloaded the database {reloads} times")
            if errors:
                raise AssertionError(f"Browser errors: {errors}")
            if source_hashes() != before_hashes:
                raise AssertionError("Measured source files changed during the run; run again on a stable tree")
            off, on = summarize(samples[False]), summarize(samples[True])
            return {
                "recorded_at_utc": datetime.now(timezone.utc).isoformat(),
                "url": args.url,
                "build_mode": args.build_mode,
                "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                "metric": "App commit timestamp to first Canvas point draw submission (first_draw_submitted trace)",
                "trace_rounding_ms": 0.01,
                "question": QUESTION,
                "points_per_result": 144,
                "dataset": dataset,
                "dataset_profile": args.dataset_profile,
                "versions": {**versions(), "chromium": browser.version},
                "environment": {"os": platform.system(), "architecture": platform.machine(),
                                "logical_cpus": os.cpu_count(), "headless": True,
                                "viewport": {"width": 1440, "height": 1000}, "device_scale_factor": 1,
                                "chromium_args": launch["args"]},
                "method": {
                    "inference": "CPU-only deterministic templates; no LLM inference",
                    "database": "Warm DuckDB-Wasm in browser; same loaded synthetic table across modes",
                    "input": "Playwright DOM fill and real browser Enter key dispatch",
                    "speculation_on": "Wait for all 144 points staged before Enter; prepared-hit best case",
                    "speculation_off": "Enter without a prepared candidate; query executes after commit",
                    "order": "Paired trials; alternating OFF/ON and ON/OFF order",
                    "discarded_warmup_trials_per_mode": args.warmup,
                    "p95": "Nearest rank: sorted[ceil(0.95 * n) - 1]",
                    "database_loading_transitions_during_trials": reloads,
                },
                "limitations": [
                    "Draw submission is not presentation, scanout, or photons reaching the eye.",
                    "Headless Chromium launched with --disable-gpu; no hardware-GPU latency claim.",
                    "Uncontrolled shared host, no CPU isolation, thermal control, or power-state control.",
                    "Repeated exact query on a warm synthetic dataset; startup and model latency are excluded.",
                    "Prepared-hit measurements move work before Enter and do not estimate hit rate or total resource cost.",
                    f"Small sample, {args.build_mode} build, browser automation; results are evidence for this run, not a target guarantee.",
                ],
                "speculation_off": off,
                "speculation_on": on,
                "median_reduction_ms": round(off["median_ms"] - on["median_ms"], 3),
                "page_errors": errors,
                "source_sha256": before_hashes,
            }
        finally:
            await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://localhost:5173", help="Running app URL")
    parser.add_argument("--build-mode", choices=["development", "production"], default="development", help="Build served at --url")
    parser.add_argument("--dataset-profile", choices=["demo", "large"], default="large", help="Synthetic source size; does not change aggregate point count")
    parser.add_argument("--chromium", help="Optional Chromium executable path")
    parser.add_argument("--trials", type=int, default=20, help="Recorded trials per speculation mode")
    parser.add_argument("--warmup", type=int, default=2, help="Discarded warmup trials per mode")
    parser.add_argument("--timeout", type=float, default=60, help="Per-action timeout in seconds")
    parser.add_argument("--output", type=Path, help="Save observed JSON as well as printing it")
    args = parser.parse_args()
    if args.trials < 1 or args.warmup < 0:
        parser.error("--trials must be positive and --warmup must be nonnegative")
    result = asyncio.run(benchmark(args))
    output = json.dumps(result, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output)
    print(output, end="")
