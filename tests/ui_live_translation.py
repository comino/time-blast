"""UI-only regression for live defaults, independent translation controls and IME dispatch.

Uses a Vite server, no model or database initialization. Configuration stays in
this UI session; this test does not introduce browser-storage persistence.
"""
import argparse
import json
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base-url', default='http://127.0.0.1:5173')
parser.add_argument('--screenshot')
args = parser.parse_args()
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1440, 'height':1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/ui-live-harness', lambda r: r.fulfill(status=200, content_type='text/html', body='<div id="root"></div>'))
    page.route('**/@vite/client', lambda r: r.fulfill(status=200, content_type='text/javascript', body='''
      const styles=new Map();
      export const createHotContext=()=>({data:{},accept(){},dispose(){},prune(){},invalidate(){},on(){}});
      export function updateStyle(id,css){let style=styles.get(id);if(!style){style=document.createElement('style');styles.set(id,style);document.head.append(style);}style.textContent=css;}
      export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}
    '''))
    page.goto(args.base_url.rstrip('/')+'/ui-live-harness')
    page.evaluate('''async () => {
      const {createUI}=await import('/src/ui/index.ts');
      window.calls={configs:[],drafts:[],commits:[]};
      window.ui=createUI(document.querySelector('#root'),{
        onDraft(text,composing){calls.drafts.push({text,composing});},onCommit(text){calls.commits.push(text);},
        onFocus(){},onConfig(config){calls.configs.push(config);},onCancel(){},onWarmModel(){},onDraw(){}
      });
    }''')
    settings = page.get_by_role('button', name='Runtime settings', exact=True)
    apply = page.get_by_role('button', name='Apply runtime')
    live = page.get_by_role('checkbox', name='Prepare translation after typing', exact=True)
    live_query = page.locator('[name="liveQuery"]')
    results = page.get_by_role('checkbox', name='Prepare query results while I type', exact=True)
    threshold = page.get_by_label('Minimum characters', exact=True)
    dataset = page.get_by_label('Browser dataset', exact=True)
    settings.click()
    assert live_query.is_checked() and live.is_checked() and results.is_checked()
    assert threshold.is_visible() and threshold.is_enabled()
    live_query.uncheck()
    live.uncheck()
    assert not threshold.is_visible() and threshold.is_disabled()
    assert dataset.input_value() == 'large' and dataset.is_visible()
    page.select_option('[name="databaseMode"]', 'remote')
    assert not dataset.is_visible() and dataset.is_disabled()
    page.select_option('[name="databaseMode"]', 'browser')
    assert dataset.is_visible() and dataset.is_enabled()
    dataset.select_option('demo')
    live.check()
    assert threshold.is_visible() and threshold.is_enabled()
    assert threshold.input_value() == '20'
    assert threshold.get_attribute('min') == '1' and threshold.get_attribute('max') == '4096'
    for invalid in ['0', '4097', '1.5', '']:
        threshold.fill(invalid)
        assert not page.locator('[data-el="runtime-form"]').evaluate('(form)=>form.checkValidity()')
        # Validate the JS guard as well as native input constraints.
        page.locator('[data-el="runtime-form"]').dispatch_event('submit')
        assert page.evaluate('calls.configs.length') == 0
        assert 'whole number' in page.locator('[data-el="runtime-error"]').inner_text()
    threshold.fill('23')
    results.uncheck()
    apply.click()
    first = page.evaluate('calls.configs.at(-1)')
    assert first['liveTranslation'] is True and first['translationMinChars'] == 23 and first['speculation'] is False
    assert first['datasetProfile'] == 'demo' and first['liveQuery'] is False
    assert '23 characters' in page.locator('[data-el="draft-note"]').inner_text()
    page.evaluate("ui.handleEvent({type:'speculation',state:'translated',text:'test',points:0})")
    assert page.locator('[data-el="draft-state"]').inner_text() == 'SQL prepared before Enter'
    assert page.locator('[data-el="draft-dot"]').get_attribute('data-state') == 'ready'

    settings.click()
    assert live.is_checked() and threshold.input_value() == '23' and not results.is_checked()
    assert dataset.input_value() == 'demo'
    threshold.fill('27')
    page.get_by_role('button', name='Close runtime settings', exact=True).click()
    settings.click()
    assert threshold.input_value() == '23', 'Unapplied edits should not replace session configuration'
    if args.screenshot:
        page.screenshot(path=args.screenshot)
    page.get_by_role('button', name='Close runtime settings', exact=True).click()
    page.locator('[data-action="speculation"]').click()
    assert page.evaluate('calls.configs.at(-1).speculation') is True
    assert page.evaluate('calls.configs.at(-1).liveTranslation') is True
    assert page.evaluate('calls.configs.at(-1).translationMinChars') == 23

    ime = page.evaluate('''() => {
      const input=document.querySelector('[data-el="input"]');input.value='  Average speed by hour  ';
      input.dispatchEvent(new CompositionEvent('compositionstart'));
      const start=calls.drafts.at(-1);
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));
      const during=calls.commits.length;
      input.dispatchEvent(new CompositionEvent('compositionend'));
      const end=calls.drafts.at(-1);
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      return {start,end,during,committed:calls.commits.at(-1)};
    }''')
    assert ime['start']['composing'] is True and ime['end']['composing'] is False
    assert ime['during'] == 0 and ime['committed'] == '  Average speed by hour  '

    settings.click()
    threshold.fill('4096')
    apply.click()
    assert page.evaluate('calls.configs.at(-1).translationMinChars') == 4096
    settings.click()
    page.get_by_role('button', name='Restore local defaults').click()
    assert live_query.is_checked() and live.is_checked() and threshold.is_visible() and results.is_checked()
    assert threshold.input_value() == '20'
    assert dataset.input_value() == 'large'
    apply.click()
    final = page.evaluate('calls.configs.at(-1)')
    assert final['liveQuery'] is True and final['liveTranslation'] is True and final['translationMinChars'] == 20 and final['speculation'] is True
    assert final['datasetProfile'] == 'large'
    badges = page.evaluate('''() => {
      const context={label:'test',rowCount:1209600,start:1788220800000,end:1789430400000,vessels:['One'],description:'test'};
      return ['synthetic-vessels-2026-09-v1','synthetic-vessels-2026-09-6s-v1','synthetic-vessels-custom'].map(id=>{
        ui.setDataset({...context,id});return document.querySelector('[data-el="dataset-badge"]').textContent;
      });
    }''')
    assert badges == ['SYNTHETIC DATA', 'SYNTHETIC DATA', 'DATASET']
    assert 'by minute' in page.locator('[data-prompt]').first.get_attribute('data-prompt')
    dense_example = page.locator('[data-prompt]').filter(has_text='Compare a week of waves')
    dense_prompt = dense_example.get_attribute('data-prompt')
    assert 'by minute' in dense_prompt and 'last 7 days' in dense_prompt
    assert 'seven days' in dense_example.inner_text()
    assert not errors, errors
    print(json.dumps({'chromium':browser.version,'live_query_default':True,'threshold_bounds':True,
                      'independent_results_toggle':True,'sql_only_status':True,'session_controls_preserved':True,
                      'ime_cancellation_signal':True,'browser_dataset_profiles':True,'synthetic_id_allowlist':True,
                      'dense_examples':True,'page_errors':errors},indent=2))
    browser.close()
