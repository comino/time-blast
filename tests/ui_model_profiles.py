"""Browser model settings without loading weights or starting DuckDB.

Requires the Vite development server and Python Playwright. This verifies UI
state and callback contracts; it does not measure model quality or GPU speed.
"""
import argparse
import json

from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base-url', default='http://127.0.0.1:5173')
args = parser.parse_args()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/ui-model-harness', lambda route: route.fulfill(
        status=200, content_type='text/html', body='<div id="root"></div>'))
    page.route('**/@vite/client', lambda route: route.fulfill(status=200, content_type='text/javascript', body='''
      const styles=new Map();
      export const createHotContext=()=>({data:{},accept(){},dispose(){},prune(){},invalidate(){},on(){}});
      export function updateStyle(id,css){let style=styles.get(id);if(!style){style=document.createElement('style');styles.set(id,style);document.head.append(style);}style.textContent=css;}
      export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}
    '''))
    page.goto(args.base_url.rstrip('/') + '/ui-model-harness')
    page.evaluate('''async () => {
      const {createUI}=await import('/src/ui/index.ts');
      window.calls={configs:[],warm:0,canceled:0};
      window.ui=createUI(document.querySelector('#root'),{
        onDraft(){},onCommit(){},onFocus(){},onConfig(config){calls.configs.push(config);},
        onCancel(){calls.canceled++;},onWarmModel(){calls.warm++;},onDraw(){}
      });
      ui.setStatus('model',{state:'ready',label:'Controlled model ready'});
    }''')
    settings = page.get_by_role('button', name='Runtime settings', exact=True)
    apply = page.get_by_role('button', name='Apply runtime')
    close = page.get_by_role('button', name='Close runtime settings', exact=True)
    model = page.get_by_label('Browser model', exact=True)
    cache = page.locator('[name="cacheModelPlans"]')
    prepare = page.locator('[data-action="warm-model"]')

    settings.click()
    assert page.locator('[name="inferenceMode"]').input_value() == 'webgpu'
    assert model.input_value() == 'qwen-1.5b'
    assert 'Smaller default' in page.locator('[data-el="local-model-help"]').inner_text()
    assert all('4-bit' in label for label in model.locator('option').all_text_contents())
    assert model.locator('option').evaluate_all('(options)=>options.map(option=>option.value)') == ['qwen-0.5b', 'qwen-1.5b', 'qwen3-4b']
    assert cache.is_checked() and prepare.is_enabled()
    prepare.click()
    assert page.evaluate('calls.warm') == 1

    model.select_option('qwen-0.5b')
    assert 'Smallest download' in page.locator('[data-el="local-model-help"]').inner_text()
    assert prepare.is_disabled()
    assert 'Apply runtime' in prepare.get_attribute('title')
    cache.uncheck()
    close.click()
    settings.click()
    assert model.input_value() == 'qwen-1.5b' and cache.is_checked(), 'Canceled edits must not change runtime'
    assert page.evaluate('calls.configs.length') == 0

    model.select_option('qwen-0.5b')
    cache.uncheck()
    apply.click()
    config = page.evaluate('calls.configs.at(-1)')
    assert config['localModel'] == 'qwen-0.5b' and config['cacheModelPlans'] is False
    assert config['inferenceMode'] == 'webgpu' and config['databaseMode'] == 'browser'
    settings.click()
    assert model.input_value() == 'qwen-0.5b' and not cache.is_checked()
    assert prepare.is_enabled()
    prepare.click()
    assert page.evaluate('calls.warm') == 2

    page.evaluate("ui.setStatus('model',{state:'loading',label:'Controlled loading',progress:0.5})")
    assert prepare.is_disabled()
    page.evaluate("ui.setStatus('model',{state:'ready',label:'Controlled ready'})")
    assert prepare.is_enabled()
    cache.check()
    assert prepare.is_enabled(), 'Cache policy alone must not imply a different model to prepare'
    apply.click()
    assert page.evaluate('calls.configs.at(-1).cacheModelPlans') is True
    assert page.evaluate('calls.configs.at(-1).localModel') == 'qwen-0.5b'

    settings.click()
    model.select_option('qwen3-4b')
    detail = page.locator('[data-el="local-model-help"]').inner_text()
    assert '2.3 GB of weights' in detail and 'Estimated GPU memory' in detail
    assert '3.4 GB (f16)' in detail and '4.3 GB (f32)' in detail
    assert prepare.is_disabled(), 'The newly selected 4B model must be applied before preparation'
    apply.click()
    assert page.evaluate('calls.configs.at(-1).localModel') == 'qwen3-4b'
    assert page.evaluate('calls.configs.at(-1).databaseMode') == 'browser'
    settings.click()
    assert model.input_value() == 'qwen3-4b' and prepare.is_enabled()
    prepare.click()
    assert page.evaluate('calls.warm') == 3
    close.click()

    settings.click()
    for mode in ['templates', 'remote']:
        page.select_option('[name="inferenceMode"]', mode)
        assert model.is_hidden() and model.is_disabled()
        assert cache.is_hidden() and cache.is_disabled()
        assert prepare.is_hidden()
    page.locator('[name="inferenceEndpoint"]').fill('https://model.example/infer')
    apply.click()
    assert page.evaluate('calls.configs.at(-1).localModel') == 'qwen3-4b', 'Inactive browser profile should be retained'
    settings.click()
    page.select_option('[name="inferenceMode"]', 'webgpu')
    assert model.is_visible() and cache.is_visible()
    assert prepare.is_disabled(), 'Switching back to local inference requires Apply'
    page.get_by_role('button', name='Restore local defaults').click()
    assert model.input_value() == 'qwen-1.5b' and cache.is_checked()
    apply.click()
    assert page.evaluate('calls.configs.at(-1).localModel') == 'qwen-1.5b'

    settings.click()
    count = page.evaluate('calls.configs.length')
    model.evaluate('''select => {
      select.add(new Option('Invalid profile','external-profile'));
      select.value='external-profile';
      select.dispatchEvent(new Event('change',{bubbles:true}));
    }''')
    page.locator('[data-el="runtime-form"]').dispatch_event('submit')
    assert page.evaluate('calls.configs.length') == count
    assert 'Choose an available browser model' in page.locator('[data-el="runtime-error"]').inner_text()
    close.click()

    page.set_viewport_size({'width': 390, 'height': 844})
    settings.click()
    model.select_option('qwen3-4b')
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
    assert model.is_visible() and cache.is_visible()
    assert not errors, errors
    print(json.dumps({'chromium': browser.version, 'model_profiles': True,
                      'qwen3_4b_profile': True, 'default_profile': 'qwen-1.5b',
                      'apply_before_prepare': True, 'plan_cache_setting': True,
                      'inactive_controls': True, 'invalid_profile_rejected': True,
                      'mobile_settings': True, 'page_errors': errors}, indent=2))
    browser.close()
