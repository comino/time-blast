import { CHART_VIEWS, type DatasetContext, type FirstBucketExecution, type QueryCompiler, type QueryPlan } from './types';
import { MAX_WINDOW_HOURS } from './query-limits';

interface CompilerExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  compile_query(metric:number, aggregate:number, bucket:number, hours:number, split:number, vessel:number, start:number, end:number):number;
  compile_query_range(metric:number, aggregate:number, bucket:number, hours:number, split:number, vessel:number, start:number, end:number, lower:number, upper:number):number;
  output_ptr():number;
  output_len():number;
}
export class WasmQueryCompiler implements QueryCompiler {
  readonly kind = 'rust-wasm' as const;
  private wasm?: CompilerExports;
  private loading?: Promise<void>;
  prepare(): Promise<void> {
    return this.loading ??= (async () => {
      const response = await fetch(`${import.meta.env.BASE_URL}wasm/query-core.wasm`);
      if (!response.ok) throw new Error('Query compiler could not load. Please reload.');
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
      this.wasm = instance.exports as CompilerExports;
    })();
  }
  compile(plan: QueryPlan, context: DatasetContext): string {
    return this.compileStatement(plan, context);
  }
  /** Compile complete groups within the original query; never re-anchor its window. */
  compileRange(plan: QueryPlan, context: DatasetContext, lower: number, upper: number): string {
    if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper)) throw new Error('Invalid execution range.');
    return this.compileStatement(plan, context, [lower, upper]);
  }
  compileFirstBucket(plan: QueryPlan, context: DatasetContext): FirstBucketExecution | undefined {
    const sql = this.compile(plan, context); // validates the original plan and snapshot
    const lower = Math.max(context.start, context.end - plan.windowHours * 3_600_000);
    const bucket = plan.bucketMinutes * 60_000;
    const cut = Math.min(context.end, (Math.floor(lower / bucket) + 1) * bucket);
    if (cut === context.end) return undefined;
    return Object.freeze({ kind: 'first-complete-bucket', sql, contextId: context.id, start: context.start, end: context.end,
      firstSql: this.compileRange(plan, context, lower, cut), remainderSql: this.compileRange(plan, context, cut, context.end) });
  }
  private compileStatement(plan: QueryPlan, context: DatasetContext, range?: readonly [number, number]): string {
    if (!this.wasm) throw new Error('Query compiler is still warming.');
    const m = ['speed','wind','wave_height','water_temp'].indexOf(plan.metric);
    const a = ['avg','min','max'].indexOf(plan.aggregate);
    // Check before coercing into the integer WASM ABI, including malformed remote responses.
    if (m < 0 || a < 0 || ![1,5,15,60,360,1440].includes(plan.bucketMinutes)
      || !Number.isInteger(plan.windowHours) || plan.windowHours<1 || plan.windowHours>MAX_WINDOW_HOURS
      || typeof plan.splitByVessel !== 'boolean' || (plan.vessel !== null && (!Number.isInteger(plan.vessel) || plan.vessel<0 || plan.vessel>5))
      || !CHART_VIEWS.includes(plan.view)
      || (['map','density','tracks'].includes(plan.view) && !plan.splitByVessel)) throw new Error('Invalid query intent.');
    const args = [m,a,plan.bucketMinutes,plan.windowHours,Number(plan.splitByVessel),plan.vessel ?? -1,context.start,context.end] as const;
    const status = range ? this.wasm.compile_query_range(...args, ...range) : this.wasm.compile_query(...args);
    const text = new TextDecoder().decode(new Uint8Array(this.wasm.memory.buffer, this.wasm.output_ptr(), this.wasm.output_len()));
    if (status !== 0) throw new Error(text);
    return text;
  }
}
