import {readFile} from 'node:fs/promises';
import {beforeAll,expect,it,vi} from 'vitest';
import {WasmQueryCompiler} from '../src/core/compiler';
import type {DatasetContext,QueryPlan} from '../src/core/types';
import {CHART_VIEWS} from '../src/core/types';
import {MAX_WINDOW_HOURS} from '../src/core/query-limits';
const context:DatasetContext={id:'test',label:'test',rowCount:1,start:0,end:86400000,vessels:['A'],description:''};
const plan:QueryPlan={metric:'speed',aggregate:'avg',bucketMinutes:60,windowHours:24,splitByVessel:false,vessel:null,view:'line'};
let compiler:WasmQueryCompiler;
beforeAll(async()=>{
  const bytes=await readFile(new URL('../public/wasm/query-core.wasm',import.meta.url));
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(bytes)));
  compiler=new WasmQueryCompiler();await compiler.prepare();vi.unstubAllGlobals();
});
it('runs the checked-in Rust/Wasm compiler',()=>{
  const sql=compiler.compile(plan,context);
  expect(sql).toContain('avg(speed)::DOUBLE AS y');expect(sql).toContain('t >= 0 AND t < 86400000');
  expect(sql).toContain('GROUP BY 1, 3');
});
it('rejects wrapped integers and identifiers before the WASM ABI',()=>{
  for(const invalid of [{bucketMinutes:2**32+60},{windowHours:2**32+24},{windowHours:MAX_WINDOW_HOURS+1},{windowHours:NaN},{windowHours:Infinity},{windowHours:0},{windowHours:-1},{windowHours:1.5},{vessel:2**32},{metric:'speed; DROP TABLE telemetry'}]) {
    expect(()=>compiler.compile({...plan,...invalid} as QueryPlan,context)).toThrow();
  }
});
it.each([15*24,710*24,MAX_WINDOW_HOURS])('compiles %s requested hours using available coverage in the checked-in Wasm binary',windowHours=>{
  const snapshot={...context,start:Date.UTC(2026,8,1),end:Date.UTC(2026,8,15)};
  const requested=Object.freeze({...plan,windowHours});
  expect(compiler.compile(requested,snapshot)).toContain(`t >= ${snapshot.start} AND t < ${snapshot.end}`);
  expect(requested.windowHours).toBe(windowHours);
});
it('uses actual remote dataset coverage beyond fourteen days',()=>{
  const snapshot={...context,start:Date.UTC(2020,0,1),end:Date.UTC(2026,8,15)};
  const windowHours=710*24;
  expect(compiler.compile({...plan,windowHours},snapshot)).toContain(`t >= ${snapshot.end-windowHours*3_600_000} AND t < ${snapshot.end}`);
});
it('keeps a filtered vessel identity when no split is requested',()=>{
  const sql=compiler.compile({...plan,vessel:3},context);
  expect(sql).toContain('vessel::INTEGER AS series');expect(sql).toContain('AND vessel = 3');
});
it.each(CHART_VIEWS)('keeps the Rust ABI and SQL unchanged for %s presentation',view=>{
  const baseline={...plan,splitByVessel:true};
  expect(compiler.compile({...baseline,view},context)).toBe(compiler.compile(baseline,context));
});
it.each(['map','density','tracks'])('rejects ambiguous fleet positions in %s before compilation',view=>{
  expect(()=>compiler.compile({...plan,view} as QueryPlan,context)).toThrow('Invalid query intent');
});

it('produces identical SQL for either grouping flag when exactly one vessel is selected',()=>{
  for (const vessel of [0,1,2,3,4,5]) {
    for (const aggregate of ['avg','min','max'] as const) {
      const selected={...plan,vessel,aggregate};
      expect(compiler.compile({...selected,splitByVessel:true},context)).toBe(compiler.compile({...selected,splitByVessel:false},context));
    }
  }
});

it('partitions the first complete query group without moving a partial lower bound',()=>{
  const snapshot={...context,end:48*3_600_000};
  const intent=Object.freeze({...plan,bucketMinutes:360,windowHours:25,splitByVessel:true});
  const execution=compiler.compileFirstBucket(intent,snapshot)!;
  expect(execution).toMatchObject({kind:'first-complete-bucket',contextId:snapshot.id,start:0,end:snapshot.end,sql:compiler.compile(intent,snapshot)});
  expect(execution.firstSql).toContain('t >= 82800000 AND t < 86400000');
  expect(execution.remainderSql).toContain('t >= 86400000 AND t < 172800000');
  expect(execution.firstSql).toContain('floor(t / 21600000)');
  expect(Object.isFrozen(execution)).toBe(true);
  expect(intent.windowHours).toBe(25);
});
it('retains canonical single-statement execution when the whole window is one partial bucket',()=>{
  expect(compiler.compileFirstBucket({...plan,bucketMinutes:1440,windowHours:1},context)).toBeUndefined();
});
it.each([24*15,24*710,MAX_WINDOW_HOURS])('partitions available coverage while preserving %s requested hours',windowHours=>{
  const snapshot={...context,start:1000,end:86_400_000};
  const intent={...plan,windowHours,vessel:3};
  const execution=compiler.compileFirstBucket(intent,snapshot)!;
  expect(execution.sql).toBe(compiler.compile(intent,snapshot));
  expect(execution.firstSql).toContain('t >= 1000 AND t < 3600000 AND vessel = 3');
  expect(execution.remainderSql).toContain('t >= 3600000 AND t < 86400000 AND vessel = 3');
});
it('rejects arbitrary execution cuts and ranges outside the logical window in actual Wasm',()=>{
  const intent={...plan,windowHours:1};
  const lo=context.end-3_600_000;
  for(const [lower,upper] of [[0,context.end],[lo,context.end+1],[lo+1,context.end],[lo,lo+1],
    [lo,lo],[NaN,context.end],[lo,Infinity],[lo+0.5,context.end]]){
    expect(()=>compiler.compileRange(intent,context,lower,upper)).toThrow();
  }
  expect(compiler.compileRange(intent,context,lo,context.end)).toBe(compiler.compile(intent,context));
});
