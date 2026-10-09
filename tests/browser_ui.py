"""Browser smoke: python3 tests/browser_ui.py [--base-url http://localhost:5173].

Requires Python Playwright and its Chromium installation. Start the Vite server
first. The product smoke queries the bundled synthetic dataset through DuckDB;
the separate UI harness injects controlled batches only to test lifecycle edges.
Observed timing is not a benchmark. Screenshots are optional review artifacts.
"""
import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright


def run(base_url, screenshot):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(base_url, wait_until="domcontentloaded")
        page.locator('[data-stage="database"][data-state="ready"]').wait_for(state='attached', timeout=90_000)
        page.locator("[data-prompt]").first.click()
        page.locator('[data-el="input"]').press("Enter")
        page.locator('[data-el="result-state"]').filter(has_text="COMPLETE").wait_for(timeout=30_000)
        assert int(page.locator('[data-el="points"]').inner_text().replace(",", "")) > 0
        assert page.locator('[data-el="latency"]').inner_text() != "—"
        assert page.locator('[data-el="source"]').inner_text() == "LOCAL TEMPLATE"
        if screenshot:
            Path(screenshot).parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=screenshot, full_page=True)
        page.locator('[data-tab="table"]').click()
        assert page.locator('[data-el="table-body"] tr').count() == 12
        page.locator('[data-tab="chart"]').click()
        page.locator('[data-action="sql"]').click()
        assert page.locator('[data-el="sql-panel"]').is_visible()
        page.locator('.pipeline-summary').click()
        page.get_by_role("button", name="Inspect pipeline").click()
        assert "first_draw_submitted" in page.locator('[data-el="trace-list"]').inner_text()
        with page.expect_download() as download:
            page.locator('[data-action="export"]').click()
        assert download.value.suggested_filename.endswith(".csv")
        page.set_viewport_size({"width": 390, "height": 844})
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
        page.get_by_role("button", name="Runtime settings", exact=True).click()
        page.select_option('[name="inferenceMode"]', "remote")
        assert page.locator('[name="inferenceDraftEndpoint"]').is_visible()
        page.locator('[name="inferenceEndpoint"]').fill("https://example.com/infer")
        page.locator('[name="inferenceDraftEndpoint"]').fill("ftp://example.com/draft")
        page.get_by_role("button", name="Apply runtime").click()
        assert "draft endpoint" in page.locator('[data-el="runtime-error"]').inner_text()
        page.get_by_role("button", name="Close runtime settings", exact=True).click()
        page.locator('[data-action="dataset"]').click()
        assert page.locator('[data-el="dataset-dialog"]').is_visible()
        page.get_by_role("button", name="Close dataset details", exact=True).click()
        assert not errors, errors
        page.close()

        # Load only the UI module, without initializing a second database/model.
        harness = browser.new_page(viewport={"width": 1440, "height": 1000})
        harness.route("**/ui-harness", lambda route: route.fulfill(
            status=200, content_type="text/html", body='<html><body><div id="root"></div></body></html>'
        ))
        harness.goto(base_url.rstrip("/") + "/ui-harness")
        result = harness.evaluate("""async () => {
          const {createUI} = await import('/src/ui/index.ts');
          const calls = {draws: [], commits: []};
          const ui = createUI(document.querySelector('#root'), {
            onDraft: () => {}, onCommit: text => calls.commits.push(text),
            onFocus: () => {}, onConfig: () => {}, onCancel: () => {},
            onWarmModel: () => {}, onDraw: id => calls.draws.push(id)
          });
          const {DEFAULT_CONFIG}=await import('/src/core/types.ts');
          ui.setConfig({...DEFAULT_CONFIG,liveQuery:false});
          const context = {id:'test', label:'test', rowCount:3, start:1000,
            end:4000, vessels:['One','Two'], description:'test'};
          const view = id => ({id, prompt:'speed', revision:1,
            plan:{metric:'speed',aggregate:'avg',bucketMinutes:1,windowHours:1,
              splitByVessel:true,vessel:null,view:'line'}, sql:'SELECT',
            source:'template',context,timing:{startedAt:performance.now()-100,
              committedAt:performance.now(),promoted:false,batches:0,points:0,bytes:0}});
          const batch = {x:new Float64Array([3000,1000,2000]),
            y:new Float64Array([3,1,2]),series:new Int32Array([0,0,0]),length:3,byteLength:60};
          const input = document.querySelector('[data-el="input"]');
          const submit = text => { input.value=text; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); };
          ui.setDataset(context);submit('speed');
          ui.handleEvent({type:'start',view:view('first')});
          ui.handleEvent({type:'batch',id:'first',batch});
          await new Promise(requestAnimationFrame);
          const firstDraws = calls.draws.length;
          document.querySelector('[data-action="cancel"]').click();
          ui.handleEvent({type:'batch',id:'first',batch});
          ui.handleEvent({type:'complete',id:'first',timing:view('first').timing});
          const canceledPoints = document.querySelector('[data-el="points"]').textContent;
          const canceledState = document.querySelector('[data-el="result-state"]').textContent;
          const commitsBeforeIme = calls.commits.length; input.value='speed';
          input.dispatchEvent(new CompositionEvent('compositionstart'));
          input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}));
          const imeCommits = calls.commits.length - commitsBeforeIme;
          input.dispatchEvent(new CompositionEvent('compositionend'));
          input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
          const imeCommitted = calls.commits.length - commitsBeforeIme;
          ui.handleEvent({type:'error',message:'A new error'});
          const preStartError = document.querySelector('[data-el="history"]').textContent.includes('A new error');
          submit('speed');ui.handleEvent({type:'start',view:view('next')});
          ui.handleEvent({type:'batch',id:'first',batch});
          const stalePoints = document.querySelector('[data-el="points"]').textContent;
          ui.handleEvent({type:'batch',id:'next',batch});
          await new Promise(requestAnimationFrame);
          return {firstDraws,canceledPoints,canceledState,imeCommits,
            commits:calls.commits.length,imeCommitted,preStartError,stalePoints,draws:calls.draws};
        }""")
        assert result["firstDraws"] == 1
        assert result["canceledPoints"] == "3" and "CANCELED" in result["canceledState"]
        assert result["imeCommits"] == 0 and result["imeCommitted"] == 1 and result["commits"] == 3
        assert result["preStartError"] and result["stalePoints"] == "—"
        assert result["draws"] == ["first", "next"]
        browser.close()
        print("PASS: real query, chart/table/CSV/trace, responsive settings, IME, cancellation, stale events")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:5173")
    parser.add_argument("--screenshot", help="Optional path for a desktop screenshot of actual query data")
    args = parser.parse_args()
    run(args.base_url, args.screenshot)
