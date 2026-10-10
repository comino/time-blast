#!/usr/bin/env python3
"""Evaluate real browser inference against the meaning corpus, with no templates.

Start Vite and run on a hardware-GPU host:
  python3 tests/browser_model_accuracy.py --profile qwen3-4b --headed

Defaults to eight public regressions. --split heldout --limit 64 includes the
heldout set; --cases id1,id2 selects explicit cases. Weights download to an
ephemeral Chromium profile. No database or chart starts. Requires Playwright.

--self-test exercises this harness and the real inference adapter with a
controlled Worker, without loading any model. It is not an accuracy evaluation.
Exit 0: every selected case correct; 1: mismatch/error; 2: no verified hardware
adapter. The report is saved after each case. No software-WebGPU option exists.
"""
from __future__ import annotations

import argparse
import asyncio
import collections
import datetime
import hashlib
import json
import pathlib
import re
import sys
import time

from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
REFUSAL = {"error": "unsupported_request"}
CORRECT = {"correct_plan", "correct_refusal"}

GPU_PROBE = """async () => {
  if (!navigator.gpu) return {available:false,reason:'navigator.gpu is absent'};
  const adapter=await navigator.gpu.requestAdapter();
  if (!adapter) return {available:false,reason:'requestAdapter() returned null'};
  const info=adapter.info ?? {};
  return {available:true,info:{vendor:info.vendor,architecture:info.architecture,
    device:info.device,description:info.description},
    fallback:info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
    features:[...adapter.features],limits:{
      maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize:adapter.limits.maxBufferSize}};
}"""

WORKER_GPU_PROBE = """async source => {
  const url=URL.createObjectURL(new Blob([
    '('+source+')().then(value=>postMessage(value)).catch(error=>postMessage({available:false,reason:String(error)}))'
  ],{type:'text/javascript'}));
  let worker;
  try {
    return await new Promise((resolve,reject)=>{
      worker=new Worker(url,{type:'module'});
      const timer=setTimeout(()=>reject(new Error('Worker GPU preflight timed out')),10000);
      worker.onmessage=event=>{clearTimeout(timer);resolve(event.data);};
      worker.onerror=event=>{clearTimeout(timer);reject(new Error(event.message));};
    });
  } finally {worker?.terminate();URL.revokeObjectURL(url);}
}"""

BOOT = """async ({context,profile}) => {
  const {LocalInferenceAdapter}=await import('/src/inference/index.ts');
  const {normalizeModelOutput}=await import('/src/inference/model-output.ts');
  const serialize=error=>{
    const details=error?.details,response=details?.response;
    const normalized=typeof response?.text==='string'
      ? normalizeModelOutput(response.text,details?.model ?? '') : undefined;
    return {name:error?.name??'Error',message:error?.message??String(error),
      source:details?.source,model:details?.model,diagnostics:details?.diagnostics,response,
      responseNormalization:normalized===undefined ? undefined : {
        normalizer:'src/inference/model-output.ts:normalizeModelOutput',
        changed:normalized!==response.text,text:normalized}};
  };
  const state=window.accuracy={ready:false,warmDone:false,statuses:[]};
  const adapter=window.accuracyAdapter=new LocalInferenceAdapter('webgpu',{
    localModel:profile,cacheModelPlans:false,
    onStatus:status=>{state.status=status;state.statuses.push(status);if(state.statuses.length>24)state.statuses.shift();}
  });
  adapter.setPlanCacheEnabled(false);
  window.startAccuracyCase=({text,revision,timeoutMs})=>{
    const probe=window.accuracyCase={done:false};
    const controller=new AbortController(),start=performance.now();
    const timer=setTimeout(()=>{probe.timedOut=true;controller.abort();},timeoutMs);
    const draft={text,revision,contextId:context.id,sentAt:start};
    adapter.observeDraft(draft);
    void adapter.resolve(draft,controller.signal).then(result=>{probe.result=result;},
      error=>{probe.error=serialize(error);}).finally(()=>{
        clearTimeout(timer);probe.wallMs=performance.now()-start;probe.done=true;
      });
  };
  const start=performance.now();
  void adapter.prepare(context).then(()=>{state.ready=true;},error=>{state.error=serialize(error);})
    .finally(()=>{state.warmupMs=performance.now()-start;state.warmDone=true;});
}"""

# Only used by the explicitly selected controlled harness test. Real runs never
# install this Worker or receive expected plans in their browser context.
FIXTURE = """fixtures => {
  Object.defineProperty(navigator,'gpu',{configurable:true,value:{}});
  window.fixtureMessages=[];
  window.Worker=class {
    constructor(){this.stopped=false;}
    postMessage(message){
      fixtureMessages.push(message);
      queueMicrotask(()=>{
        if(this.stopped)return;
        if(message.type==='prepare')this.onmessage?.({data:{type:'ready',id:message.id,model:'controlled-qwen-fixture'}});
        if(message.type==='resolve'){
          const fixture=fixtures[message.draft.text];
          this.onmessage?.({data:fixture.error?{type:'error',id:message.id,...fixture.error}:
            {type:'result',id:message.id,result:{plan:fixture.plan,source:'webgpu',model:'controlled-qwen-fixture',
              diagnostics:{attempts:1,generationMs:1,completionTokens:30}}}});
        }
      });
    }
    terminate(){this.stopped=true;}
  };
}"""


def hardware_problem(gpu):
    if not gpu.get("available"):
        return gpu.get("reason", "WebGPU unavailable")
    if gpu.get("fallback"):
        return "WebGPU reported a fallback adapter"
    description = " ".join(str(value or "") for value in gpu.get("info", {}).values())
    if re.search(r"swiftshader|llvmpipe|lavapipe|software|microsoft basic render", description, re.I):
        return "Software GPU detected; this evaluator requires hardware WebGPU"
    if not description.strip():
        return "GPU identity was not exposed; hardware could not be verified"
    return None


def classify(expected, probe):
    result, failure = probe.get("result"), probe.get("error") or {}
    if probe.get("timedOut"):
        return "timeout"
    if result:
        if result.get("source") != "webgpu" or result.get("diagnostics", {}).get("cacheHit"):
            return "invalid_execution_path"
        if expected == REFUSAL:
            return "false_accept"
        return "correct_plan" if result.get("plan") == expected else "wrong_plan"
    response = failure.get("response") or {}
    runtime_fault = failure.get("name") in {"DeviceLostError", "ModelNotLoadedError", "AbortError", "TypeError"}
    if runtime_fault or failure.get("source") != "webgpu" or not response.get("text"):
        return "runtime_error"
    if response.get("finishReason") != "stop" or response.get("truncated"):
        return "invalid_output" if expected != REFUSAL else "rejected_unsupported"
    try:
        # The browser uses the production model allowlist and exact-prefix rule.
        # Keep raw response untouched; never guess or strip reasoning in Python.
        normalized = failure.get("responseNormalization") or {}
        refusal = json.loads(normalized.get("text", response["text"])) == REFUSAL
    except (ValueError, TypeError):
        refusal = False
    if refusal:
        return "correct_refusal" if expected == REFUSAL else "false_refusal"
    return "rejected_unsupported" if expected == REFUSAL else "invalid_output"


def select_cases(corpus, args):
    cases = corpus["cases"]
    if args.cases:
        selected = args.cases.split(",")
        by_id = {case["id"]: case for case in cases}
        missing = set(selected) - set(by_id)
        if missing:
            raise ValueError(f"Unknown case IDs: {', '.join(sorted(missing))}")
        if len(selected) != len(set(selected)):
            raise ValueError("Case IDs must not be duplicated")
        cases = [by_id[case_id] for case_id in selected]
    elif args.split != "all":
        cases = [case for case in cases if case["split"] == args.split]
    cases = cases[:args.limit]
    if not cases:
        raise ValueError("No corpus cases selected")
    return cases


def save_report(path, report):
    results = report["results"]
    report["summary"] = {"completed_cases": len(results),
                         "outcomes": dict(collections.Counter(item["outcome"] for item in results))}
    report["model_ids"] = sorted({model for item in results
                                  if (model := ((item["probe"].get("result") or item["probe"].get("error") or {}).get("model")))})
    if report["mode"] == "hardware_webgpu":
        # Runtime failures stay in the denominator; unavailable preflight has no score.
        report["summary"]["strict_accuracy"] = (
            sum(item["outcome"] in CORRECT for item in results) / len(results) if results else None)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2) + "\n")
    temporary.replace(path)


async def wait_state(page, expression, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = await asyncio.wait_for(page.evaluate(expression), max(0.001, deadline - time.monotonic()))
        if state and state.get("done", state.get("warmDone", False)):
            return state
        await asyncio.sleep(0.1)
    raise TimeoutError(f"Browser operation exceeded {timeout} seconds")


def fixture_cases():
    plan = {"metric": "wind", "aggregate": "max", "bucketMinutes": 60,
            "windowHours": 48, "splitByVessel": False, "vessel": None, "view": "line"}
    refusal = {"name": "Error", "message": "The model marked this request as unsupported.",
               "inference": {"source": "webgpu", "model": "controlled-qwen-fixture",
                             "diagnostics": {"attempts": 2, "generationMs": 2},
                             "response": {"text": json.dumps(REFUSAL), "truncated": False, "finishReason": "stop"}}}
    qwen3_model = "Qwen3-4B-q4f16_1-MLC"
    canonical_prefix = "<think>\n\n</think>\n\n"
    def prefixed_refusal(prefix, model=qwen3_model):
        return {**refusal, "inference": {**refusal["inference"], "model": model,
                "response": {**refusal["inference"]["response"], "text": prefix + json.dumps(REFUSAL)}}}
    cases = [
        {"id": "success", "question": "fixture success", "expected": plan},
        {"id": "repeat", "question": "fixture success", "expected": plan},
        {"id": "refusal", "question": "fixture refusal", "expected": REFUSAL},
        {"id": "bounded_failure", "question": "fixture bounded failure", "expected": REFUSAL},
        {"id": "canonical_refusal", "question": "fixture canonical refusal", "expected": REFUSAL},
        {"id": "canonical_false_refusal", "question": "fixture canonical false refusal", "expected": plan},
        {"id": "noncanonical_prefix", "question": "fixture noncanonical prefix", "expected": REFUSAL},
        {"id": "reasoning_prefix", "question": "fixture reasoning prefix", "expected": REFUSAL},
        {"id": "unknown_model_prefix", "question": "fixture unknown model prefix", "expected": REFUSAL},
        {"id": "invalid", "question": "fixture invalid", "expected": plan},
    ]
    fixtures = {"fixture success": {"plan": plan}, "fixture refusal": {"error": refusal},
                "fixture bounded failure": {"error": {"name": "Error", "message": "Invalid model response.",
                    "inference": {"source": "webgpu", "model": "controlled-qwen-fixture",
                                  "response": {"text": "x" * 3000, "finishReason": "stop"}}}},
                "fixture canonical refusal": {"error": prefixed_refusal(canonical_prefix)},
                "fixture canonical false refusal": {"error": prefixed_refusal(canonical_prefix)},
                "fixture noncanonical prefix": {"error": prefixed_refusal("<think></think>\n")},
                "fixture reasoning prefix": {"error": prefixed_refusal("<think>reasoning</think>\n\n")},
                "fixture unknown model prefix": {"error": prefixed_refusal(canonical_prefix, "unapproved-model")},
                "fixture invalid": {"plan": {**plan, "bucketMinutes": 2}}}
    return cases, fixtures


async def run(args):
    corpus = json.loads(args.corpus.read_text())
    cases = select_cases(corpus, args)
    fixtures = None
    if args.self_test:
        cases, fixtures = fixture_cases()
    package = ROOT / "node_modules/@mlc-ai/web-llm/package.json"
    report = {"mode": "controlled_harness" if args.self_test else "hardware_webgpu", "status": "running",
              "started_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "corpus_sha256": hashlib.sha256(args.corpus.read_bytes()).hexdigest(),
              "context": corpus["context"], "selected_case_ids": [case["id"] for case in cases],
              "profile": args.profile, "inference_mode": "webgpu", "cache_model_plans": False,
              "webllm_version_from_local_checkout": json.loads(package.read_text())["version"],
              "runtime": "LocalInferenceAdapter with WebLLM in its dedicated browser worker",
              "inference_source_sha256_from_local_checkout": {
                  str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in sorted((ROOT / "src/inference").glob("*.ts"))},
              "warmup_timeout_seconds": args.warmup_timeout, "case_timeout_seconds": args.timeout,
              "headless": not args.headed, "results": [], "page_errors": [],
              "limitations": ["Stage times are software measurements; no database or drawing is measured.",
                              "Only final returned plans and bounded final failures are exposed by the adapter; intermediate repair output is unavailable.",
                              "GPU metadata comes from preflight probes, not an engine-level device trace.",
                              "The Vite server must serve the same checkout as the recorded local dependency version."]}
    if args.self_test:
        report["limitations"].append("Controlled Worker only: this report provides no model accuracy or GPU performance evidence.")
    save_report(args.output, report)
    started = time.monotonic()
    code = 1
    async with async_playwright() as playwright:
        launch = {"headless": not args.headed, "args": ["--no-sandbox"]}
        if args.chromium:
            launch["executable_path"] = args.chromium
        browser = await playwright.chromium.launch(**launch)
        report["chromium_version"] = browser.version
        try:
            page = await browser.new_page()
            page.on("pageerror", lambda error: report["page_errors"].append(str(error)))
            await page.route("**/__model_accuracy", lambda route: route.fulfill(
                status=200, content_type="text/html", body="<!doctype html><title>Model meaning evaluation</title>"))
            # Prevent shared development edits from reloading the isolated harness.
            await page.route("**/@vite/client", lambda route: route.fulfill(
                status=200, content_type="text/javascript",
                body="export const createHotContext=()=>({data:{},accept(){},dispose(){},on(){}});"))
            await page.goto(args.url.rstrip("/") + "/__model_accuracy")
            if fixtures is None:
                report["main_gpu"] = await asyncio.wait_for(page.evaluate(GPU_PROBE), 15)
                report["worker_gpu"] = await asyncio.wait_for(page.evaluate(WORKER_GPU_PROBE, GPU_PROBE), 15)
                problem = hardware_problem(report["main_gpu"]) or hardware_problem(report["worker_gpu"])
                if problem:
                    report.update(status="unavailable", error=problem)
                    print(f"No hardware evaluation ran: {problem}. No model weights were loaded.", flush=True)
                    code = 2
                    return code
            else:
                await page.evaluate(FIXTURE, fixtures)
            await asyncio.wait_for(page.evaluate(BOOT, {"context": corpus["context"], "profile": args.profile}), 30)
            report["warmup"] = await wait_state(page, "window.accuracy", args.warmup_timeout)
            save_report(args.output, report)
            if not report["warmup"].get("ready"):
                report.update(status="error", error="Model warmup failed; inspect warmup diagnostics")
                return 1
            for index, case in enumerate(cases):
                # Expected output stays in Python and cannot influence inference or repair.
                await asyncio.wait_for(page.evaluate("input=>window.startAccuracyCase(input)",
                                    {"text": case["question"], "revision": index + 1, "timeoutMs": args.timeout * 1000}), 10)
                probe = await wait_state(page, "window.accuracyCase", args.timeout + 5)
                result = {"id": case["id"], "question": case["question"], "expected": case["expected"],
                          "split": case.get("split", "fixture"), "outcome": classify(case["expected"], probe),
                          "actual": (probe.get("result") or {}).get("plan"), "probe": probe}
                report["results"].append(result)
                save_report(args.output, report)
                print(json.dumps({"id": result["id"], "outcome": result["outcome"], "wall_ms": probe.get("wallMs")}), flush=True)
                if result["outcome"] in {"runtime_error", "timeout", "invalid_execution_path"}:
                    # An interrupted/device-lost engine must not corrupt subsequent trials.
                    report.update(status="error", error="Stopped after a runtime or execution-path failure")
                    break
            else:
                report["status"] = "complete"
            if args.self_test:
                messages = await page.evaluate("window.fixtureMessages")
                by_id = {item["id"]: item for item in report["results"]}
                canonical_error = by_id.get("canonical_refusal", {}).get("probe", {}).get("error", {})
                report["fixture_assertions"] = {
                    "outcomes": [item["outcome"] for item in report["results"]] == [
                        "correct_plan", "correct_plan", "correct_refusal", "rejected_unsupported",
                        "correct_refusal", "false_refusal", "rejected_unsupported", "rejected_unsupported",
                        "rejected_unsupported", "runtime_error"],
                    "fresh_generations": len([item for item in messages if item["type"] == "resolve"]) == len(cases),
                    "profile_forwarded": next(item for item in messages if item["type"] == "prepare")["localModel"] == args.profile,
                    "invalid_plan_never_executable": report["results"][-1]["actual"] is None,
                    "bounded_raw_failure": len(report["results"][3]["probe"]["error"]["response"]["text"]) == 2048
                        and report["results"][3]["probe"]["error"]["response"]["truncated"] is True,
                    "canonical_raw_preserved": canonical_error.get("response", {}).get("text") ==
                        fixtures["fixture canonical refusal"]["error"]["inference"]["response"]["text"],
                    "canonical_normalization_recorded": canonical_error.get("responseNormalization", {}).get("changed") is True
                        and canonical_error.get("responseNormalization", {}).get("text") == json.dumps(REFUSAL),
                    "other_prefixes_preserved": all(
                        by_id.get(case_id, {}).get("probe", {}).get("error", {}).get("responseNormalization", {}).get("changed") is False
                        for case_id in ["noncanonical_prefix", "reasoning_prefix", "unknown_model_prefix"]),
                    "software_gpu_rejected": hardware_problem({"available": True, "info": {"description": "SwiftShader"}}) is not None,
                    "fallback_gpu_rejected": hardware_problem({"available": True, "fallback": True}) is not None,
                }
                code = 0 if all(report["fixture_assertions"].values()) and not report["page_errors"] else 1
                report["status"] = "self_test_passed" if code == 0 else "self_test_failed"
            else:
                code = 0 if report["status"] == "complete" and all(item["outcome"] in CORRECT for item in report["results"]) and not report["page_errors"] else 1
        except Exception as error:
            report.update(status="error", error=str(error))
        finally:
            # Browser close terminates all workers/GPU activity, including timed-out calls.
            await browser.close()
            report["elapsed_seconds"] = round(time.monotonic() - started, 3)
            save_report(args.output, report)
            print(json.dumps({"status": report["status"], "summary": report["summary"], "report": str(args.output)}), flush=True)
    return code


def arguments():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:5173", help="Vite origin serving this checkout")
    parser.add_argument("--profile", choices=["qwen-0.5b", "qwen-1.5b", "qwen3-4b"], default="qwen3-4b")
    parser.add_argument("--corpus", type=pathlib.Path, default=ROOT / "evals/inference-corpus.json")
    parser.add_argument("--split", choices=["regression", "heldout", "all"], default="regression")
    parser.add_argument("--cases", help="Comma-separated case IDs; overrides split filtering")
    parser.add_argument("--limit", type=int, default=8, help="Maximum case count, 1..64")
    parser.add_argument("--timeout", type=float, default=30, help="Per-case seconds, 1..120")
    parser.add_argument("--warmup-timeout", type=float, default=300, help="Model warmup seconds, 1..600")
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("/tmp/time-blast-browser-model-accuracy.json"))
    parser.add_argument("--chromium", help="Optional Chromium executable")
    parser.add_argument("--headed", action="store_true", help="Show Chromium; may be required to expose hardware GPU")
    parser.add_argument("--self-test", action="store_true", help="Controlled adapter/Worker harness test; never loads weights")
    args = parser.parse_args()
    if not 1 <= args.limit <= 64 or not 1 <= args.timeout <= 120 or not 1 <= args.warmup_timeout <= 600:
        parser.error("Use limit 1..64, timeout 1..120, warmup-timeout 1..600")
    return args


if __name__ == "__main__":
    sys.exit(asyncio.run(run(arguments())))
