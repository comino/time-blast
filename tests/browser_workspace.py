"""Persistent canvas lifecycle and interaction regression.

Uses controlled column batches through the UI module only; no database or model
starts. Controlled animation frames verify first-marker ordering, not latency.
Run with Vite: python3 tests/browser_workspace.py --base-url http://127.0.0.1:5173
"""
import argparse
import json

from playwright.sync_api import sync_playwright


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base-url', default='http://127.0.0.1:5173')
args = parser.parse_args()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1600, 'height': 1050})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/workspace-harness', lambda route: route.fulfill(
        status=200, content_type='text/html', body='<div id="root"></div>'))
    page.route('**/@vite/client', lambda route: route.fulfill(
        status=200, content_type='text/javascript', body='''
          const styles=new Map();
          export const createHotContext=()=>({data:{},accept(){},dispose(){},prune(){},invalidate(){},on(){}});
          export function updateStyle(id,css){let s=styles.get(id);if(!s){s=document.createElement('style');styles.set(id,s);document.head.append(s);}s.textContent=css;}
          export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}
        '''))
    page.goto(args.base_url.rstrip('/') + '/workspace-harness')
    initial = page.evaluate('''async () => {
      const {createUI}=await import('/src/ui/index.ts');
      // Vite can attach an HMR timestamp to this dependency. Patch the actual
      // loaded module rather than importing a second, unversioned class instance.
      const chartURL=performance.getEntriesByType('resource').find(entry=>new URL(entry.name).pathname==='/src/ui/chart.ts')?.name;
      const {StreamChart}=await import(chartURL??'/src/ui/chart.ts');
      const pending=new Map(), appended=[], requests=new Map();
      let next=0, timestamp=performance.now();
      window.requestAnimationFrame=callback=>{pending.set(++next,callback);return next;};
      window.cancelAnimationFrame=id=>pending.delete(id);
      const frame=()=>{const batch=[...pending.values()];pending.clear();timestamp+=16;for(const callback of batch)callback(timestamp);};
      const settle=()=>{for(let i=0;pending.size&&i<1200;i++)frame();if(pending.size)throw Error('Workspace frame work did not settle');};
      const assert=(value,message)=>{if(!value)throw Error(message);};
      const originalAppend=StreamChart.prototype.append;
      StreamChart.prototype.append=function(batch){appended.push({card:this.canvas.closest('.result-card')?.dataset.cardId,batch});return originalAppend.call(this,batch);};
      const cards=()=>[...document.querySelectorAll('.result-card[data-card-id]')];
      const selected=()=>document.querySelector('.result-card[data-selected="true"]');
      const field=(card,name)=>card.querySelector(`[data-card-el="${name}"]`);
      const state=card=>field(card,'result-state').textContent.trim();
      const calls={commits:[],draws:[],drawTraces:[],cancels:0,configs:[],mountedAtCommit:[]};
      const ui=createUI(document.querySelector('#root'),{
        onDraft(){},onFocus(){},onWarmModel(){},
        onCommit(text){calls.commits.push(text);calls.mountedAtCommit.push(Boolean(selected()?.isConnected&&selected().textContent.includes(text)));},
        onDraw(id,at){calls.draws.push(id);const timing=requests.get(id)?.timing;if(timing&&timing.firstDrawAt===undefined){timing.firstDrawAt=at;calls.drawTraces.push(id);}},
        onCancel(){calls.cancels++;},onConfig(config){calls.configs.push(config);}
      });
      const context={id:'workspace-test',label:'Workspace fixture',rowCount:6,start:1000,end:7000,vessels:['One','Two'],description:'Controlled UI fixture'};
      ui.setDataset(context);
      const submit=prompt=>{const input=document.querySelector('[data-el="input"]');input.value=prompt;input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return selected();};
      const view=(id,prompt)=>{const request={id,prompt,revision:1,plan:{metric:'speed',aggregate:'avg',bucketMinutes:1,windowHours:1,splitByVessel:true,vessel:null,view:'line'},sql:'SELECT '+id,source:'template',context,timing:{startedAt:performance.now(),committedAt:performance.now(),promoted:false,batches:1,points:3,bytes:108}};requests.set(id,request);return request;};
      const batch=values=>({x:new Float64Array([1000,3000,6000]),y:new Float64Array(values),series:new Int32Array([0,0,1]),lat:new Float64Array([45,46,48]),lon:new Float64Array([-20,-19,-17]),length:3,byteLength:108});
      const start=(id,prompt)=>{const request=view(id,prompt);ui.handleEvent({type:'start',view:request});return request;};
      const append=(id,points)=>ui.handleEvent({type:'batch',id,batch:points});
      const complete=request=>ui.handleEvent({type:'complete',id:request.id,timing:request.timing});
      const finish=(id,prompt,values)=>{const card=submit(prompt),request=start(id,prompt),points=batch(values);append(id,points);complete(request);settle();return {card,request,points};};
      settle();
      assert(cards().length===0,'Workspace starts without fake result cards');
      ui.handleEvent({type:'start',view:view('unsolicited','No submission')});
      assert(cards().length===0,'Unsolicited start must not create a result');

      const firstCard=submit('First fleet question');
      assert(cards().length===1&&calls.mountedAtCommit[0],'Loading card must mount before onCommit');
      assert(!/COMPLETE|EMPTY RESULT|CANCELED/.test(state(firstCard)),'New question must begin loading');
      const first=start('first','First fleet question'),firstBatch=batch([10,20,30]);
      append('first',firstBatch);
      assert(calls.draws.join(',')==='first','First marker must draw synchronously before any frame');
      assert(calls.drawTraces.join(',')==='first','Draw notification must preserve coordinator trace recording on the shared timing object');
      complete(first);settle();
      assert(state(firstCard)==='COMPLETE','First result must settle');
      assert(field(firstCard,'mean').textContent==='20','First card has its own statistics');
      const firstId=firstCard.dataset.cardId;

      const second=finish('second','Second fleet question',[2,4,6]);
      assert(cards().length===2,'Second question must append a card');
      assert(firstCard.isConnected&&field(firstCard,'mean').textContent==='20','Previous chart must keep its data');
      assert(field(second.card,'mean').textContent==='4','New chart must have independent statistics');
      append('first',batch([100,100,100]));
      complete(first);settle();
      assert(field(second.card,'mean').textContent==='4','A previous query cannot overwrite the active result');
      ui.handleEvent({type:'batch',id:'never-started',batch:firstBatch});
      assert(cards().length===2,'Unknown batch must not create a card');

      const commitsBeforeModes=calls.commits.length;
      window.workspace={ui,calls,cards,selected,field,state,submit,view,batch,start,append,complete,finish,frame,settle,assert,pending,appended,firstCard,firstId,firstBatch,second,commitsBeforeModes};
      return {loadingBeforeInference:true,firstMarkerBeforeFrame:true,persistentIndependentCards:true,staleIdsIgnored:true};
    }''')

    # Controls use real browser interactions, so hidden/non-interactive controls fail.
    current = page.locator('.result-card[data-selected="true"]')
    modes = current.locator('select').first
    for mode in ['bar', 'scatter', 'map', 'table', 'line']:
        modes.select_option(mode)
        page.evaluate('workspace.settle()')
        assert page.evaluate('workspace.calls.commits.length===workspace.commitsBeforeModes')
        assert page.evaluate('workspace.field(workspace.second.card,"mean").textContent') == '4'
    page.evaluate('''() => {
      const {assert,appended,second}=workspace;
      const received=appended.filter(entry=>entry.card===second.card.dataset.cardId);
      assert(received.length>0&&received.every(entry=>entry.batch===second.points), 'View changes must retain the original numeric batch: '+JSON.stringify({card:second.card.dataset.cardId,received:received.length,all:appended.map(entry=>entry.card)}));
    }''')

    current.locator('[data-card-action="duplicate"]').click()
    page.evaluate('workspace.settle()')
    duplicate = page.evaluate('''() => {
      const w=workspace,copy=w.selected(),entries=w.appended.filter(entry=>entry.card===copy.dataset.cardId);
      w.assert(w.cards().length===3,'Duplicate must add a persistent card');
      w.assert(w.calls.commits.length===w.commitsBeforeModes,'Duplicate must not infer or query');
      w.assert(entries.length>0&&entries.every(entry=>entry.batch===w.second.points),'Duplicate must share numeric buffers');
      w.assert(w.field(copy,'mean').textContent==='4','Duplicate must preserve values');
      return copy.dataset.cardId;
    }''')

    # Camera controls and dragging must operate on existing cards without a query.
    world = page.locator('[data-el="board-world"]')
    before_zoom = world.evaluate('(element)=>getComputedStyle(element).transform')
    page.locator('[data-action="zoom-in"]').click()
    page.evaluate('workspace.settle()')
    after_zoom = world.evaluate('(element)=>getComputedStyle(element).transform')
    assert after_zoom != before_zoom, 'Zoom must update the board transform'
    page.locator('[data-action="fit"]').click()
    page.evaluate('workspace.settle()')
    selected = page.locator(f'.result-card[data-card-id="{duplicate}"]')
    before_drag = selected.bounding_box()
    handle = selected.locator('.card-drag-handle').bounding_box()
    assert before_drag and handle
    start_x, start_y = handle['x'] + min(80, handle['width'] / 3), handle['y'] + handle['height'] / 2
    page.mouse.move(start_x, start_y)
    page.mouse.down()
    page.mouse.move(start_x + 65, start_y + 40, steps=4)
    page.evaluate('workspace.frame()')
    page.mouse.up()
    page.evaluate('workspace.settle()')
    after_drag = selected.bounding_box()
    assert after_drag and abs(after_drag['x'] - before_drag['x']) > 20, 'Dragging must move the card'
    assert page.evaluate('workspace.calls.commits.length===workspace.commitsBeforeModes')

    page.locator('[data-action="fit"]').click()
    page.evaluate('workspace.settle()')
    before_resize = selected.bounding_box()
    handle = selected.locator('.card-resize-handle').bounding_box()
    assert before_resize and handle
    start_x, start_y = handle['x'] + handle['width'] / 2, handle['y'] + handle['height'] / 2
    page.mouse.move(start_x, start_y)
    page.mouse.down()
    page.mouse.move(start_x + 50, start_y + 30, steps=3)
    page.mouse.up()
    page.evaluate('workspace.settle()')
    after_resize = selected.bounding_box()
    assert after_resize and after_resize['width'] > before_resize['width'] + 25, 'Resize handle must resize the card'

    selected.locator('[data-card-action="close"]').click()
    page.evaluate('workspace.settle()')
    assert page.locator('.result-card').count() == 2

    lifecycle = page.evaluate('''() => {
      const w=workspace;
      const canceled=w.submit('Cancel before inference');
      const before=w.calls.cancels;
      canceled.querySelector('[data-card-action="cancel"]').click();
      w.assert(w.calls.cancels===before+1,'Pending card cancel must cancel the execution');
      w.start('canceled-late','Cancel before inference');w.append('canceled-late',w.firstBatch);w.settle();
      w.assert(w.state(canceled)==='CANCELED','Late start cannot revive a canceled card');
      w.assert(!w.calls.draws.includes('canceled-late'),'Canceled request cannot submit a first point');
      const failed=w.submit('Fail before inference');
      w.ui.handleEvent({type:'error',message:'Controlled inference failure'});
      w.assert(w.state(failed).includes('ERROR')&&failed.textContent.includes('Controlled inference failure'),'Pre-start error belongs to pending card');
      w.assert(w.field(w.firstCard,'mean').textContent==='20','Pending error must preserve existing charts');
      const superseded=w.submit('Superseded question');
      const cancelsBeforeSuperseding=w.calls.cancels;
      const replacement=w.submit('Replacement question');
      w.assert(w.calls.cancels===cancelsBeforeSuperseding,'Submitting a replacement must preserve the prepared candidate for commit promotion');
      w.start('superseded-late','Superseded question');w.append('superseded-late',w.firstBatch);
      w.assert(!w.calls.draws.includes('superseded-late'),'Superseded prompt cannot bind replacement card');
      const request=w.start('replacement','Replacement question');w.append('replacement',w.batch([3,6,9]));w.complete(request);w.settle();
      w.assert(/CANCELED|SUPERSEDED/.test(w.state(superseded))&&w.state(replacement)==='COMPLETE','Replacement must leave old work frozen');
      w.assert(w.field(replacement,'mean').textContent==='6','Replacement data must reach only its own card');
      return {pendingCancellation:true,preStartError:true,supersededStartIgnored:true};
    }''')

    # Applying runtime settings invalidates unfinished UI work, not saved results.
    page.evaluate('workspace.submit("Pending during runtime change")')
    page.locator('[data-action="settings"]').click()
    page.locator('[name="inferenceMode"]').select_option('templates')
    page.get_by_role('button', name='Apply runtime').click()
    page.evaluate('''() => {
      const w=workspace;
      w.assert(w.calls.configs.length===1,'Runtime change must reach callback');
      w.assert(w.state(w.selected())==='RUNTIME CHANGED','Runtime change must stop pending card');
      w.start('runtime-late','Pending during runtime change');w.append('runtime-late',w.firstBatch);w.settle();
      w.assert(!w.calls.draws.includes('runtime-late'),'Runtime change must reject obsolete work');
    }''')
    page.evaluate('''() => {
      const w=workspace;
      for(const mode of ['table','map']){
        const prompt=`Hidden ${mode} question`,id=`hidden-${mode}`,card=w.submit(prompt);
        const select=w.field(card,'representation');select.value=mode;select.dispatchEvent(new Event('change',{bubbles:true}));
        document.querySelector('[data-el="board-viewport"]').dispatchEvent(new WheelEvent('wheel',{deltaX:100000,bubbles:true,cancelable:true}));
        const request=w.start(id,prompt);w.append(id,w.batch([1,2,3]));w.complete(request);w.settle();
        w.assert(!w.calls.draws.includes(id),`An offscreen ${mode} must not report its first visible draw`);
        document.querySelector(`[data-history-card="${card.dataset.cardId}"]`).click();w.settle();
        w.assert(w.calls.draws.filter(value=>value===id).length===1,`Focusing a populated ${mode} must record its first draw once`);
        w.assert(w.calls.drawTraces.filter(value=>value===id).length===1,`Revealing a ${mode} must preserve the coordinator timing trace`);
      }
    }''')
    bounded = page.evaluate('''() => {
      const w=workspace;
      for(let i=0;i<10;i++)w.finish('bounded-'+i,'Bounded history '+i,[i,i+1,i+2]);
      w.assert(w.cards().length===8,'Card history must be bounded at eight');
      w.assert(new Set(w.cards().map(card=>card.style.left+','+card.style.top)).size===8,'Automatic card placement must not stack new results on the same slot after eviction');
      w.assert(!w.firstCard.isConnected,'Oldest inactive card must be evicted');
      w.assert(w.selected().getAttribute('aria-label')==='Bounded history 9','Newest result must remain selected');
      w.oldestAtCapacity=w.cards()[0];w.oldestMean=w.field(w.oldestAtCapacity,'mean').textContent;
      w.oldestBatches=w.appended.filter(entry=>entry.card===w.oldestAtCapacity.dataset.cardId).map(entry=>entry.batch);
      return {maximumCards:w.cards().length,oldestEvicted:true};
    }''')
    page.locator('[data-action="fit"]').click()
    page.evaluate('workspace.settle()')
    page.locator('.result-card').first.locator('[data-card-action="duplicate"]').click()
    page.evaluate('''() => {
      const w=workspace;w.settle();
      const copy=w.selected(),entries=w.appended.filter(entry=>entry.card===copy.dataset.cardId);
      w.assert(w.cards().length===8,'Duplicating at capacity must keep the card budget');
      w.assert(w.field(copy,'mean').textContent===w.oldestMean,'Oldest source must survive until its duplicate is initialized');
      w.assert(entries.length===w.oldestBatches.length&&entries.every((entry,i)=>entry.batch===w.oldestBatches[i]),'Eviction during duplication must retain shared buffers');
    }''')
    page.locator('[data-action="clear-canvas"]').click()
    page.evaluate('''() => {
      workspace.settle();workspace.assert(workspace.cards().length===0,'Clear canvas must remove all cards');
      workspace.ui.destroy();workspace.settle();workspace.assert(!workspace.pending.size,'Destroy must release scheduled frame work');
    }''')
    assert not errors, errors
    print(json.dumps({'chromium': browser.version, **initial, **lifecycle, **bounded,
                      'modesWithoutQuery': True, 'duplicateSharesBuffers': True,
                      'zoomFitDragResize': True, 'runtimeInvalidation': True,
                      'hiddenTableDrawDeferred': True,
                      'hiddenMapDrawDeferred': True,
                      'removalAndDestroy': True, 'pageErrors': errors}, indent=2))
    browser.close()
