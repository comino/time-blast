#!/usr/bin/env python3
"""Smoke the actual browser database, streaming cancellation, and Rust compiler.

Start Vite first, then run: python3 tests/browser_database.py
Requires Python Playwright and an installed Chromium; --chromium can select one.
Reports observed counts and installed versions, not performance benchmarks.
"""

import argparse
import asyncio
import json
from pathlib import Path

from playwright.async_api import async_playwright


SMOKE = """async () => {
  const { DuckDBAdapter } = await import('/src/adapters/duckdb.ts');
  const { WasmQueryCompiler } = await import('/src/core/compiler.ts');
  const database = new DuckDBAdapter();
  const compiler = new WasmQueryCompiler();
  const progress = [];
  try {
    const context = await database.prepare(status => progress.push(status.label));
    await compiler.prepare();
    const plan = { metric: 'speed', aggregate: 'avg', bucketMinutes: 60,
      windowHours: 24, splitByVessel: true, vessel: null, view: 'line' };
    const sql = compiler.compile(plan, context);
    const request = (id, signal = new AbortController().signal) => ({
      id, sql, plan, context, signal, priority: 'committed',
    });
    let batches = 0, points = 0, first;
    for await (const batch of database.execute(request('browser-smoke'))) {
      batches++; points += batch.length;
      first ??= { x: batch.x[0], y: batch.y[0], series: batch.series[0] };
    }
    if (context.rowCount !== 120960 || points !== 144)
      throw new Error(`Unexpected fixture/result count: ${context.rowCount}/${points}`);
    if (first.x !== context.end - 24 * 3600000 || first.series !== 0 || !Number.isFinite(first.y))
      throw new Error('Unexpected first hourly observation');

    const controller = new AbortController();
    const stream = database.execute({ ...request('browser-smoke-cancel', controller.signal),
      sql: 'SELECT t AS x, speed AS y, vessel AS series, lat, lon FROM telemetry' });
    const partial = await stream.next();
    if (partial.done || !partial.value.length) throw new Error('Raw query produced no batch');
    const cancelFirstBatch = partial.value.length;
    controller.abort();
    let cancellation;
    try { await stream.next(); } catch (error) { cancellation = error.name; }
    if (cancellation !== 'AbortError') throw new Error('Canceled query did not reject with AbortError');

    let nextRows = 0;
    for await (const batch of database.execute(request('browser-smoke-after-cancel')))
      nextRows += batch.length;
    if (nextRows !== 144) throw new Error(`Cancellation affected next query: ${nextRows} rows`);
    await new Promise(resolve => setTimeout(resolve, 250));
    return { contextId: context.id, datasetRows: context.rowCount, progress,
      batches, points, first, cancelFirstBatch, cancellation, nextRows };
  } finally { await database.dispose(); }
}"""


def installed_versions():
    root = Path(__file__).resolve().parents[1]
    versions = {}
    for package in ("@duckdb/duckdb-wasm", "apache-arrow"):
        path = root / "node_modules" / package / "package.json"
        versions[package] = json.loads(path.read_text())["version"] if path.exists() else "unknown"
    return versions


async def run(args):
    async with async_playwright() as playwright:
        launch = {"headless": True, "args": ["--no-sandbox"]}
        if args.chromium:
            launch["executable_path"] = args.chromium
        browser = await playwright.chromium.launch(**launch)
        try:
            page = await browser.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            # Keep the smoke independent of application UI and its background queries.
            await page.route("**/__database_smoke", lambda route: route.fulfill(
                status=200, content_type="text/html", body="<!doctype html><title>Database smoke</title>"))
            await page.goto(args.url.rstrip("/") + "/__database_smoke")
            result = await asyncio.wait_for(page.evaluate(SMOKE), timeout=args.timeout)
            print(json.dumps({"versions": {**installed_versions(), "chromium": browser.version},
                              "result": result, "page_errors": errors}, indent=2))
            if errors:
                raise AssertionError("Browser reported an error during database smoke")
        finally:
            await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://localhost:5173", help="Running Vite development origin")
    parser.add_argument("--chromium", help="Optional Chromium executable path")
    parser.add_argument("--timeout", type=float, default=120, help="Database smoke timeout in seconds")
    asyncio.run(run(parser.parse_args()))
