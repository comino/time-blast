/**
 * In-page fake inference node for /measure.html: a tb1 node on a dedicated worker, the same
 * placement as the WebLLM node (src/inference-node/webllm.worker.ts), answering INFER with canned
 * SQL (src/measure/canned.ts) after a configurable delay. Mirrors tests/fake_inference.py:
 * HELLO → READY, CONTEXT stored, INFER → SQL_DELTA ×2, SQL, INFER_STATS (cost 0), every reply
 * echoing the INFER's identities and stamped INFER_RECEIVED / SQL_FIRST_DELTA / SQL_COMPLETE.
 *
 * Configuration rides in the HELLO payload: `{"fake": {"latencyMs": 0, "mode": "echo"}}`; a new mode
 * or latency means a new link (the engine reconnects on a placement change).
 */
import { createPortLink, type PortLike } from '../engine/links';
import type { LocalFrame } from '../engine/contracts';
import { header, json, Kind, Node, now, readJson, readText, Stage, text, type Frame, type Stamp } from '../protocol/frame';
import { sqlFor, type AnswerMode } from './canned';

const link = createPortLink('inference', self as unknown as PortLike);
let latencyMs = 0, mode: AnswerMode = 'echo';
const pending = new Map<number, ReturnType<typeof setTimeout>>();

function answer(f: Frame<Uint8Array>, received: number): void {
  pending.delete(f.request);
  const sql = sqlFor(readText(f.payload), mode);
  const ids = { epoch: f.epoch, request: f.request, revision: f.revision, context: f.context };
  const half = sql.length >> 1;
  const ledger: Stamp[] = [{ stage: Stage.INFER_RECEIVED, node: Node.INFERENCE, at: received }, { stage: Stage.SQL_FIRST_DELTA, node: Node.INFERENCE, at: now() }];
  link.send({ ...header(Kind.SQL_DELTA, ids), stamps: ledger, payload: text(sql.slice(0, half)) });
  link.send({ ...header(Kind.SQL_DELTA, ids), stamps: [], payload: text(sql.slice(half)) });
  link.send({ ...header(Kind.SQL, ids), stamps: [...ledger, { stage: Stage.SQL_COMPLETE, node: Node.INFERENCE, at: now() }], payload: text(sql) });
  link.send({ ...header(Kind.INFER_STATS, ids), stamps: [], payload: json({ model: 'fake (in page)', promptTokens: 0, completionTokens: 0, costUsd: 0, attempts: 1 }) });
}

link.listen((frame: LocalFrame) => {
  const f = frame as Frame<Uint8Array>;
  switch (f.kind) {
    case Kind.HELLO: {
      try {
        const cfg = readJson<{ fake?: { latencyMs?: number; mode?: AnswerMode } }>(f.payload).fake ?? {};
        latencyMs = Math.max(0, Number(cfg.latencyMs ?? 0));
        if (cfg.mode === 'plain' || cfg.mode === 'echo' || cfg.mode === 'vary') mode = cfg.mode;
      } catch { /* defaults */ }
      link.send({ ...header(Kind.READY), stamps: [], payload: json({ node: 'inference', name: 'fake-inference (in page)', model: `fake · ${mode} · ${latencyMs} ms` }) });
      return;
    }
    case Kind.INFER: {
      const received = now();
      if (latencyMs <= 0) answer(f, received);
      else pending.set(f.request, setTimeout(() => answer(f, received), latencyMs));
      return;
    }
    case Kind.CANCEL: {
      const drop = f.request ? [f.request] : [...pending.keys()];
      for (const request of drop) { clearTimeout(pending.get(request)); pending.delete(request); }
      return;
    }
    default: return; // CONTEXT, PRIME, … : nothing to do for canned answers
  }
});
