import {BrowserCoordinator,type CoordinatorClient,type CoordinatorOptions} from './coordinator';
import type {AdapterStatus,Draft} from './types';

/** Remote scheduling, direct data delivery. A server never needs to bounce local
 * Arrow buffers through a network to decide which draft to prepare or accept. */
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
  private timeout:ReturnType<typeof setTimeout>;
  constructor(endpoint:string,private options:CoordinatorOptions,private status:(s:AdapterStatus)=>void) {
    const url=new URL(endpoint,location.href);
    if (!['ws:','wss:'].includes(url.protocol)||url.username||url.password) throw new Error('Coordinator requires a ws:// or wss:// endpoint without embedded credentials.');
    this.executor=new BrowserCoordinator({...options,debounceMs:0});
    this.socket=new WebSocket(url,'time-blast.v1');
    this.timeout=setTimeout(()=>this.fail('Remote coordinator did not become ready within 10 seconds.'),10_000);
    status({state:'loading',label:'Connecting remote coordinator'});
    this.socket.onopen=()=>this.send({type:'HELLO',version:1,epoch:this.epoch,context:options.context,speculation:options.speculation,
      inference:{id:options.inference.id,placement:options.inference.placement},
      database:{id:options.database.id,placement:options.database.placement},
      dataPlane:'direct-to-browser'});
    this.socket.onmessage=({data})=> {
      if(this.disposed)return;
      try {
        if (typeof data!=='string'||data.length>16_384) throw new Error('Invalid coordinator message.');
        const message=JSON.parse(data);
        if (message.type==='READY'&&message.version===1) {
          clearTimeout(this.timeout);
          this.ready=true; status({state:'ready',label:'Remote coordinator connected'});
          if (this.latest) this.send({type:'DRAFT',epoch:this.epoch,draft:this.latest,composing:this.composing});
          if (this.committed) this.send({type:'COMMIT',epoch:this.epoch,commitId:this.commitId,draft:this.committed});
        } else if (message.type==='PREPARE'&&this.ready&&options.speculation&&!this.composing
          &&message.epoch===this.epoch&&message.revision>this.lastPrepared&&message.revision>this.lastAccepted
          &&message.revision===this.latest?.revision&&message.contextId===options.context.id) {
          this.lastPrepared=message.revision;
          this.executor.observeDraft(this.latest!);
        } else if (message.type==='ACCEPT'&&this.ready&&this.committed
          &&message.epoch===this.epoch&&message.commitId===this.commitId
          &&message.revision===this.committed.revision&&message.contextId===options.context.id) {
          this.lastAccepted=message.revision;
          const draft=this.committed; this.committed=undefined; this.executor.commit(draft);
        } else if (message.type==='ERROR') {
          this.fail(String(message.message??'Remote coordinator failed').slice(0,1024));
        }
      } catch (error) { this.fail(error instanceof Error?error.message:String(error)); }
    };
    this.socket.onerror=()=>this.fail('Remote coordinator connection failed.');
    this.socket.onclose=()=> { if (!this.disposed) this.fail('Remote coordinator disconnected.'); };
  }
  private send(message:unknown):void {
    if (this.socket.readyState!==WebSocket.OPEN) return;
    if (this.socket.bufferedAmount>65_536) { this.fail('Coordinator send queue exceeded its budget.'); return; }
    this.socket.send(JSON.stringify(message));
  }
  private snapshot(text:string):Draft {
    if (text!==this.lastText) { this.revision++; this.lastText=text; }
    return {revision:this.revision,text,contextId:this.options.context.id,sentAt:performance.now()};
  }
  draft(text:string,composing=false):void {
    if (this.disposed) return;
    this.latest=this.snapshot(text); this.composing=composing;
    // Inference context receives edits immediately even before scheduling permission.
    // Observe with scheduling suppressed: invalidate stale work immediately,
    // then await the server's PREPARE decision for this revision.
    this.executor.observeDraft(this.latest,true);
    if (this.ready) this.send({type:'DRAFT',epoch:this.epoch,draft:this.latest,composing});
  }
  commit(text:string):void {
    if (this.disposed||!text.trim()) return;
    this.committed=this.snapshot(text);
    this.commitId++;
    if (this.ready) this.send({type:'COMMIT',epoch:this.epoch,commitId:this.commitId,draft:this.committed});
  }
  cancel():void {
    this.epoch++;this.committed=undefined;this.latest=undefined;this.lastPrepared=-1;this.lastAccepted=-1;
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
