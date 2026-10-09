import type {ColumnBatch, DatabaseAdapter, DatasetContext, Draft, InferenceAdapter, InferenceResult, PipelineEvent, QueryCompiler, QueryTiming, QueryView} from './types';
import {MAX_PROMPT_CHARS} from '../inference/plan';
import {inferenceFailureDetails} from '../inference/failure';

type Emit = (event:PipelineEvent)=>void;
interface Job {
  id:string; draft:Draft; abort:AbortController; timing:QueryTiming;
  view?:QueryView; staged:ColumnBatch[]; committed:boolean; settled:boolean; queryStarted:boolean; error?:Error;
  retained:Set<ArrayBufferLike>; retainedBytes:number; draining?:Promise<void>;
}
export interface CoordinatorOptions {
  database:DatabaseAdapter; inference:InferenceAdapter; compiler:QueryCompiler; context:DatasetContext;
  emit:Emit; speculation:boolean; debounceMs?:number; speculativeBytes?:number; resultBytes?:number;
  liveTranslation?:boolean; translationMinChars?:number; draftDebounceMs?:number;
}

export function translationThreshold(value?:number):number {
  return Number.isSafeInteger(value)&&value!>=1&&value!<=MAX_PROMPT_CHARS?value!:20;
}

/** Control only. The data path passes retained column views by reference. */
export class BrowserCoordinator {
  private candidate?:Job;
  private foreground?:Job;
  private timer?:ReturnType<typeof setTimeout>;
  private latest?:Draft;
  private closed=false;
  private counter=0;
  private yieldChannel?:MessageChannel;
  private yieldCounter=0;
  private yields=new Map<number,()=>void>();
  private readonly session=crypto.randomUUID().slice(0,8);
  constructor(private readonly options:CoordinatorOptions) {}
  private emit(event:PipelineEvent) { if (!this.closed) this.options.emit(event); }
  private trace(event:string,detail:string) { this.emit({type:'trace',entry:{at:performance.now(),event,detail}}); }

  validatePrompt(text:string):boolean {
    if(text.length<=MAX_PROMPT_CHARS)return true;
    clearTimeout(this.timer);this.dropCandidate('Draft exceeds the request limit');
    this.emit({type:'error',message:`Requests must be at most ${MAX_PROMPT_CHARS} characters.`});return false;
  }

  observeDraft(draft:Draft,composing=false,schedulingSuppressed=false):void {
    if (this.closed || (this.latest && draft.revision < this.latest.revision)) return;
    if(!this.validatePrompt(draft.text))return;
    if (draft.contextId !== this.options.context.id) return;
    this.latest=draft;
    this.options.inference.observeDraft(draft);
    this.emit({type:'draft',revision:draft.revision,chars:draft.text.length});
    clearTimeout(this.timer);
    const live=this.options.liveTranslation??false;
    const minimum=live?translationThreshold(this.options.translationMinChars):4;
    if (this.candidate && (this.candidate.draft.text !== draft.text||composing||draft.text.trim().length<minimum)) this.dropCandidate('Draft changed');
    if(composing||draft.text.trim().length<minimum) {
      this.emit({type:'speculation',state:'idle',text:'',points:0});return;
    }
    if ((!this.options.speculation&&!live) || schedulingSuppressed || this.candidate) return;
    const prepare=()=> {
      if (this.closed || this.latest !== draft) return;
      const job=this.makeJob(draft,false);
      this.candidate=job;
      this.emit({type:'speculation',state:'resolving',text:draft.text,points:0});
      this.trace(live?'translation_started':'speculation_started',`revision ${draft.revision}`);
      void this.run(job);
    };
    // The timestamp belongs to the browser draft, not a remote PREPARE reply.
    // Count network/scheduler delay toward the pause instead of waiting twice.
    const idle=this.options.draftDebounceMs;
    if(idle!==undefined) {
      const wait=Math.max(0,Math.min(idle,draft.sentAt+idle-performance.now()));
      if(wait>0)this.timer=setTimeout(prepare,Math.ceil(wait));else prepare();
    } else if(live)prepare();else this.timer=setTimeout(prepare,this.options.debounceMs ?? 180);
  }

  commit(draft:Draft):void {
    if (this.closed || !draft.text.trim()) return;
    if(!this.validatePrompt(draft.text))return;
    if (draft.contextId !== this.options.context.id) {
      this.emit({type:'error',message:'The dataset changed. Please submit the question again.'}); return;
    }
    // Remote ACCEPT can arrive after a later edit. Resolve the immutable submission
    // without rewinding the model's draft snapshot or that edit's preparation timer.
    const newerDraft=Boolean(this.latest&&this.latest.revision>draft.revision);
    if(!newerDraft) {
      clearTimeout(this.timer);
      this.latest=draft;
      this.options.inference.observeDraft(draft);
    }
    this.cancelForeground();
    const reusable=this.candidate && !this.candidate.abort.signal.aborted && !this.candidate.error
      && this.candidate.draft.text===draft.text && this.candidate.draft.contextId===draft.contextId;
    let job:Job;
    if (reusable) {
      job=this.candidate!;
      this.candidate=undefined;
      job.committed=true;
      job.timing.committedAt=draft.sentAt;
      job.timing.promoted=job.staged.length>0;
      this.foreground=job;
      this.trace(job.timing.promoted?'prepared_result_promoted':job.view&&!job.queryStarted?'prepared_sql_promoted':'inflight_work_promoted',`revision ${draft.revision}`);
      // A same-text draft may have a later revision; bind display to the committed revision.
      job.draft=draft;
      if (job.view) {
        job.view.revision=draft.revision;
        this.emit({type:'start',view:job.view});
        this.publishStaged(job);
      }
      if (job.settled) void this.completePromoted(job);
      else if(job.view&&!job.queryStarted)void this.run(job);
    } else {
      this.dropCandidate('Commit did not match prepared work');
      job=this.makeJob(draft,true);
      this.foreground=job;
      this.trace('commit',`revision ${draft.revision}`);
      void this.run(job);
    }
    if(!newerDraft)this.emit({type:'speculation',state:'idle',text:'',points:0});
  }

  private makeJob(draft:Draft,committed:boolean):Job {
    const now=performance.now();
    return {id:`${this.session}-${++this.counter}`,draft,abort:new AbortController(),committed,settled:false,queryStarted:false,staged:[],retained:new Set(),retainedBytes:0,
      timing:{startedAt:now,committedAt:committed?draft.sentAt:undefined,promoted:false,batches:0,points:0,bytes:0}};
  }

  private async run(job:Job):Promise<void> {
    const {inference,compiler,database,context}=this.options;
    let resolved:InferenceResult|undefined;
    try {
      if(!job.view) {
        job.timing.inferenceStartedAt=performance.now();
        const result=resolved=await inference.resolve(job.draft,job.abort.signal);
        if (job.abort.signal.aborted || this.closed) return;
        job.timing.intentAt=performance.now();
        const sql=compiler.compile(result.plan,context);
        job.timing.compiledAt=performance.now();
        job.view={id:job.id,prompt:job.draft.text,revision:job.draft.revision,plan:result.plan,sql,
          source:result.source,model:result.model,inference:result.diagnostics,database:database.id,context,timing:job.timing};
        if (job.committed) this.emit({type:'start',view:job.view});
        this.trace('intent_validated',`${result.source} · ${job.id}`);
      }
      if(job.abort.signal.aborted||this.closed||job.queryStarted)return;
      if(!job.committed&&!this.options.speculation) {
        this.emit({type:'speculation',state:'translated',text:job.draft.text,points:0});
        this.trace('sql_prepared',`revision ${job.draft.revision} · database waits for Enter`);return;
      }
      job.queryStarted=true;
      if(!job.committed)this.emit({type:'speculation',state:'querying',text:job.draft.text,points:0});
      const {sql,plan}=job.view;
      job.timing.queryStartedAt=performance.now();
      for await (const batch of database.execute({id:job.id,sql,plan,context,signal:job.abort.signal,
        // Admission can occur after Enter. An already-sent remote request needs a
        // service-specific upgrade protocol, which this prototype does not have.
        get priority() { return job.committed?'committed' as const:'speculative' as const; }})) {
        if (job.draining) await job.draining;
        if (job.abort.signal.aborted || this.closed) return;
        if (!batch.length) continue;
        const max=job.committed?(this.options.resultBytes??16*1024*1024):(this.options.speculativeBytes??4*1024*1024);
        const buffers=new Set(batch.retainedBuffers??[batch.x.buffer,batch.y.buffer,batch.series.buffer,
          ...(batch.lat?[batch.lat.buffer]:[]),...(batch.lon?[batch.lon.buffer]:[])]);
        let additional=0;
        for(const buffer of buffers)if(!job.retained.has(buffer))additional+=buffer.byteLength;
        if (job.retainedBytes+additional>max) throw new Error(job.committed
          ?'Result exceeded the 16 MiB drawing budget. Choose a shorter window or wider bucket.'
          :'Speculative result exceeded its memory budget.');
        for(const buffer of buffers)job.retained.add(buffer);
        job.retainedBytes+=additional;
        job.timing.firstBatchAt ??= performance.now();
        job.timing.batches++; job.timing.points+=batch.length; job.timing.bytes+=batch.byteLength;
        if (job.committed) {
          job.timing.firstPublishedAt ??= performance.now();
          this.emit({type:'batch',id:job.id,batch});
        }
        else job.staged.push(batch);
      }
      const completedAt=performance.now();
      if (job.draining) await job.draining;
      if (job.abort.signal.aborted || this.closed) return;
      job.settled=true;
      job.timing.completedAt=completedAt;
      if (job.committed) {this.emit({type:'complete',id:job.id,timing:job.timing});job.retained.clear();}
      else this.emit({type:'speculation',state:'ready',text:job.draft.text,points:job.timing.points});
      this.trace('query_complete',`${job.timing.points.toLocaleString()} points · ${job.timing.batches} batches`);
    } catch (cause) {
      if (job.abort.signal.aborted || this.closed) return;
      job.error=cause instanceof Error?cause:new Error(String(cause));
      job.timing.failedAt=performance.now();
      job.settled=true;
      job.abort.abort();
      job.staged=[]; job.retained.clear();
      if (job.committed && this.foreground===job) {
        const details=resolved??inferenceFailureDetails(cause);
        this.emit({type:'error',id:job.view?job.id:undefined,message:job.error.message,failure:{
          timing:job.timing,phase:job.queryStarted?'query':job.timing.intentAt!==undefined?'compile':'inference',
          source:job.view?.source??details.source,model:job.view?.model??details.model,
          inference:job.view?.inference??details.diagnostics,database:database.id,
        }});
      }
      else if (this.candidate===job) {
        this.candidate=undefined;
        this.emit({type:'speculation',state:'idle',text:'',points:0});
        this.trace('speculation_discarded',job.error.message);
      }
    }
  }

  private publishStaged(job:Job):void {
    const staged=job.staged;job.staged=[];
    if(!staged.length)return;
    job.timing.firstPublishedAt ??= performance.now();
    this.emit({type:'batch',id:job.id,batch:staged[0]});
    if(staged.length===1)return;
    job.draining=(async()=>{
      let i=1;
      while(i<staged.length) {
        await this.yieldTask(job.abort.signal);
        const deadline=performance.now()+4;let count=0;
        do {
          if(this.closed||job.abort.signal.aborted||this.foreground!==job)return;
          this.emit({type:'batch',id:job.id,batch:staged[i++]});
        } while(i<staged.length&&++count<32&&performance.now()<deadline);
      }
    })().finally(()=>{job.draining=undefined;});
  }
  private yieldTask(signal:AbortSignal):Promise<void> {
    if(signal.aborted||this.closed)return Promise.resolve();
    return new Promise(resolve=>{
      const id=++this.yieldCounter;
      const finish=()=>{this.yields.delete(id);signal.removeEventListener('abort',finish);resolve();};
      this.yields.set(id,finish);signal.addEventListener('abort',finish,{once:true});
      const scheduler=(globalThis as typeof globalThis&{scheduler?:{yield?:()=>Promise<void>}}).scheduler;
      if(scheduler?.yield) {void scheduler.yield().then(finish,finish);return;}
      if(!this.yieldChannel) {
        this.yieldChannel=new MessageChannel();
        this.yieldChannel.port2.onmessage=({data})=>this.yields.get(data)?.();
      }
      this.yieldChannel.port1.postMessage(id);
    });
  }
  private async completePromoted(job:Job):Promise<void> {
    if(job.draining)await job.draining;
    if(!this.closed&&!job.abort.signal.aborted&&this.foreground===job) {
      this.emit({type:'complete',id:job.id,timing:job.timing});job.retained.clear();
    }
  }

  /** Supersede only submitted work; an exact speculative candidate can still promote. */
  cancelForeground():void {
    this.foreground?.abort.abort();
    this.foreground?.retained.clear();
    this.foreground=undefined;
  }

  markDraw(id:string,at:number):void {
    const job=this.foreground;
    if (!job || job.id!==id || job.timing.firstDrawAt!==undefined) return;
    job.timing.firstDrawAt=at;
    this.trace('first_draw_submitted',`${Math.max(0,at-(job.timing.committedAt??at)).toFixed(2)} ms after commit`);
  }
  private dropCandidate(reason:string) {
    if (!this.candidate) return;
    this.candidate.abort.abort(); this.candidate.staged=[]; this.candidate.retained.clear(); this.candidate=undefined;
    this.emit({type:'speculation',state:'canceled',text:reason,points:0});
  }
  cancel():void {
    clearTimeout(this.timer); this.dropCandidate('Canceled'); this.cancelForeground();
    this.trace('canceled','Pending work canceled');
  }
  dispose():void {
    this.cancel();this.closed=true;
    this.yieldChannel?.port1.close();this.yieldChannel?.port2.close();
    for(const finish of this.yields.values())finish();
  }
}

export interface CoordinatorClient {
  draft(text:string,composing?:boolean):void;
  commit(text:string):void;
  cancel():void;
  markDraw(id:string,at:number):void;
  dispose():void;
}

/** Real local draft transport. Large result buffers stay on the direct reference path. */
export class LocalCoordinatorClient implements CoordinatorClient {
  private channel=new MessageChannel();
  private revision=0;
  private lastText='';
  private closed=false;
  private epoch=0;
  constructor(private readonly coordinator:BrowserCoordinator,private readonly contextId:string) {
    this.channel.port2.onmessage=({data})=> {
      if (this.closed || data.epoch!==this.epoch) return;
      if (data.type==='DRAFT') coordinator.observeDraft(data.draft,data.composing);
      else if (data.type==='COMMIT') coordinator.commit(data.draft);
      else if (data.type==='CANCEL') coordinator.cancel();
    };
  }
  private snapshot(text:string):Draft {
    if (text!==this.lastText) { this.lastText=text; this.revision++; }
    return {revision:this.revision,text,contextId:this.contextId,sentAt:performance.now()};
  }
  draft(text:string,composing=false):void {
    if(this.closed)return;
    const valid=this.coordinator.validatePrompt(text);
    // An empty invalidation is bounded and follows older queued drafts in FIFO order.
    this.channel.port1.postMessage({type:'DRAFT',epoch:this.epoch,draft:this.snapshot(valid?text:''),composing:valid?composing:true});
  }
  commit(text:string):void {
    if(this.closed||!text.trim()||!this.coordinator.validatePrompt(text))return;
    // Enter supersedes foreground work synchronously, before queued transport runs.
    // Fence older queued snapshots without discarding an exact staged candidate.
    this.coordinator.cancelForeground();this.epoch++;
    this.channel.port1.postMessage({type:'COMMIT',epoch:this.epoch,draft:this.snapshot(text)});
  }
  cancel():void { this.epoch++; this.coordinator.cancel(); }
  markDraw(id:string,at:number):void { this.coordinator.markDraw(id,at); }
  dispose():void {
    this.closed=true; this.channel.port1.close(); this.channel.port2.close(); this.coordinator.dispose();
  }
}
