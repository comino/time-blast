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
let databaseKey='';
let inferenceKey='';
const compiler=new WasmQueryCompiler();
const ui=createUI(document.querySelector<HTMLElement>('#app')!,{
  onDraft(text,composing) { draftText=text; client?.draft(text,composing); },
  onCommit(text) {
    if (!client) { ui.handleEvent({type:'error',message:'The dataset is still warming. Try again when DuckDB is ready.'});ui.setBusy(false);return; }
    client.commit(text);
  },
  onFocus() { void warmModel(); },
  onConfig(next) {
    config=next;ui.setConfig(config);void initialize();
  },
  onCancel() { client?.cancel(); },
  onWarmModel() { void warmModel(); },
  onDraw(id,at) { client?.markDraw(id,at); },
});

async function warmModel():Promise<void> {
  if (!inference||!context) return;
  const model=inference;
  try { await model.prepare(context); }
  catch (error) { if(model===inference)ui.setStatus('model',{state:'unavailable',label:'Model unavailable',detail:String(error)}); }
}

async function initialize():Promise<void> {
  const own=++generation;
  const selected={...config};
  const nextDatabaseKey=JSON.stringify([selected.databaseMode,selected.databaseEndpoint,selected.databaseMode==='browser'?selected.datasetProfile:null]);
  const nextInferenceKey=JSON.stringify([selected.inferenceMode,selected.inferenceEndpoint,selected.inferenceDraftEndpoint]);
  const keepDatabase=databaseKey===nextDatabaseKey&&Boolean(database&&context);
  const keepInference=inferenceKey===nextInferenceKey&&Boolean(inference);
  client?.dispose();client=undefined;
  if(!keepInference){inference?.dispose();inference=undefined;}
  const previous=keepDatabase?undefined:database;
  if(!keepDatabase){database=undefined;context=undefined;}
  ui.setBusy(false);
  ui.setStatus('coordinator',{state:'loading',label:'Preparing execution path'});
  ui.setStatus('compiler',{state:'loading',label:'Loading Rust/Wasm compiler'});
  if(!keepInference)ui.setStatus('model',{state:'cold',label:'Waiting for dataset context'});
  try {
    await previous?.dispose();
    if (own!==generation) return;
    const db=database??(selected.databaseMode==='browser'?new DuckDBAdapter(selected.datasetProfile):new RemoteDatabaseAdapter(selected.databaseEndpoint));
    database=db;
    databaseKey=nextDatabaseKey;
    const [dataset]=await Promise.all([
      db.prepare(status=>{if(own===generation)ui.setStatus('database',status);}),
      compiler.prepare().then(()=>{if(own===generation)ui.setStatus('compiler',{state:'ready',label:'Rust/Wasm query compiler'});}),
    ]);
    if (own!==generation) return;
    context=dataset;ui.setDataset(dataset);
    const model:InferenceAdapter=inference??createInferenceAdapter(selected.inferenceMode,{endpoint:selected.inferenceEndpoint,draftEndpoint:selected.inferenceDraftEndpoint,
      onStatus:status=>{if(model===inference)ui.setStatus('model',status);}});
    inference=model;
    inferenceKey=nextInferenceKey;
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
  const options={database:db,inference:model,compiler,context:dataset,emit,speculation:selected.speculation,
    liveTranslation:selected.liveTranslation,translationMinChars:selected.translationMinChars};
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
window.addEventListener('pagehide',()=>{
  generation++;client?.dispose();client=undefined;inference?.dispose();inference=undefined;
  void database?.dispose();database=undefined;context=undefined;
});
window.addEventListener('pageshow',event=>{if(event.persisted)void initialize();});
