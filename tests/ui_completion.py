"""UI-only regression: COMPLETE waits for chart drawing and statistics.

Frame callbacks are controlled to verify intermediate states deterministically.
This is a lifecycle/geometry check, not a timing or presentation benchmark.
"""
import argparse
import json
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base-url', default='http://127.0.0.1:5173')
args = parser.parse_args()
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1440, 'height':1000})
    page.route('**/ui-completion-harness', lambda r: r.fulfill(status=200, content_type='text/html', body='<div id="root"></div>'))
    page.route('**/@vite/client', lambda r: r.fulfill(status=200, content_type='text/javascript', body='''
      const styles=new Map();
      export const createHotContext=()=>({data:{},accept(){},dispose(){},prune(){},invalidate(){},on(){}});
      export function updateStyle(id,css){let style=styles.get(id);if(!style){style=document.createElement('style');styles.set(id,style);document.head.append(style);}style.textContent=css;}
      export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}
    '''))
    page.goto(args.base_url.rstrip('/')+'/ui-completion-harness')
    result = page.evaluate('''async () => {
      const {createUI}=await import('/src/ui/index.ts');
      const pending=new Map();let next=0,frameTime=performance.now(),draws=0,maxX=0,cancels=0;
      window.requestAnimationFrame=fn=>{pending.set(++next,fn);return next;};
      window.cancelAnimationFrame=id=>pending.delete(id);
      const frame=()=>{const callbacks=[...pending.values()];pending.clear();frameTime+=16;for(const fn of callbacks)fn(frameTime);};
      const settle=()=>{for(let i=0;pending.size&&i<1000;i++)frame();if(pending.size)throw Error('Work did not settle');};
      const assert=(ok,message)=>{if(!ok)throw Error(message);};
      const lineTo=CanvasRenderingContext2D.prototype.lineTo,beginPath=CanvasRenderingContext2D.prototype.beginPath,stroke=CanvasRenderingContext2D.prototype.stroke,pathMax=new WeakMap();
      CanvasRenderingContext2D.prototype.beginPath=function(){pathMax.set(this,-Infinity);return beginPath.call(this);};
      CanvasRenderingContext2D.prototype.lineTo=function(x,y){pathMax.set(this,Math.max(pathMax.get(this)??-Infinity,x));return lineTo.call(this,x,y);};
      CanvasRenderingContext2D.prototype.stroke=function(){if(this.canvas.dataset.el==='chart'&&this.strokeStyle==='#ff906c')maxX=Math.max(maxX,pathMax.get(this)??0);return stroke.call(this);};
      const ui=createUI(document.querySelector('#root'),{onDraft(){},onCommit(){},onFocus(){},onConfig(){},onCancel(){cancels++;},onWarmModel(){},onDraw(){draws++;}});
      const {DEFAULT_CONFIG}=await import('/src/core/types.ts');
      ui.setConfig({...DEFAULT_CONFIG,liveQuery:false});
      const context={id:'test',label:'test',rowCount:60480,start:0,end:60480000,vessels:['One'],description:'test'};
      const request=id=>({id,prompt:'speed',revision:1,plan:{metric:'speed',aggregate:'avg',bucketMinutes:1,windowHours:336,splitByVessel:true,vessel:null,view:'line'},sql:'SELECT',source:'template',context,
        timing:{startedAt:performance.now(),committedAt:performance.now(),completedAt:123,promoted:false,batches:1,points:60480,bytes:1209600}});
      const batch=n=>({x:Float64Array.from({length:n},(_,i)=>i*1000),y:Float64Array.from({length:n},(_,i)=>i<n/2?10:30),series:new Int32Array(n),length:n,byteLength:n*20});
      const state=()=>document.querySelector('[data-el="result-state"]').textContent.trim();
      const submit=text=>{const input=document.querySelector('[data-el="input"]');input.value=text;input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));};
      const start=(id,n=60480)=>{const view=request(id);submit(view.prompt);ui.handleEvent({type:'start',view});ui.handleEvent({type:'batch',id,batch:batch(n)});return view;};
      const complete=view=>ui.handleEvent({type:'complete',id:view.id,timing:view.timing});
      ui.setDataset(context);settle();
      const large=start('large');complete(large);
      assert(state()==='DRAWING','Query completion must leave an unfinished chart DRAWING');
      assert(!document.querySelector('[data-action="cancel"]').hidden,'Drawing must retain the stop control');
      assert(draws===1,'First marker must remain immediate');frame();frame();
      assert(state()==='DRAWING','A partially indexed result must remain DRAWING');
      assert(document.querySelector('[data-el="mean"]').textContent==='10','Fixture should expose partial statistics');
      settle();assert(state()==='COMPLETE','Settled chart must become COMPLETE');
      assert(document.querySelector('[data-action="cancel"]').hidden,'Settled drawing must hide the stop control');
      assert(document.querySelector('[data-el="mean"]').textContent==='20','COMPLETE requires final statistics');
      assert(large.timing.completedAt===123,'Rendering must not change database completion timing');
      const main=document.querySelector('[data-el="chart"]');
      assert(maxX>main.getBoundingClientRect().width-24,'Chart must cover the final point');

      const canceled=start('canceled');complete(canceled);document.querySelector('[data-action="cancel"]').click();settle();
      assert(state()==='CANCELED','Canceled work must not become COMPLETE');
      const old=start('old');complete(old);const fresh=start('fresh',2);settle();
      assert(state()==='STREAMING','Old completion must not complete a replacement query');
      complete(old);assert(state()==='STREAMING','Stale completion must be rejected');
      complete(fresh);assert(state()==='COMPLETE','Already rendered replacement may complete immediately');
      const pendingStart=start('pending-start');complete(pendingStart);
      const input=document.querySelector('[data-el="input"]');input.value='A replacement question';
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      settle();complete(pendingStart);
      assert(!document.querySelector('[data-action="cancel"]').hidden,'Old drawing completion must not clear a pending request');
      const failed=start('failed');ui.handleEvent({type:'error',id:'failed',message:'Result failed'});complete(failed);settle();
      assert(state()==='QUERY ERROR','Renderer completion must not replace an error');
      assert(document.querySelector('[data-action="cancel"]').hidden,'A failed request must remain idle after drawing settles');

      const terminal=start('terminal',2);complete(terminal);settle();
      const terminalPoints=document.querySelector('[data-el="points"]').textContent;
      ui.handleEvent({type:'batch',id:'terminal',batch:batch(3)});
      ui.handleEvent({type:'error',id:'terminal',message:'Late error'});settle();
      assert(state()==='COMPLETE'&&document.querySelector('[data-el="points"]').textContent===terminalPoints,'Terminal results must reject late data and errors');
      const hidden=start('hidden');document.querySelector('[data-tab="table"]').click();complete(hidden);settle();
      assert(state()==='COMPLETE','Hidden chart may complete after summaries are indexed');
      document.querySelector('[data-tab="chart"]').click();assert(state()==='DRAWING','Showing a pending chart redraw must report DRAWING');
      assert(!document.querySelector('[data-action="cancel"]').hidden,'A pending redraw must restore the stop control');
      settle();assert(state()==='COMPLETE','Shown chart must complete after redraw');
      const userCancel=start('user-cancel');complete(userCancel);const beforeCancel=cancels;
      window.checkUserCancel=()=>{
        assert(cancels===beforeCancel+1,'Visible stop control must cancel the request');
        settle();assert(state()==='CANCELED','A user-canceled drawing must remain canceled');
        assert(document.querySelector('[data-el="mean"]').textContent==='—','Canceled drawing must not index pending statistics');
        assert(document.querySelector('[data-action="cancel"]').hidden,'Cancellation must hide the stop control');
        ui.destroy();return true;
      };
      return {largePoints:60480,firstMarkerImmediate:true,completeWaitsForDrawingAndStatistics:true,
        cancellationAndReplacementSafe:true,errorPreserved:true,terminalEventsRejected:true,hiddenAndRestoredStates:true,completionTimingUnchanged:true};
    }''')
    stop = page.locator('[data-action="cancel"]')
    assert stop.is_visible(), 'DRAWING must expose a visible stop button'
    stop.click()
    result['userCanCancelDrawing'] = page.evaluate('window.checkUserCancel()')
    print(json.dumps({'chromium':browser.version, **result}, indent=2))
    browser.close()
