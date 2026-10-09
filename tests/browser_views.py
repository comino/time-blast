"""Real DuckDB queries and presentation controls for all supported visualizations.

Requires Vite and Python Playwright with Chromium. This is a functional check,
not a latency benchmark. Renderer modules are deliberately not pre-warmed by
the harness: their first imports exercise the production lazy-loading path.
"""
import argparse
import json

from playwright.sync_api import sync_playwright


QUERIES = [
    ('heatmap', 'Show a heatmap of vessel speeds by hour over the last 7 days', 1008),
    ('surface', 'Compare vessel wave height by hour over the last 7 days as a 3D surface', 1008),
    ('tracks', 'Show voyage tracks of vessel speeds by hour over the last 24 hours', 144),
    ('map', 'Show a geographic map of vessel speeds by hour over the last 24 hours', 144),
    ('density', 'Show a density map of vessel speeds by hour over the last 24 hours', 144),
    ('seasons', 'Compare vessel water temperature over the last 14 days as a seasonal wheel', 2016),
    ('scatter', 'Compare vessel speeds by hour as a scatter plot', 144),
    ('table', 'Compare vessel speeds by hour as a data table', 144),
    ('bar', 'Compare vessel speeds by hour as a bar chart', 144),
    ('line', 'Compare vessel speeds by hour as a line chart', 144),
]


def settled(page):
    page.wait_for_function("""() => document.querySelector(
      '.result-card[data-selected="true"] [data-card-el="result-state"]'
    )?.textContent.trim() === 'COMPLETE'""")


def set_range(locator, value):
    locator.evaluate("""(input,value) => {
      input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));
    }""", value)


def quiet_vite(page):
    # Keep simultaneous development edits from navigating an in-flight fixture.
    # CSS module injection still behaves as Vite expects.
    page.route('**/@vite/client', lambda route: route.fulfill(
        status=200, content_type='text/javascript', body='''
          const styles=new Map();
          export const createHotContext=()=>({data:{},accept(){},dispose(){},prune(){},invalidate(){},on(){}});
          export function updateStyle(id,css){let s=styles.get(id);if(!s){s=document.createElement('style');styles.set(id,s);document.head.append(s);}s.textContent=css;}
          export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}
        '''))


def cold_import_lifecycle(browser, base_url, errors):
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.on('pageerror', lambda error: errors.append(str(error)))
    quiet_vite(page)
    held = []
    page.route('**/views-harness', lambda route: route.fulfill(
        status=200, content_type='text/html', body='<div id="root"></div>'))
    page.route('**/matrix-renderer.ts*', lambda route: held.append(route))
    page.goto(base_url.rstrip('/') + '/views-harness')
    with page.expect_request('**/matrix-renderer.ts*'):
        state = page.evaluate("""async () => {
          const {createUI}=await import('/src/ui/index.ts');
          const calls=window.coldCalls={draws:[]};
          const ui=window.coldUI=createUI(document.querySelector('#root'),{
            onDraft(){},onFocus(){},onWarmModel(){},onCommit(){},onConfig(){},onCancel(){},
            onDraw(id){calls.draws.push(id);},
          });
          const context={id:'cold-renderer',label:'Cold renderer fixture',rowCount:3,start:0,end:180000,vessels:['One'],description:'Controlled lazy loading'};
          ui.setDataset(context);
          const input=document.querySelector('[data-el="input"]');input.value='Cold heatmap';
          input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
          const view={id:'cold-matrix',prompt:input.value,revision:1,plan:{metric:'speed',aggregate:'avg',bucketMinutes:1,windowHours:1,splitByVessel:true,vessel:null,view:'heatmap'},
            sql:'SELECT',source:'template',context,timing:{startedAt:performance.now(),committedAt:performance.now(),promoted:false,batches:1,points:3,bytes:60}};
          window.coldFixture={context,view};
          ui.handleEvent({type:'start',view});
          ui.handleEvent({type:'batch',id:view.id,batch:{x:new Float64Array([0,60000,120000]),y:new Float64Array([10,20,30]),series:new Int32Array(3),length:3,byteLength:60}});
          ui.handleEvent({type:'complete',id:view.id,timing:view.timing});
          return {state:document.querySelector('[data-el="result-state"]').textContent.trim(),draws:calls.draws.length,
            loading:!document.querySelector('[data-el="plot-empty"]').hidden};
        }""")
    assert state == {'state': 'DRAWING', 'draws': 0, 'loading': True}, state
    assert len(held) == 1, 'Cold renderer module must load only once'
    held[0].continue_()
    settled(page)
    assert page.evaluate('coldCalls.draws') == ['cold-matrix']
    assert page.locator('[data-el="plot-empty"]').is_hidden()
    assert page.locator('[data-el="mean"]').inner_text() == '20'
    page.locator('[data-tab="table"]').click()
    assert page.locator('[data-el="representation"]').input_value() == 'table'
    page.locator('[data-tab="chart"]').click()
    settled(page)
    assert page.locator('[data-el="representation"]').input_value() == 'heatmap', 'Chart tab must restore the prior advanced view'
    empty = page.evaluate("""() => {
      const input=document.querySelector('[data-el="input"]');input.value='Empty heatmap';
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      const view={...coldFixture.view,id:'empty-heatmap',prompt:input.value,
        timing:{startedAt:performance.now(),committedAt:performance.now(),promoted:false,batches:0,points:0,bytes:0}};
      coldUI.handleEvent({type:'start',view});coldUI.handleEvent({type:'complete',id:view.id,timing:view.timing});
      return {state:document.querySelector('[data-el="result-state"]').textContent.trim(),
        spinning:document.querySelector('.result-card[data-selected="true"]').classList.contains('is-loading'),draws:coldCalls.draws};
    }""")
    assert empty == {'state': 'EMPTY RESULT', 'spinning': False, 'draws': ['cold-matrix']}, empty
    page.evaluate('coldUI.destroy()')
    page.close()


def run(base_url):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1600, 'height': 1050})
        page.set_default_timeout(45_000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        quiet_vite(page)
        page.goto(base_url, wait_until='domcontentloaded')
        page.locator('[data-stage="database"][data-state="ready"]').wait_for(state='attached', timeout=90_000)
        page.get_by_role('button', name='Runtime settings', exact=True).click()
        page.locator('[name="inferenceMode"]').select_option('templates')
        page.locator('[name="speculation"]').uncheck()
        page.locator('[name="liveTranslation"]').uncheck()
        page.get_by_role('button', name='Apply runtime').click()
        page.wait_for_function("""() =>
          document.querySelector('[data-stage="coordinator"]').dataset.state==='ready' &&
          document.querySelector('[data-stage="model"] small').textContent==='Deterministic templates'""")
        page.evaluate("""async () => {
          const url=performance.getEntriesByType('resource').find(entry=>new URL(entry.name).pathname==='/src/ui/chart.ts')?.name;
          const {StreamChart}=await import(url??'/src/ui/chart.ts');
          const seen=window.viewChecks={starts:[],events:[],charts:new Map(),batches:new Map()};
          const begin=StreamChart.prototype.begin,append=StreamChart.prototype.append;
          StreamChart.prototype.begin=function(view){seen.starts.push(view);seen.charts.set(view.id,this);return begin.call(this,view);};
          StreamChart.prototype.append=function(batch){
            const id=seen.starts.find(view=>seen.charts.get(view.id)===this)?.id;
            if(id){let list=seen.batches.get(id);if(!list)seen.batches.set(id,list=[]);list.push(batch);}
            return append.call(this,batch);
          };
          new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)
            if(node.nodeType===1)seen.events.push(node.firstElementChild?.textContent);
          }).observe(document.querySelector('[data-el="trace-list"]'),{childList:true});
        }""")
        assert not page.evaluate(r"""performance.getEntriesByType('resource').some(entry=>
          /\/(matrix|geo|season)-renderer\.ts/.test(new URL(entry.name).pathname))"""), 'Advanced views should not load at startup'

        query_results = []
        for mode, prompt, points in QUERIES:
            count_before = page.evaluate('viewChecks.starts.length')
            draws_before = page.evaluate("viewChecks.events.filter(event=>event==='first_draw_submitted').length")
            page.locator('[data-el="input"]').fill(prompt)
            page.locator('[data-el="input"]').press('Enter')
            page.wait_for_function('count=>viewChecks.starts.length===count+1', arg=count_before)
            settled(page)
            current = page.locator('.result-card[data-selected="true"]')
            assert current.locator('[data-card-el="representation"]').input_value() == mode
            assert int(current.locator('[data-card-el="points"]').inner_text().replace(',', '')) == points
            assert current.locator('[data-card-el="latency"]').inner_text() != '—'
            assert current.locator('[data-card-el="source"]').inner_text() == 'LOCAL TEMPLATE'
            plan = page.evaluate('viewChecks.starts.at(-1).plan')
            assert plan['view'] == mode and plan['splitByVessel'] is True, plan
            page.wait_for_function("count=>viewChecks.events.filter(event=>event==='first_draw_submitted').length===count+1", arg=draws_before)
            assert page.locator('.result-card').count() == min(count_before + 1, 8)
            query_results.append({'view': mode, 'points': points})
            if len(query_results) == 3:
                assert [page.locator('.result-card').nth(i).locator('[data-card-el="representation"]').input_value() for i in range(3)] == ['heatmap', 'surface', 'tracks']
                assert [page.locator('.result-card').nth(i).locator('[data-card-el="points"]').inner_text() for i in range(3)] == ['1,008', '1,008', '144']

        loaded = page.evaluate(r"""performance.getEntriesByType('resource').map(entry=>new URL(entry.name).pathname)
          .filter(path=>/\/(matrix|geo|season)-renderer\.ts/.test(path))""")
        assert {'/src/ui/matrix-renderer.ts', '/src/ui/geo-renderer.ts', '/src/ui/season-renderer.ts'} <= set(loaded)
        current = page.locator('.result-card[data-selected="true"]')
        select = current.locator('[data-card-el="representation"]')
        page.evaluate("""() => {
          const check=viewChecks;check.modeStartCount=check.starts.length;
          check.queryCount=check.events.filter(event=>event==='query_complete').length;
          check.current=check.starts.at(-1);check.originalBatches=check.charts.get(check.current.id).batches.slice();
        }""")
        for mode, _, _ in QUERIES:
            select.select_option(mode)
            settled(page)
            assert current.locator('[data-card-el="points"]').inner_text() == '144'
            assert page.evaluate("""viewChecks.starts.length===viewChecks.modeStartCount &&
              viewChecks.events.filter(event=>event==='query_complete').length===viewChecks.queryCount &&
              viewChecks.charts.get(viewChecks.current.id).batches.length===viewChecks.originalBatches.length &&
              viewChecks.charts.get(viewChecks.current.id).batches.every((batch,i)=>batch===viewChecks.originalBatches[i])"""), 'Switching views must reuse the same batches without inference or a query'

        select.select_option('surface')
        settled(page)
        surface = current.locator('[data-card-el="track"]')
        image_before = surface.evaluate('(canvas)=>canvas.toDataURL()')
        set_range(current.locator('[data-card-el="rotation"]'), 65)
        settled(page)
        assert surface.evaluate('(canvas)=>canvas.toDataURL()') != image_before, 'Surface rotation must change the rendered view'

        select.select_option('tracks')
        settled(page)
        slider = current.locator('[data-card-el="playback"]')
        play = current.locator('[data-card-action="playback"]')
        set_range(slider, 400)
        settled(page)
        assert 'UTC' in current.locator('[data-card-el="playback-time"]').inner_text()
        play.click()
        page.wait_for_function("""document.querySelector('[data-el="playback"]').value>410""")
        assert play.inner_text() == 'Pause'
        play.click()
        assert play.inner_text() == 'Play voyage'
        # Drain the already requested redraw, then prove playback has stopped.
        settled(page)
        paused = slider.input_value()
        page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        assert slider.input_value() == paused
        play.click()
        assert play.inner_text() == 'Pause'
        page.locator('[data-el="board-viewport"]').dispatch_event('wheel', {'deltaX': 100000, 'bubbles': True, 'cancelable': True})
        page.wait_for_function("""document.querySelector('.result-card[data-selected="true"]').classList.contains('is-offscreen')""")
        assert play.inner_text() == 'Play voyage', 'Offscreen playback must stop'
        paused = slider.input_value()
        page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        assert slider.input_value() == paused
        page.locator('[data-action="fit"]').click()
        settled(page)
        assert page.evaluate('viewChecks.starts.length===viewChecks.modeStartCount')

        photos = select.locator('option').filter(has_text='Photos')
        assert photos.is_disabled()
        assert 'no image URLs' in photos.inner_text()
        page.locator('[data-el="input"]').fill('Average speed by hour')
        page.locator('[data-el="input"]').press('Enter')
        page.wait_for_function('viewChecks.starts.length===viewChecks.modeStartCount+1')
        settled(page)
        for mode in ['map', 'density', 'tracks']:
            option = page.locator('[data-el="representation"]').locator(f'option[value="{mode}"]')
            assert option.is_disabled(), f'{mode} must not display fleet-averaged coordinates'
            assert 'grouped by vessel' in option.get_attribute('title')
        cold_import_lifecycle(browser, base_url, errors)
        assert not errors, errors
        print(json.dumps({'chromium': browser.version, 'intentQueries': query_results,
                          'coldRendererFamiliesLoaded': 3, 'switchModesWithoutQuery': 10,
                          'coldImportDefersCompletionAndDraw': True,
                          'emptyAdvancedSettles': True, 'chartTabRestoresAdvancedView': True,
                          'sharedBatchIdentity': True, 'independentCards': True,
                          'surfaceRotation': True, 'voyagePlayPauseAndHide': True,
                          'photosUnavailable': True, 'fleetSpatialViewsDisabled': True,
                          'pageErrors': errors}, indent=2))
        browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:5173')
    run(parser.parse_args().base_url)
