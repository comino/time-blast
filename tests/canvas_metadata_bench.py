"""Real Chromium IndexedDB/document measurements, with no inference or result data.

Usage: python3 tests/canvas_metadata_bench.py http://127.0.0.1:5394 --json report.json
The supplied Vite server serves imports; a minimal isolated page avoids app startup.
"""
import json
import sys
from playwright.sync_api import sync_playwright

BASE = sys.argv[1].rstrip('/')
PROGRAM = r"""async () => {
  const {CanvasModel} = await import('/src/canvas/model.ts');
  const {CanvasSession} = await import('/src/canvas/session.ts');
  const {IndexedCanvasStore} = await import('/src/canvas/store.ts');
  const {forkCanvas} = await import('/src/canvas/validation.ts');
  const {encodeCanvasFile} = await import('/src/canvas/recovery.ts');
  const clock = () => performance.now();
  const quantiles = xs => { const a = xs.slice().sort((a,b)=>a-b); return {n:a.length,
    p50:a[Math.floor(a.length*.5)], p95:a[Math.min(a.length-1,Math.floor(a.length*.95))], max:a.at(-1)}; };
  function build(n) {
    const m = CanvasModel.create(`Metadata benchmark ${n}`);
    m.addSource({id:'source',name:'vessels',locator:{kind:'fixture',name:'vessels'},policy:'current',tables:[{name:'telemetry',columns:[{name:'speed',type:'DOUBLE'}]}]});
    for(let i=0;i<n;i++) {
      let chartId;
      for(let revision=0;revision<5;revision++) {
        const d = m.startDraft(chartId ? {chartId,text:`Revision ${revision}: use maximum speed`} :
          {sourceRefId:'source',text:`Average speed for chart ${i}`,layout:{x:24+i%2*524,y:24+Math.floor(i/2)*494,width:500,height:470}}).draft;
        chartId=d.chartId;
        const sql=`SELECT ${i+revision} AS x, ${i*2+revision} AS y`;
        m.recordSql(d.id,d.sequence,sql);m.finishDraft(d.id);m.outcome(d.id,d.sequence,sql,'succeeded');
      }
    }
    return m;
  }
  const out={kind:'timeblast.canvas-metadata-benchmark',at:new Date().toISOString(),
    browser:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,
    notes:'Main-thread document/IndexedDB only; no inference, GPU, network or query data. Five revisions per chart; all canvas membership snapshots retained. Warm repeats share the browser process. Not thought-to-result or photon latency.',cases:[]};
  for(const n of [1,10,100]) {
    const m=new CanvasModel(forkCanvas(build(n).snapshot())), snapshot=m.snapshot();
    const name='timeblast-bench-'+crypto.randomUUID(), store=await IndexedCanvasStore.open(name);
    let t=clock(); await store.write(m.initialPatch()); const initialSaveMs=clock()-t;
    t=clock(); await store.load(m.header.id); const coldLoadMs=clock()-t;
    const load=[],fork=[],exportMs=[];
    for(let i=0;i<5;i++) {
      t=clock();await store.load(m.header.id);load.push(clock()-t);
      t=clock();forkCanvas(snapshot);fork.push(clock()-t);
      t=clock();encodeCanvasFile(snapshot);exportMs.push(clock()-t);
    }
    const session=new CanvasSession(m,store), sourceId=m.sources.keys().next().value;
    const d=session.command(m=>m.startDraft({sourceRefId:sourceId,text:''})).draft;
    await session.settled();
    const withStorage=[],ack=[],withoutStorage=[];
    let value='';
    for(let i=0;i<120;i++) {
      value+='x';t=clock();session.command(m=>m.updateText(d.id,value));withStorage.push((clock()-t)*1000);
      const started=clock();await session.settled();ack.push(clock()-started);
    }
    // Same document mutations and clones, without the journaling/IndexedDB layer.
    const bare=new CanvasModel(snapshot), b=bare.startDraft({sourceRefId:sourceId,text:''}).draft;value='';
    for(let i=0;i<120;i++) {value+='x';t=clock();bare.updateText(b.id,value);withoutStorage.push((clock()-t)*1000);}
    const bytes=new TextEncoder().encode(encodeCanvasFile(snapshot)).length;
    out.cases.push({charts:n,revisions:snapshot.revisions.length,commits:snapshot.commits.length,bytes,
      initialSaveMs,coldLoadMs,warmLoadMs:quantiles(load),forkMs:quantiles(fork),exportMs:quantiles(exportMs),
      authoringWithPersistenceUs:quantiles(withStorage.slice(20)),authoringModelOnlyUs:quantiles(withoutStorage.slice(20)),
      acknowledgementMs:quantiles(ack.slice(20)),saveState:session.saveState.state});
    session.close();store.close();await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=resolve;r.onerror=()=>reject(r.error);});
  }
  return out;
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.route('**/canvas-metadata-bench.html', lambda route: route.fulfill(body='<!doctype html><title>Canvas metadata benchmark</title>', headers={
        'Content-Type': 'text/html', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless'}))
    page.goto(BASE + '/canvas-metadata-bench.html')
    report = page.evaluate(PROGRAM)
    report['browserVersion'] = browser.version
    browser.close()
output = json.dumps(report, indent=2)
print(output)
if '--json' in sys.argv:
    with open(sys.argv[sys.argv.index('--json')+1], 'w') as f:
        f.write(output + '\n')
