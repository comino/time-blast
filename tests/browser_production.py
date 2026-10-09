"""Verify a built deployment through its public UI and actual HTTP asset path.

python3 tests/browser_production.py --url https://time-blast.46-224-133-201.sslip.io
Requires Python Playwright and Chromium. No model download or latency claim.
"""
import argparse
import json

from playwright.sync_api import sync_playwright


def run(url, screenshot):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.set_default_timeout(60_000)
        errors, engines, failed_assets = [], [], []
        page.on("pageerror", lambda error: errors.append(str(error)))

        def response_seen(response):
            if ".wasm.gz" in response.url:
                engines.append({"url": response.url, "status": response.status,
                                "headers": response.headers})
            if response.status >= 400 and response.url.startswith(url.rstrip("/")):
                failed_assets.append({"url": response.url, "status": response.status})

        page.on("response", response_seen)
        document = page.goto(url, wait_until="domcontentloaded")
        assert document.status == 200
        assert page.evaluate("isSecureContext")
        assert "no-cache" in document.headers.get("cache-control", "")
        page.locator('[data-stage="database"][data-state="ready"]').wait_for(state="attached")
        assert "1,209,600" in page.locator('[data-el="dataset-sub"]').inner_text()
        before = len(engines)
        assert before == 1, engines
        # The deployed default must draw real data without Enter or settings edits.
        assert page.locator('[data-action="live-query"]').get_attribute('aria-checked') == 'true'
        page.locator('[data-el="input"]').fill("Compare vessel speeds by hour over the last 24 hours")
        page.wait_for_function("""() =>
          document.querySelector('[data-el="result-state"]')?.textContent.trim() === 'COMPLETE' &&
          document.querySelector('[data-el="points"]')?.textContent.trim() === '144'""")
        assert page.locator('.result-card[data-live-preview="true"]').count() == 1
        assert page.locator('[data-history-card]').count() == 0
        for name in ['inference-latency', 'database-first-latency', 'database-latency', 'render-latency']:
            assert page.locator(f'[data-el="{name}"]').inner_text() != '—', name
        assert page.locator('[data-el="database-label"]').inner_text() == 'DUCKDB TOTAL'
        live_query_meta = page.locator('[data-el="query-meta"]').inner_text()
        page.locator('[data-el="input"]').press("Enter")
        page.evaluate('new Promise(requestAnimationFrame)')
        assert page.locator('.result-card').count() == 1
        assert page.locator('.result-card[data-live-preview="true"]').count() == 0
        assert page.locator('[data-el="query-meta"]').inner_text() == live_query_meta
        assert page.locator('[data-history-card]').count() == 1
        page.locator('[data-el="input"]').fill("")
        page.locator('[data-action="clear-canvas"]').click()
        page.evaluate("""() => {
          window.__databaseReloads = 0;
          new MutationObserver(() => {
            if (document.querySelector('[data-stage="database"]').dataset.state === 'loading')
              window.__databaseReloads++;
          }).observe(document.querySelector('[data-stage="database"]'), {
            attributes:true, attributeFilter:['data-state']});
        }""")
        page.get_by_role("button", name="Runtime settings", exact=True).click()
        page.select_option('[name="inferenceMode"]', "templates")
        page.locator('[name="liveQuery"]').uncheck()
        page.locator('[name="liveTranslation"]').uncheck()
        page.get_by_role("button", name="Apply runtime").click()
        page.wait_for_function("""() =>
          document.querySelector('[data-stage="model"] small').textContent === 'Deterministic templates' &&
          document.querySelector('[data-stage="coordinator"]').dataset.state === 'ready'""")
        assert page.evaluate("window.__databaseReloads") == 0
        assert len(engines) == before, "Changing inference settings reloaded DuckDB"
        # Whitespace must preserve exact prepared identity through Enter.
        page.locator('[data-el="input"]').fill("Compare vessel speeds by hour over the last 24 hours ")
        page.wait_for_function("""() =>
          document.querySelector('[data-el="draft-state"]').textContent.includes('144 points staged')""")
        page.locator('[data-el="input"]').press("Enter")
        page.wait_for_function("""() =>
          document.querySelector('[data-el="result-state"]').textContent.trim() === 'COMPLETE' &&
          document.querySelector('[data-el="points"]').textContent.trim() === '144'""")
        assert "Prepared result promoted" in page.locator('[data-el="latency-detail"]').inner_text()
        assert page.locator('[data-el="source"]').inner_text() == "LOCAL TEMPLATE"
        page.get_by_role("tab", name="Data", exact=True).click()
        assert page.locator('[data-el="table-body"] tr').count() == 12
        page.get_by_role("tab", name="Chart", exact=True).click()
        page.wait_for_function("document.querySelector('[data-el=\"result-state\"]').textContent.trim() === 'COMPLETE'")

        # Translation-only mode prepares SQL on each eligible edit without a query.
        page.locator('[data-el="input"]').fill("")
        page.get_by_role("button", name="Runtime settings", exact=True).click()
        page.locator('[name="liveTranslation"]').check()
        page.locator('[name="translationMinChars"]').fill("20")
        page.locator('[name="speculation"]').uncheck()
        page.get_by_role("button", name="Apply runtime").click()
        page.wait_for_function("document.querySelector('[data-stage=\"coordinator\"]').dataset.state === 'ready'")
        page.evaluate("""() => {
          window.__translationEvents = [];
          new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes)
              if (node.nodeType === 1) window.__translationEvents.push(node.firstElementChild?.textContent);
          }).observe(document.querySelector('[data-el="trace-list"]'), {childList:true});
        }""")
        previous_revision = page.locator('[data-el="revision"]').inner_text()
        page.locator('[data-el="input"]').fill("Average wind")
        page.wait_for_function("before => document.querySelector('[data-el=\"revision\"]').textContent !== before", arg=previous_revision)
        assert page.evaluate("window.__translationEvents.includes('translation_started')") is False
        page.locator('[data-el="input"]').fill("Average speed by hour")
        page.wait_for_function("window.__translationEvents.includes('sql_prepared')")
        prepared = page.evaluate("window.__translationEvents.filter(e => e === 'sql_prepared').length")
        page.locator('[data-el="input"]').press("Space")
        page.wait_for_function("count => window.__translationEvents.filter(e => e === 'sql_prepared').length > count", arg=prepared)
        assert page.locator('[data-el="draft-state"]').inner_text() == "SQL prepared before Enter"
        assert not page.evaluate("window.__translationEvents.includes('query_complete')")
        page.locator('[data-el="input"]').press("Enter")
        page.wait_for_function("window.__translationEvents.includes('prepared_sql_promoted') && window.__translationEvents.includes('query_complete')")
        assert page.locator('[data-el="points"]').inner_text() == "24"

        # Exercise dense output on the larger source, not merely its row-count label.
        page.get_by_role("button", name="Runtime settings", exact=True).click()
        page.locator('[name="liveTranslation"]').uncheck()
        page.locator('[name="speculation"]').check()
        page.get_by_role("button", name="Apply runtime").click()
        page.wait_for_function("document.querySelector('[data-stage=\"coordinator\"]').dataset.state === 'ready'")
        page.locator('[data-el="input"]').fill("Compare vessel wave height by minute over the last 7 days")
        page.wait_for_function("document.querySelector('[data-el=\"draft-state\"]').textContent.includes('60,480 points staged')")
        page.locator('[data-el="input"]').press("Enter")
        page.wait_for_function("""() =>
          document.querySelector('[data-el="result-state"]').textContent.trim() === 'COMPLETE' &&
          document.querySelector('[data-el="points"]').textContent.trim() === '60,480'""")
        assert "Prepared result promoted" in page.locator('[data-el="latency-detail"]').inner_text()
        assert page.locator('.result-card').count() == 3
        completed_queries = page.evaluate("window.__translationEvents.filter(e => e === 'query_complete').length")
        page.locator('[data-action="fit"]').click()
        cards = page.locator('.result-card')
        cards.nth(1).locator('[data-card-el="representation"]').select_option("bar")
        cards.nth(2).locator('[data-card-el="representation"]').select_option("scatter")
        cards.nth(0).locator('[data-card-action="duplicate"]').click()
        assert cards.count() == 4
        cards.nth(3).locator('[data-card-el="representation"]').select_option("map")
        page.locator('[data-action="fit"]').click()
        page.wait_for_function("""() => [...document.querySelectorAll('[data-card-el="result-state"]')]
          .every(label => label.textContent.trim() === 'COMPLETE')""")
        assert page.locator('[data-el="latency-detail"]').inner_text() == "Shared result · no new query"
        for name in ['latency', 'inference-latency', 'database-first-latency', 'database-latency', 'render-latency']:
            assert page.locator(f'[data-el="{name}"]').inner_text() == '—', 'Copies must not claim new execution timing'
        assert [cards.nth(i).locator('[data-card-el="points"]').inner_text() for i in range(4)] == ["144", "24", "60,480", "144"]
        assert page.evaluate("window.__translationEvents.filter(e => e === 'query_complete').length") == completed_queries
        # New view requests use their own inferred intent and lazy renderer chunks.
        page.locator('[data-action="clear-canvas"]').click()
        advanced = [
            ("heatmap", "Show a heatmap of vessel wind by hour over the last 7 days"),
            ("surface", "Compare vessel wave height by hour over the last 7 days as a 3D surface"),
            ("tracks", "Show voyage tracks of vessel speeds by hour over the last 7 days"),
            ("density", "Show a density map of vessel speeds by hour over the last 7 days"),
        ]
        for mode, prompt in advanced:
            page.locator('[data-el="input"]').fill(prompt)
            page.wait_for_function("document.querySelector('[data-el=\"draft-state\"]').textContent.includes('1,008 points staged')")
            page.locator('[data-el="input"]').press("Enter")
            page.wait_for_function("document.querySelector('[data-el=\"result-state\"]').textContent.trim() === 'COMPLETE'")
            assert page.locator('[data-el="representation"]').input_value() == mode
            assert page.locator('[data-el="points"]').inner_text() == "1,008"
            assert page.locator('[data-el="latency"]').inner_text() != "—"
        assert cards.count() == 4
        completed_queries = page.evaluate("window.__translationEvents.filter(e => e === 'query_complete').length")
        page.locator('[data-el="representation"]').select_option("seasons")
        page.wait_for_function("document.querySelector('[data-el=\"result-state\"]').textContent.trim() === 'COMPLETE'")
        page.locator('[data-el="representation"]').select_option("density")
        page.wait_for_function("document.querySelector('[data-el=\"result-state\"]').textContent.trim() === 'COMPLETE'")
        assert page.evaluate("window.__translationEvents.filter(e => e === 'query_complete').length") == completed_queries
        page.locator('[data-action="fit"]').click()
        page.wait_for_function("""() => [...document.querySelectorAll('[data-card-el="result-state"]')]
          .every(label => label.textContent.trim() === 'COMPLETE')""")
        assert page.evaluate("window.__databaseReloads") == 0
        assert len(engines) == before
        if screenshot:
            page.screenshot(path=screenshot, full_page=True)
        for engine in engines:
            assert engine["status"] == 200, engine
            assert engine["headers"].get("content-encoding") == "gzip", engine
            assert engine["headers"].get("content-type") == "application/wasm", engine
            assert "immutable" in engine["headers"].get("cache-control", ""), engine
        assert not failed_assets, failed_assets
        assert not errors, errors
        print(json.dumps({"url": url, "chromium": browser.version, "dataset_rows": 1_209_600,
                          "dense_chart_points": 60_480, "default_live_chart_without_enter": True,
                          "live_pin_without_query": True, "stage_timings_visible": True,
                          "live_translation_without_query": True,
                          "prepared_whitespace_promoted": True, "database_reloads": 0,
                          "persistent_cards": 4, "presentation_without_new_query": True,
                          "advanced_intents": [mode for mode, _ in advanced], "calendar_switch": True,
                          "http_decoded_engines": len(engines), "page_errors": errors}, indent=2))
        browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--screenshot")
    args = parser.parse_args()
    run(args.url, args.screenshot)
