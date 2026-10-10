/** Execution limits for model-written SQL. Row/byte budgets carry over the prototype's values
 * (formerly src/adapters/arrow.ts MAX_RESULT_ROWS / MAX_RESULT_BYTES), enforced on the same
 * Arrow batches. */
export interface QueryLimits {
  /** Maximum result rows streamed for one request. */
  maxRows: number;
  /** Maximum Arrow IPC bytes (sum of BATCH message sizes) for one request. */
  maxBytes: number;
  /** Wall-clock budget from EXEC receipt to DONE. */
  timeMs: number;
  /** Queued EXECs beyond the running one. */
  maxQueued: number;
}

export const DEFAULT_LIMITS: QueryLimits = Object.freeze({
  maxRows: 250_000,
  maxBytes: 32 * 1024 * 1024,
  timeMs: 15_000,
  maxQueued: 16,
});

/** DuckDB-Wasm `query.queryPollingInterval`: how long one poll of a pending query runs
 * before control returns to JS. Bounds CANCEL latency during execution. */
export const POLL_INTERVAL_MS = 4;
/** Continuous JS-side work (decode + emit batches) before yielding to the event loop. */
export const SLICE_MS = 4;
