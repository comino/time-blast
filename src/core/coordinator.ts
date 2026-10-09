import type {ColumnBatch, DatabaseAdapter, DatasetContext, Draft, InferenceAdapter, PipelineEvent, QueryCompiler, QueryTiming, QueryView} from './types';

type Emit = (event:PipelineEvent)=>void;
interface Job {
  id:string; draft:Draft; abort:AbortController; timing:QueryTiming;
  view?:QueryView; staged:ColumnBatch[]; committed:boolean; settled:boolean; error?:Error;
}
export interface CoordinatorOptions {
  database:DatabaseAdapter; inference:InferenceAdapter; compiler:QueryCompiler; context:DatasetContext;
  emit:Emit; speculation:boolean; debounceMs?:number; speculativeBytes?:number; resultBytes?:number;
}

/** Control only. The data path passes retained column views by reference. */
export class BrowserCoordinator {
  private candidate?:Job;
  private foreground?:Job;
  private timer?:ReturnType<typeof setTimeout>;
  private latest?:Draft;
  private closed=false;
  private counter=0;
  private readonly session=crypto.randomUUID().slice(0,8);
  constructor(private readonly options:CoordinatorOptions) {}
  private emit(event:PipelineEvent) { if (!this.closed) this.options.emit(event); }
  private trace(event:string,detail:string) { this.emit({type:'trace',entry:{at:performance.now(),event,detail}}); }

  observeDraft(draft:Draft,composing=false):void {
    if (this.closed || (this.latest && draft.revision < this.latest.revision)) return;
    if (draft.contextId !== this.options.context.id) return;
    this.latest=draft;
    this.options.inference.observeDraft(draft);
    this.emit({type:'draft',revision:draft.revision,chars:draft.text.length});
    clearTimeout(this.timer);
    if (this.candidate && this.candidate.draft.text !== draft.text) this.dropCandidate('Draft changed');
    if (!this.options.speculation || composing || draft.text.trim().length<4 || this.candidate) return;
    this.timer=setTimeout(()=> {
      if (this.closed || this.latest !== draft) return;
      const job=this.makeJob(draft,false);
      this.candidate=job;
      this.emit({type:'speculation',state:'resolving',text:draft.text,points:0});
      this.trace('speculation_started',`revision ${draft.revision}`);
      void this.run(job);
    },this.options.debounceMs ?? 180);
  }

  commit(draft:Draft):void {
    if (this.closed || !draft.text.trim()) return;
    if (draft.contextId !== this.options.context.id) {
      this.emit({type:'error',message:'The dataset changed. Please submit the question again.'}); return;
    }
    clearTimeout(this.timer);
    // COMMIT is a full immutable snapshot; it never waits for a draft acknowledgement.
    this.latest=draft;
    this.options.inference.observeDraft(draft);
    this.foreground?.abort.abort();
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
      this.trace(job.timing.promoted?'prepared_result_promoted':'inflight_work_promoted',`revision ${draft.revision}`);
      // A same-text draft may have a later revision; bind display to the committed revision.
      job.draft=draft;
      if (job.view) {
        job.view.revision=draft.revision;
        this.emit({type:'start',view:job.view});
        for (const batch of job.staged) this.emit({type:'batch',id:job.id,batch});
        job.staged=[];
      }
      if (job.settled) this.emit({type:'complete',id:job.id,timing:job.timing});
    } else {
      this.dropCandidate('Commit did not match prepared work');
      job=this.makeJob(draft,true);
      this.foreground=job;
      this.trace('commit',`revision ${draft.revision}`);
      void this.run(job);
    }
    this.emit({type:'speculation',state:'idle',text:'',points:0});
  }

  private makeJob(draft:Draft,committed:boolean):Job {
    const now=performance.now();
    return {id:`${this.session}-${++this.counter}`,draft,abort:new AbortController(),committed,settled:false,staged:[],
      timing:{startedAt:now,committedAt:committed?draft.sentAt:undefined,promoted:false,batches:0,points:0,bytes:0}};
  }

  private async run(job:Job):Promise<void> {
    const {inference,compiler,database,context}=this.options;
    try {
      const result=await inference.resolve(job.draft,job.abort.signal);
      if (job.abort.signal.aborted || this.closed) return;
      job.timing.intentAt=performance.now();
      const sql=compiler.compile(result.plan,context);
      job.view={id:job.id,prompt:job.draft.text,revision:job.draft.revision,plan:result.plan,sql,
        source:result.source,model:result.model,context,timing:job.timing};
      if (job.committed) this.emit({type:'start',view:job.view});
      else this.emit({type:'speculation',state:'querying',text:job.draft.text,points:0});
      this.trace('intent_validated',`${result.source} · ${job.id}`);
      for await (const batch of database.execute({id:job.id,sql,plan:result.plan,context,signal:job.abort.signal,
        priority:job.committed?'committed':'speculative'})) {
        if (job.abort.signal.aborted || this.closed) return;
        if (!batch.length) continue;
        const max=job.committed?(this.options.resultBytes??16*1024*1024):(this.options.speculativeBytes??4*1024*1024);
        if (job.timing.bytes+batch.byteLength>max) throw new Error(job.committed
          ?'Result exceeded the 16 MiB drawing budget. Choose a shorter window or wider bucket.'
          :'Speculative result exceeded its memory budget.');
        job.timing.firstBatchAt ??= performance.now();
        job.timing.batches++; job.timing.points+=batch.length; job.timing.bytes+=batch.byteLength;
        if (job.committed) this.emit({type:'batch',id:job.id,batch});
        else job.staged.push(batch);
      }
      if (job.abort.signal.aborted || this.closed) return;
      job.settled=true;
      job.timing.completedAt=performance.now();
      if (job.committed) this.emit({type:'complete',id:job.id,timing:job.timing});
      else this.emit({type:'speculation',state:'ready',text:job.draft.text,points:job.timing.points});
      this.trace('query_complete',`${job.timing.points.toLocaleString()} points · ${job.timing.batches} batches`);
    } catch (cause) {
      if (job.abort.signal.aborted || this.closed) return;
      job.error=cause instanceof Error?cause:new Error(String(cause));
      job.settled=true;
      job.abort.abort();
      job.staged=[];
      if (job.committed && this.foreground===job) this.emit({type:'error',id:job.view?job.id:undefined,message:job.error.message});
      else if (this.candidate===job) {
        this.candidate=undefined;
        this.emit({type:'speculation',state:'idle',text:'',points:0});
        this.trace('speculation_discarded',job.error.message);
      }
    }
  }

  markDraw(id:string,at:number):void {
    const job=this.foreground;
    if (!job || job.id!==id || job.timing.firstDrawAt!==undefined) return;
    job.timing.firstDrawAt=at;
    this.trace('first_draw_submitted',`${Math.max(0,at-(job.timing.committedAt??at)).toFixed(2)} ms after commit`);
  }
  private dropCandidate(reason:string) {
    if (!this.candidate) return;
    this.candidate.abort.abort(); this.candidate.staged=[]; this.candidate=undefined;
    this.emit({type:'speculation',state:'canceled',text:reason,points:0});
  }
  cancel():void {
    clearTimeout(this.timer); this.dropCandidate('Canceled'); this.foreground?.abort.abort();
    this.trace('canceled','Pending work canceled');
  }
  dispose():void { this.cancel(); this.closed=true; }
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
    if (!this.closed) this.channel.port1.postMessage({type:'DRAFT',epoch:this.epoch,draft:this.snapshot(text),composing});
  }
  commit(text:string):void {
    if (!this.closed) this.channel.port1.postMessage({type:'COMMIT',epoch:this.epoch,draft:this.snapshot(text)});
  }
  cancel():void { this.epoch++; this.coordinator.cancel(); }
  markDraw(id:string,at:number):void { this.coordinator.markDraw(id,at); }
  dispose():void {
    this.closed=true; this.channel.port1.close(); this.channel.port2.close(); this.coordinator.dispose();
  }
}
