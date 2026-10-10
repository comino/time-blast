#!/usr/bin/env python3
"""Untimed real DuckDB checks for read-only execution and phase cancellation.

No LLM, numeric copies or performance claims. The test deliberately substitutes
an UPDATE in compiler metadata to verify the engine transaction rejects writes.
It uses only a disposable browser-owned synthetic database.
"""
import argparse
import json
from playwright.sync_api import sync_playwright
from browser_views import quiet_vite

CHECK = r'''async () => {
  const {DuckDBAdapter}=await import('/src/adapters/duckdb.ts');
  const {WasmQueryCompiler}=await import('/src/core/compiler.ts');
  const database=new DuckDBAdapter('demo'),compiler=new WasmQueryCompiler();
  const assert=(ok,message)=>{if(!ok)throw Error(message);};
  try {
    const context=await database.prepare();await compiler.prepare();
    const plan={metric:'speed',aggregate:'avg',bucketMinutes:60,windowHours:24,splitByVessel:true,vessel:null,view:'line'};
    const sql=compiler.compile(plan,context),firstBucket=compiler.compileFirstBucket(plan,context);
    let ordinal=0,sends=[];
    const connect=database.engine.connect.bind(database.engine);
    database.engine.connect=async()=>{
      const connection=await connect(),send=connection.send.bind(connection);
      connection.send=(...args)=>{sends.push(args[0]);return send(...args);};return connection;
    };
    const request=(execution=undefined,signal=new AbortController().signal)=>({id:'safety-'+(++ordinal),
      sql,plan,context,signal,priority:'committed',firstBucket:execution});
    const consume=async input=>{const batches=[];for await(const batch of database.execute(input))batches.push(batch);return batches;};
    const equal=(left,right)=>{
      let a=0,b=0,ai=0,bi=0,rows=0;
      while(a<left.length&&b<right.length){
        for(const field of ['x','series','y','lat','lon'])assert(Object.is(left[a][field][ai],right[b][field][bi]),'Recovery changed '+field);
        rows++;if(++ai===left[a].length){a++;ai=0;}if(++bi===right[b].length){b++;bi=0;}
      }
      assert(a===left.length&&b===right.length&&rows===144,'Recovery changed cardinality');return rows;
    };
    const baseline=await consume(request()),writes=[];
    const mutation=`UPDATE telemetry SET speed = speed + 100 WHERE t >= ${context.end-24*3600000} AND vessel = 0 RETURNING t::DOUBLE AS x, speed::DOUBLE AS y, vessel::INTEGER AS series, lat::DOUBLE AS lat, lon::DOUBLE AS lon`;
    for(const phase of ['firstSql','remainderSql']){
      sends=[];let rows=0,error;
      try{for await(const batch of database.execute(request({...firstBucket,[phase]:mutation})))rows+=batch.length;}
      catch(failure){error=String(failure);}
      assert(error&&/read.only/i.test(error),'Engine did not reject the UPDATE as read-only: '+error);
      assert(rows===(phase==='firstSql'?0:6),'Unexpected points before rejected write');
      const startedStatements=sends.length;
      const recoveryRows=equal(baseline,await consume(request()));
      writes.push({phase,error,pointsBeforeError:rows,startedStatements,recoveryRows,valuesUnchanged:true});
    }
    sends=[];const early=database.execute(request(firstBucket));
    assert((await early.next()).value.length===6,'Expected a complete prefix');
    await early.return();assert(sends.length===1,'Early return started the remainder');
    equal(baseline,await consume(request()));
    sends=[];const controller=new AbortController(),running=database.execute(request(firstBucket,controller.signal));
    assert((await running.next()).value.length===6,'Expected prefix before remainder cancellation');
    assert((await running.next()).value.length>0&&sends.length===2,'Remainder did not start');
    controller.abort();let cancellation;
    try{await running.next();}catch(error){cancellation=error.name;}
    assert(cancellation==='AbortError','Remainder cancellation reported completion');
    equal(baseline,await consume(request()));
    return {datasetRows:context.rowCount,writes,earlyReturnSkippedRemainder:true,remainderCancellation:cancellation,
      recoveryValuesExact:true,performanceMeasured:false};
  } finally {await database.dispose();}
}'''


def run(args):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        try:
            page = browser.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            quiet_vite(page)
            page.route('**/first-bucket-safety', lambda route: route.fulfill(content_type='text/html', body=''))
            page.goto(args.url.rstrip('/') + '/first-bucket-safety')
            result = page.evaluate(CHECK)
            assert not errors, errors
            print(json.dumps({'browser': browser.version, 'result': result, 'pageErrors': errors}, indent=2))
        finally:
            browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:5173')
    run(parser.parse_args())
