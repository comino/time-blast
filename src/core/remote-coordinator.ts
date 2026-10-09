import {BrowserCoordinator,translationThreshold,type CoordinatorClient,type CoordinatorOptions} from './coordinator';
import type {AdapterStatus,Draft} from './types';
import {MAX_PROMPT_CHARS} from '../inference/plan';

const MAX_SOCKET_BYTES=65_536;
const controlEncoder=new TextEncoder();

/** Remote scheduling, direct data delivery. A server never needs to bounce local
 * Arrow buffers through a network to decide which draft to prepare or accept.
 * Live translation is advertised policy, still authorized per revision by PREPARE;
 * no remote service or immediate remote scheduling guarantee is provided here. */
export class RemoteCoordinatorClient implements CoordinatorClient {
  private socket:WebSocket;
  private executor:BrowserCoordinator;
  private latest?:Draft;
  private committed?:Draft;
  private composing=false;
  private revision=0;
  private ready=false;
  private disposed=false;
  private lastText='';
  private epoch=0;
  private commitId=0;
  private lastPrepared=-1;
  private lastAccepted=-1;
  private deferredPrepare?:number;
  private timeout:ReturnType<typeof setTimeout>;
  constructor(endpoint:string,private options:CoordinatorOptions,private status:(s:AdapterStatus)=>void) {
    const url=new URL(endpoint,location.href);
    if (!['ws:','wss:'].includes(url.protocol)||url.username||url.password) throw new Error('Coordinator requires a ws:// or wss:// endpoint without embedded credentials.');
    this.executor=new BrowserCoordinator({...options,debounceMs:0});
    this.socket=new WebSocket(url,'time-blast.v1');
    this.timeout=setTimeout(()=>this.fail('Remote coordinator did not become ready within 10 seconds.'),10_000);
    status({state:'loading',label:'Connecting remote coordinator'});
    this.socket.onopen=()=>this.send({type:'HELLO',version:1,epoch:this.epoch,context:options.context,speculation:options.speculation,
      liveTranslation:options.liveTranslation??false,translationMinChars:translationThreshold(options.translationMinChars),
      inference:{id:options.inference.id,placement:options.inference.placement},
      database:{id:options.database.id,placement:options.database.placement},
      dataPlane:'direct-to-browser'});
    this.socket.onmessage=({data})=> {
      if(this.disposed)return;
      try {
        if (typeof data!=='string'||data.length>16_384||controlEncoder.encode(data).byteLength>16_384) throw new Error('Invalid coordinator message.');
        const message=JSON.parse(data);
        if (message.type==='READY'&&message.version===1) {
          clearTimeout(this.timeout);
          this.ready=true; status({state:'ready',label:'Remote coordinator connected'});
          if (this.latest) this.send({type:'DRAFT',epoch:this.epoch,draft:this.latest,composing:this.composing});
          if (this.committed) this.send({type:'COMMIT',epoch:this.epoch,commitId:this.commitId,draft:this.committed});
        } else if (message.type==='PREPARE'&&this.ready&&(options.speculation||options.liveTranslation)&&!this.composing
          &&(!options.liveTranslation||(this.latest?.text.trim().length??0)>=translationThreshold(options.translationMinChars))
          &&message.epoch===this.epoch&&message.revision>this.lastPrepared&&message.revision>this.lastAccepted
          &&message.revision===this.latest?.revision&&message.contextId===options.context.id) {
          this.lastPrepared=message.revision;
          // A newer draft must not run ahead of an immutable submission awaiting
          // ACCEPT. Keep one permission and admit it after that foreground starts.
          if(this.committed)this.deferredPrepare=message.revision;
          else this.executor.observeDraft(this.latest!);
        } else if (message.type==='ACCEPT'&&this.ready&&this.committed
          &&message.epoch===this.epoch&&message.commitId===this.commitId
          &&message.revision===this.committed.revision&&message.contextId===options.context.id) {
          this.lastAccepted=message.revision;
          const draft=this.committed; this.committed=undefined; this.executor.commit(draft);
          const prepared=this.deferredPrepare;this.deferredPrepare=undefined;
          if(prepared!==undefined&&prepared>draft.revision&&prepared===this.latest?.revision&&!this.composing) {
            this.executor.observeDraft(this.latest!);
          }
        } else if (message.type==='ERROR') {
          this.fail(String(message.message??'Remote coordinator failed').slice(0,1024));
        }
      } catch (error) { this.fail(error instanceof Error?error.message:String(error)); }
    };
    this.socket.onerror=()=>this.fail('Remote coordinator connection failed.');
    this.socket.onclose=()=> { if (!this.disposed) this.fail('Remote coordinator disconnected.'); };
  }
  private send(message:unknown):void {
    if (this.disposed||this.socket.readyState!==WebSocket.OPEN) return;
    const payload=JSON.stringify(message);
    if (payload.length>MAX_SOCKET_BYTES||this.socket.bufferedAmount+controlEncoder.encode(payload).byteLength>MAX_SOCKET_BYTES) {
      this.fail('Coordinator send queue exceeded its budget.'); return;
    }
    this.socket.send(payload);
  }
  private snapshot(text:string,advance=false):Draft {
    if (advance||text!==this.lastText) { this.revision++; this.lastText=text; }
    return {revision:this.revision,text,contextId:this.options.context.id,sentAt:performance.now()};
  }
  draft(text:string,composing=false):void {
    if (this.disposed) return;
    if (text.length>MAX_PROMPT_CHARS) {
      // Invalidate the old candidate, but neither retain nor transmit an unbounded paste.
      this.latest=undefined;
      this.executor.observeDraft(this.snapshot('',composing!==this.composing),composing,true);
      this.composing=composing;
      return;
    }
    // Composition changes revoke scheduling permission even when text is unchanged.
    this.latest=this.snapshot(text,composing!==this.composing); this.composing=composing;
    // Inference context receives edits immediately even before scheduling permission.
    // Observe with scheduling suppressed: invalidate stale work immediately,
    // then await the server's PREPARE decision for this revision.
    this.executor.observeDraft(this.latest,composing,true);
    if (this.ready) this.send({type:'DRAFT',epoch:this.epoch,draft:this.latest,composing});
  }
  commit(text:string):void {
    if (this.disposed||!text.trim()) return;
    // Enter supersedes foreground work immediately, even while ACCEPT is in flight.
    this.executor.cancelForeground();
    this.committed=undefined;
    this.deferredPrepare=undefined;
    this.commitId++;
    if (text.length>MAX_PROMPT_CHARS) {
      this.draft(text);
      this.options.emit({type:'error',message:`Requests must be at most ${MAX_PROMPT_CHARS} characters.`});
      return;
    }
    this.latest=this.committed=this.snapshot(text,this.composing); this.composing=false;
    // Preserve an exact candidate; discard mismatched speculation before server latency.
    this.executor.observeDraft(this.committed,false,true);
    if (this.ready) this.send({type:'COMMIT',epoch:this.epoch,commitId:this.commitId,draft:this.committed});
  }
  cancel():void {
    this.epoch++;this.committed=undefined;this.latest=undefined;this.lastPrepared=-1;this.lastAccepted=-1;this.deferredPrepare=undefined;
    this.executor.cancel();this.send({type:'CANCEL',epoch:this.epoch});
  }
  markDraw(id:string,at:number):void { this.executor.markDraw(id,at); }
  private fail(message:string):void {
    if (this.disposed) return;
    this.status({state:'error',label:'Remote coordinator unavailable',detail:message});
    this.options.emit({type:'error',message}); this.dispose();
  }
  dispose():void {
    if (this.disposed) return;
    this.disposed=true;clearTimeout(this.timeout);this.executor.dispose();this.socket.close();
  }
}
