"""Durable card/board interactions in Chromium, without an engine or provider.

Start Vite, then run:
    python3 tests/canvas_card_smoke.py http://127.0.0.1:5394
"""
import json
import sys

from playwright.sync_api import sync_playwright


URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5394").rstrip("/")
PAGE = """<!doctype html><html><head>
<link rel="stylesheet" href="/src/ui/styles.css"><link rel="stylesheet" href="/src/ui/app.css"><style>body{margin:0}#viewport{position:relative;width:1100px;height:900px;overflow:hidden}
#world{position:absolute;inset:0;transform-origin:0 0}</style></head><body>
<div id="viewport"><div id="world"></div></div><span id="zoom"></span></body></html>"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/__canvas_card_test__", lambda route: route.fulfill(content_type="text/html", body=PAGE))
    page.goto(URL + "/__canvas_card_test__")
    result = page.evaluate("""async () => {
      const { Board } = await import('/src/ui/board.ts');
      const { SlotCardView } = await import('/src/ui/slot-card.ts');
      const assert = (ok, message) => { if (!ok) throw new Error(message); };
      const equal = (a, b, message) => assert(JSON.stringify(a) === JSON.stringify(b), `${message}: ${JSON.stringify(a)}`);
      const events = { param: [], end: [], view: [], action: [], layout: [], gesture: [] };
      const board = new Board(document.querySelector('#viewport'), document.querySelector('#world'), document.querySelector('#zoom'), () => {});
      board.onLayout = items => events.layout.push(items.map(item => ({ slot: item.slot, x: item.x, y: item.y, width: item.width, height: item.height })));
      let automaticMoves = 0;
      board.place = () => { automaticMoves++; };
      board.focus = () => { automaticMoves++; };
      const handlers = {
        view: (...args) => events.view.push(args), param: (...args) => events.param.push(args),
        paramEnd: (...args) => events.end.push(args),
        edit: (...args) => events.action.push(['edit', ...args]), history: slot => events.action.push(['history', slot]),
        refresh: slot => events.action.push(['refresh', slot]), reattach: slot => events.action.push(['reattach', slot]),
        exportCsv() {}, close() {}, back() {}, gesture: (...args) => { events.gesture.push(args); return true; },
      };
      const card = new SlotCardView(90, handlers, board);
      const q = name => card.element.querySelector(`[data-c="${name}"]`);
      const action = name => card.element.querySelector(`[data-a="${name}"]`).click();
      const layout = { x: 40, y: 60, width: 500, height: 470 };
      const definition = { layout, originalQuestion: 'Average wind by day', sql: 'SELECT day, avg(wind) FROM observations GROUP BY day',
        presentation: { view: 'tracks', params: { rotation: 95, playback: .2 } }, status: 'Loading source' };
      const event = (name, type) => q(name).dispatchEvent(new Event(type, { bubbles: true }));
      const input = (name, value) => { q(name).value = String(value); event(name, 'input'); };
      const clear = () => { for (const values of Object.values(events)) values.length = 0; };
      card.document(definition);
      equal([card.x, card.y, card.width, card.height], [40, 60, 500, 470], 'saved layout');
      assert(automaticMoves === 0 && card.shown, 'restoration shows the card without placing or focusing');
      equal([q('title').textContent, q('sql').textContent, q('state-label').textContent],
        [definition.originalQuestion, definition.sql, definition.status], 'metadata exists before any RESULT');
      equal([events.param.length, events.view.length, events.layout.length], [0, 0, 0], 'document replacement is silent');
      card.views(['line', 'table'], 'line');
      assert(q('view').value === 'tracks' && q('view').selectedOptions[0].disabled, 'unavailable saved intent remains selected');
      card.views(['tracks', 'table'], 'tracks');
      assert(q('view').value === 'tracks' && !q('view').selectedOptions[0].disabled, 'saved intent returns when available');
      q('view').value = ''; event('view', 'change');
      equal(events.view, [[90, null]], 'Auto is an explicit view choice');
      card.views(['line', 'table'], 'line');
      assert(q('view').value === '', 'renderer choice does not turn Auto into a manual view');
      card.document({ ...definition, presentation: { view: null, params: {} } });
      equal([q('rotation').value, q('playback').value, q('view').value], ['-30', '1000', ''], 'missing parameters reset to renderer defaults');

      clear(); card.views(['surface', 'table'], 'surface');
      input('rotation', 10); input('rotation', 20); input('rotation', 25);
      card.status('Saving…');
      assert(q('rotation').value === '25' && events.end.length === 0, 'status must not reset or commit the slider');
      event('rotation', 'change'); event('rotation', 'blur');
      equal(events.param.map(call => call[2]), [10, 20, 25], 'slider previews reach runtime');
      equal(events.end, [[90]], 'one semantic change per slider gesture');
      clear(); card.views(['tracks', 'table'], 'tracks');
      input('playback', 100); input('playback', 200); input('playback', 300);
      assert(events.end.length === 0, 'scrubbing does not checkpoint each input');
      event('playback', 'change'); event('playback', 'blur');
      equal(events.end, [[90]], 'scrub ends exactly once');

      let nextRaf = 0, now = performance.now();
      const raf = new Map();
      window.requestAnimationFrame = callback => { raf.set(++nextRaf, callback); return nextRaf; };
      window.cancelAnimationFrame = id => raf.delete(id);
      const step = delta => { now += delta; const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach(callback => callback(now)); };
      card.document(definition); card.views(['tracks', 'table'], 'tracks'); clear();
      action('play'); step(600);
      const position = q('playback').value;
      card.status('Saved');
      assert(raf.size === 1 && q('playback').value === position, 'status leaves playback running');
      step(600); action('play');
      assert(raf.size === 0 && events.param.length === 2 && events.end.length === 1, 'pause ends one playback change');
      clear(); now = performance.now(); action('play'); step(10000);
      assert(q('playback').value === '1000' && raf.size === 0 && events.end.length === 1, 'natural playback completion ends once');

      clear(); now = performance.now(); action('play'); step(100);
      const staleCallbacks = [...raf.values()];
      card.document({ ...definition, presentation: { view: null, params: {} }, status: 'Restored' });
      const before = events.param.length;
      staleCallbacks.forEach(callback => callback(now + 1000));
      event('playback', 'change'); event('playback', 'blur');
      assert(events.param.length === before && events.end.length === 0 && raf.size === 0, 'restoring silently cancels playback and stale callbacks');
      equal([q('rotation').value, q('playback').value], ['-30', '1000'], 'history restores full presentation');

      clear(); card.axes({ x: [], y: [], plot: { left: 10, top: 15, width: 400, height: 200 } });
      const metadata = [q('title').textContent, q('sql').textContent, q('subtitle').textContent];
      const bounds = [card.x, card.y, card.width, card.height];
      card.presentation({ view: 'surface', params: { rotation: 42 } });
      equal([q('view').value, q('rotation').value, q('playback').value], ['surface', '42', '1000'], 'inferred intent updates controls');
      equal([q('title').textContent, q('sql').textContent, q('subtitle').textContent], metadata, 'presentation leaves query metadata intact');
      equal([card.x, card.y, card.width, card.height], bounds, 'presentation leaves layout intact');
      equal(card.plotRect, { left: 10, top: 15, width: 400, height: 200 }, 'presentation leaves plot gesture geometry intact');
      equal([events.param.length, events.end.length, events.view.length, events.layout.length], [0, 0, 0, 0], 'inferred presentation is silent');

      clear();
      for (const name of ['edit', 'edit-sql', 'regenerate', 'history', 'refresh', 'reattach']) action(name);
      equal(events.action, [['edit', 90, 'question'], ['edit', 90, 'sql'], ['edit', 90, 'regenerate'], ['history', 90], ['refresh', 90], ['reattach', 90]], 'durable actions');
      clear(); card.document({ ...definition, presentation: { view: null, params: {} } });
      window.h = { card, board, events, clear, definition, handlers, SlotCardView };
      return { metadata: true, fullPresentation: true, presentationOnly: true, unavailableViewIntent: true, sliderTransactions: true, playbackTransactions: true, stalePlayback: true, actions: true };
    }""")

    # Real pointer capture: no layout write during moves, one at the actual gesture end.
    page.mouse.move(100, 82)
    page.mouse.down()
    page.mouse.move(150, 112, steps=4)
    assert page.evaluate("h.events.layout.length") == 0
    page.evaluate("document.querySelector('#viewport').dispatchEvent(new PointerEvent('pointerup', { pointerId: 999, bubbles: true }))")
    assert page.evaluate("h.events.layout.length") == 0
    page.mouse.move(160, 122)
    page.mouse.up()
    assert page.evaluate("h.events.layout") == [[{"slot": 90, "x": 100, "y": 100, "width": 500, "height": 470}]]
    page.evaluate("document.querySelector('#viewport').dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1 }))")
    assert page.evaluate("h.events.layout.length") == 1
    page.mouse.click(140, 122)
    assert page.evaluate("h.events.layout.length") == 1

    page.evaluate("h.clear()")
    resize = page.locator('.card-resize-handle').bounding_box()
    assert resize is not None
    resize_x, resize_y = resize["x"] + resize["width"] / 2, resize["y"] + resize["height"] / 2
    page.mouse.move(resize_x, resize_y)
    page.mouse.down()
    page.mouse.move(resize_x + 30, resize_y + 20, steps=4)
    assert page.evaluate("h.events.layout.length") == 0
    page.mouse.up()
    resized = page.evaluate("h.events.layout")
    assert resized == [[{"slot": 90, "x": 100, "y": 100, "width": 530, "height": 490}]], resized

    page.evaluate("h.clear()")
    page.mouse.move(1000, 800)
    page.mouse.down()
    page.mouse.move(1020, 820)
    page.mouse.up()
    assert page.evaluate("h.events.layout.length") == 0

    page.evaluate("""() => {
      const other = new h.SlotCardView(91, h.handlers, h.board);
      other.document({ ...h.definition, layout: { x: 640, y: 70, width: 400, height: 400 } });
      h.board.arrange();
      if (h.events.layout.length !== 1 || h.events.layout[0].length !== 2) throw new Error('Arrange must commit all changed items together');
      h.board.arrange();
      if (h.events.layout.length !== 1) throw new Error('No-op Arrange must not create history');
      other.destroy(); h.board.resetCamera(); h.clear();
      h.card.document({ ...h.definition, layout: { x: 100, y: 100, width: 450, height: 440 } });
    }""")
    page.mouse.move(160, 122)
    page.mouse.down()
    page.mouse.move(180, 142)
    page.evaluate("h.card.document({ ...h.definition, layout: { x: 200, y: 120, width: 450, height: 440 } })")
    page.mouse.move(210, 162)
    page.mouse.up()
    assert page.evaluate("[h.card.x, h.card.y, h.events.layout.length]") == [200, 120, 0]

    # A definition replacement also cancels a brush before a subsequent pointermove.
    page.evaluate("h.card.axes({x:[],y:[],plot:{left:0,top:0,width:400,height:200}})")
    plot = page.locator('[data-c="canvas"]').bounding_box()
    assert plot is not None
    page.mouse.move(plot["x"] + 80, plot["y"] + 60)
    page.mouse.down()
    page.mouse.move(plot["x"] + 120, plot["y"] + 60)
    page.evaluate("h.card.document({ ...h.definition, layout: { x: 200, y: 120, width: 450, height: 440 } })")
    page.mouse.move(plot["x"] + 150, plot["y"] + 60)
    page.mouse.up()
    assert page.evaluate("h.events.gesture.length") == 0
    assert errors == [], errors
    page.evaluate("h.card.destroy(); h.board.destroy()")
    result.update(layoutTransactions=True, noOpGestures=True, arrangeTransaction=True, staleDrag=True, staleBrush=True)
    print(json.dumps({"browser": browser.version, "checks": result}, indent=2))
    browser.close()
