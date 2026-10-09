import {DuckDBAdapter} from './adapters/duckdb';
import {RemoteDatabaseAdapter} from './adapters/remote-database';
import {WasmQueryCompiler} from './core/compiler';
import {BrowserCoordinator,LocalCoordinatorClient,type CoordinatorClient} from './core/coordinator';
import {RemoteCoordinatorClient} from './core/remote-coordinator';
import {DEFAULT_CONFIG,type DatabaseAdapter,type DatasetContext,type InferenceAdapter,type PipelineEvent,type RuntimeConfig} from './core/types';
import {createInferenceAdapter} from './inference';
import {createUI} from './ui';

let client:CoordinatorClient|undefined;
let database:DatabaseAdapter|undefined;
let inference:InferenceAdapter|undefined;
let context:DatasetContext|undefined;
let config={...DEFAULT_CONFIG};
let generation=0;
let draftText='';
const compiler=new WasmQueryCompiler();
const ui=createUI(document.querySelector<HTMLElement>('#app')!,{
  onDraft(text,composing) { draftText=text; client?.draft(text,composing); },
  onCommit(text) {
    if (!client) { ui.handleEvent({type:'error',message:'The dataset is still warming. Try again when DuckDB is ready.'});ui.setBusy(false);return; }
    client.commit(text);
  },
  onFocus() { void warmModel(); },
  onConfig(next) {
    const previous=config;config=next;ui.setConfig(config);
    const sameAdapters=previous.databaseMode===next.databaseMode&&previous.databaseEndpoint===next.databaseEndpoint
      &&previous.inferenceMode===next.inferenceMode&&previous.inferenceEndpoint===next.inferenceEndpoint
      &&previous.inferenceDraftEndpoint===next.inferenceDraftEndpoint;
    if(sameAdapters&&database&&inference&&context) {
      client?.dispose();
      connect(next,generation,context,database,inference);
    } else void initialize();
  },
  onCancel() { client?.cancel(); },
  onWarmModel() { void warmModel(); },
  onDraw(id,at) { client?.markDraw(id,at); },
});

async function warmModel():Promise<void> {
  if (!inference||!context) return;
  try { await inference.prepare(context); }
  catch (error) { ui.setStatus('model',{state:'unavailable',label:'Model unavailable',detail:String(error)}); }
}

async function initialize():Promise<void> {
  const own=++generation;
  const selected={...config};
  client?.dispose();client=undefined;
  inference?.dispose();inference=undefined;
  const previous=database;database=undefined;context=undefined;
  ui.setBusy(false);
  ui.setStatus('coordinator',{state:'loading',label:'Preparing execution path'});
  ui.setStatus('compiler',{state:'loading',label:'Loading Rust/Wasm compiler'});
  ui.setStatus('model',{state:'cold',label:'Waiting for dataset context'});
  await previous?.dispose();
  if (own!==generation) return;
  const db=selected.databaseMode==='browser'?new DuckDBAdapter():new RemoteDatabaseAdapter(selected.databaseEndpoint);
  database=db;
  try {
    const [dataset]=await Promise.all([
      db.prepare(status=>{if(own===generation)ui.setStatus('database',status);}),
      compiler.prepare().then(()=>{if(own===generation)ui.setStatus('compiler',{state:'ready',label:'Rust/Wasm query compiler'});}),
    ]);
    if (own!==generation) { await db.dispose();return; }
    context=dataset;ui.setDataset(dataset);
    const model=createInferenceAdapter(selected.inferenceMode,{endpoint:selected.inferenceEndpoint,draftEndpoint:selected.inferenceDraftEndpoint,
      onStatus:status=>{if(own===generation)ui.setStatus('model',status);}});
    inference=model;
    // prepare establishes context synchronously; a slow model download never gates template queries.
    void model.prepare(dataset).catch(error=>{if(own===generation)ui.setStatus('model',{state:'unavailable',label:'Model unavailable',detail:String(error)});});
    connect(selected,own,dataset,db,model);
  } catch(error) {
    if(own!==generation)return;
    const message=error instanceof Error?error.message:String(error);
    ui.setStatus('coordinator',{state:'error',label:'Runtime could not start',detail:message});
    ui.handleEvent({type:'error',message});ui.setBusy(false);
  }
}

function connect(selected:RuntimeConfig,own:number,dataset:DatasetContext,db:DatabaseAdapter,model:InferenceAdapter):void {
  const emit=(event:PipelineEvent)=> {
    if(own!==generation)return;
    ui.handleEvent(event);
    if(event.type==='complete'||event.type==='error')ui.setBusy(false);
  };
  const options={database:db,inference:model,compiler,context:dataset,emit,speculation:selected.speculation};
  ui.setBusy(false);
  try {
    if(selected.coordinatorMode==='browser') {
      client=new LocalCoordinatorClient(new BrowserCoordinator(options),dataset.id);
      ui.setStatus('coordinator',{state:'ready',label:'Local MessageChannel · ready'});
    } else client=new RemoteCoordinatorClient(selected.coordinatorEndpoint,options,status=>{if(own===generation)ui.setStatus('coordinator',status);});
    if(draftText)client.draft(draftText);
  } catch(error) { client=undefined;emit({type:'error',message:String(error)}); }
}

ui.setConfig(config);
void initialize();
window.addEventListener('pagehide',()=>{generation++;client?.dispose();inference?.dispose();void database?.dispose();});
window.addEventListener('pageshow',event=>{if(event.persisted)void initialize();});
