#!/usr/bin/env python3
"""Regression for usable mobile matrix geometry and query-details bounds.

Controlled columns exercise the actual workspace/card/renderers without starting
models or a database. Checks a 390x844 viewport, long-window coverage text,
explicit resize behavior, and unchanged desktop default sizing.
"""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_views import quiet_vite

SETUP = r'''async () => {
  const {createUI}=await import('/src/ui/index.ts');
  const url=performance.getEntriesByType('resource').map(e=>e.name)
    .filter(n=>new URL(n).pathname==='/src/ui/result-card.ts').at(-1);
  const {ResultCard}=await import(url||'/src/ui/result-card.ts');
  const begin=ResultCard.prototype.begin;
  ResultCard.prototype.begin=function(view){window.matrixCard=this;return begin.call(this,view);};
  const {DEFAULT_CONFIG}=await import('/src/core/types.ts');
  window.ui=createUI(document.querySelector('#app'),{
    onDraft(){},onCommit(){},onFocus(){},onConfig(){},onCancel(){},onWarmModel(){},onDraw(){},
  });
  ui.setConfig({...DEFAULT_CONFIG,liveQuery:false,liveTranslation:false,speculation:false});
  const context={id:'mobile-matrix-fixture',label:'Matrix fixture',description:'Controlled columns',
    rowCount:2016,start:Date.UTC(2026,8,1),end:Date.UTC(2026,8,15),
    vessels:['Aurora','Meridian','Kestrel','Solstice','Atlas','Nomad']};
  ui.setDataset(context);ui.setStatus('coordinator',{state:'ready',label:'Ready'});
  window.showSurface=hours=>{
    const input=document.querySelector('[data-el="input"]');
    input.value=`Compare vessel wave height by hour over the last ${hours/24} days as a 3D surface`;
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    const start=Math.max(context.start,context.end-hours*3600000),n=(context.end-start)/3600000*6;
    const timing={startedAt:performance.now(),committedAt:performance.now(),promoted:false,batches:1,points:n,bytes:n*20};
    const view={id:'matrix-'+hours,prompt:input.value,revision:hours,sql:'SELECT controlled_fixture',source:'webgpu',context,timing,
      plan:{metric:'wave_height',aggregate:'avg',bucketMinutes:60,windowHours:hours,splitByVessel:true,vessel:null,view:'surface'}};
    ui.handleEvent({type:'start',view});
    const batch={x:Float64Array.from({length:n},(_,i)=>start+Math.floor(i/6)*3600000),
      y:Float64Array.from({length:n},(_,i)=>2+2*Math.sin(i/15)),series:Int32Array.from({length:n},(_,i)=>i%6),length:n,byteLength:n*20};
    ui.handleEvent({type:'batch',id:view.id,batch});ui.handleEvent({type:'complete',id:view.id,timing});
  };
  window.matrixGeometry=()=>{
    const card=matrixCard.element,r=matrixCard.renderer;
    const rect=node=>{const b=node.getBoundingClientRect();return{x:b.x,y:b.y,bottom:b.bottom,width:b.width,height:b.height};};
    return {height:matrixCard.height,width:matrixCard.width,domHeight:card.offsetHeight,
      canvasHeight:r.height,projectionHeight:r.projectedHeight,
      body:rect(card.querySelector('.card-body')),stats:rect(card.querySelector('.card-stats')),
      timings:rect(card.querySelector('.card-timings')),footer:rect(card.querySelector('.card-footer')),
      details:rect(card.querySelector('.sql-panel')),card:rect(card),
      coverage:!card.querySelector('[data-card-el="coverage-note"]').hidden,
      rotation:!card.querySelector('[data-card-el="rotation-wrap"]').hidden};
  };
}'''


def settle(page):
    page.evaluate('new Promise(requestAnimationFrame).then(()=>new Promise(requestAnimationFrame))')
    page.wait_for_function("document.querySelector('.result-card[data-selected=\"true\"] [data-card-el=\"result-state\"]')?.textContent.trim()==='COMPLETE'")


def new_fixture(browser, url, width, height, errors):
    page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
    page.set_default_timeout(20_000)
    page.on('pageerror',lambda error:errors.append(str(error)))
    quiet_vite(page)
    page.route('**/mobile-matrix-harness',lambda route:route.fulfill(status=200,content_type='text/html',body='<div id="app"></div>'))
    page.goto(url.rstrip('/')+'/mobile-matrix-harness')
    page.evaluate(SETUP)
    return page


def run(args):
    with sync_playwright()as playwright:
        browser=playwright.chromium.launch(headless=True,args=['--no-sandbox'])
        errors=[]
        try:
            mobile=new_fixture(browser,args.url,390,844,errors)
            empty=mobile.locator('.canvas-space').bounding_box()
            assert empty['height']<560, 'An empty canvas must retain the compact mobile landing layout'
            mobile.locator('[data-el="input"]').scroll_into_view_if_needed()
            assert mobile.locator('[data-el="input"]').is_visible(), 'The mobile composer must remain scroll-accessible'
            mobile.evaluate('window.scrollTo(0,0)')
            mobile.evaluate('showSurface(24)');settle(mobile)
            standard=mobile.evaluate('matrixGeometry()')
            assert standard['height']==standard['domHeight'],standard
            assert standard['canvasHeight']>=180 and standard['projectionHeight']>=40,standard
            assert standard['card']['width']>=320, 'Default mobile fit must keep chart labels readable'
            assert standard['rotation'],standard
            if args.screenshot:mobile.screenshot(path=args.screenshot,full_page=True)

            # A longer requested window adds coverage text above the normal legend.
            mobile.evaluate('showSurface(710*24)');settle(mobile)
            covered=mobile.evaluate('matrixGeometry()')
            assert covered['coverage'] and covered['rotation'],covered
            assert covered['canvasHeight']>=180 and covered['projectionHeight']>=40,covered
            assert covered['height']==covered['domHeight'],covered
            if args.screenshot:
                path=Path(args.screenshot)
                mobile.screenshot(path=str(path.with_stem(path.stem+'-coverage')),full_page=True)
            mobile.locator('[data-action="sql"]').click()
            details=mobile.evaluate('matrixGeometry()')
            assert details['details']['bottom']<=details['stats']['y'],details
            assert details['details']['bottom']<=details['timings']['y'],details
            assert details['details']['y']>=details['body']['y']-1,details
            assert details['details']['bottom']<=details['body']['bottom']+1,details
            mobile.locator('[data-action="sql"]').click()

            # Resize through the actual workspace pointer path, then switch views.
            handle=mobile.locator('.result-card[data-selected="true"] .card-resize-handle').bounding_box()
            x=handle['x']+handle['width']/2;y=handle['y']+handle['height']/2
            mobile.mouse.move(x,y);mobile.mouse.down();mobile.mouse.move(x,y+80,steps=8);mobile.mouse.up()
            grown=mobile.evaluate('matrixGeometry()')
            assert grown['height']>covered['height']+60,grown
            assert abs(grown['height']-grown['domHeight'])<=1,grown
            mobile.locator('[data-el="representation"]').select_option('line');settle(mobile)
            mobile.locator('[data-el="representation"]').select_option('surface');settle(mobile)
            assert mobile.evaluate('matrixCard.height')==grown['height'], 'Switching views must preserve an explicit larger height'
            # An undersized matrix must be clamped in the shared geometry model,
            # so Fit/Arrange use the same size as the element actually displays.
            mobile.evaluate('matrixCard.height=350;matrixCard.layout()');settle(mobile)
            clamped=mobile.evaluate('matrixGeometry()')
            assert clamped['height']==clamped['domHeight'] and clamped['height']>=covered['height'],clamped
            assert clamped['projectionHeight']>=40,clamped
            mobile.locator('[data-action="fit"]').click()
            settle(mobile)
            assert mobile.evaluate('matrixCard.height')==clamped['height']
            assert not mobile.evaluate('document.documentElement.scrollWidth>innerWidth')
            mobile.locator('[data-el="input"]').scroll_into_view_if_needed()
            assert mobile.locator('[data-el="input"]').is_visible()
            mobile.evaluate('ui.destroy()');mobile.close()

            desktop=new_fixture(browser,args.url,1440,1000,errors)
            desktop.evaluate('showSurface(24)');settle(desktop)
            regular=desktop.evaluate('matrixGeometry()')
            assert regular['height']==560 and regular['domHeight']==560,regular
            desktop.locator('[data-action="sql"]').click()
            assert desktop.evaluate('matrixGeometry().details.bottom<=matrixGeometry().stats.y')
            desktop.evaluate('ui.destroy()');desktop.close()
            assert not errors,errors
            print(json.dumps({'chromium':browser.version,'mobile':standard,'coverage':covered,
              'detailsAboveStats':True,'explicitResizePreserved':True,'minimumUsesGeometryModel':True,
              'desktopHeight':regular['height'],'pageErrors':errors},indent=2))
        finally:browser.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:5173')
    parser.add_argument('--screenshot')
    run(parser.parse_args())
