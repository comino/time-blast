import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {BrowserCoordinator,LocalCoordinatorClient,translationThreshold} from '../src/core/coordinator';
import type {ColumnBatch,DatabaseAdapter,DatasetContext,Draft,InferenceAdapter,InferenceResult,PipelineEvent,QueryCompiler,QueryPlan} from '../src/core/types';

const context:DatasetContext={id:'snapshot-1',label:'Test',rowCount:2,start:0,end:86_400_000,vessels:['A'],description:'Test'};
const plan:QueryPlan={metric:'speed',aggregate:'avg',bucketMinutes:60,windowHours:24,splitByVessel:false,vessel:null,view:'line'};
const batch:ColumnBatch={x:new Float64Array([0,3600000]),y:new Float64Array([12,14]),series:new Int32Array([0,0]),length:2,byteLength:40};
const draft=(text='Average speed by hour',revision=1):Draft=>({text,revision,contextId:context.id,sentAt:performance.now()});
function harness(overrides:{database?:DatabaseAdapter;inference?:InferenceAdapter;speculativeBytes?:number;speculation?:boolean;liveTranslation?:boolean;translationMinChars?:number;debounceMs?:number;draftDebounceMs?:number}={}) {
  const events:PipelineEvent[]=[];
  const inference:InferenceAdapter=overrides.inference??{id:'test',placement:'browser',prepare:async()=>{},observeDraft:vi.fn(),dispose(){},resolve:vi.fn(async()=>({plan,source:'template' as const}))};
  const database:DatabaseAdapter=overrides.database??{id:'test-db',placement:'browser',prepare:async()=>context,dispose:async()=>{},execute:vi.fn(async function*(){yield batch;})};
  const compiler:QueryCompiler={kind:'rust-wasm',prepare:async()=>{},compile:vi.fn(()=>'SQL')};
  const coordinator=new BrowserCoordinator({inference,database,compiler,context,emit:e=>events.push(e),speculation:overrides.speculation??true,
    debounceMs:'debounceMs' in overrides?overrides.debounceMs:10,speculativeBytes:overrides.speculativeBytes,
    liveTranslation:overrides.liveTranslation,translationMinChars:overrides.translationMinChars,draftDebounceMs:overrides.draftDebounceMs});
  return {coordinator,events,inference,database,compiler};
}
beforeEach(()=>vi.stubGlobal('scheduler',{yield:()=>new Promise<void>(resolve=>setTimeout(resolve,0))}));
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function queuedTransport() {
  const messages:any[]=[];const port2={onmessage:null as any,close(){}};
  vi.stubGlobal('MessageChannel',class {port1={postMessage:(data:any)=>messages.push(data),close(){}};port2=port2;});
  return ()=>{while(messages.length)port2.onmessage({data:messages.shift()});};
}

describe('pipeline timing boundaries',()=>{
  it('separates inference, compilation, first database batch and full database streaming',async()=>{
    let now=100;vi.spyOn(performance,'now').mockImplementation(()=>now);
    let finishInference!:(result:InferenceResult)=>void,firstBatch!:()=>void,lastBatch!:()=>void;
    const first=new Promise<void>(resolve=>{firstBatch=resolve;}),last=new Promise<void>(resolve=>{lastBatch=resolve;});
    const inference:InferenceAdapter={id:'model',placement:'browser',prepare:async()=>{},dispose(){},observeDraft(){},resolve:()=>new Promise(resolve=>{finishInference=resolve;})};
    const database:DatabaseAdapter={id:'duckdb-wasm',placement:'browser',prepare:async()=>context,dispose:async()=>{},execute:async function*(){await first;yield batch;await last;yield batch;}};
    const h=harness({inference,database});vi.mocked(h.compiler.compile).mockImplementation(()=>{now+=3;return 'SQL';});
    h.coordinator.commit(draft());expect(h.events.some(event=>event.type==='start')).toBe(false);
    now=112;finishInference({plan,source:'webgpu'});await settle();
    const start=h.events.find(event=>event.type==='start');expect(start?.type).toBe('start');if(start?.type!=='start')throw new Error('Missing query start');
    expect(start.view.database).toBe('duckdb-wasm');
    expect(start.view.timing).toMatchObject({startedAt:100,inferenceStartedAt:100,intentAt:112,compiledAt:115,queryStartedAt:115});
    expect(start.view.timing.firstBatchAt).toBeUndefined();expect(start.view.timing.firstPublishedAt).toBeUndefined();
    now=132;firstBatch();await settle();
    expect(start.view.timing).toMatchObject({firstBatchAt:132,firstPublishedAt:132});
    expect(start.view.timing.completedAt).toBeUndefined();expect(h.events.filter(event=>event.type==='batch')).toHaveLength(1);
    h.coordinator.markDraw(start.view.id,140);
    now=160;lastBatch();await settle();
    expect(start.view.timing.completedAt).toBe(160);
    expect(start.view.timing.intentAt!-start.view.timing.inferenceStartedAt!).toBe(12);
    expect(start.view.timing.compiledAt!-start.view.timing.intentAt!).toBe(3);
    expect(start.view.timing.firstBatchAt!-start.view.timing.queryStartedAt!).toBe(17);
    expect(start.view.timing.completedAt!-start.view.timing.queryStartedAt!).toBe(45);
    expect(start.view.timing.firstDrawAt!-start.view.timing.firstPublishedAt!).toBe(8);
    expect(h.events.filter(event=>event.type==='complete')).toHaveLength(1);h.coordinator.dispose();
  });
  it('excludes the wait for submission from prepared SQL inference and database work',async()=>{
    let now=50;vi.spyOn(performance,'now').mockImplementation(()=>now);
    let finishInference!:(result:InferenceResult)=>void,finishQuery!:()=>void;
    const held=new Promise<void>(resolve=>{finishQuery=resolve;});
    const inference:InferenceAdapter={id:'model',placement:'remote',prepare:async()=>{},dispose(){},observeDraft(){},resolve:vi.fn(()=>new Promise<InferenceResult>(resolve=>{finishInference=resolve;}))};
    const database:DatabaseAdapter={id:'clickhouse-http',placement:'remote',prepare:async()=>context,dispose:async()=>{},execute:vi.fn(async function*(){await held;yield batch;})};
    const h=harness({inference,database,liveTranslation:true,speculation:false});
    vi.mocked(h.compiler.compile).mockImplementation(()=>{now+=2;return 'SQL';});
    const d=draft();h.coordinator.observeDraft(d);now=70;finishInference({plan,source:'remote'});await settle();
    expect(database.execute).not.toHaveBeenCalled();
    now=500;h.coordinator.commit({...d,sentAt:now});await settle();
    const start=h.events.find(event=>event.type==='start');if(start?.type!=='start')throw new Error('Missing query start');
    expect(start.view.timing).toMatchObject({inferenceStartedAt:50,intentAt:70,compiledAt:72,queryStartedAt:500,committedAt:500});
    now=540;finishQuery();await settle();
    expect(start.view.timing).toMatchObject({firstBatchAt:540,firstPublishedAt:540,completedAt:540,promoted:false});
    expect(start.view.timing.intentAt!-start.view.timing.inferenceStartedAt!).toBe(20);
    expect(start.view.timing.completedAt!-start.view.timing.queryStartedAt!).toBe(40);
    expect(inference.resolve).toHaveBeenCalledOnce();expect(database.execute).toHaveBeenCalledOnce();h.coordinator.dispose();
  });
  it('preserves prepared database timings while measuring publication and drawing after promotion',async()=>{
    let now=0;vi.spyOn(performance,'now').mockImplementation(()=>now);
    let firstBatch!:()=>void,lastBatch!:()=>void,finishDrain!:()=>void;
    const first=new Promise<void>(resolve=>{firstBatch=resolve;}),last=new Promise<void>(resolve=>{lastBatch=resolve;});
    vi.stubGlobal('scheduler',{yield:()=>new Promise<void>(resolve=>{finishDrain=resolve;})});
    const database:DatabaseAdapter={id:'duckdb-wasm',placement:'browser',prepare:async()=>context,dispose:async()=>{},execute:async function*(){await first;yield batch;await last;yield batch;}};
    const h=harness({database,liveTranslation:true});const d=draft();h.coordinator.observeDraft(d);await settle();
    now=20;firstBatch();await settle();now=40;lastBatch();await settle();
    expect(h.events.some(event=>event.type==='batch')).toBe(false);
    now=500;h.coordinator.commit({...d,sentAt:now});
    const start=h.events.find(event=>event.type==='start');if(start?.type!=='start')throw new Error('Missing query start');
    expect(start.view.timing).toMatchObject({inferenceStartedAt:0,intentAt:0,compiledAt:0,queryStartedAt:0,firstBatchAt:20,completedAt:40,committedAt:500,firstPublishedAt:500,promoted:true});
    expect(h.events.filter(event=>event.type==='batch')).toHaveLength(1);expect(h.events.some(event=>event.type==='complete')).toBe(false);
    h.coordinator.markDraw(start.view.id,510);
    now=550;finishDrain();await settle();
    expect(start.view.timing.firstPublishedAt).toBe(500);expect(start.view.timing.completedAt).toBe(40);
    expect(start.view.timing.firstDrawAt!-start.view.timing.firstPublishedAt!).toBe(10);
    expect(start.view.timing.completedAt!-start.view.timing.queryStartedAt!).toBe(40);
    expect(h.events.filter(event=>event.type==='batch')).toHaveLength(2);expect(h.events.filter(event=>event.type==='complete')).toHaveLength(1);h.coordinator.dispose();
  });
});

describe('draft preparation and commit correctness',()=>{
  it.each([true,false])('waits for two quiet seconds before automatic work, with live translation %s',async liveTranslation=>{
    vi.useFakeTimers();const h=harness({liveTranslation,draftDebounceMs:2000});
    h.coordinator.observeDraft(draft('Average speed by hour'));
    expect(h.inference.observeDraft).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.inference.resolve).not.toHaveBeenCalled();expect(h.database.execute).not.toHaveBeenCalled();
    h.coordinator.observeDraft(draft('Average wind speed by hour',2));
    expect(h.inference.observeDraft).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.inference.resolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.inference.resolve).toHaveBeenCalledOnce();expect(h.database.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(h.inference.resolve).mock.calls[0][0].text).toBe('Average wind speed by hour');h.coordinator.dispose();
  });
  it('runs Enter immediately and promotes work when submission meets the idle deadline',async()=>{
    vi.useFakeTimers();const h=harness({liveTranslation:true,draftDebounceMs:2000});const first=draft();
    h.coordinator.observeDraft(first);await vi.advanceTimersByTimeAsync(500);
    h.coordinator.commit({...first,sentAt:performance.now()});await settle();
    expect(h.inference.resolve).toHaveBeenCalledOnce();expect(h.database.execute).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);expect(h.inference.resolve).toHaveBeenCalledOnce();
    const second=draft('Average wind speed by hour',2);h.coordinator.observeDraft(second);
    await vi.advanceTimersByTimeAsync(2000);h.coordinator.commit({...second,sentAt:performance.now()});await settle();
    expect(h.inference.resolve).toHaveBeenCalledTimes(2);expect(h.database.execute).toHaveBeenCalledTimes(2);
    expect(h.events.filter(event=>event.type==='start')).toHaveLength(2);h.coordinator.dispose();
  });
  it('cancels quiet-period work on composition, short drafts and Stop',async()=>{
    vi.useFakeTimers();const h=harness({liveTranslation:true,draftDebounceMs:2000});
    h.coordinator.observeDraft(draft());await vi.advanceTimersByTimeAsync(1000);
    h.coordinator.observeDraft(draft('Average speed by hour',2),true);await vi.advanceTimersByTimeAsync(2000);
    expect(h.inference.resolve).not.toHaveBeenCalled();
    h.coordinator.observeDraft(draft('Average speed by hour',3));await vi.advanceTimersByTimeAsync(1000);
    h.coordinator.observeDraft(draft('short',4));await vi.advanceTimersByTimeAsync(2000);
    expect(h.inference.resolve).not.toHaveBeenCalled();
    h.coordinator.observeDraft(draft('Average speed by hour',5));h.coordinator.cancel();
    await vi.advanceTimersByTimeAsync(2000);expect(h.inference.resolve).not.toHaveBeenCalled();h.coordinator.dispose();
  });
  it('keeps the default 180ms speculation pause when live translation is disabled',async()=>{
    vi.useFakeTimers();const h=harness({debounceMs:undefined});h.coordinator.observeDraft(draft());
    expect(h.inference.resolve).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(179);
    expect(h.inference.resolve).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);
    expect(h.inference.resolve).toHaveBeenCalledOnce();h.coordinator.dispose();
  });
  it('starts live translation at the configured threshold without a debounce or database work',async()=>{
    vi.useFakeTimers();const h=harness({liveTranslation:true,speculation:false});
    h.coordinator.observeDraft(draft('x'.repeat(19)));expect(h.inference.resolve).not.toHaveBeenCalled();
    h.coordinator.observeDraft(draft('x'.repeat(20),2));expect(h.inference.resolve).toHaveBeenCalledOnce();await settle();
    expect(h.compiler.compile).toHaveBeenCalledOnce();expect(h.database.execute).not.toHaveBeenCalled();
    expect(h.events.some(e=>e.type==='speculation'&&e.state==='translated'&&e.points===0)).toBe(true);
    expect(h.events.some(e=>e.type==='start'||e.type==='complete')).toBe(false);h.coordinator.dispose();
    const custom=harness({liveTranslation:true,speculation:false,translationMinChars:5});custom.coordinator.observeDraft(draft('12345'));
    expect(custom.inference.resolve).toHaveBeenCalledOnce();custom.coordinator.dispose();
    for(const invalid of [undefined,0,-1,1.5,4097,NaN])expect(translationThreshold(invalid)).toBe(20);
  });
  it('reuses prepared SQL on Enter without repeating inference or compilation',async()=>{
    const h=harness({liveTranslation:true,speculation:false});const d=draft();h.coordinator.observeDraft(d);await settle();
    expect(h.database.execute).not.toHaveBeenCalled();h.coordinator.commit({...d,sentAt:performance.now()});await settle();
    expect(h.inference.resolve).toHaveBeenCalledOnce();expect(h.compiler.compile).toHaveBeenCalledOnce();expect(h.database.execute).toHaveBeenCalledOnce();
    expect((h.database.execute as any).mock.calls[0][0]).toMatchObject({sql:'SQL',priority:'committed'});
    expect(h.events.filter(e=>e.type==='start')).toHaveLength(1);expect(h.events.filter(e=>e.type==='complete')).toHaveLength(1);
    expect(h.events.some(e=>e.type==='trace'&&e.entry.event==='prepared_sql_promoted')).toBe(true);h.coordinator.dispose();
  });
  it('replaces each eligible edited translation and rejects canceled late inference',async()=>{
    const requests:{signal:AbortSignal;finish:(result:InferenceResult)=>void}[]=[];
    const inference:InferenceAdapter={id:'held',placement:'browser',prepare:async()=>{},dispose(){},observeDraft(){},resolve:vi.fn((_draft,signal)=>new Promise<InferenceResult>(resolve=>requests.push({signal,finish:resolve})))};
    const h=harness({inference,liveTranslation:true,speculation:false});
    for(let i=0;i<20;i++)h.coordinator.observeDraft(draft('x'.repeat(20+i),i+1));
    expect(inference.resolve).toHaveBeenCalledTimes(20);expect(requests.slice(0,-1).every(r=>r.signal.aborted)).toBe(true);expect(requests.at(-1)?.signal.aborted).toBe(false);
    for(const request of requests)request.finish({plan,source:'template'});await settle();
    expect(h.compiler.compile).toHaveBeenCalledOnce();expect(h.database.execute).not.toHaveBeenCalled();
    h.coordinator.commit(draft('x'.repeat(39),20));await settle();expect(inference.resolve).toHaveBeenCalledTimes(20);expect(h.database.execute).toHaveBeenCalledOnce();h.coordinator.dispose();
  });
  it('cancels live candidates during composition or below threshold and resumes final IME text',async()=>{
    const h=harness({liveTranslation:true,speculation:false});const d=draft();h.coordinator.observeDraft(d);await settle();
    h.coordinator.observeDraft(d,true);h.coordinator.commit(d);await settle();expect(h.inference.resolve).toHaveBeenCalledTimes(2);
    h.coordinator.observeDraft({...d,revision:2},true);expect(h.inference.resolve).toHaveBeenCalledTimes(2);
    h.coordinator.observeDraft({...d,revision:3});await settle();expect(h.inference.resolve).toHaveBeenCalledTimes(3);
    h.coordinator.observeDraft(draft('short',4));h.coordinator.commit(draft(d.text,5));await settle();expect(h.inference.resolve).toHaveBeenCalledTimes(4);h.coordinator.dispose();
  });
  it('promotes in-flight live translation without rerunning it',async()=>{
    let finish!:(result:InferenceResult)=>void;
    const inference:InferenceAdapter={id:'held',placement:'browser',prepare:async()=>{},dispose(){},observeDraft(){},resolve:vi.fn(()=>new Promise<InferenceResult>(resolve=>{finish=resolve;}))};
    const h=harness({inference,liveTranslation:true,speculation:false});const d=draft();h.coordinator.observeDraft(d);h.coordinator.commit(d);
    finish({plan,source:'template'});await settle();expect(inference.resolve).toHaveBeenCalledOnce();expect(h.database.execute).toHaveBeenCalledOnce();
    expect(h.events.filter(e=>e.type==='start')).toHaveLength(1);h.coordinator.dispose();
  });
  it('keeps database speculation independently enabled for immediate live candidates',async()=>{
    const h=harness({liveTranslation:true,speculation:true});const d=draft();h.coordinator.observeDraft(d);await settle();
    expect(h.database.execute).toHaveBeenCalledOnce();expect(h.events.some(e=>e.type==='speculation'&&e.state==='ready')).toBe(true);
    h.coordinator.commit(d);expect(h.database.execute).toHaveBeenCalledOnce();expect(h.events.some(e=>e.type==='complete'&&e.timing.promoted)).toBe(true);h.coordinator.dispose();
  });
  it('supersedes the foreground at Enter before the replacement commit is delivered',async()=>{
    const deliver=queuedTransport();let finish!:(result:InferenceResult)=>void;let active:AbortSignal|undefined;let calls=0;
    const inference:InferenceAdapter={id:'held',placement:'browser',prepare:async()=>{},dispose(){},observeDraft(){},resolve:(_draft,signal)=>{
      if(++calls===1){active=signal;return new Promise(resolve=>{finish=resolve;});}
      return Promise.resolve({plan,source:'template'});
    }};
    const h=harness({inference});const client=new LocalCoordinatorClient(h.coordinator,context.id);
    client.commit('Average speed by hour');deliver();
    client.commit('Maximum wind by hour');expect(active?.aborted).toBe(true);
    finish({plan,source:'template'});await settle();
    expect(h.events.some(e=>e.type==='start'||e.type==='batch'||e.type==='complete')).toBe(false);
    deliver();await settle();expect(h.events.filter(e=>e.type==='start').map(e=>e.type==='start'&&e.view.prompt)).toEqual(['Maximum wind by hour']);client.dispose();
  });
  it('ignores a superseded queued commit even when its data was already prepared',async()=>{
    vi.useFakeTimers();const deliver=queuedTransport();const h=harness();const d=draft();
    h.coordinator.observeDraft(d);await vi.advanceTimersByTimeAsync(15);
    const client=new LocalCoordinatorClient(h.coordinator,context.id);client.commit(d.text);client.commit('Maximum wind by hour');deliver();await settle();
    expect(h.events.filter(e=>e.type==='start').map(e=>e.type==='start'&&e.view.prompt)).toEqual(['Maximum wind by hour']);client.dispose();
  });
  it('keeps exact prepared data across synchronous local commit fencing',async()=>{
    vi.useFakeTimers();const deliver=queuedTransport();const h=harness();const d=draft();
    h.coordinator.observeDraft(d);await vi.advanceTimersByTimeAsync(15);
    const client=new LocalCoordinatorClient(h.coordinator,context.id);client.commit(d.text);client.commit(d.text);deliver();
    expect(h.database.execute).toHaveBeenCalledTimes(1);
    expect(h.events.filter(e=>e.type==='complete'&&e.timing.promoted)).toHaveLength(1);client.dispose();
  });
  it('rejects oversized local snapshots before MessageChannel copies them',()=>{
    const postMessage=vi.fn();
    vi.stubGlobal('MessageChannel',class {port1={postMessage,close(){}};port2={onmessage:null,close(){}};});
    const h=harness();const client=new LocalCoordinatorClient(h.coordinator,context.id);
    client.draft('x'.repeat(4097));client.commit('x'.repeat(4097));
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toMatchObject({type:'DRAFT',draft:{text:''},composing:true});
    expect(h.inference.resolve).not.toHaveBeenCalled();
    expect(h.events.filter(e=>e.type==='error')).toHaveLength(2);client.dispose();
  });
  it('invalidates earlier queued drafts after an oversized paste',async()=>{
    vi.useFakeTimers();let channel:any;
    vi.stubGlobal('MessageChannel',class {
      messages:any[]=[];port1={postMessage:(message:any)=>this.messages.push(message),close(){}};port2={onmessage:null as any,close(){}};
      constructor(){channel=this;}
    });
    const h=harness();const client=new LocalCoordinatorClient(h.coordinator,context.id);
    client.draft('Average speed by hour');client.draft('x'.repeat(4097));
    for(const data of channel.messages)channel.port2.onmessage({data});
    await vi.advanceTimersByTimeAsync(30);
    expect(h.inference.resolve).not.toHaveBeenCalled();client.dispose();
  });
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
  it('keeps exact whitespace snapshots reusable and upgrades priority before admission',async()=>{
    vi.useFakeTimers();let finish!:()=>void;let request:any;
    const held=new Promise<void>(r=>{finish=r;});
    const database:DatabaseAdapter={id:'held',placement:'remote',prepare:async()=>context,dispose:async()=>{},execute:async function*(value){request=value;await held;yield batch;}};
    const h=harness({database});const d=draft(' Average speed by hour ');
    h.coordinator.observeDraft(d);await vi.advanceTimersByTimeAsync(15);
    expect(request.priority).toBe('speculative');h.coordinator.commit(d);
    expect(request.priority).toBe('committed');finish();await settle();
    expect(h.inference.resolve).toHaveBeenCalledTimes(1);h.coordinator.dispose();
  });
  it('counts unique backing allocations rather than visible column slices',async()=>{
    vi.useFakeTimers();const backing=new ArrayBuffer(1024);
    const sliced={...batch,x:new Float64Array(backing,0,2),y:new Float64Array(backing,16,2),series:new Int32Array(backing,32,2),retainedBuffers:[backing]};
    const database:DatabaseAdapter={id:'slice',placement:'browser',prepare:async()=>context,dispose:async()=>{},execute:async function*(){yield sliced;yield sliced;}};
    const h=harness({database,speculativeBytes:1024});h.coordinator.observeDraft(draft());await vi.advanceTimersByTimeAsync(15);
    expect(h.events.some(e=>e.type==='speculation'&&e.state==='ready')).toBe(true);h.coordinator.dispose();
    const tooSmall=harness({database,speculativeBytes:1023});tooSmall.coordinator.observeDraft(draft());await vi.advanceTimersByTimeAsync(15);
    expect(tooSmall.events.some(e=>e.type==='speculation'&&e.state==='ready')).toBe(false);
    expect(tooSmall.events.some(e=>e.type==='trace'&&e.entry.event==='speculation_discarded')).toBe(true);tooSmall.coordinator.dispose();
  });
  it('yields staged batches after the first and fences the drain on cancellation',async()=>{
    vi.useFakeTimers();const database:DatabaseAdapter={id:'many',placement:'browser',prepare:async()=>context,dispose:async()=>{},execute:async function*(){yield batch;yield batch;yield batch;}};
    const h=harness({database});const d=draft();h.coordinator.observeDraft(d);await vi.advanceTimersByTimeAsync(15);
    h.coordinator.commit(d);
    expect(h.events.filter(e=>e.type==='batch')).toHaveLength(1);
    expect(h.events.some(e=>e.type==='complete')).toBe(false);
    h.coordinator.cancel();await vi.runAllTimersAsync();
    expect(h.events.filter(e=>e.type==='batch')).toHaveLength(1);
    expect(h.events.some(e=>e.type==='complete')).toBe(false);h.coordinator.dispose();
  });
  it('keeps live batches behind staged batches and completes after draining',async()=>{
    vi.useFakeTimers();let finish!:()=>void;const held=new Promise<void>(r=>{finish=r;});
    const second={...batch,y:new Float64Array([22,24])},third={...batch,y:new Float64Array([32,34])};
    const database:DatabaseAdapter={id:'stream',placement:'browser',prepare:async()=>context,dispose:async()=>{},execute:async function*(){yield batch;yield second;await held;yield third;}};
    const h=harness({database});const d=draft();h.coordinator.observeDraft(d);await vi.advanceTimersByTimeAsync(15);
    h.coordinator.commit(d);finish();await settle();
    expect(h.events.filter(e=>e.type==='batch')).toHaveLength(1);
    await vi.runAllTimersAsync();
    expect(h.events.filter(e=>e.type==='batch').map(e=>e.type==='batch'&&e.batch)).toEqual([batch,second,third]);
    expect(h.events.filter(e=>e.type==='complete')).toHaveLength(1);h.coordinator.dispose();
  });
  it('uses reusable MessageChannel tasks when scheduler.yield is absent',async()=>{
    vi.useFakeTimers();vi.stubGlobal('scheduler',undefined);const channels:any[]=[];
    vi.stubGlobal('MessageChannel',class {
      values:number[]=[];port1={postMessage:(id:number)=>this.values.push(id),close:vi.fn()};port2={onmessage:null as any,close:vi.fn()};
      constructor(){channels.push(this);}
    });
    const database:DatabaseAdapter={id:'many',placement:'browser',prepare:async()=>context,dispose:async()=>{},execute:async function*(){for(let i=0;i<70;i++)yield batch;}};
    const h=harness({database});const d=draft();h.coordinator.observeDraft(d);await vi.advanceTimersByTimeAsync(15);h.coordinator.commit(d);
    expect(h.events.filter(e=>e.type==='batch')).toHaveLength(1);expect(channels).toHaveLength(1);
    const channel=channels[0];channel.port2.onmessage({data:channel.values.shift()});await settle();
    expect(h.events.filter(e=>e.type==='batch')).toHaveLength(33);
    h.coordinator.cancel();channel.port2.onmessage({data:channel.values.shift()});await settle();
    expect(h.events.filter(e=>e.type==='batch')).toHaveLength(33);h.coordinator.dispose();expect(channel.port1.close).toHaveBeenCalledOnce();
  });
  it('cancelForeground preserves a prepared candidate for later acceptance',async()=>{
    vi.useFakeTimers();const h=harness();const d=draft();h.coordinator.observeDraft(d);await vi.advanceTimersByTimeAsync(15);
    h.coordinator.cancelForeground();h.coordinator.commit(d);
    expect(h.database.execute).toHaveBeenCalledTimes(1);
    expect(h.events.some(e=>e.type==='complete'&&e.timing.promoted)).toBe(true);h.coordinator.dispose();
  });
});
