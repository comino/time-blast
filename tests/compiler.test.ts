import {readFile} from 'node:fs/promises';
import {beforeAll,expect,it,vi} from 'vitest';
import {WasmQueryCompiler} from '../src/core/compiler';
import type {DatasetContext,QueryPlan} from '../src/core/types';
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
  for(const invalid of [{bucketMinutes:2**32+60},{windowHours:2**32+24},{vessel:2**32},{metric:'speed; DROP TABLE telemetry'}]) {
    expect(()=>compiler.compile({...plan,...invalid} as QueryPlan,context)).toThrow();
  }
});
it('keeps a filtered vessel identity when no split is requested',()=>{
  const sql=compiler.compile({...plan,vessel:3},context);
  expect(sql).toContain('vessel::INTEGER AS series');expect(sql).toContain('AND vessel = 3');
});
