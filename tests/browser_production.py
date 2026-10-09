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
        before = len(engines)
        assert before == 1, engines
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
        assert page.locator('[data-el="latency-detail"]').inner_text() == "Prepared result promoted"
        assert page.locator('[data-el="source"]').inner_text() == "LOCAL TEMPLATE"
        page.get_by_role("tab", name="Data", exact=True).click()
        assert page.locator('[data-el="table-body"] tr').count() == 12
        page.get_by_role("tab", name="Chart", exact=True).click()
        if screenshot:
            page.screenshot(path=screenshot, full_page=True)
        for engine in engines:
            assert engine["status"] == 200, engine
            assert engine["headers"].get("content-encoding") == "gzip", engine
            assert engine["headers"].get("content-type") == "application/wasm", engine
            assert "immutable" in engine["headers"].get("cache-control", ""), engine
        assert not failed_assets, failed_assets
        assert not errors, errors
        print(json.dumps({"url": url, "chromium": browser.version, "points": 144,
                          "prepared_whitespace_promoted": True, "database_reloads": 0,
                          "http_decoded_engines": len(engines), "page_errors": errors}, indent=2))
        browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--screenshot")
    args = parser.parse_args()
    run(args.url, args.screenshot)
