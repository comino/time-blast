#!/usr/bin/env python3
"""Captured model JSON through the real decoder, Rust, DuckDB, and canvas.

Semantic-v5 encoding (default) replays three Qwen3-4B GGUF Q4_K_M completions.
Full encoding retains three earlier Qwen3-4B captures, including the known
week/minute heatmap mismatch against the corpus reference line. Semantic
encoding retains two earlier Qwen2.5-1.5B experimental captures. All were
generated with llama.cpp b11538, not browser WebGPU. This exercises execution
of recorded output, not live model inference or general accuracy.

No renderer is prewarmed. Cold advanced rendering may draw after more than the
first batch. A separate held-import lifecycle check verifies that no drawing is
reported before renderer code is available. Line replay still requires its
first point to draw from the first batch before streaming completes.
"""
import argparse
import hashlib
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_views import cold_import_lifecycle, quiet_vite

ROOT = Path(__file__).resolve().parents[1]
REPORTS = {
    'semantic-v5': {
        'path': 'evals/results/2026-10-09-qwen3-4-semantic-v5-regression.json',
        'report_sha256': '839a253765ab08f11c1b1d7baf601d8331fb2449a69bcf37a7ba0c3fdb150279',
        'artifact_sha256': 'd4e0e3a17cb92c813ed89a6dbd1f876391123897c8657c1a6f3c7316243502c0',
        'model': 'Qwen3-4B Q4_K_M recorded native v5 completion (test replay)',
        'raw_sha256': {
            'user_week_minute_waves': 'f7774dbbadd76d319dab3f21f2418d9af6f41a8e6cc771c55837145c73172271',
            'user_adjacent_day_surface': '2adb24a0c846732754879f35c068cde57ad8b4874c55c7aabaa9728edbcb7374',
            'user_wide_surface': '51f856b5961f0aaf68d01afbfb1f99cdf501900cda2ba6edd4964f17bb3638b0',
        },
    },
    'full': {
        'path': 'evals/results/2026-10-09-qwen3-4-full-regression.json',
        'artifact_sha256': 'f31f5a6163f8ae4d83c19ebaa30f30430b1282f5fc733fe12a31bea91e84ceb6',
        'model': 'Qwen3-4B Q4_K_M recorded native completion (test replay)',
        'raw_sha256': {
            'user_week_minute_waves': '804a6feec258a1493f4e111ffd35327598673902250fdd5c40b2b6048abd1444',
            'user_adjacent_day_surface': '7b8c80cc7e3c39ae3f6bb41c3c4bdd7edf104b5ccf0f2d08ab3a2c5fbb5fe760',
            'user_wide_surface': 'c69568fa7ccfb173b830751c6b64b094c4d6e4f62d9ddebec40ee2f1f17ffd54',
        },
    },
    'semantic': {
        'path': 'evals/results/2026-10-09-qwen1.5-semantic-v4-regression.json',
        'artifact_sha256': 'cf85b74b376708f772ae4ec59fd6ed709cc4eddc8796eb1862a53ade3e518dd2',
        'model': 'Qwen2.5-1.5B Q4_K_M recorded native completion (test replay)',
        'raw_sha256': {
            'user_week_minute_waves': '0c3839dd1450a3ec2ee3231bec00ca865688cd735524670d181c0310a7be8c8a',
            'user_adjacent_day_surface': 'aceb26738346aa4d1990dbc9a7886b917314b06ab5a1393c2562641a12eb2199',
        },
    },
}


def read_captures(encoding):
    source = REPORTS[encoding]
    report_bytes = (ROOT / source['path']).read_bytes()
    report = json.loads(report_bytes)
    report_sha = hashlib.sha256(report_bytes).hexdigest()
    if 'report_sha256' in source:
        assert report_sha == source['report_sha256'], 'Captured report provenance changed'
    assert report['status'] == 'complete', 'Replay requires a completed report'
    assert report['artifact_sha256'] == source['artifact_sha256'], 'Unexpected generation artifact'
    by_id = {case['id']: case for case in report['results']}
    captures = []
    for case_id, raw_sha in source['raw_sha256'].items():
        case = by_id[case_id]
        attempt = case['attempts'][-1]
        text = attempt['output']['text']
        assert not attempt['output']['truncated'] and attempt['finish_reason'] == 'stop'
        assert hashlib.sha256(text.encode()).hexdigest() == raw_sha, 'Captured completion bytes changed'
        week = case_id == 'user_week_minute_waves'
        wide = case_id == 'user_wide_surface'
        expected = {'metric': 'wave_height', 'aggregate': 'avg', 'bucketMinutes': 1 if week else 60,
                    'windowHours': 168 if week else 17040 if wide else 24,
                    'splitByVessel': True, 'vessel': None,
                    'view': ('heatmap' if encoding == 'full' else 'line') if week else 'surface'}
        assert case['actual'] == expected, 'Unexpected captured interpretation'
        mismatches = {field: {'reference': value, 'captured': expected[field]}
                      for field, value in case['expected'].items() if expected[field] != value}
        known = {'view': {'reference': 'line', 'captured': 'heatmap'}} if encoding == 'full' and week else {}
        assert mismatches == known, 'Unexpected semantic mismatch in selected replay capture'
        captures.append({'id': case_id, 'question': case['question'], 'text': text,
                         'rawSHA256': raw_sha, 'points': 60480 if week else 2016 if wide else 144,
                         'expected': expected, 'referencePlan': case['expected'], 'knownModelMismatch': mismatches,
                         'windowLabel': '7 days' if week else '710 days' if wide else '24 hours'})
    provenance = {'report': source['path'], 'reportSHA256': report_sha,
                  'artifactSHA256': report['artifact_sha256'], 'corpusSHA256': report['corpus_sha256'],
                  'evaluatorSHA256': report['evaluator_sha256'], 'runtime': report['runtime'],
                  'modelArtifact': report.get('model_artifact'), 'runtimeArtifact': report.get('runtime_artifact'),
                  'serverConfiguration': report.get('server_configuration'), 'settings': report['settings'],
                  'sourceGenerationEncoding': report['artifact']['encoding']}
    return captures, provenance

SMOKE = r"""async ({fixtures,encoding,model,firstBucket}) => {
  const parsePlan = encoding==='full'
    ? (await import('/src/inference/plan.ts')).parseModelPlan
    : encoding==='semantic-v5'
      ? (await import('/src/inference/semantic-plan.ts')).parseSemanticModelPlanV5
      : (await import('/src/inference/semantic-plan.ts')).parseSemanticModelPlan;
  const {WasmQueryCompiler} = await import('/src/core/compiler.ts');
  const {DuckDBAdapter} = await import('/src/adapters/duckdb.ts');
  const {BrowserCoordinator} = await import('/src/core/coordinator.ts');
  const {ResultCard} = await import('/src/ui/result-card.ts');
  await import('/src/ui/styles.css');
  const registryURL=performance.getEntriesByType('resource').map(e=>e.name)
    .filter(url=>new URL(url).pathname==='/src/ui/renderer-registry.ts').at(-1);
  const {rendererFactory}=await import(registryURL||'/src/ui/renderer-registry.ts');
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const frame = () => new Promise(requestAnimationFrame);
  const settled = async card => {
    for (let i = 0; i < 600 && card.busy; i++) await frame();
    assert(!card.busy, 'Card did not settle');
  };
  const markers = new WeakMap(), segments = new WeakMap(), pathLengths = new WeakMap();
  const proto = CanvasRenderingContext2D.prototype;
  const original = Object.fromEntries(['arc','clearRect','beginPath','lineTo','stroke'].map(k => [k,proto[k]]));
  proto.arc = function(...args) {
    if (this.canvas.getAttribute('aria-hidden') === 'true') {
      assert(args.every(Number.isFinite), 'Marker coordinates must be finite');
      const list = markers.get(this) ?? []; list.push(this.fillStyle); markers.set(this,list);
    }
    return original.arc.apply(this,args);
  };
  proto.clearRect = function(...args) { markers.set(this,[]); return original.clearRect.apply(this,args); };
  proto.beginPath = function(...args) { pathLengths.set(this,0); return original.beginPath.apply(this,args); };
  proto.lineTo = function(...args) { pathLengths.set(this,(pathLengths.get(this)??0)+1); return original.lineTo.apply(this,args); };
  proto.stroke = function(...args) {
    const counts = segments.get(this)??new Map();
    counts.set(this.strokeStyle,(counts.get(this.strokeStyle)??0)+(pathLengths.get(this)??0));
    segments.set(this,counts); return original.stroke.apply(this,args);
  };
  const database = new DuckDBAdapter('large'), compiler = new WasmQueryCompiler();
  let coordinator, card, resolveTerminal, terminal, executions = 0, compilations = 0;
  let raw = '', ordinal = 0, produced = [], draws = [];
  const results = [], rejected = [];
  try {
    const context = await database.prepare();
    await compiler.prepare();
    assert(context.rowCount === 1209600, 'Expected dense synthetic source data');
    assert(compiler.kind === 'rust-wasm', 'Expected the real Rust/Wasm compiler');
    const inference = {
      id: 'recorded-native-completion', placement: 'browser', prepare: async()=>{}, observeDraft(){}, dispose(){},
      async resolve() {
        return {plan:parsePlan(raw,context),source:'webgpu',model};
      },
    };
    const measuredDatabase = {
      id:database.id, placement:database.placement, supportsFirstBucket:database.supportsFirstBucket,
      prepare:()=>database.prepare(), dispose:()=>database.dispose(),
      async *execute(request) { executions++; for await(const batch of database.execute(request)){ produced.push(batch); yield batch; } },
    };
    const measuredCompiler = {
      kind:compiler.kind, prepare:()=>compiler.prepare(),
      compile(plan,context) { compilations++; return compiler.compile(plan,context); },
      compileFirstBucket:(plan,context)=>compiler.compileFirstBucket(plan,context),
    };
    coordinator = new BrowserCoordinator({database:measuredDatabase,inference,compiler:measuredCompiler,context,speculation:false,firstBucket,
      emit(event) {
        if(event.type==='start') card.begin(event.view);
        else if(event.type==='batch') card.append(event.batch);
        else if(event.type==='complete') {card.finish(event.timing);resolveTerminal(event);}
        else if(event.type==='error') {card.error(event.message,event.failure);resolveTerminal(event);}
      },
    });
    const run = async fixture => {
      card?.destroy(); raw=fixture.text; produced=[];draws=[];
      card = new ResultCard('replay-'+(++ordinal),fixture.question,document.querySelector('#root'),{
        select(){},close(){},duplicate(){},cancel(){},change(){},
        draw(id,at) {draws.push({id,at,received:card.total});coordinator.markDraw(id,at);},
      });
      card.width=1000;card.height=740;card.layout();card.select(true);
      await frame();await frame();
      terminal=new Promise(resolve=>{resolveTerminal=resolve;});
      coordinator.commit({revision:ordinal,text:fixture.question,contextId:context.id,sentAt:performance.now()});
      const event=await terminal;await settled(card);
      return event;
    };
    const colors=['#ff906c','#74d4c3','#d4c17e','#83b9e3','#e39eaf','#b0c985'];
    for(const fixture of fixtures) {
      const rendererReadyBeforeQuery=['line','bar','scatter','table'].includes(fixture.expected.view)||!!rendererFactory(fixture.expected.view);
      if(encoding==='full'&&fixture===fixtures[0])assert(!rendererReadyBeforeQuery,'The first captured heatmap must exercise cold renderer loading');
      const event=await run(fixture);
      assert(event.type==='complete', 'Captured model response failed: '+event.message);
      assert(JSON.stringify(card.view.plan)===JSON.stringify(fixture.expected), 'Decoded meaning changed for '+fixture.id);
      assert(card.mode===fixture.expected.view, 'Requested visualization was lost');
      assert(card.element.querySelector('[data-card-el="plot-title"]').textContent==='Wave height · by vessel',
        'The visible title must identify the actual vessel grouping');
      assert(card.element.querySelector('[data-card-el="plot-subtitle"]').textContent.includes(
        'last '+fixture.windowLabel), 'The visible subtitle lost the requested window');
      assert(card.total===fixture.points, 'Wrong result point count: '+card.total);
      assert(card.batches.length===produced.length && card.batches.every((batch,i)=>batch===produced[i]
        &&batch.x.buffer===produced[i].x.buffer&&batch.y.buffer===produced[i].y.buffer&&batch.series.buffer===produced[i].series.buffer),
        'Numeric producer buffers were copied between DuckDB and the chart');
      const perSeries=new Map();let min=Infinity,max=-Infinity;
      for(const batch of card.batches) for(let i=0;i<batch.length;i++) {
        assert(Number.isFinite(batch.y[i]),'Nonfinite queried metric');
        min=Math.min(min,batch.x[i]);max=Math.max(max,batch.x[i]);
        perSeries.set(batch.series[i],(perSeries.get(batch.series[i])??0)+1);
      }
      const expectedStart=Math.max(context.start,context.end-fixture.expected.windowHours*3600000);
      assert(min===expectedStart&&max===context.end-fixture.expected.bucketMinutes*60000,'Requested time bounds changed');
      const clipped=fixture.expected.windowHours*3600000>context.end-context.start;
      const coverage=card.element.querySelector('[data-card-el="coverage-note"]');
      assert(coverage.hidden===!clipped, 'Coverage notice disagrees with available data');
      if(clipped)assert(coverage.textContent.includes('Requested '+fixture.windowLabel)&&coverage.textContent.includes('14 days'), 'Coverage notice lost requested/available windows');
      assert(perSeries.size===6&&[0,1,2,3,4,5].every(id=>perSeries.get(id)===fixture.points/6),'Missing vessel points');
      assert(draws.length===1&&card.view.timing.firstDrawAt!==undefined,'First drawing submission was not recorded');
      if(firstBucket) {
        assert(card.view.execution==='first-complete-bucket','Local execution strategy was lost');
        assert(produced[0].length===6,'First complete timestamp must contain all six vessels');
        assert(card.element.querySelector('[data-card-el="sql"]').textContent.includes('read-only DuckDB snapshot'),
          'Query details must distinguish logical SQL from execution');
      }
      assert(card.element.querySelector('[data-card-el="result-state"]').textContent.trim()==='COMPLETE','Chart did not visibly complete');
      let endpointCount;
      if(card.mode==='line') {
        const canvas=card.element.querySelector('[data-card-el="chart"]');
        const overlay=canvas.parentElement.querySelector('canvas[aria-hidden="true"]');
        const points=markers.get(overlay.getContext('2d'))??[];endpointCount=points.length;
        assert(points.length===6&&colors.every(color=>points.filter(value=>value===color).length===1),'Missing final vessel endpoint markers');
        const counts=segments.get(canvas.getContext('2d'))??new Map();
        assert(colors.every(color=>(counts.get(color)??0)>=fixture.points/6-1),'Dense line rendering omitted vessel segments');
        assert(draws[0].received===produced[0].length&&draws[0].received<fixture.points,'First point was not drawn from the first batch');
        assert(card.view.timing.firstDrawAt<=card.view.timing.completedAt,'Line rendering waited for stream completion');
      } else {
        const renderer=card.renderer;
        assert(renderer?.source?.batches===card.chart.batches,'Matrix renderer must borrow the chart batch list');
        assert(renderer.rows.size===6,'Matrix renderer lost vessel rows');
      }
      results.push({id:fixture.id,plan:card.view.plan,points:card.total,series:perSeries.size,min,max,
        batches:produced.length,execution:card.view.execution,sharedProducerBuffers:true,firstDrawReceivedPoints:draws[0].received,endpointCount,
        explicitRendererPrewarm:false,rendererReadyBeforeQuery,firstDrawBeforeCompletion:card.view.timing.firstDrawAt<=card.view.timing.completedAt,
        dataCoverageClamped:clipped,referencePlan:fixture.referencePlan,knownModelMismatch:fixture.knownModelMismatch,
        capturedOutput:fixture.text,capturedOutputSHA256:fixture.rawSHA256,sql:card.view.sql});
    }
    const base=JSON.parse(fixtures[0].text);
    const invalid=encoding==='full'?[
      {id:'extra-field',text:JSON.stringify({...base,sql:'SELECT 1'})},
      {id:'missing-field',text:JSON.stringify(Object.fromEntries(Object.entries(base).filter(([key])=>key!=='metric')))},
      {id:'invalid-metric',text:JSON.stringify({...base,metric:'fuel_use'})},
      {id:'invalid-bucket',text:JSON.stringify({...base,bucketMinutes:2})},
      {id:'invalid-window',text:JSON.stringify({...base,windowHours:0})},
      {id:'unknown-vessel',text:JSON.stringify({...base,vessel:6})},
      {id:'invalid-spatial-grouping',text:JSON.stringify({...base,view:'map',splitByVessel:false})},
      {id:'malformed-json',text:'{"metric":'},
      {id:'unknown-chart',text:JSON.stringify({...base,view:'pie'})},
      {id:'explicit-refusal',text:'{"error":"unsupported_request"}'},
    ]:[
      {id:'multiple-metrics',text:JSON.stringify({...base,metrics:['wave_height','wind']})},
      {id:'unsupported-filter',text:JSON.stringify({...base,unsupported:['excluding Aurora']})},
      {id:'malformed-json',text:'{"metrics":'},
      {id:'unknown-chart',text:JSON.stringify({...base,view:'pie'})},
      {id:'explicit-refusal',text:'{"error":"unsupported_request"}'},
    ];
    if(encoding==='semantic-v5')invalid.push(
      ...['median','sum'].map(aggregate=>({id:'unsupported-'+aggregate,text:JSON.stringify({...base,aggregate})})),
      {id:'extra-field',text:JSON.stringify({...base,sql:'SELECT 1'})},
      {id:'missing-field',text:JSON.stringify(Object.fromEntries(Object.entries(base).filter(([key])=>key!=='metrics')))},
      {id:'unknown-metric',text:JSON.stringify({...base,metrics:['fuel_use']})},
      {id:'unknown-vessel',text:JSON.stringify({...base,vessel:'Poseidon'})},
      {id:'invalid-spatial-grouping',text:JSON.stringify({...base,view:'map',grouping:'fleet'})},
      {id:'zero-window',text:JSON.stringify({...base,window:{count:0,unit:'day'}})},
      {id:'fractional-hour-window',text:JSON.stringify({...base,window:{count:0.5,unit:'hour'}})},
      {id:'overflow-window',text:JSON.stringify({...base,window:{count:4294967295,unit:'day'}})},
      {id:'string-bucket-count',text:JSON.stringify({...base,bucket:{count:'5',unit:'minute'}})},
      {id:'unknown-window-unit',text:JSON.stringify({...base,window:{count:1,unit:'month'}})},
      {id:'negative-bucket',text:JSON.stringify({...base,bucket:{count:-1,unit:'hour'}})},
      {id:'unsupported-bucket',text:JSON.stringify({...base,bucket:{count:30,unit:'minute'}})},
    );
    const before=executions,beforeCompile=compilations;
    for(const fixture of invalid) {
      const event=await run({...fixture,question:'Controlled rejected completion '+fixture.id});
      assert(event.type==='error'&&event.failure.phase==='inference','Invalid completion must fail before compilation');
      assert(compilations===beforeCompile,'Invalid completion reached the SQL compiler');
      assert(executions===before&&produced.length===0,'Invalid completion reached DuckDB');
      assert(draws.length===0&&card.total===0&&!card.view,'Invalid completion generated a chart');
      assert(card.element.querySelector('[data-card-el="result-state"]').textContent.trim()==='QUERY ERROR','Invalid completion did not stop loading');
      rejected.push({id:fixture.id,message:event.message,compiled:false,databaseExecuted:false,drawn:false});
    }
    return {encoding,datasetRows:context.rowCount,compiler:compiler.kind,compilations,executions,results,rejected,
      modelReplayOnly:true,liveInference:false,accuracyClaim:false,explicitRendererPrewarm:false,physicalPresentationMeasured:false};
  } finally {
    coordinator?.dispose();card?.destroy();await database.dispose();
    for(const [name,method] of Object.entries(original))proto[name]=method;
  }
}"""


def run(args):
    captures, provenance = read_captures(args.encoding)
    with sync_playwright() as playwright:
        launch = {'headless': True, 'args': ['--no-sandbox']}
        if args.chromium:
            launch['executable_path'] = args.chromium
        browser = playwright.chromium.launch(**launch)
        try:
            page = browser.new_page(viewport={'width': 1200, 'height': 950}, device_scale_factor=1)
            page.set_default_timeout(120_000)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            quiet_vite(page)
            page.route('**/model-query-harness', lambda route: route.fulfill(
                status=200, content_type='text/html', body='<div id="root" style="position:relative;width:1100px;height:850px"></div>'))
            page.goto(args.url.rstrip('/') + '/model-query-harness')
            result = page.evaluate(SMOKE, {'fixtures': captures, 'encoding': args.encoding,
                                         'model': REPORTS[args.encoding]['model'], 'firstBucket': args.first_bucket})
            cold_import_lifecycle(browser, args.url, errors)
            print(json.dumps({'browser': browser.version, 'fixtureProvenance': provenance,
                              'result': result, 'coldImportSeparatelyHoldsDraw': True, 'pageErrors': errors}, indent=2))
            assert not errors, errors
        finally:
            browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:5173')
    parser.add_argument('--chromium', help='Optional Chromium executable path')
    parser.add_argument('--encoding', choices=REPORTS, default='semantic-v5', help='Captured generation encoding; semantic-v5 exercises the Qwen3-4B contract')
    parser.add_argument('--first-bucket', action='store_true', help='Exercise the local first-complete-bucket execution strategy')
    run(parser.parse_args())
