"""Default live charts, pinning, cancellation and visible stage timing regression.

Uses actual DuckDB for the product flow and a controlled UI fixture for startup,
IME, stale-event and exact timing boundaries. This is not a latency benchmark.
"""
import argparse
import json
from playwright.sync_api import sync_playwright


def quiet_vite(page):
    page.route('**/@vite/client', lambda route: route.fulfill(
        status=200, content_type='text/javascript', body='''
          const styles=new Map();
          export const createHotContext=()=>({data:{},accept(){},dispose(){},prune(){},invalidate(){},on(){}});
          export function updateStyle(id,css){let s=styles.get(id);if(!s){s=document.createElement('style');styles.set(id,s);document.head.append(s);}s.textContent=css;}
          export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}
        '''))


def settle(page, points):
    page.wait_for_function('''points => {
      const card=document.querySelector('.result-card[data-selected="true"]');
      return card?.querySelector('[data-card-el="result-state"]').textContent.trim()==='COMPLETE'
        && card.querySelector('[data-card-el="points"]').textContent.replaceAll(',','')===String(points);
    }''', arg=points)


def actual_duckdb(browser, url, errors, screenshot=None):
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.set_default_timeout(60_000)
    page.on('pageerror', lambda error: errors.append(str(error)))
    quiet_vite(page)
    page.goto(url, wait_until='domcontentloaded')
    page.locator('[data-stage="database"][data-state="ready"]').wait_for(state='attached')
    page.locator('[data-stage="coordinator"][data-state="ready"]').wait_for(state='attached')
    page.evaluate('''() => {
      window.liveEvents=[];
      new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)
        if(node.nodeType===1)liveEvents.push(node.firstElementChild?.textContent);
      }).observe(document.querySelector('[data-el="trace-list"]'),{childList:true});
    }''')
    input_field = page.locator('[data-el="input"]')
    cards = page.locator('.result-card')
    assert page.locator('[data-action="live-query"]').get_attribute('aria-checked') == 'true'
    assert cards.count() == 0
    input_field.fill('Compare vessel speeds by hour over the last 24 hours')
    settle(page, 144)
    assert cards.count() == 1
    assert cards.first.get_attribute('data-live-preview') == 'true'
    assert page.locator('[data-history-card]').count() == 0
    first_card = cards.first.get_attribute('data-card-id')
    page.evaluate('''() => {
      window.firstPreviewNode=document.querySelector('.result-card');
      window.firstPreviewCanvas=firstPreviewNode.querySelector('[data-card-el="chart"]');
    }''')
    assert cards.first.locator('[data-card-el="inference-label"]').inner_text() == 'TEMPLATE'
    assert cards.first.locator('[data-card-el="database-first-label"]').inner_text() == 'DUCKDB → FIRST'
    assert cards.first.locator('[data-card-el="database-label"]').inner_text() == 'DUCKDB TOTAL'
    for field in ['inference-latency', 'database-first-latency', 'database-latency', 'render-latency', 'latency']:
        value = cards.first.locator(f'[data-card-el="{field}"]').inner_text()
        assert value != '—' and ('ms' in value or value.endswith(' s')), (field, value)
    if screenshot:
        page.screenshot(path=screenshot, full_page=True)
    timings = {field: cards.first.locator(f'[data-card-el="{field}"]').inner_text()
               for field in ['inference-latency', 'database-first-latency', 'database-latency', 'render-latency']}
    input_field.fill('Compare vessel wind by hour over the last 24 hours')
    settle(page, 144)
    assert cards.count() == 1 and cards.first.get_attribute('data-card-id') == first_card
    assert page.evaluate('''() => document.querySelector('.result-card')===firstPreviewNode &&
      firstPreviewNode.querySelector('[data-card-el="chart"]')===firstPreviewCanvas'''), 'Live edits must reuse the card shell and canvas'
    assert 'Wind' in cards.first.locator('[data-card-el="plot-title"]').inner_text()
    assert page.locator('[data-history-card]').count() == 0
    completed = page.evaluate("liveEvents.filter(event=>event==='query_complete').length")
    query_meta = cards.first.locator('[data-card-el="query-meta"]').inner_text()
    input_field.press('Enter')
    page.evaluate('new Promise(requestAnimationFrame)')
    assert cards.count() == 1 and cards.first.get_attribute('data-live-preview') != 'true'
    assert page.locator('[data-history-card]').count() == 1
    assert cards.first.locator('[data-card-el="query-meta"]').inner_text() == query_meta
    assert page.evaluate("liveEvents.filter(event=>event==='query_complete').length") == completed
    pinned_title = cards.first.locator('[data-card-el="plot-title"]').inner_text()
    input_field.fill('Show a heatmap of vessel wave height by hour over the last 7 days')
    settle(page, 1008)
    assert cards.count() == 2
    assert cards.first.locator('[data-card-el="plot-title"]').inner_text() == pinned_title
    assert cards.first.locator('[data-card-el="points"]').inner_text() == '144'
    assert cards.last.locator('[data-card-el="representation"]').input_value() == 'heatmap'
    input_field.fill('Average wind')
    page.wait_for_function("document.querySelectorAll('.result-card').length===1")
    assert cards.first.get_attribute('data-card-id') == first_card

    # The same product can still prepare results privately and require Enter.
    page.locator('[data-action="live-query"]').click()
    page.locator('[data-stage="coordinator"][data-state="ready"]').wait_for(state='attached')
    assert page.locator('[data-action="live-query"]').get_attribute('aria-checked') == 'false'
    input_field.fill('Compare vessel wave height by minute over the last 24 hours')
    page.wait_for_function("document.querySelector('[data-el=\"draft-state\"]').textContent.includes('8,640 points staged')")
    assert cards.count() == 1
    input_field.press('Enter')
    settle(page, 8640)
    assert cards.count() == 2
    assert not page.locator('.result-card[data-live-preview="true"]').count()
    assert 'Prepared result promoted' in page.locator('[data-el="latency-detail"]').inner_text()
    page.close()
    return {'default_live_duckdb': True, 'preview_replaces_in_place': True,
            'enter_pins_without_query': True, 'pinned_result_preserved': True,
            'short_draft_removes_preview': True, 'manual_preparation_mode': True,
            'observed_stage_timings_not_benchmark': timings}


def controlled_ui(browser, url, errors):
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.on('pageerror', lambda error: errors.append(str(error)))
    quiet_vite(page)
    page.route('**/live-query-harness', lambda route: route.fulfill(
        status=200, content_type='text/html', body='<div id="root"></div>'))
    page.goto(url.rstrip('/') + '/live-query-harness')
    result = page.evaluate('''async () => {
      const {createUI}=await import('/src/ui/index.ts');
      const {DEFAULT_CONFIG}=await import('/src/core/types.ts');
      const assert=(value,message)=>{if(!value)throw Error(message);};
      const tick=()=>new Promise(resolve=>queueMicrotask(resolve));
      const calls={commits:[],drafts:[],cancels:0,draws:[]};
      const ui=createUI(document.querySelector('#root'),{
        onDraft(text,composing){calls.drafts.push({text,composing});},onCommit(text){calls.commits.push(text);},
        onFocus(){},onConfig(){},onCancel(){calls.cancels++;},onWarmModel(){},onDraw(id){calls.draws.push(id);}
      });
      const input=document.querySelector('[data-el="input"]');
      const cards=()=>[...document.querySelectorAll('.result-card')];
      const active=()=>document.querySelector('.result-card[data-selected="true"]');
      const field=name=>active()?.querySelector(`[data-card-el="${name}"]`)?.textContent;
      const edit=text=>{input.value=text;input.dispatchEvent(new InputEvent('input',{bubbles:true}));};
      const enter=()=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      const context={id:'live-test',label:'Live test',rowCount:3,start:0,end:180000,vessels:['One'],description:'Controlled live fixture'};
      const view=(id,prompt)=>({id,prompt,revision:1,source:'template',database:'duckdb-wasm',context,sql:'SELECT',
        plan:{metric:'speed',aggregate:'avg',bucketMinutes:1,windowHours:1,splitByVessel:true,vessel:null,view:'line'},
        timing:{startedAt:10,inferenceStartedAt:12,intentAt:23,compiledAt:25,queryStartedAt:30,firstBatchAt:61,
          firstPublishedAt:80,firstDrawAt:87,completedAt:101,committedAt:75,promoted:true,batches:1,points:3,bytes:60}});
      const batch={x:new Float64Array([0,60000,120000]),y:new Float64Array([1,2,3]),series:new Int32Array(3),length:3,byteLength:60};
      const start=request=>ui.handleEvent({type:'start',view:request});
      const append=request=>ui.handleEvent({type:'batch',id:request.id,batch});
      const complete=request=>ui.handleEvent({type:'complete',id:request.id,timing:request.timing});
      const ready=()=>ui.setStatus('coordinator',{state:'ready',label:'Ready'});
      const waitDraw=async()=>{for(let i=0;i<12&&field('result-state')?.trim()!=='COMPLETE';i++)await new Promise(requestAnimationFrame);};
      ui.setDataset(context);
      const first='Average speed by hour';
      edit(first);await tick();
      assert(calls.commits.length===0&&cards().length===0,'Typing before runtime readiness must wait');
      ready();await tick();
      assert(calls.commits.join('|')===first&&cards().length===1,'Ready runtime must run an existing eligible draft without Enter');
      const beforeDuplicateDraft=calls.drafts.length;edit(first);await tick();
      assert(calls.drafts.length===beforeDuplicateDraft&&calls.commits.length===1,'Unchanged native input must not repeat draft transport or query');
      const old=view('old',first);start(old);append(old);
      const previewNode=active(),previewCanvas=active().querySelector('[data-card-el="chart"]');
      const replacement='Average wind speed by hour';
      edit(replacement);await tick();
      assert(calls.commits.at(-1)===replacement&&cards().length===1,'Each edit must replace one preview');
      assert(active()===previewNode&&active().querySelector('[data-card-el="chart"]')===previewCanvas,'Live edits must reuse card and canvas DOM');
      assert(field('points')==='—'&&field('mean')==='—','New revision must immediately clear old summary values');
      const current=view('current',replacement);start(current);
      append(old);complete(old);
      assert(field('points')==='—','A superseded result must not populate a newer preview');
      append(current);complete(current);await waitDraw();
      assert(field('result-state').trim()==='COMPLETE','Current preview must complete');
      assert(field('inference-latency')==='11.0 ms','Inference must exclude compilation and database');
      assert(field('database-first-latency')==='31.0 ms','Database first batch must start at query dispatch');
      assert(field('database-latency')==='71.0 ms','Database total must include the full query interval');
      assert(field('render-latency')==='7.0 ms','Draw delay must start at delivery, not speculative production');
      assert(field('latency')==='12.0 ms','Run to draw must remain independent of prepared work');
      assert(field('latency-detail').includes('SQL compile: 2.0 ms'),'Compile duration must be separately explained');
      const completedCommits=calls.commits.length,completedDrafts=calls.drafts.length;edit(replacement);await tick();
      assert(calls.commits.length===completedCommits&&calls.drafts.length===completedDrafts,'Duplicate input after completion must not transport or execute again');
      const beforeRuntime=calls.commits.length;
      ui.setConfig({...DEFAULT_CONFIG,inferenceMode:'templates'});await tick();
      assert(calls.commits.length===beforeRuntime,'Runtime change must wait for the replacement runtime');
      ready();await tick();
      assert(calls.commits.length===beforeRuntime+1&&calls.commits.at(-1)===replacement,'Runtime readiness must rerun a completed preview with unchanged text');
      const changed=view('runtime-changed',replacement);start(changed);append(changed);complete(changed);await waitDraw();
      const beforePin=calls.commits.length, pinned=active();enter();await tick();
      assert(calls.commits.length===beforePin&&cards().length===1,'Enter must pin a completed preview without requerying');
      assert(pinned.dataset.livePreview!=='true'&&document.querySelectorAll('[data-history-card]').length===1,'Only pinned views belong in history');

      // Composition must never start a partial-language query or pin Enter.
      input.dispatchEvent(new CompositionEvent('compositionstart'));
      edit('Compare every vessel speed by minute');await tick();
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));await tick();
      assert(calls.commits.length===beforePin&&cards().length===1,'IME composition must suppress live and manual query');
      input.dispatchEvent(new CompositionEvent('compositionend'));await tick();
      assert(calls.commits.length===beforePin+1&&cards().length===2,'Composition end must run the final draft');
      const afterCompositionDrafts=calls.drafts.length;edit(input.value);await tick();
      assert(calls.drafts.length===afterCompositionDrafts&&calls.commits.length===beforePin+1,'Duplicate final IME input must not repeat inference');
      const gpu=view('gpu',calls.commits.at(-1));gpu.source='webgpu';start(gpu);
      assert(field('inference-label')==='INFERENCE','Actual model work must use the inference label');
      const beforeStop=calls.commits.length;
      document.querySelector('[data-action="cancel-active"]').click();await tick();ready();await tick();
      assert(calls.commits.length===beforeStop,'Stop must stay stopped across readiness notifications');
      const stopped=view('stopped',calls.commits.at(-1));start(stopped);append(stopped);complete(stopped);
      assert(field('result-state').includes('CANCELED'),'Late stopped events must not restart the preview');
      edit('Average wave height by hour');await tick();
      assert(calls.commits.length===beforeStop+1,'An actual edit resumes live query after Stop');
      edit('short');await tick();
      assert(cards().length===1&&pinned.isConnected,'Short drafts must remove only the unsaved preview');
      const beforeBurst=calls.commits.length;
      edit('Average speed by hour');edit('Average wind speed by hour');edit('Average water temperature by hour');await tick();
      assert(calls.commits.length===beforeBurst+1&&calls.commits.at(-1)==='Average water temperature by hour','Synchronous edits must coalesce to the latest draft');
      const beforeManual=calls.commits.length;
      ui.setConfig({...DEFAULT_CONFIG,liveQuery:false});
      edit('Average fleet speed by minute');await tick();ready();await tick();
      assert(calls.commits.length===beforeManual,'Disabled live query must never auto-submit');
      enter();await tick();assert(calls.commits.length===beforeManual+1,'Manual Enter must still submit');
      assert(pinned.isConnected,'Runtime and manual transitions must preserve pinned charts');
      ui.destroy();
      return {startupDraftReplayed:true,completedPreviewRequeriesAfterRuntimeChange:true,previewDOMReused:true,staleEventsIgnored:true,stageBoundariesExact:true,imeSuppressed:true,
        stopPersistsUntilEdit:true,burstCoalesced:true,manualModeWorks:true,pinnedDataPreserved:true};
    }''')
    page.close()
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:5173')
    parser.add_argument('--ui-only', action='store_true')
    parser.add_argument('--screenshot', help='Optional screenshot of the first real live chart')
    args = parser.parse_args()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
        errors = []
        result = {} if args.ui_only else actual_duckdb(browser, args.base_url, errors, args.screenshot)
        result['controlled_ui'] = controlled_ui(browser, args.base_url, errors)
        assert not errors, errors
        print(json.dumps({'chromium': browser.version, **result, 'page_errors': errors}, indent=2))
        browser.close()
