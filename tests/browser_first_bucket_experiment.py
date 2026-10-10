#!/usr/bin/env python3
"""Paired comparison: whole-window SQL versus first complete bucket + remainder.

Run only after other
CPU/GPU workloads have stopped. All timed cases use the real DuckDB adapter,
Rust/Wasm compiler and prepared line-chart card. Production uses one adapter
execution, connection and read-only transaction. The retained experimental mode
uses two ordinary adapter executions/connections. Both are restricted to bundled
application-managed immutable table. No remote/live snapshot claim is made.

Example after inference evaluations finish:
  python3 tests/browser_first_bucket_experiment.py --trials 6 --output /tmp/first-bucket.json
Inspect numeric equality and total completion overhead alongside first drawing.
The report identifies the implementation and hashes all changed execution code.
"""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path
from playwright.async_api import async_playwright
from browser_database import installed_versions

ROOT = Path(__file__).resolve().parents[1]
BASE = {'metric': 'wave_height', 'aggregate': 'avg', 'bucketMinutes': 1,
        'windowHours': 168, 'splitByVessel': True, 'vessel': None, 'view': 'line'}
CASES = [
    {'id': 'minute_week_vessels', 'plan': BASE, 'points': 60480},
    {'id': 'hour_day_vessels', 'plan': {**BASE, 'metric': 'wind', 'aggregate': 'max', 'bucketMinutes': 60, 'windowHours': 24}, 'points': 144},
    {'id': 'six_hour_partial_lower', 'plan': {**BASE, 'metric': 'speed', 'bucketMinutes': 360, 'windowHours': 25}, 'points': 30},
    {'id': 'minute_week_named', 'plan': {**BASE, 'aggregate': 'min', 'splitByVessel': False, 'vessel': 2}, 'points': 10080},
    {'id': 'hour_week_fleet', 'plan': {**BASE, 'metric': 'water_temp', 'bucketMinutes': 60, 'splitByVessel': False}, 'points': 168},
    {'id': 'single_partial_day_bucket', 'plan': {**BASE, 'metric': 'speed', 'bucketMinutes': 1440, 'windowHours': 1, 'splitByVessel': False}, 'points': 1},
]

EXPERIMENT = r'''async ({cases,trials,warmups,profile,implementation}) => {
  const {DuckDBAdapter}=await import('/src/adapters/duckdb.ts');
  const {WasmQueryCompiler}=await import('/src/core/compiler.ts');
  const {ResultCard}=await import('/src/ui/result-card.ts');
  const {MAX_RESULT_ROWS,MAX_RESULT_BYTES,accountRetainedBytes,checkAbort}=await import('/src/adapters/arrow.ts');
  await import('/src/ui/styles.css');
  const assert=(ok,message)=>{if(!ok)throw Error(message);};
  const frame=()=>new Promise(requestAnimationFrame);
  const database=new DuckDBAdapter(profile),compiler=new WasmQueryCompiler();
  let card,ordinal=0;
  const startupAt=performance.now();
  try {
    const context=await database.prepare();await compiler.prepare();
    const startupMs=performance.now()-startupAt;
    assert(['synthetic-vessels-2026-09-v1','synthetic-vessels-2026-09-6s-v1'].includes(context.id), 'Only bundled immutable snapshots are allowed');
    // Test-only instrumentation observes actual worker calls, including skipped
    // remainder calls after cancellation. It does not replace engine behavior.
    let onPhysicalStatement,queryConnections=0;
    const connect=database.engine.connect.bind(database.engine);
    database.engine.connect=async()=>{
      queryConnections++;const connection=await connect(),send=connection.send.bind(connection);
      connection.send=(...args)=>{onPhysicalStatement?.(args[0]);return send(...args);};
      return connection;
    };
    const bounds=plan=>{
      const lower=Math.max(context.start,context.end-plan.windowHours*3600000),end=context.end,bucket=plan.bucketMinutes*60000;
      const cut=Math.min(end,(Math.floor(lower/bucket)+1)*bucket);
      assert(Number.isSafeInteger(lower)&&Number.isSafeInteger(cut)&&lower<cut&&cut<=end,'Invalid partition bounds');
      return {lower,cut,end,bucket,split:cut<end};
    };
    // Experimental use of the existing compiler: ephemeral compilation bounds
    // restrict WHERE only. The real QueryRequest and card keep the original
    // immutable dataset context and unchanged logical plan. Production should
    // expose an explicit bounded-range compiler operation instead of doing this.
    const statements=(plan,sql,mode)=>{
      const range=bounds(plan);
      if(mode==='baseline'||!range.split)return {range,sql:[sql]};
      return {range,sql:[compiler.compile(plan,{...context,start:range.lower,end:range.cut}),
        compiler.compile(plan,{...context,start:range.cut,end:range.end})]};
    };
    async function* stream(plan,sql,mode,signal,onStatement,onPlanning) {
      checkAbort(signal);const at=performance.now();
      if(implementation==='production') {
        const firstBucket=mode==='first_bucket'?compiler.compileFirstBucket(plan,context):undefined;
        onPlanning?.(performance.now()-at,bounds(plan));
        onPhysicalStatement=onStatement;
        try {
          yield* database.execute({id:'partition-production-'+ordinal,sql,plan,context,signal,priority:'committed',firstBucket});
        } finally {onPhysicalStatement=undefined;}
        return;
      }
      const program=statements(plan,sql,mode);onPlanning?.(performance.now()-at,program.range);
      const retained=new WeakSet();let rows=0,bytes=0;
      for(const part of program.sql) {
        checkAbort(signal);onStatement(part);
        for await(const batch of database.execute({id:'partition-experiment-'+ordinal,sql:part,plan,context,signal,priority:'committed'})) {
          checkAbort(signal);rows+=batch.length;bytes+=accountRetainedBytes(batch,retained);
          assert(rows<=MAX_RESULT_ROWS&&bytes<=MAX_RESULT_BYTES,'Combined logical result exceeded its original budget');
          yield batch;
        }
      }
    }
    const run=async(fixture,mode)=>{
      card?.destroy();const id='partition-view-'+(++ordinal),plan=fixture.plan;
      const sql=compiler.compile(plan,context); // existing logical compile is outside both DB timings
      let firstDrawAt,firstDrawPoints,firstBatchAt,halfAt,physicalStatements=0,planningMs,range;
      const timing={startedAt:0,committedAt:0,promoted:false,batches:0,points:0,bytes:0};
      card=new ResultCard(id,fixture.id,document.querySelector('#root'),{
        select(){},close(){},duplicate(){},cancel(){},change(){},
        draw(_id,at){firstDrawAt??=at;firstDrawPoints??=card.total;},
      });
      card.width=1000;card.height=740;card.layout();card.select(true);
      card.begin({id,prompt:fixture.id,revision:ordinal,plan,sql,source:'template',context,timing});
      await frame();await frame(); // prepare geometry equally; no SQL/model work here
      const batches=[],unique=new WeakSet();let bytes=0,rows=0;
      const beforeConnections=queryConnections;
      const startedAt=performance.now();timing.startedAt=timing.committedAt=timing.queryStartedAt=startedAt;
      for await(const batch of stream(plan,sql,mode,new AbortController().signal,()=>physicalStatements++,
          (ms,value)=>{planningMs=ms;range=value;})) {
        const at=performance.now();firstBatchAt??=at;timing.firstBatchAt??=at;timing.firstPublishedAt??=at;
        rows+=batch.length;bytes+=accountRetainedBytes(batch,unique);
        timing.points=rows;timing.batches++;timing.bytes+=batch.byteLength;
        batches.push(batch); // retain borrowed batch references for post-timing comparison only
        card.append(batch);
        assert(card.batches.at(-1)===batch,'Card copied/replaced a producer batch');
        if(rows>=fixture.points/2)halfAt??=at;
      }
      const completedAt=performance.now();timing.completedAt=completedAt;card.finish(timing);
      for(let n=0;n<600&&card.busy;n++)await frame();
      assert(!card.busy&&rows===fixture.points,'Wrong cardinality or incomplete chart');
      assert(firstDrawAt!==undefined&&firstBatchAt!==undefined,'Expected a visible complete first point');
      if(implementation==='production')assert(queryConnections-beforeConnections===1,'Production query opened more than one connection');
      if(mode==='first_bucket'&&range.split){
        assert(firstDrawPoints===(plan.vessel!==null||!plan.splitByVessel?1:context.vessels.length),'First drawing did not use the complete prefix group');
        assert(firstDrawAt<completedAt,'Prefix drawing waited for completion');
      }
      const fullDrawAt=performance.now();
      return {batches,record:{case:fixture.id,mode,plan,range,physicalStatements,queryConnections:queryConnections-beforeConnections,planningMs,rows,batches:batches.length,
        retainedBytes:bytes,firstBatchMs:firstBatchAt-startedAt,firstDrawMs:firstDrawAt-startedAt,
        firstDrawReceivedPoints:firstDrawPoints,halfDataMs:halfAt-startedAt,totalMs:completedAt-startedAt,
        fullDrawMs:fullDrawAt-startedAt,borrowedProducerBatches:true,cardPreparedBeforeTiming:true}};
    };
    // Numeric verification happens after both timers, traversing retained views
    // with two cursors. No rows, merged arrays, or copied numeric payloads.
    const compare=(left,right)=>{
      const fields=['x','series','y','lat','lon'];
      const differences=Object.fromEntries(fields.map(name=>[name,{count:0,maxAbsolute:0,maxRelative:0}]));
      let a=0,ai=0,b=0,bi=0,rows=0;
      while(a<left.length&&b<right.length) {
        const x=left[a],y=right[b];
        for(const name of fields) {
          assert(x[name]&&y[name],'Missing comparison column '+name);
          const before=x[name][ai],after=y[name][bi];
          if(!Object.is(before,after)) {
            const diff=differences[name];diff.count++;
            const delta=Math.abs(before-after);diff.maxAbsolute=Math.max(diff.maxAbsolute,delta);
            diff.maxRelative=Math.max(diff.maxRelative,delta/Math.max(Number.MIN_VALUE,Math.abs(before),Math.abs(after)));
          }
        }
        rows++;if(++ai===x.length){a++;ai=0;}if(++bi===y.length){b++;bi=0;}
      }
      assert(a===left.length&&b===right.length,'Partition cardinality changed');
      return {rows,exactNumericMatch:fields.every(name=>differences[name].count===0),
        exactKeysAndOrder:differences.x.count===0&&differences.series.count===0,differences};
    };
    const pairs=[];
    for(let caseIndex=0;caseIndex<cases.length;caseIndex++) {
      const fixture=cases[caseIndex];
      for(let n=0;n<warmups;n++)for(const mode of ['baseline','first_bucket']) {
        const result=await run(fixture,mode);result.batches.length=0;
      }
      for(let trial=0;trial<trials;trial++) {
        const order=(trial+caseIndex)%2?['first_bucket','baseline']:['baseline','first_bucket'];
        const values={};for(const mode of order)values[mode]=await run(fixture,mode);
        const equality=compare(values.baseline.batches,values.first_bucket.batches);
        pairs.push({case:fixture.id,trial,order,baseline:values.baseline.record,firstBucket:values.first_bucket.record,equality,
          firstDrawSavedMs:values.baseline.record.firstDrawMs-values.first_bucket.record.firstDrawMs,
          totalOverheadMs:values.first_bucket.record.totalMs-values.baseline.record.totalMs});
        values.baseline.batches.length=values.first_bucket.batches.length=0;
      }
    }
    // Functional cancellation check is deliberately outside the timing trials.
    const fixture=cases.find(item=>bounds(item.plan).split);
    let cancellation;
    if(fixture) {
      const controller=new AbortController(),sql=compiler.compile(fixture.plan,context);let started=0;
      const iterator=stream(fixture.plan,sql,'first_bucket',controller.signal,()=>started++);
      const first=await iterator.next();assert(!first.done&&first.value.length>0,'Prefix did not produce a final aggregate');
      controller.abort();let errorName;
      try{await iterator.next();}catch(error){errorName=error.name;}
      await iterator.return();
      assert(errorName==='AbortError'&&started===1,'Cancellation did not fence the remainder');
      let recoveryRows=0;
      for await(const batch of database.execute({id:'after-partition-cancel',sql,plan:fixture.plan,context,
        signal:new AbortController().signal,priority:'committed'}))recoveryRows+=batch.length;
      assert(recoveryRows===fixture.points,'Canceled prefix affected the next query');
      cancellation={remainderSkipped:true,startedStatements:started,recoveryRows,errorName};
    }
    return {status:'measured_experiment',implementation,profile,contextId:context.id,datasetRows:context.rowCount,startupMs,trials,warmups,pairs,cancellation,
      scope:'Warm bundled DuckDB plus prepared line card; no model, remote service or concurrent query',
      firstBucketUsesTwoAdapterConnections:implementation==='experimental',readOnlyTransaction:implementation==='production',
      originalRequestContextPreserved:true,physicalPresentationMeasured:false,
      correctnessOracleRetainsAtMostTwoResults:true,numericBuffersCopiedForOracle:false};
  } finally {card?.destroy();await database.dispose();}
}'''


def quantile(values, fraction):
    values = sorted(values)
    position = (len(values)-1)*fraction
    lo = int(position)
    hi = min(lo+1, len(values)-1)
    return values[lo]+(values[hi]-values[lo])*(position-lo)


def summarize(result):
    summary = []
    for case in CASES:
        pairs = [pair for pair in result['pairs'] if pair['case'] == case['id']]
        if not pairs:
            continue
        stats = {}
        for variant in ['baseline', 'firstBucket']:
            stats[variant] = {metric: {'median': quantile([p[variant][metric] for p in pairs], .5),
                                       'p95': quantile([p[variant][metric] for p in pairs], .95)}
                              for metric in ['firstBatchMs', 'firstDrawMs', 'halfDataMs', 'totalMs', 'fullDrawMs']}
        summary.append({'case': case['id'], 'pairs': len(pairs), 'statistics': stats,
                        'medianFirstDrawSavedMs': quantile([p['firstDrawSavedMs'] for p in pairs], .5),
                        'medianTotalOverheadMs': quantile([p['totalOverheadMs'] for p in pairs], .5),
                        'allKeysAndOrderExact': all(p['equality']['exactKeysAndOrder'] for p in pairs),
                        'allNumericValuesExact': all(p['equality']['exactNumericMatch'] for p in pairs)})
    return summary


async def run(args):
    selected = [case for case in CASES if not args.case or case['id'] in args.case]
    if args.dry_run:
        print(json.dumps({'status': 'not_run', 'implementation': args.implementation, 'cases': selected, 'trials': args.trials, 'warmups': args.warmups}, indent=2))
        return
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--no-sandbox'])
        try:
            page = await browser.new_page(viewport={'width': 1200, 'height': 950}, device_scale_factor=1)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.route('**/@vite/client', lambda route: route.fulfill(status=200, content_type='text/javascript', body='export const createHotContext=()=>({accept(){},dispose(){},prune(){}}); export function updateStyle(id,css){const s=document.createElement("style");s.textContent=css;document.head.append(s);} export function removeStyle(){}'))
            await page.route('**/first-bucket-experiment', lambda route: route.fulfill(status=200, content_type='text/html', body='<div id="root" style="position:relative;width:1100px;height:850px"></div>'))
            await page.goto(args.url.rstrip('/')+'/first-bucket-experiment')
            result = await asyncio.wait_for(page.evaluate(EXPERIMENT, {'cases': selected, 'trials': args.trials, 'warmups': args.warmups, 'profile': args.dataset_profile, 'implementation': args.implementation}), timeout=args.timeout)
            report = {'versions': {**installed_versions(), 'chromium': browser.version},
                      'sourceSHA256': {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in
                                      ['tests/browser_first_bucket_experiment.py', 'src/adapters/duckdb.ts', 'src/adapters/arrow.ts', 'src/core/compiler.ts', 'crates/query-core/src/lib.rs', 'public/wasm/query-core.wasm', 'src/ui/chart.ts']},
                      'summary': summarize(result), 'result': result, 'pageErrors': errors,
                      'limitations': ['Warm trials only; small-sample p95 is descriptive, not a reliable production tail estimate.',
                                      'Production uses a shared read-only transaction on an owned bundled snapshot; experimental mode relies on application-managed immutability.' if args.implementation == 'production' else 'The experimental separate SELECT statements rely on application-managed immutable local data, not a transaction snapshot.',
                                      'Result verification retains borrowed batches outside the timing path; no full-result numeric copy is made.',
                                      'Any numeric mismatch blocks claiming an exact baseline-equivalent optimization. Inspect avg-related drift explicitly.',
                                      'First drawing is Canvas submission, not physical presentation. Timings include harness/card/budget bookkeeping.']}
            report['exactEquivalencePassed'] = all(pair['equality']['exactNumericMatch'] and pair['equality']['exactKeysAndOrder']
                                                   for pair in result['pairs'])
            text = json.dumps(report, indent=2)+'\n'
            if args.output:
                Path(args.output).write_text(text)
            print(text)
            assert not errors, errors
            assert report['exactEquivalencePassed'], 'Observed result differences; inspect the saved report before considering an exact optimization'
        finally:
            await browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:5173')
    parser.add_argument('--dataset-profile', choices=['demo', 'large'], default='large')
    parser.add_argument('--implementation', choices=['production', 'experimental'], default='production')
    parser.add_argument('--trials', type=int, default=6)
    parser.add_argument('--warmups', type=int, default=1)
    parser.add_argument('--timeout', type=float, default=180)
    parser.add_argument('--case', action='append', choices=[case['id'] for case in CASES])
    parser.add_argument('--output')
    parser.add_argument('--dry-run', action='store_true', help='Print the bounded experiment plan without starting Chromium or DuckDB')
    args = parser.parse_args()
    if not 1 <= args.trials <= 20 or not 0 <= args.warmups <= 3 or not 1 <= args.timeout <= 600:
        parser.error('Use 1–20 trials, 0–3 warmups, and a 1–600 second timeout')
    asyncio.run(run(args))
