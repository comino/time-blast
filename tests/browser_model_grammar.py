"""Compile local output schema using WebLLM's pinned browser XGrammar Wasm.

No GPU or model weights. The test exports the existing bundled grammar module
from a test-only served copy of WebLLM; production dependencies remain untouched.
ASCII vocabulary tests schema/matcher compatibility, not Qwen tokenization or
model accuracy. Requires Vite and Python Playwright.
"""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base-url', default='http://127.0.0.1:5173')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
package = root / 'node_modules/@mlc-ai/web-llm'
version = json.loads((package / 'package.json').read_text())['version']
source = (package / 'lib/index.js').read_text()
assert version == '0.2.85', 'Recheck internal grammar export when upgrading WebLLM'
assert source.count('var libExports$1 = requireLib$1();') == 1
source += '\nexport { libExports$1 as testGrammar };\n'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/grammar-harness', lambda route: route.fulfill(content_type='text/html', body=''))
    page.route('**/test-webllm-grammar.mjs', lambda route: route.fulfill(content_type='text/javascript', body=source))
    page.goto(args.base_url.rstrip('/') + '/grammar-harness')
    report = page.evaluate('''async () => {
      const {testGrammar:xg}=await import('/test-webllm-grammar.mjs');
      const {SEMANTIC_MODEL_RESPONSE_SCHEMA:schema,parseSemanticModelPlan:parse,
        SEMANTIC_MODEL_RESPONSE_SCHEMA_V5:v5Schema,parseSemanticModelPlanV5:parseV5,
        SEMANTIC_MODEL_RESPONSE_SCHEMA_V6:v6Schema,parseSemanticModelPlanV6:parseV6}=await import('/src/inference/semantic-plan.ts');
      const info=await xg.TokenizerInfo.createTokenizerInfo(Array.from({length:128},(_,i)=>String.fromCharCode(i)).concat('<eos>'),'raw',false,129,[128]);
      const compiler=await xg.GrammarCompiler.createGrammarCompiler(info);
      const grammar=await compiler.compileJSONSchema(JSON.stringify(schema));
      const match=async value=>{
        const matcher=await xg.GrammarMatcher.createGrammarMatcher(grammar);
        try {return matcher._acceptString(JSON.stringify(value)) && matcher.acceptToken(128) && matcher.isTerminated();}
        finally{matcher.dispose();}
      };
      const base={metrics:['wave_height'],aggregate:'avg',bucket:{count:1,unit:'minute'},window:{count:7,unit:'day'},grouping:'vessel',vessel:null,view:null,unsupported:[]};
      const accepted=[base,{...base,vessel:'Aurora',view:'surface'},
        {...base,metrics:['wave_height','wind']}, {...base,unsupported:['exclude Aurora']},
        {...base,metrics:['salinity'],view:'pie'}, {error:'unsupported_request'}];
      const fraction={...base,bucket:{count:0.25,unit:'hour'},window:{count:1.5,unit:'day'}};
      if(!await match(fraction))throw new Error('Grammar rejected fractional quantity');
      const rejected=[{...base,extra:'ignored?'},{...base,grouping:true},{...base,aggregate:'median'},
        {...base,metrics:[]},{...base,view:4}, {error:'something_else'}];
      for(const value of accepted)if(!await match(value))throw new Error('Grammar rejected faithful extraction: '+JSON.stringify(value));
      for(const value of rejected)if(await match(value))throw new Error('Grammar accepted malformed output: '+JSON.stringify(value));
      const context={id:'grammar',label:'Fleet',start:0,end:1,rowCount:1,vessels:['Aurora'],description:''};
      const converted=parse(JSON.stringify(fraction),context);
      if(converted.bucketMinutes!==15||converted.windowHours!==36)throw new Error('Fraction conversion mismatch');
      for(const value of accepted.slice(2)){
        let refused=false;try{parse(JSON.stringify(value),context);}catch{refused=true;}
        if(!refused)throw new Error('Faithful unsupported extraction became executable');
      }
      grammar.dispose();
      const v5=await compiler.compileJSONSchema(JSON.stringify(v5Schema));
      const v5Match=async value=>{
        const matcher=await xg.GrammarMatcher.createGrammarMatcher(v5);
        try {return matcher._acceptString(JSON.stringify(value)) && matcher.acceptToken(128) && matcher.isTerminated();}
        finally{matcher.dispose();}
      };
      const surface={...base,bucket:{count:1,unit:'hour'},window:{count:1,unit:'day'},view:'surface'};
      const v5Supported=[base,fraction,surface,{...base,vessel:'Aurora'},
        {...base,window:{count:4294967295,unit:'hour'}}];
      const v5Unsupported=[
        ...['median','sum','percentile'].map(aggregate=>({...base,aggregate})),
        {...base,metrics:['salinity']},{...base,metrics:['wave_height','wind']},
        {...base,view:'pie'},{...base,vessel:'Poseidon'},
        {...base,unsupported:['excluding Aurora']},
        {...surface,unsupported:['3D surface']},
        {...base,bucket:{count:30,unit:'minute'}},
        {...base,window:{count:0.5,unit:'hour'}},
        {...base,window:{count:0,unit:'day'}},
        {...base,window:{count:4294967295,unit:'day'}},
        {error:'unsupported_request'},
      ];
      const {unsupported:_missing,...missingUnsupported}=base;
      const v5Malformed=[
        {...base,aggregate:7},{...base,aggregate:'x'.repeat(65)},
        {...base,bucket:{count:'5',unit:'minute'}},
        {...base,bucket:{count:1,unit:'month'}},
        {...base,window:{count:1,unit:'second'}},
        {...base,window:{count:1,unit:'hour',ignored:1}},
        {...base,unsupported:Array(9).fill('extra')},
        {...base,unsupported:['x'.repeat(161)]},
        {...base,unsupported:[null]},missingUnsupported,
        {...base,sql:'SELECT 1'},
        {error:'unsupported_request',metrics:['speed']},
      ];
      for(const value of [...v5Supported,...v5Unsupported]){
        if(!await v5Match(value))throw new Error('V5 grammar rejected faithful extraction: '+JSON.stringify(value));
      }
      for(const value of v5Malformed){
        if(await v5Match(value))throw new Error('V5 grammar accepted malformed output: '+JSON.stringify(value));
      }
      for(const value of v5Supported)parseV5(JSON.stringify(value),context);
      for(const value of v5Unsupported){
        let rejected=false;try{parseV5(JSON.stringify(value),context);}catch{rejected=true;}
        if(!rejected)throw new Error('V5 unsupported extraction became executable: '+JSON.stringify(value));
      }
      let neutralFeedback='';
      try{parseV5(JSON.stringify({...surface,unsupported:['3D surface']}),context);}catch(error){neutralFeedback=error.message;}
      if(!neutralFeedback.startsWith('The model marked these requirements as unsupported: 3D surface.')||
        !neutralFeedback.includes('Remove an item only if the complete plan represents it'))throw new Error('V5 lost neutral correction feedback');
      const correctedSurface=parseV5(JSON.stringify(surface),context);
      if(correctedSurface.view!=='surface'||correctedSurface.windowHours!==24||correctedSurface.bucketMinutes!==60||
        !correctedSurface.splitByVessel)throw new Error('V5 corrected supported surface lost meaning');
      const v5Fraction=parseV5(JSON.stringify(fraction),context);
      if(v5Fraction.bucketMinutes!==15||v5Fraction.windowHours!==36)throw new Error('V5 fraction conversion mismatch');
      v5.dispose();
      const v6=await compiler.compileJSONSchema(JSON.stringify(v6Schema));
      const v6Match=async value=>{
        const matcher=await xg.GrammarMatcher.createGrammarMatcher(v6);
        try {return matcher._acceptString(JSON.stringify(value)) && matcher.acceptToken(128) && matcher.isTerminated();}
        finally{matcher.dispose();}
      };
      const withScope=value=>value.error?value:{metrics:value.metrics,aggregate:value.aggregate,bucket:value.bucket,
        timeScope:'trailing',window:value.window,grouping:value.grouping,vessel:value.vessel,view:value.view,unsupported:value.unsupported};
      const v6Supported=v5Supported.map(withScope);
      const v6Base=withScope(base);
      const v6Unsupported=[...v5Unsupported.map(withScope),
        {...v6Base,timeScope:'absolute'}, {...v6Base,timeScope:'future'},
        {...v6Base,bucket:{count:1,unit:'month'}},
        {...v6Base,window:{count:1,unit:'second'}},
        {...v6Base,window:{count:1,unit:'__proto__'}},
      ];
      const v6Malformed=[base,{...v6Base,timeScope:'past'}, {...v6Base,timeScope:null},
        {...v6Base,bucket:{count:1,unit:'x'.repeat(65)}},
        {...v6Base,window:{count:1,unit:5}}, {...v6Base,sql:'SELECT 1'},
        {...v6Base,bucket:{count:'1',unit:'hour'}},
      ];
      for(const value of [...v6Supported,...v6Unsupported]){
        if(!await v6Match(value))throw new Error('V6 grammar rejected faithful extraction: '+JSON.stringify(value));
      }
      for(const value of v6Malformed){
        if(await v6Match(value))throw new Error('V6 grammar accepted malformed output: '+JSON.stringify(value));
      }
      for(const value of v6Supported)parseV6(JSON.stringify(value),context);
      for(const value of v6Unsupported){
        let rejected=false;try{parseV6(JSON.stringify(value),context);}catch{rejected=true;}
        if(!rejected)throw new Error('V6 unsupported extraction became executable: '+JSON.stringify(value));
      }
      v6.dispose();
      const {MODEL_RESPONSE_SCHEMA,parseModelPlan}=await import('/src/inference/plan.ts');
      const {CHART_VIEWS}=await import('/src/core/types.ts');
      const full=await compiler.compileJSONSchema(JSON.stringify(MODEL_RESPONSE_SCHEMA));
      const fullMatch=async value=>{
        const matcher=await xg.GrammarMatcher.createGrammarMatcher(full);
        try {return matcher._acceptString(JSON.stringify(value,null,2)) && matcher.acceptToken(128) && matcher.isTerminated();}
        finally{matcher.dispose();}
      };
      const plan={metric:'wave_height',aggregate:'avg',bucketMinutes:1,windowHours:168,splitByVessel:true,vessel:null,view:'line'};
      const fullAccepted=CHART_VIEWS.map(view=>({...plan,view})).concat([
        {...plan,windowHours:4294967295}, {error:'unsupported_request'},
      ]);
      const fullRejected=[{...plan,extra:1},{...plan,bucketMinutes:2},{...plan,aggregate:'median'},
        {...plan,view:'pie'},{...plan,splitByVessel:1},{error:'something_else'}];
      for(const value of fullAccepted)if(!await fullMatch(value))throw new Error('Full grammar rejected valid response: '+JSON.stringify(value));
      for(const value of fullRejected)if(await fullMatch(value))throw new Error('Full grammar accepted malformed response: '+JSON.stringify(value));
      for(const value of fullAccepted.filter(value=>!value.error))parseModelPlan(JSON.stringify(value),context);
      const unsafeGeo={...plan,splitByVessel:false,view:'map'};
      if(!await fullMatch(unsafeGeo))throw new Error('Expected shape-only grammar to defer geographic grouping to validation');
      let geoRejected=false;try{parseModelPlan(JSON.stringify(unsafeGeo),context);}catch{geoRejected=true;}
      if(!geoRejected)throw new Error('Full decoder accepted a fleet-average geographic position');
      full.dispose();compiler.dispose();info.dispose();
      return {experimentalSemantic:{accepted:accepted.length,rejected:rejected.length,unsupportedRejectedByDecoder:accepted.length-2},
        experimentalSemanticV5:{supportedAccepted:v5Supported.length,faithfulUnsupportedAcceptedByGrammar:v5Unsupported.length,
          malformedRejectedByGrammar:v5Malformed.length,unsupportedRejectedByDecoder:v5Unsupported.length,
          correctedSurfaceAccepted:true,fractionConversionVerified:true,neutralCorrectionFeedbackVerified:true},
        experimentalSemanticV6:{supportedAccepted:v6Supported.length,faithfulUnsupportedAcceptedByGrammar:v6Unsupported.length,
          malformedRejectedByGrammar:v6Malformed.length,unsupportedRejectedByDecoder:v6Unsupported.length},
        productionFull:{accepted:fullAccepted.length,rejected:fullRejected.length,unsafeGeographicGroupingRejectedByDecoder:geoRejected}};
    }''')
    assert not errors, errors
    print(json.dumps({'webllm':version,'browser':browser.version,'grammar':report,'gpuUsed':False}))
    browser.close()
