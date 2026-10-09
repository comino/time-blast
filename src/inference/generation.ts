import { abortError } from './plan';

interface Entry {
  id:string; task:()=>Promise<unknown>; stop:()=>void|Promise<void>;
  resolve:(value:unknown)=>void; reject:(error:unknown)=>void;
  canceled:boolean; stopping?:Promise<void>;
}

/** One active generation and one removable waiter; stop belongs to its owner. */
export class GenerationQueue {
  private active?:Entry;
  private waiting?:Entry;

  run<T>(id:string,task:()=>Promise<T>,stop:()=>void|Promise<void>):Promise<T> {
    if(this.active?.id===id||this.waiting?.id===id)return Promise.reject(new Error('Duplicate inference request ID.'));
    if(this.active&&this.waiting)return Promise.reject(new Error('Inference admission queue is full.'));
    return new Promise<T>((resolve,reject)=>{
      const entry:Entry={id,task,stop,resolve:value=>resolve(value as T),reject,canceled:false};
      if(this.active)this.waiting=entry;
      else {this.active=entry;void this.execute(entry);}
    });
  }

  isCanceled(id:string):boolean {return this.active?.id===id&&this.active.canceled;}

  cancel(id:string):void {
    if(this.waiting?.id===id) {
      const entry=this.waiting;this.waiting=undefined;
      entry.reject(abortError());return;
    }
    const entry=this.active;
    if(entry?.id!==id||entry.canceled)return;
    entry.canceled=true;
    try {entry.stopping=Promise.resolve(entry.stop()).catch(()=>undefined);}
    catch {entry.stopping=Promise.resolve();}
  }

  private async execute(entry:Entry):Promise<void> {
    let value:unknown,error:unknown,failed=false;
    try {
      // Start in a microtask so cancellation before execution also skips the body.
      await Promise.resolve();
      if(entry.canceled)throw abortError();
      value=await entry.task();
      if(entry.canceled)throw abortError();
    } catch(cause) {failed=true;error=cause;}
    finally {
      if(entry.stopping)await entry.stopping;
      if(this.active===entry)this.active=undefined;
    }
    if(failed)entry.reject(error);else entry.resolve(value);
    const next=this.waiting;this.waiting=undefined;
    if(next){this.active=next;void this.execute(next);}
  }
}
