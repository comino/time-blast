"""Requested-window and failed-inference presentation regressions.

The product checks execute real DuckDB queries through deterministic templates.
The UI fixture supplies a failed model response; neither check measures model
accuracy or claims to exercise hardware WebGPU inference.
"""
import argparse
import json

from playwright.sync_api import sync_playwright

from browser_views import quiet_vite


def actual_windows(browser, base_url, errors, screenshot=None):
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.set_default_timeout(60_000)
    page.on('pageerror', lambda error: errors.append(str(error)))
    quiet_vite(page)
    page.goto(base_url, wait_until='domcontentloaded')
    page.locator('[data-stage="database"][data-state="ready"]').wait_for(state='attached')
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
      window.windowChecks={starts:[],charts:new Map()};
      const begin=StreamChart.prototype.begin;
      StreamChart.prototype.begin=function(view){windowChecks.starts.push(view);windowChecks.charts.set(view.id,this);return begin.call(this,view);};
    }""")
    input_field = page.locator('[data-el="input"]')
    results = []
    for days, points in [(710, 2016), (1, 144)]:
        prompt = f'Compare vessel wave height by hour over the last {days}days as a 3D surface'
        # The screenshot contained a space in "710 days"; the follow-up did not.
        if days == 710:
            prompt = prompt.replace('710days', '710 days')
        input_field.fill(prompt)
        # Live mode must recover from these prompts without requiring Enter.
        page.wait_for_function("""points => {
          const card=document.querySelector('.result-card[data-selected="true"]');
          return card?.querySelector('[data-card-el="result-state"]').textContent.trim()==='COMPLETE'
            && card.querySelector('[data-card-el="points"]').textContent.replaceAll(',','')===String(points);
        }""", arg=points)
        current = page.locator('.result-card[data-selected="true"]')
        assert current.locator('[data-card-el="representation"]').input_value() == 'surface'
        assert current.locator('[data-card-el="track"]').evaluate('(canvas)=>canvas.clientHeight') >= 210, \
            'Default desktop cards must leave enough surface height for projection, labels and controls'
        assert current.locator('[data-card-el="source"]').inner_text() == 'LOCAL TEMPLATE'
        assert page.locator('.result-card').count() == 1, 'Live edits must reuse the preview'
        result = page.evaluate("""() => {
          const view=windowChecks.starts.at(-1),batches=windowChecks.charts.get(view.id).batches;
          let min=Infinity,max=-Infinity;const series=new Set();
          for(const batch of batches)for(let i=0;i<batch.length;i++){
            min=Math.min(min,batch.x[i]);max=Math.max(max,batch.x[i]);series.add(batch.series[i]);
          }
          return {hours:view.plan.windowHours,mode:view.plan.view,bucket:view.plan.bucketMinutes,
            start:view.context.start,end:view.context.end,min,max,series:series.size,sql:view.sql};
        }""")
        assert result['hours'] == days * 24, 'The plan must preserve the requested window'
        assert result['mode'] == 'surface' and result['bucket'] == 60 and result['series'] == 6
        assert result['min'] == max(result['start'], result['end'] - days * 86_400_000), result
        assert result['max'] == result['end'] - 3_600_000, result
        coverage = current.locator('[data-card-el="coverage-note"]')
        if days == 710:
            assert coverage.is_visible()
            note = coverage.inner_text().lower()
            assert '710 days' in note and '14 days' in note and 'available' in note, note
            bounds = current.locator('[data-card-el="time-range"]').inner_text()
            assert 'Sep 1' in bounds and 'Sep 15' in bounds, bounds
            if screenshot:
                page.screenshot(path=screenshot, full_page=True)
        else:
            assert coverage.is_hidden(), 'A fully covered day must not retain the previous coverage warning'
        results.append({'prompt': prompt, 'points': points, 'requestedHours': result['hours'],
                        'actualStart': result['min'], 'actualLastBucket': result['max']})
    page.close()
    return results


def failed_inference_ui(browser, base_url, errors):
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.on('pageerror', lambda error: errors.append(str(error)))
    quiet_vite(page)
    page.route('**/failure-harness', lambda route: route.fulfill(
        status=200, content_type='text/html', body='<div id="root"></div>'))
    page.goto(base_url.rstrip('/') + '/failure-harness')
    result = page.evaluate("""async () => {
      const {createUI}=await import('/src/ui/index.ts');
      const assert=(condition,message)=>{if(!condition)throw Error(message);};
      const calls={commits:[],draws:[]};
      const ui=createUI(document.querySelector('#root'),{
        onDraft(){},onCommit(text){calls.commits.push(text);},onFocus(){},onConfig(){},
        onCancel(){},onWarmModel(){},onDraw(id){calls.draws.push(id);},
      });
      const context={id:'failure-test',label:'Failure fixture',rowCount:3,start:0,end:180000,vessels:['One'],description:'Controlled model failure'};
      ui.setDataset(context);ui.setStatus('coordinator',{state:'ready',label:'Ready'});
      const active=()=>document.querySelector('.result-card[data-selected="true"]');
      const part=name=>active().querySelector(`[data-card-el="${name}"]`);
      const field=name=>part(name).textContent.trim();
      const edit=async text=>{
        const input=document.querySelector('[data-el="input"]');input.value=text;
        input.dispatchEvent(new InputEvent('input',{bubbles:true}));
        await new Promise(resolve=>setTimeout(resolve,2050));
        assert(calls.commits.at(-1)===text,'Live edit did not submit');
      };
      const failure={phase:'inference',source:'webgpu',model:'Controlled model',database:'duckdb-wasm',
        inference:{warmupMs:20,queueMs:10,prefillMs:30,decodeMs:300,promptTokens:88,completionTokens:1},
        timing:{startedAt:10,committedAt:10,inferenceStartedAt:15,failedAt:365,promoted:false,batches:0,points:0,bytes:0}};
      await edit('Compare vessel wave height by hour over the last 1days as a 3D surface');
      const preview=active();
      ui.handleEvent({type:'error',message:'Controlled model rejected the request',failure});
      assert(field('result-state')==='QUERY ERROR','Failed inference must stop the card');
      assert(field('inference-label')==='INFERENCE'&&field('inference-latency')==='350.0 ms',
        'A pre-start model failure must retain the measured inference interval');
      assert(field('source')==='LOCAL MODEL','Failed inference must show the actual source');
      assert(field('inference-detail').includes('88 tokens')&&field('inference-detail').includes('300.0 ms'),
        'Failed model generation telemetry must remain inspectable');
      for(const name of ['database-first-latency','database-latency','render-latency','latency'])
        assert(field(name)==='—',`A pre-query failure cannot fabricate ${name}`);
      assert(/inference/i.test(field('plot-subtitle')),'Error subtitle must identify the failed phase');
      assert(!/preparing|waiting/i.test(field('plot-subtitle')+' '+field('batch-count')),
        'Terminal error cannot claim that preparation or data delivery is pending');
      assert(!active().classList.contains('is-loading'),'Terminal error must stop the loading animation');
      assert([...active().querySelectorAll('.loading-orb,.loading-orb i')].every(node=>getComputedStyle(node).animationName==='none'),
        'Terminal error must leave no animated loading orb');
      const terminalText=active().textContent;
      ui.handleEvent({type:'error',id:'superseded',message:'Stale model failure',failure});
      assert(active().textContent===terminalText,'Stale attributed failures must not overwrite the failed card');

      await edit('Compare vessel speed by hour over the last 24 hours');
      assert(active()===preview,'Retry must reuse the live preview shell');
      assert(field('inference-latency')==='—'&&field('source')==='—'&&field('inference-detail')==='',
        'A fresh request must clear failure timing, source and diagnostic metadata');
      assert(active().classList.contains('is-loading'),'A fresh request must resume loading');
      const view={id:'retry',prompt:calls.commits.at(-1),revision:2,sql:'SELECT',source:'template',database:'duckdb-wasm',context,
        plan:{metric:'speed',aggregate:'avg',bucketMinutes:1,windowHours:1,splitByVessel:true,vessel:null,view:'line'},
        timing:{startedAt:400,committedAt:400,inferenceStartedAt:400,intentAt:405,compiledAt:406,
          queryStartedAt:406,firstBatchAt:410,firstPublishedAt:410,firstDrawAt:415,completedAt:420,
          promoted:false,batches:1,points:3,bytes:60}};
      ui.handleEvent({type:'start',view});
      ui.handleEvent({type:'error',id:'superseded',message:'Late inference failure',failure});
      assert(field('result-state')==='QUERYING','A stale failure must not stop a newer query');
      ui.handleEvent({type:'batch',id:view.id,batch:{x:new Float64Array([0,60000,120000]),y:new Float64Array([1,2,3]),series:new Int32Array(3),length:3,byteLength:60}});
      ui.handleEvent({type:'complete',id:view.id,timing:view.timing});
      for(let i=0;i<20&&field('result-state')!=='COMPLETE';i++)await new Promise(requestAnimationFrame);
      assert(field('result-state')==='COMPLETE'&&field('points')==='3','Retry must produce a usable chart');
      assert(field('inference-latency')==='5.0 ms'&&field('source')==='LOCAL TEMPLATE',
        'Successful retry must use its own timing and source');
      assert(part('inference-detail').hidden,'Successful template result must hide stale model diagnostics');
      const successfulText=active().textContent;
      ui.handleEvent({type:'error',id:view.id,message:'Late failure after completion',failure});
      assert(active().textContent===successfulText,'Completed results must ignore late failures');

      await edit('Compare vessel water temperature by hour over the last 24 hours');
      const compileTiming={startedAt:500,committedAt:500,inferenceStartedAt:505,intentAt:555,
        failedAt:575,promoted:false,batches:0,points:0,bytes:0};
      ui.handleEvent({type:'error',message:'Controlled compilation failure',failure:{phase:'compile',source:'webgpu',
        model:'Controlled model',database:'duckdb-wasm',inference:{cacheHit:true},timing:compileTiming}});
      assert(field('plot-subtitle')==='SQL compilation failed','Compilation failure must name its phase');
      assert(field('inference-latency')==='50.0 ms','Compilation failure must preserve completed inference timing');
      assert(field('inference-label')==='PLAN CACHE'&&field('source')==='CACHED MODEL PLAN',
        'Compilation failure must preserve the cached plan source without claiming model generation');
      assert(!/database.*execut/i.test(field('inference-detail')),
        'A failed cached plan must not claim that its database query executed');
      assert(field('latency-detail').includes('Database did not start.'),'Compilation failure must explain that no database ran');
      for(const name of ['database-first-latency','database-latency','render-latency','latency'])
        assert(field(name)==='—',`Compilation failure cannot fabricate ${name}`);
      assert(compileTiming.completedAt===undefined&&compileTiming.firstDrawAt===undefined,
        'Displaying failure cannot mutate timing into a completed/drawn result');

      await edit('Compare vessel wind speed by hour over the last 24 hours');
      const queryTiming={startedAt:800,committedAt:800,inferenceStartedAt:805,intentAt:855,
        compiledAt:860,queryStartedAt:900,promoted:false,batches:0,points:0,bytes:0};
      const querying={...view,id:'failed-query',prompt:calls.commits.at(-1),timing:queryTiming};
      ui.handleEvent({type:'start',view:querying});
      const failedQueryTiming={...queryTiming,failedAt:1000};
      ui.handleEvent({type:'error',id:querying.id,message:'Controlled DuckDB execution failure',failure:{
        phase:'query',source:'template',database:'duckdb-wasm',timing:failedQueryTiming}});
      assert(field('plot-subtitle')==='Query failed','Database failure must name its phase');
      assert(field('database-label')==='DUCKDB → ERROR'&&field('database-latency')==='100.0 ms',
        'Failed database elapsed time must be presented as time to error');
      for(const name of ['database-first-latency','render-latency','latency'])
        assert(field(name)==='—',`A query that failed before data cannot fabricate ${name}`);
      assert(failedQueryTiming.completedAt===undefined&&failedQueryTiming.firstDrawAt===undefined,
        'Database failure must not imply stream completion or drawing');
      assert(!active().classList.contains('is-loading'),'Database failure must stop loading');
      ui.destroy();
      return {preStartInferenceTiming:true,noInventedDatabaseTiming:true,modelDiagnosticsPreserved:true,
        terminalLoadingStopped:true,failedPhaseVisible:true,retryClearsFailure:true,staleAttributedErrorsIgnored:true,
        compileFailurePreservesInference:true,failedDatabaseLabelsTimeToError:true};
    }""")
    page.close()
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:5173')
    parser.add_argument('--ui-only', action='store_true')
    parser.add_argument('--screenshot', help='Optional screenshot of the requested 710-day surface and coverage note')
    args = parser.parse_args()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
        errors = []
        results = {} if args.ui_only else {'actualDuckDBWindows': actual_windows(browser, args.base_url, errors, args.screenshot)}
        results['controlledFailedInference'] = failed_inference_ui(browser, args.base_url, errors)
        assert not errors, errors
        print(json.dumps({'chromium': browser.version, **results, 'pageErrors': errors}, indent=2))
        browser.close()
