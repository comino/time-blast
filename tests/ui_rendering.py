"""UI-only first-frame, ordering, visibility and command-count regression harness.

No database or model initialization. Timing observations are software proxies, not
benchmarks or physical presentation measurements. Requires a Vite development server.
"""
import argparse
import json
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base-url', default='http://127.0.0.1:5173')
parser.add_argument('--screenshot')
args = parser.parse_args()
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1440, 'height':1000}, device_scale_factor=1)
    page.route('**/ui-rendering-harness', lambda r: r.fulfill(status=200, content_type='text/html', body='<div id="root"></div>'))
    # Keep unrelated edits in concurrent review sessions from reloading this isolated harness.
    page.route('**/@vite/client', lambda r: r.fulfill(status=200, content_type='text/javascript', body='''
      const styles=new Map();
      export const createHotContext=()=>({data:{},accept(){},dispose(){},prune(){},invalidate(){},on(){}});
      export function updateStyle(id,css){let style=styles.get(id);if(!style){style=document.createElement('style');styles.set(id,style);document.head.append(style);}style.textContent=css;}
      export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}
    '''))
    page.goto(args.base_url.rstrip('/')+'/ui-rendering-harness')
    result = page.evaluate('''async () => {
      const {createUI}=await import('/src/ui/index.ts');
      const {ColumnOrder}=await import('/src/ui/order.ts');
      const {StreamChart,TrackChart}=await import('/src/ui/chart.ts');
      const nativeRAF=requestAnimationFrame.bind(window), nativeCancel=cancelAnimationFrame.bind(window), pending=new Set();
      window.requestAnimationFrame=fn=>{const id=nativeRAF(time=>{pending.delete(id);fn(time);});pending.add(id);return id;};
      window.cancelAnimationFrame=id=>{pending.delete(id);nativeCancel(id);};
      const settle=async()=>{for(let i=0;pending.size&&i<1000;i++)await new Promise(nativeRAF);if(pending.size)throw Error('UI work did not settle');};
      let chartLines=0,trackLines=0,indexed=0,drawAt=0,origin=0,commits=[];
      const lineTo=CanvasRenderingContext2D.prototype.lineTo;
      CanvasRenderingContext2D.prototype.lineTo=function(...args){if(this.canvas.dataset.el==='chart')chartLines++;if(this.canvas.dataset.el==='track')trackLines++;return lineTo.apply(this,args);};
      const append=ColumnOrder.prototype.appendRange;
      ColumnOrder.prototype.appendRange=function(batch,index,from,to){indexed+=to-from;return append.call(this,batch,index,from,to);};
      const ui=createUI(document.querySelector('#root'),{onDraft(){},onCommit(text){commits.push(text);},onFocus(){},onConfig(){},onCancel(){},onWarmModel(){},onDraw(id,at){drawAt=at-origin;}});
      const context={id:'test',label:'test',rowCount:100000,start:0,end:100000000,vessels:['One'],description:'test'};
      const view=id=>({id,prompt:'speed',revision:1,plan:{metric:'speed',aggregate:'avg',bucketMinutes:1,windowHours:336,splitByVessel:true,vessel:null,view:'line'},sql:'SELECT',source:'template',context,timing:{startedAt:origin,committedAt:origin,promoted:true,batches:0,points:0,bytes:0}});
      const batch=(n,start=0)=>({x:Float64Array.from({length:n},(_,i)=>(i+start)*1000),y:new Float64Array(n).fill(10),series:new Int32Array(n),lat:Float64Array.from({length:n},(_,i)=>i%100/100),lon:Float64Array.from({length:n},(_,i)=>i%100/100),length:n,byteLength:n*36});
      ui.setDataset(context);await settle();
      const large=batch(100000);indexed=0;origin=performance.now();
      ui.handleEvent({type:'start',view:view('large')});ui.handleEvent({type:'batch',id:'large',batch:large});
      const handlerReturned=performance.now()-origin, indexedAtReturn=indexed;
      await new Promise(nativeRAF);const firstFrameTail=performance.now()-origin,indexedAtFirstFrame=indexed;
      document.querySelector('[data-action="cancel"]').click();await settle();
      const firstFrame={drawAt,handlerReturned,firstFrameTail,indexedAtReturn,indexedAtFirstFrame,indexedAfterCancel:indexed};
      if(indexedAtReturn||indexedAtFirstFrame||indexed)throw Error('Bulk indexing preceded first rendering opportunity or survived cancellation');
      const counts=[];
      for(const [id,chunks,n,hidden] of [['single',1,4000,false],['stream',40,100,false],['hidden',1,4000,true]]){
        origin=performance.now();ui.handleEvent({type:'start',view:view(id)});await settle();
        if(hidden)document.querySelector('[data-tab="table"]').click();
        chartLines=trackLines=0;
        for(let i=0;i<chunks;i++){ui.handleEvent({type:'batch',id,batch:batch(n,i*n)});await settle();}
        counts.push({id,chunks,n,hidden,chartLines,trackLines});
        if(hidden&&chartLines)throw Error('Hidden chart drew geometry');
      }
      if(counts[1].chartLines>counts[0].chartLines+10||counts[1].trackLines>counts[0].trackLines+10)throw Error('Ordered stream redraws prior geometry');
      document.querySelector('[data-tab="chart"]').click();await settle();
      const input=document.querySelector('[data-el="input"]');input.value='  Average speed by hour  ';
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      if(commits.at(-1)!==input.value)throw Error('Commit changed exact draft text');
      const base=document.querySelector('[data-el="chart"]').getBoundingClientRect();
      const overlay=document.querySelector('[data-el="chart"]').parentElement.querySelector('[aria-hidden="true"]').getBoundingClientRect();
      if(base.x!==overlay.x||base.y!==overlay.y||base.width!==overlay.width||base.height!==overlay.height)throw Error('Marker overlay does not align');
      return {firstFrame,counts,mean:document.querySelector('[data-el="mean"]').textContent,rawCommit:commits.at(-1),overlayAligned:true};
    }''')
    if args.screenshot:
        page.screenshot(path=args.screenshot, full_page=True)
    print(json.dumps({'browser':browser.version, **result}, indent=2))
    browser.close()
