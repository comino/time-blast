/** Static page markup. Same look as the prototype (classes from styles.css), new content:
 * status pills, the timing panel and the batch-1 runtime settings. */
import { FIXTURES, MODEL_PROFILES } from './defaults';
import { icons } from './icons';
import { VIEW_LABELS } from './slot-card';

const pill = (component: string, label: string) => `<div data-stage="${component}" data-state="cold"><span class="stage-dot"></span><span>${label}</span><small>Starting</small></div>`;

export const appShell = `
<header class="app-header">
  <a class="brand" href="#" aria-label="Time Blast workspace"><span class="brand-symbol">${icons.bolt}</span>time<span class="brand-light">blast</span><span class="brand-version">CANVAS / 01</span></a>
  <span class="header-center"><span class="workspace-dot"></span>A question becomes a view.</span>
  <div class="header-actions"><span class="local-tag" data-el="placement">${icons.target} <span data-el="placement-label">STARTING</span></span><button class="icon-button" data-action="settings" aria-label="Runtime settings" title="Runtime settings">${icons.settings}</button></div>
</header>
<div class="workspace">
  <main class="canvas-space" aria-label="Data canvas">
    <div class="canvas-toolbar">
      <div class="canvas-heading"><span class="eyebrow">YOUR CANVAS</span><span class="card-count" data-el="card-count">0 views</span></div>
      <div class="canvas-tools"><span class="fixture-tag" data-el="dataset-badge">DATASET</span><button class="text-button" data-action="arrange" title="Arrange views in a grid">${icons.grid}Arrange</button><button class="text-button" data-action="clear-canvas" title="Remove every kept view">Clear canvas</button></div>
    </div>
    <div class="board-viewport" data-el="board-viewport" tabindex="0" aria-label="Canvas workspace. Drag the background to pan; use the controls to zoom.">
      <div class="board-world" data-el="board-world"></div>
      <div class="board-empty" data-el="board-empty"><div class="empty-emblem" aria-hidden="true"><span>${icons.trend}</span><i></i><b></b></div><span class="eyebrow">ROOM FOR YOUR NEXT DISCOVERY</span><h1>Type a question.<br>See it as you type.</h1><p>Every keystroke updates a live view. Enter keeps it on the canvas.<br>Drop a Parquet or CSV file anywhere to explore your own data.</p><div class="empty-chart-types" aria-label="Available views">${Object.values(VIEW_LABELS).map(l => `<span>${l}</span>`).join('')}</div></div>
      <div class="board-notice" data-el="board-notice" role="status" hidden></div>
    </div>
    <div class="canvas-bottom"><div class="zoom-controls" aria-label="Canvas zoom controls"><button data-action="zoom-out" aria-label="Zoom out">−</button><span data-el="zoom-label">100%</span><button data-action="zoom-in" aria-label="Zoom in">+</button><span class="control-divider"></span><button data-action="fit" title="Fit all views">Fit</button></div><span class="canvas-hint">Drag to explore · Enter keeps a live view</span></div>
  </main>
  <aside class="conversation" aria-label="Conversation">
    <div class="conversation-heading"><div><span class="eyebrow">EXPLORE</span><h2 data-el="dataset-title">Loading data</h2></div><button class="icon-button" data-action="settings" aria-label="Dataset and runtime settings" title="Dataset and runtime settings">${icons.database}</button></div>
    <div class="dataset-chip"><span class="small-status" data-el="dataset-dot"></span><div><strong data-el="dataset-name">Dataset</strong><span data-el="dataset-sub">Waiting for the engine…</span></div></div>
    <div class="status-pills pipeline-stages" data-el="status-pills" aria-label="Component status">${pill('database', 'Database')}${pill('inference', 'Inference')}${pill('renderer', 'Renderer')}${pill('coordinator', 'Coordinator')}</div>
    <div class="chat-scroll" data-el="chat-scroll">
      <div class="intro"><p>Type to explore. The live view follows every keystroke; Enter keeps it on your canvas.</p></div>
      <div class="examples" data-el="examples"><span class="eyebrow">A FEW PLACES TO START</span>
        <button data-prompt="Average vessel speed by hour"><span>How fast is the fleet moving?</span>${icons.arrow}<small>Average · hourly</small></button>
        <button data-prompt="Maximum wind by hour per vessel"><span>Where did the wind pick up?</span>${icons.arrow}<small>Maximum · per vessel</small></button>
        <button data-prompt="Wave height by hour and vessel as a heatmap"><span>Find patterns in the waves</span>${icons.arrow}<small>Heatmap · time × vessel</small></button>
      </div>
      <div class="message-history" data-el="history" aria-live="polite"></div>
    </div>
    <div class="composer-area">
      <div class="draft-state"><span class="pulse-dot" data-el="draft-dot"></span><span data-el="draft-state">Ready when you are</span><span class="mono" data-el="revision">r.0</span><button class="text-button cancel-button" data-action="stop" title="Cancel all work (Escape)">Stop</button></div>
      <form class="composer" data-el="composer"><div class="composer-caption">${icons.plus} <span>Live view · Enter to keep</span></div><label class="sr-only" for="query-input">Ask about the dataset</label><textarea id="query-input" data-el="input" rows="3" placeholder="Ask anything about the data…" spellcheck="false" autocomplete="off"></textarea><div class="composer-footer"><span>↵ Keep this view <span class="shortcut">· shift ↵ new line · esc stop</span></span><button class="send-button" data-el="submit" type="submit" aria-label="Keep this view">${icons.up}</button></div></form>
      <div class="composer-options"><button class="toggle-label" data-toggle="live" role="switch" aria-checked="true" title="Translate and draw on every keystroke"><span class="switch"></span>Live query</button><button class="toggle-label" data-toggle="speculate" role="switch" aria-checked="true" title="Execute speculative results before Enter"><span class="switch"></span>Prepare while typing</button></div>
    </div>
    <details class="pipeline-card timing-card" data-el="timing" open><summary class="pipeline-summary"><span class="pipeline-mark">${icons.bolt}</span>Last keystroke → first draw<strong class="timing-headline" data-el="timing-headline">—</strong><span class="cache-pill" data-el="timing-cache" hidden>CACHE HIT</span><span class="pipeline-chevron">⌄</span></summary>
      <div class="timing-body">
        <p class="timing-meta" data-el="timing-meta">No request measured yet.</p>
        <ol class="timing-stages" data-el="timing-stages"></ol>
        <p class="timing-infer" data-el="timing-infer"></p>
        <dl class="timing-rolling"><div><dt>MEDIAN</dt><dd data-el="roll-median">—</dd></div><div><dt>P95</dt><dd data-el="roll-p95">—</dd></div><div><dt>N</dt><dd data-el="roll-count">0</dd></div><div><dt>UI / KEY</dt><dd data-el="ui-cost" title="Main-thread time from input event handler entry to postMessage return, median of recent keystrokes">—</dd></div><div><dt>COST</dt><dd data-el="session-cost" title="Inference cost reported by INFER_STATS this session">$0</dd></div></dl>
        <p class="timing-note">Software timestamps on the page clock (draw submitted, not photons). Rolling stats over the last 50 drawn requests.</p>
      </div></details>
  </aside>
</div>
<button type="button" class="icon-button focus-toggle" data-action="focus" data-el="focus-toggle" aria-pressed="false" aria-label="Focus: fullscreen, only canvas and chat" title="Focus: fullscreen, only canvas and chat"><span class="focus-on">${icons.focus}</span><span class="focus-off">${icons.unfocus}</span></button>
<div class="drop-hint" data-el="drop-hint" hidden><div>${icons.file}<strong>Drop a Parquet or CSV file</strong><span>It loads into the in-browser database as a new dataset.</span></div></div>
<dialog class="runtime-dialog" data-el="settings-dialog"><form data-el="settings-form" method="dialog"><div class="dialog-heading"><div><span class="eyebrow">RUNTIME</span><h2>Choose where work happens.</h2></div><button type="button" class="icon-button" data-action="close-settings" aria-label="Close runtime settings">${icons.close}</button></div><p class="dialog-intro">Same frames, any placement. Coordinator settings apply immediately.</p>
  <div class="runtime-section"><label for="inference-kind">Inference <span>Turns your question into SQL</span></label><select id="inference-kind" name="inferenceKind"><option value="remote">Remote endpoint (tb1 WebSocket)</option><option value="webgpu">In this browser · WebGPU</option></select>
    <input type="url" name="inferenceEndpoint" aria-label="Inference endpoint URL" placeholder="wss://your-service.example/tb1"/>
    <div class="optional-field" data-el="model-field"><label for="model-profile">Browser model</label><select id="model-profile" name="modelProfile">${MODEL_PROFILES.map(p => `<option value="${p.id}">${p.label}</option>`).join('')}</select><small data-el="model-detail"></small></div>
    <button type="button" class="small-button" data-action="apply-inference">Use this inference ${icons.arrow}</button></div>
  <div class="runtime-section"><label for="dataset-fixture">Dataset <span>Loaded into DuckDB in the engine worker</span></label><select id="dataset-fixture" name="fixture">${FIXTURES.map(f => `<option value="${f.name}">${f.label}</option>`).join('')}</select><button type="button" class="small-button" data-action="load-fixture">Load fixture ${icons.arrow}</button>
    <div class="optional-field"><label for="dataset-url">From a URL</label><input id="dataset-url" type="url" name="datasetUrl" placeholder="https://example.org/data.parquet"/><button type="button" class="small-button" data-action="load-url">Load URL ${icons.arrow}</button></div>
    <div class="optional-field"><label for="dataset-file">From a file</label><input id="dataset-file" type="file" name="datasetFile" accept=".parquet,.pq,.csv,.tsv,.gz"/><small>Or drop a Parquet/CSV file anywhere on the page.</small></div></div>
  <div class="runtime-section"><label>Coordinator <span>Runs in the engine worker; changes apply live</span></label>
    <label class="checkbox-label"><input name="live" type="checkbox"/><span><span>Live query</span><small>Translate and draw on every keystroke. Off: only Enter runs.</small></span></label>
    <label class="checkbox-label"><input name="speculate" type="checkbox"/><span><span>Prepare while typing</span><small>Execute speculative results before Enter.</small></span></label>
    <label class="checkbox-label"><input name="translationCache" type="checkbox"/><span><span>Translation cache</span><small>Reuse exact text → SQL translations.</small></span></label>
    <div class="optional-field"><label for="inference-policy">In-flight policy</label><select id="inference-policy" name="inferencePolicy"><option value="latest">latest · finish, then translate the newest</option><option value="restart">restart · cancel and start the newest</option></select></div>
    <div class="optional-field"><label for="min-chars">Minimum characters</label><input id="min-chars" name="minChars" type="number" min="0" max="500" step="1"/></div>
    <div class="optional-field latency-dial"><label for="latency-dial">Latency dial <output data-el="latency-dial-value">off</output></label><div><input type="checkbox" name="latencyDialOn" aria-label="Enable latency dial"/><input id="latency-dial" name="latencyDialMs" type="range" min="0" max="1000" step="5"/></div><small>Releases cached translations after exactly this delay to simulate faster (or slower) inference.</small></div>
  </div>
  <div class="runtime-section"><label>Motion <span>Purely visual; never delays a query or a draw</span></label>
    <label class="checkbox-label"><input name="motionGrow" type="checkbox"/><span><span>Charts grow</span><small>A new chart breathes as a seed while it loads, then grows into place.</small></span></label>
    <label class="checkbox-label"><input name="motionCamera" type="checkbox"/><span><span>Smooth camera</span><small>Adding or removing a chart glides the canvas to fit; zoom buttons glide.</small></span></label>
  </div>
  <p class="runtime-error" data-el="settings-error" role="alert"></p>
  <div class="dialog-actions"><button type="button" class="text-button" data-action="reset-settings">Restore defaults</button><button type="button" class="primary-button" data-action="close-settings">Done ${icons.arrow}</button></div></form></dialog>
`;
