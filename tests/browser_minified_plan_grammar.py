#!/usr/bin/env python3
"""Generate/check an experimental minified full-plan grammar with pinned XGrammar.

Requires Vite and Python Playwright. Run with --write to regenerate the three
evals/experiments/full-plan-minified artifacts; default checks committed bytes.
No model, GPU, native server endpoint, production import or prompt change.
The raw generated EBNF is NOT compatible with the pinned llama.cpp parser.
"""
import argparse
import hashlib
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / "evals/experiments"
OPTIONS = {"anyWhitespace": False, "indent": -1, "separators": [",", ":"], "strictMode": True}
GENERATOR = r'''async () => {
  const {testGrammar:xg}=await import('/minified-xgrammar.mjs');
  const {MODEL_RESPONSE_SCHEMA:schema}=await import('/src/inference/plan.ts');
  const schemaText=JSON.stringify(schema);
  // Passing undefined would select the binding's default indent=2. Its -1
  // sentinel means no indentation; explicit separators also remove colon spaces.
  const generated=await xg.Grammar.fromJSONSchema(schemaText,false,-1,[',',':'],true);
  const grammarText=generated.toString();generated.dispose();
  const info=await xg.TokenizerInfo.createTokenizerInfo(
    Array.from({length:128},(_,i)=>String.fromCharCode(i)).concat('<eos>'),'raw',false,129,[128]);
  const compiler=await xg.GrammarCompiler.createGrammarCompiler(info);
  // Recompile the printed artifact through the same entry point used by
  // response_format:{type:'grammar',grammar:...}; do not test only the schema.
  const compiled=await compiler.compileGrammar(grammarText);
  const fixtures=[];
  const base={metric:'speed',aggregate:'avg',bucketMinutes:60,windowHours:24,
    splitByVessel:true,vessel:null,view:'line'};
  const add=(id,value,accepted=true)=>fixtures.push({id,text:JSON.stringify(value),accepted});
  add('base',base);add('refusal',{error:'unsupported_request'});
  const variants={metric:['speed','wind','wave_height','water_temp'],aggregate:['avg','min','max'],
    bucketMinutes:[1,5,15,60,360,1440],windowHours:[1,24,17040,4294967295],
    splitByVessel:[false,true],vessel:[null,0,1,2,3,4,5],
    view:['line','bar','scatter','table','heatmap','surface','map','density','tracks','seasons']};
  for(const [key,values] of Object.entries(variants))for(const value of values)
    add('valid-'+key+'-'+String(value),{...base,[key]:value});
  const invalid={metric:['salinity'],aggregate:['median'],bucketMinutes:[2],
    windowHours:[0,-1,1.5,4294967296],splitByVessel:['true',1,null],vessel:[-1,6,1.5,'0',false],view:['pie',4]};
  for(const [key,values] of Object.entries(invalid))for(const value of values)
    add('invalid-'+key+'-'+String(value),{...base,[key]:value},false);
  for(const key of Object.keys(base)){const copy={...base};delete copy[key];add('missing-'+key,copy,false);}
  add('extra-field',{...base,sql:'SELECT 1'},false);
  add('unknown-refusal',{error:'other'},false);
  add('refusal-with-extra',{error:'unsupported_request',metric:'speed'},false);
  add('null',null,false);add('array',[base],false);
  const text=JSON.stringify(base);
  fixtures.push({id:'incomplete',text:text.slice(0,-1),accepted:false},
    {id:'duplicate-field',text:text.slice(0,-1)+',"view":"line"}',accepted:false},
    {id:'second-object',text:text+text,accepted:false},
    {id:'exponent-integer',text:text.replace('"windowHours":24','"windowHours":2.4e1'),accepted:false});
  // Exercise whitespace at every delimiter boundary outside quoted strings.
  const positions=new Set([0,text.length]);let quoted=false,escaped=false;
  for(let i=0;i<text.length;i++){
    const char=text[i];
    if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;}
    else if(char==='"')quoted=true;
    else if('{}:,'.includes(char)){positions.add(i);positions.add(i+1);}
  }
  for(const position of positions)for(const whitespace of [' ','\t','\r','\n'])
    fixtures.push({id:'outside-whitespace-'+position+'-'+whitespace.charCodeAt(0),
      text:text.slice(0,position)+whitespace+text.slice(position),accepted:false});
  const verify=async (grammar,cases)=>{
    const matcher=await xg.GrammarMatcher.createGrammarMatcher(grammar);
    try{
      for(const fixture of cases){
        matcher.reset();
        const accepted=matcher._acceptString(fixture.text)&&matcher.acceptToken(128)&&matcher.isTerminated();
        if(accepted!==fixture.accepted)throw new Error('Grammar fixture mismatch: '+fixture.id);
      }
    }finally{matcher.dispose();}
  };
  await verify(compiled,fixtures);
  // The full plan has enum strings only. A separate short probe confirms
  // whitespace remains legal INSIDE strings; no output-text stripping occurs.
  const stringProbeGrammar=await xg.Grammar.fromJSONSchema(JSON.stringify({type:'string'}),false,-1,[',',':'],true);
  const stringProbeCompiled=await compiler.compileGrammar(stringProbeGrammar.toString());
  const stringProbe=[{id:'string-space',text:JSON.stringify('North Atlantic'),accepted:true},
    {id:'string-escaped-newline',text:JSON.stringify('North\nAtlantic'),accepted:true},
    {id:'outside-string-space',text:' '+JSON.stringify('North Atlantic'),accepted:false}];
  await verify(stringProbeCompiled,stringProbe);
  stringProbeCompiled.dispose();stringProbeGrammar.dispose();compiled.dispose();compiler.dispose();info.dispose();
  return {schemaText,grammarText,fixtures,stringProbe};
}'''


def pretty(value):
    return json.dumps(value, indent=2) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:5173")
    parser.add_argument("--write", action="store_true", help="Regenerate experimental artifacts")
    args = parser.parse_args()
    package = ROOT / "node_modules/@mlc-ai/web-llm"
    version = json.loads((package / "package.json").read_text())["version"]
    source = (package / "lib/index.js").read_text()
    assert version == "0.2.85", "Recheck the test-only grammar export for a new runtime"
    assert source.count("var libExports$1 = requireLib$1();") == 1
    bundle_sha256 = hashlib.sha256(source.encode()).hexdigest()
    # A served test copy exposes the bundled Wasm bindings. Production files
    # and imports remain untouched; this is not a public runtime dependency.
    instrumented = source + "\nexport { libExports$1 as testGrammar };\n"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        try:
            page = browser.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.route("**/minified-plan-grammar", lambda route: route.fulfill(content_type="text/html", body=""))
            page.route("**/minified-xgrammar.mjs", lambda route: route.fulfill(content_type="text/javascript", body=instrumented))
            page.goto(args.base_url.rstrip("/") + "/minified-plan-grammar")
            result = page.evaluate(GENERATOR)
            assert not errors, errors
            browser_version = browser.version
        finally:
            browser.close()
    grammar = result["grammarText"]
    fixtures = {"fullPlan": result["fixtures"], "stringProbe": result["stringProbe"]}
    metadata = {
        "status": "Experimental WebLLM-only artifact; no model accuracy, latency or GPU measurement.",
        "webllm_version": version, "webllm_bundle_sha256": bundle_sha256,
        "generator": "Pinned bundled XGrammar Grammar.fromJSONSchema().toString()",
        "options": OPTIONS, "root_rule": "root", "schema_export": "src/inference/plan.ts:MODEL_RESPONSE_SCHEMA",
        "schema": json.loads(result["schemaText"]),
        "schema_sha256": hashlib.sha256(result["schemaText"].encode()).hexdigest(),
        "grammar_sha256": hashlib.sha256(grammar.encode()).hexdigest(),
        "fixtures_sha256": hashlib.sha256(pretty(fixtures).encode()).hexdigest(),
        "full_plan_fixture_count": len(result["fixtures"]), "string_probe_fixture_count": len(result["stringProbe"]),
        "native_compatibility": {"status": "incompatible", "validator_binary_available_during_inspection": False,
            "parser_source": "https://github.com/ggml-org/llama.cpp/blob/79e2e74eb11022c1ba2e438df7f0ca2d4c10f8b6/src/llama-grammar.cpp",
            "reason": "Raw output uses underscore rule names, lookahead and a zero escape unsupported by this parser. No conversion attempted."},
        "limitations": ["Character/matcher tests use an ASCII fixture vocabulary, not Qwen tokenization or generation.",
            "The schema-generated grammar uses canonical property order and integer literals; it is not a general JSON normalizer.",
            "Keep production validation, prompt and correction semantics unchanged in any future model comparison.",
            "Minification can change model choices; token and latency savings require per-model measurement.",
            "Generated Qwen3 empty-thinking headers precede the constrained JSON and still require the existing strict normalization."]}
    files = {"full-plan-minified.ebnf": grammar, "full-plan-minified.fixtures.json": pretty(fixtures),
             "full-plan-minified.json": pretty(metadata)}
    if args.write:
        DESTINATION.mkdir(parents=True, exist_ok=True)
        for name, content in files.items():
            (DESTINATION / name).write_text(content)
    else:
        for name, content in files.items():
            assert (DESTINATION / name).read_text() == content, f"Artifact drift: {name}; inspect before using --write"
    print(pretty({"webllm": version, "browser": browser_version, "grammar_sha256": metadata["grammar_sha256"],
        "full_plan_fixtures": len(result["fixtures"]), "string_probe_fixtures": len(result["stringProbe"]),
        "native_compatible": False, "gpu_used": False, "model_loaded": False, "wrote_artifacts": args.write}))


if __name__ == "__main__":
    main()
