import {afterEach,describe,expect,it,vi} from 'vitest';
import {BrowserCoordinator} from '../src/core/coordinator';
import type {ColumnBatch,DatabaseAdapter,DatasetContext,Draft,InferenceAdapter,InferenceResult,PipelineEvent,QueryCompiler,QueryPlan} from '../src/core/types';

const context:DatasetContext={id:'snapshot-1',label:'Test',rowCount:2,start:0,end:86_400_000,vessels:['A'],description:'Test'};
const plan:QueryPlan={metric:'speed',aggregate:'avg',bucketMinutes:60,windowHours:24,splitByVessel:false,vessel:null,view:'line'};
const batch:ColumnBatch={x:new Float64Array([0,3600000]),y:new Float64Array([12,14]),series:new Int32Array([0,0]),length:2,byteLength:40};
const draft=(text='Average speed by hour',revision=1):Draft=>({text,revision,contextId:context.id,sentAt:performance.now()});
function harness(overrides:{database?:DatabaseAdapter;inference?:InferenceAdapter;speculativeBytes?:number}={}) {
  const events:PipelineEvent[]=[];
  const inference:InferenceAdapter=overrides.inference??{id:'test',placement:'browser',prepare:async()=>{},observeDraft:vi.fn(),dispose(){},resolve:vi.fn(async()=>({plan,source:'template' as const}))};
  const database:DatabaseAdapter=overrides.database??{id:'test-db',placement:'browser',prepare:async()=>context,dispose:async()=>{},execute:vi.fn(async function*(){yield batch;})};
  const compiler:QueryCompiler={kind:'rust-wasm',prepare:async()=>{},compile:vi.fn(()=>'SQL')};
  const coordinator=new BrowserCoordinator({inference,database,compiler,context,emit:e=>events.push(e),speculation:true,debounceMs:10,speculativeBytes:overrides.speculativeBytes});
  return {coordinator,events,inference,database,compiler};
}
afterEach(()=>vi.useRealTimers());
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};

describe('draft preparation and commit correctness',()=>{
  it('promotes exact prepared work without copying or executing again',async()=>{
    vi.useFakeTimers(); const h=harness();const d=draft();
    h.coordinator.observeDraft(d);await vi.advanceTimersByTimeAsync(15);
    expect(h.events.some(e=>e.type==='batch')).toBe(false);
    expect(h.events.some(e=>e.type==='speculation'&&e.state==='ready')).toBe(true);
    const committed={...d,sentAt:performance.now()};h.coordinator.commit(committed);
    const delivered=h.events.find(e=>e.type==='batch');
    expect(delivered?.type==='batch'&&delivered.batch).toBe(batch);
    expect(h.database.execute).toHaveBeenCalledTimes(1);
    const complete=h.events.find(e=>e.type==='complete');
    expect(complete?.type==='complete'&&complete.timing.promoted).toBe(true);
    expect(complete?.type==='complete'&&complete.timing.committedAt).toBe(committed.sentAt);
    h.coordinator.dispose();
  });
  it('does not promote another question, even when inference completes after cancellation',async()=>{
    vi.useFakeTimers();let resolveFirst!:(value:any)=>void;let calls=0;
    const inference:InferenceAdapter={id:'delayed',placement:'browser',prepare:async()=>{},dispose(){},observeDraft(){},resolve:()=>{
      calls++;return calls===1?new Promise(r=>{resolveFirst=r;}):Promise.resolve({plan,source:'template'});
    }};
    const h=harness({inference});h.coordinator.observeDraft(draft());await vi.advanceTimersByTimeAsync(15);
    h.coordinator.commit(draft('Maximum wind by hour',2));await settle();
    resolveFirst({plan,source:'template'});await settle();
    const starts=h.events.filter(e=>e.type==='start');expect(starts).toHaveLength(1);
    expect(starts[0].type==='start'&&starts[0].view.prompt).toBe('Maximum wind by hour');
    expect(h.database.execute).toHaveBeenCalledTimes(1);h.coordinator.dispose();
  });
  it('promotes in-flight inference once and labels it separately from a ready result',async()=>{
    vi.useFakeTimers();let resolve!:(value:any)=>void;
    const inference:InferenceAdapter={id:'slow',placement:'browser',prepare:async()=>{},dispose(){},observeDraft(){},resolve:vi.fn(()=>new Promise<InferenceResult>(r=>{resolve=r;}))};
    const h=harness({inference});const d=draft();h.coordinator.observeDraft(d);await vi.advanceTimersByTimeAsync(15);
    h.coordinator.commit({...d,sentAt:performance.now()});resolve({plan,source:'webgpu'});await settle();
    expect(inference.resolve).toHaveBeenCalledTimes(1);expect(h.events.filter(e=>e.type==='start')).toHaveLength(1);
    const complete=h.events.find(e=>e.type==='complete');expect(complete?.type==='complete'&&complete.timing.promoted).toBe(false);
    h.coordinator.dispose();
  });
  it('does not speculate during IME composition or on an obsolete revision',async()=>{
    vi.useFakeTimers();const h=harness();h.coordinator.observeDraft(draft('平均',3),true);
    h.coordinator.observeDraft(draft('old wording',2));await vi.advanceTimersByTimeAsync(50);
    expect(h.inference.resolve).not.toHaveBeenCalled();h.coordinator.dispose();
  });
  it('rejects a different snapshot before inference',()=>{
    const h=harness();h.coordinator.commit({...draft(),contextId:'different'});
    expect(h.inference.resolve).not.toHaveBeenCalled();expect(h.events.some(e=>e.type==='error')).toBe(true);h.coordinator.dispose();
  });
  it('drops over-budget speculative data and executes a fresh committed query',async()=>{
    vi.useFakeTimers();const h=harness({speculativeBytes:1});const d=draft();
    h.coordinator.observeDraft(d);await vi.advanceTimersByTimeAsync(15);
    h.coordinator.commit(d);await settle();
    expect(h.database.execute).toHaveBeenCalledTimes(2);expect(h.events.filter(e=>e.type==='batch')).toHaveLength(1);h.coordinator.dispose();
  });
  it('publishes the first batch before the producer completes and fences late canceled batches',async()=>{
    let finish!:()=>void;const suspended=new Promise<void>(r=>{finish=r;});
    const database:DatabaseAdapter={id:'stream',placement:'browser',prepare:async()=>context,dispose:async()=>{},execute:async function*(){yield batch;await suspended;yield batch;}};
    const h=harness({database});h.coordinator.commit(draft());await settle();
    expect(h.events.filter(e=>e.type==='batch')).toHaveLength(1);
    expect(h.events.some(e=>e.type==='complete')).toBe(false);
    h.coordinator.cancel();finish();await settle();
    expect(h.events.filter(e=>e.type==='batch')).toHaveLength(1);
    expect(h.events.some(e=>e.type==='complete')).toBe(false);h.coordinator.dispose();
  });
});
