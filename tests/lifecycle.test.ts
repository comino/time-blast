import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {DEFAULT_CONFIG} from '../src/core/types';

const state=vi.hoisted(()=>({databases:[] as any[],models:[] as any[],clients:[] as any[],coordinatorOptions:[] as any[],callbacks:undefined as any,
  statuses:[] as any[],events:[] as any[],busy:[] as boolean[],failConstruct:false,failDispose:false,listeners:new Map<string,Function>()}));
vi.mock('../src/adapters/duckdb',()=>({DuckDBAdapter:class {
  dispose=vi.fn(async()=>{if(state.failDispose)throw new Error('Disposal failed');});
  context={id:`dataset-${state.databases.length}`,vessels:['A'],start:0,end:1};
  prepare=vi.fn(async()=>this.context);
  constructor(readonly profile?:string){if(state.failConstruct)throw new Error('Invalid database endpoint');state.databases.push(this);}
}}));
vi.mock('../src/adapters/remote-database',async()=>({RemoteDatabaseAdapter:(await import('../src/adapters/duckdb')).DuckDBAdapter}));
vi.mock('../src/core/compiler',()=>({WasmQueryCompiler:class {prepare=vi.fn(async()=>{});}}));
vi.mock('../src/core/coordinator',()=>({BrowserCoordinator:class {constructor(options:any){state.coordinatorOptions.push(options);}},LocalCoordinatorClient:class {
  dispose=vi.fn();draft=vi.fn();commit=vi.fn();
  constructor(){state.clients.push(this);}
}}));
vi.mock('../src/core/remote-coordinator',async()=>({RemoteCoordinatorClient:(await import('../src/core/coordinator')).LocalCoordinatorClient}));
vi.mock('../src/inference',()=>({createInferenceAdapter:vi.fn((mode,options)=>{
  const model={mode,options,prepare:vi.fn(async()=>{}),dispose:vi.fn()};state.models.push(model);return model;
})}));
vi.mock('../src/ui',()=>({createUI:(_root:any,callbacks:any)=>{
  state.callbacks=callbacks;
  return {setConfig:vi.fn(),setBusy:(value:boolean)=>state.busy.push(value),handleEvent:(event:any)=>state.events.push(event),setDataset:vi.fn(),setStatus:(...args:any[])=>state.statuses.push(args)};
}}));

beforeEach(()=>{
  vi.resetModules();state.databases=[];state.models=[];state.clients=[];state.coordinatorOptions=[];state.statuses=[];state.events=[];state.busy=[];state.failConstruct=false;state.failDispose=false;state.listeners.clear();
  vi.stubGlobal('document',{querySelector:()=>({})});
  vi.stubGlobal('window',{addEventListener:(type:string,callback:Function)=>state.listeners.set(type,callback)});
});
afterEach(()=>vi.unstubAllGlobals());
const start=async()=>{await import('../src/main');await vi.waitFor(()=>expect(state.clients).toHaveLength(1));};

describe('runtime adapter ownership',()=>{
  it('reconfigures live translation without replacing warmed adapters',async()=>{
    await start();expect(state.coordinatorOptions[0]).toMatchObject({liveTranslation:false,translationMinChars:20});
    state.callbacks.onConfig({...DEFAULT_CONFIG,liveTranslation:true,translationMinChars:24,speculation:false});
    await vi.waitFor(()=>expect(state.clients).toHaveLength(2));
    expect(state.databases).toHaveLength(1);expect(state.models).toHaveLength(1);
    expect(state.coordinatorOptions.at(-1)).toMatchObject({liveTranslation:true,translationMinChars:24,speculation:false});
  });
  it('changes local dataset profiles without replacing the warmed model',async()=>{
    await start();expect(state.databases[0].profile).toBe('large');
    state.callbacks.onConfig({...DEFAULT_CONFIG,datasetProfile:'demo'});
    await vi.waitFor(()=>expect(state.clients).toHaveLength(2));
    expect(state.databases).toHaveLength(2);expect(state.databases[1].profile).toBe('demo');expect(state.models).toHaveLength(1);
    expect(state.models[0].prepare).toHaveBeenLastCalledWith(state.databases[1].context);
  });
  it.each(['constructor','disposal'])('reports database %s failures instead of leaving initialization pending',async failure=>{
    await start();state.failConstruct=failure==='constructor';state.failDispose=failure==='disposal';
    state.callbacks.onConfig({...DEFAULT_CONFIG,databaseMode:'remote',databaseEndpoint:'https://db.test?invalid'});
    await vi.waitFor(()=>expect(state.events.some(event=>event.type==='error')).toBe(true));
    expect(state.statuses.at(-1)).toMatchObject(['coordinator',{state:'error'}]);expect(state.busy.at(-1)).toBe(false);
  });
  it('retains the warmed database when only inference changes',async()=>{
    await start();state.callbacks.onConfig({...DEFAULT_CONFIG,inferenceMode:'templates'});
    await vi.waitFor(()=>expect(state.models).toHaveLength(2));
    expect(state.databases).toHaveLength(1);expect(state.databases[0].dispose).not.toHaveBeenCalled();
    expect(state.models[0].dispose).toHaveBeenCalledOnce();
  });
  it('retains the warmed model and updates its context when only database changes',async()=>{
    await start();state.callbacks.onConfig({...DEFAULT_CONFIG,databaseMode:'remote',databaseEndpoint:'https://db.test'});
    await vi.waitFor(()=>expect(state.clients).toHaveLength(2));
    expect(state.models).toHaveLength(1);expect(state.models[0].dispose).not.toHaveBeenCalled();
    expect(state.databases[0].dispose).toHaveBeenCalledOnce();
    expect(state.models[0].prepare).toHaveBeenLastCalledWith(state.databases[1].context);
    state.models[0].options.onStatus({state:'ready',label:'Still warm'});
    expect(state.statuses.at(-1)).toEqual(['model',{state:'ready',label:'Still warm'}]);
  });
  it('reconnects coordination without replacing either adapter and recreates after page restore',async()=>{
    await start();state.callbacks.onConfig({...DEFAULT_CONFIG,speculation:false,coordinatorMode:'remote',coordinatorEndpoint:'wss://schedule.test'});
    await vi.waitFor(()=>expect(state.clients).toHaveLength(2));
    expect(state.models).toHaveLength(1);expect(state.databases).toHaveLength(1);
    state.listeners.get('pagehide')!();state.listeners.get('pageshow')!({persisted:true});
    await vi.waitFor(()=>expect(state.clients).toHaveLength(3));
    expect(state.models).toHaveLength(2);expect(state.databases).toHaveLength(2);
  });
});
