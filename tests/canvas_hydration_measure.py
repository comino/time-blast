"""Browser hydration ledger for 1/10/100 charts with five revisions each.

Run against a dedicated Vite preview (or dev server with HMR disabled):
  python3 tests/canvas_hydration_measure.py http://127.0.0.1:5394

Measures full-page reload, real DuckDB execution and UI terminals, followed by a
sequential Refresh of every remaining definition with residency bounded to eight.
Refresh deliberately includes the current source-reopen behavior. Metadata is
seeded through the production model/session/IndexedDB; inference remains unused.
One browser, warm HTTP/module caches, fresh workers and fixture data per reload.
These single observations are a smoke ledger, not p95/p99 benchmark claims.
"""
import json
import os
import sys
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from canvas_smoke import InferenceServer, TRACE, query, wait


URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5394").rstrip("/")
COUNTS = tuple(int(value) for value in os.environ.get("CANVAS_MEASURE_COUNTS", "1,10,100").split(","))
SUGGEST_OPTIONS = json.loads(os.environ["CANVAS_SUGGEST_OPTIONS"]) if "CANVAS_SUGGEST_OPTIONS" in os.environ else None

with sync_playwright() as p:
    server = InferenceServer()
    browser = p.chromium.launch(headless=True, args=["--enable-unsafe-swiftshader"])
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    context.add_init_script("localStorage.setItem('time-blast.ui.v1', " + json.dumps(json.dumps({
        "inference": {"kind": "remote", "endpoint": f"ws://127.0.0.1:{server.port}/session"},
        "coordinator": {"live": True, "speculate": True},
    })) + ");")
    context.add_init_script(TRACE)
    if SUGGEST_OPTIONS is not None:
        context.add_init_script("localStorage.setItem('time-blast.suggest', " + json.dumps(json.dumps(SUGGEST_OPTIONS)) + ");")
    page = context.new_page()
    errors, rows = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(URL, wait_until="domcontentloaded")
        wait(page, "window.__timeBlastUi?.controller.defaultSourceId && __timeBlastUi.controller.context")
        for count in COUNTS:
            print(f"measuring {count} charts", flush=True)
            seeded = page.evaluate("""async ({ count, sql }) => {
              const controller = __timeBlastUi.controller;
              const CanvasModel = controller.model.constructor, CanvasSession = controller.session.constructor;
              await controller.session.settled();
              const model = CanvasModel.create(`Hydration ${count}`);
              const source = structuredClone(controller.model.sources.get(controller.defaultSourceId));
              source.id = crypto.randomUUID(); delete source.canvasId;
              model.addSource(source);
              for (let chart = 0; chart < count; chart++) {
                let chartId;
                for (let revision = 0; revision < 5; revision++) {
                  const draft = model.startDraft({ chartId, sourceRefId: source.id,
                    text: revision ? `Revision ${revision + 1}` : `Average speed chart ${chart + 1}`,
                    layout: { x: 24 + chart % 2 * 524, y: 24 + Math.floor(chart / 2) * 494, width: 500, height: 470 } }).draft;
                  chartId = draft.chartId;
                  const statement = sql.replace('AVG(speed)', `AVG(speed) + ${chart}`);
                  model.recordSql(draft.id, draft.sequence, statement);
                  model.outcome(draft.id, draft.sequence, statement, 'succeeded');
                  model.finishDraft(draft.id);
                }
              }
              const raw = JSON.stringify(model.snapshot());
              const imported = CanvasSession.import(controller.storage, raw);
              await imported.settled();
              if (imported.saveState.state !== 'saved') throw new Error(imported.saveState.message);
              const result = { id: imported.model.header.id, serializedBytes: new TextEncoder().encode(raw).byteLength,
                revisions: imported.model.revisions.size, commits: imported.model.commits.size };
              imported.close();
              return result;
            }""", {"count": count, "sql": query()})
            before = len(server.calls)
            page.reload(wait_until="domcontentloaded")
            wait(page, "window.__timeBlastUi?.controller.model?.header.id === " + json.dumps(seeded["id"]) +
                 f" && document.querySelectorAll('.slot-card').length === {count}")
            metadata_ms = page.evaluate("performance.now()")
            expected = min(8, count)
            wait(page, "new Set((window.__canvasWire ?? []).filter(f => f.kind === 0x36 && f.value.status === 'succeeded').map(f => f.value.slot)).size === " + str(expected), timeout=90000)
            wait(page, "!__timeBlastUi.controller.runningJob && __timeBlastUi.controller.jobs.length === 0")
            observed = page.evaluate("""() => {
              const controller = __timeBlastUi.controller;
              const success = __canvasWire.filter(f => f.kind === 0x36 && f.value.status === 'succeeded');
              const drawn = __canvasWire.filter(f => f.kind === 0x34);
              const firstDraw = drawn.find(f => f.stamps.some(s => s.stage === 16));
              const start = __canvasWire.find(f => f.kind === 0x14 && f.context > 0)?.at;
              return { readyDefinitions: controller.model.state.charts.length,
                resident: [...controller.entries.values()].filter(e => e.resident).length,
                activeRequests: [...controller.entries.values()].filter(e => e.request > 0).length,
                completedSlots: [...new Set(success.map(f => f.value.slot))].length,
                firstExecutionTerminalMs: success[0]?.at, allInitialExecutionTerminalsMs: success.at(-1)?.at,
                firstTargetRegistrationMs: start, hydrateExecutionSpanMs: success.at(-1)?.at - start,
                firstTimingFrameMs: drawn[0]?.at, hydratedTableCount: document.querySelectorAll('.slot-card [data-c=tbody]').length,
                firstDrawTimingFrameMs: firstDraw?.at,
                firstDrawSubmittedMs: firstDraw?.stamps.find(s => s.stage === 16)?.at - performance.timeOrigin,
                tablesWithRows: [...document.querySelectorAll('.slot-card [data-c=tbody]')].filter(e => e.children.length).length,
                renderer: __canvasWire.find(f => f.kind === 4 && f.value.component === 'renderer')?.value.label };
            }""")
            assert observed["resident"] == expected and observed["completedSlots"] == expected, observed
            assert observed["readyDefinitions"] == count and observed["activeRequests"] == expected, observed
            assert len(server.calls) == before, server.calls
            print(f"cycling remaining {count - expected} definitions through actual Refresh", flush=True)
            cycle = page.evaluate("""async () => {
              const controller = __timeBlastUi.controller, start = performance.now();
              const resident = () => [...controller.entries.values()].filter(e => e.resident).length;
              let maxResident = resident(), refreshed = 0;
              const sample = () => { maxResident = Math.max(maxResident, resident()); };
              const sampler = setInterval(sample, 16);
              const successes = () => __canvasWire.filter(f => f.kind === 0x36 && f.value.status === 'succeeded');
              try {
                for (const chart of controller.model.state.charts) {
                  const entry = controller.entries.get(chart.id);
                  if (successes().some(f => f.value.slot === entry.slot)) continue;
                  const button = document.querySelector(`.slot-card[data-slot="${entry.slot}"] [data-a="refresh"]`);
                  if (!button) throw new Error(`Missing Refresh for slot ${entry.slot}`);
                  button.click(); refreshed++; sample();
                  const deadline = performance.now() + 60000;
                  while (!successes().some(f => f.value.slot === entry.slot)) {
                    if (!controller.runningJob && !controller.jobs.length && /could not|failed|error/i.test(entry.status)) throw new Error(`Refresh failed: slot ${entry.slot}, ${entry.status}`);
                    if (performance.now() >= deadline) throw new Error(`Refresh did not finish: slot ${entry.slot}, ${entry.status}`);
                    await new Promise(resolve => setTimeout(resolve, 10)); sample();
                  }
                }
                const success = successes(), requests = new Set(success.map(f => f.request));
                const executedSql = new Set(__canvasWire.filter(f => f.kind === 0x37 && requests.has(f.request)).map(f => f.value.sql));
                const expectedSql = controller.model.state.charts.map(c => controller.model.selected(c.id).sql);
                if (expectedSql.some(sql => !executedSql.has(sql))) throw new Error('A selected chart SQL was not executed');
                sample();
                return { refreshedDefinitions: refreshed, maxResidentDuringCycle: maxResident,
                  allDefinitionsExecuted: new Set(success.map(f => f.value.slot)).size,
                  distinctSelectedSqlExecuted: expectedSql.filter(sql => executedSql.has(sql)).length,
                  allDefinitionsHydratedMs: success.at(-1)?.at,
                  cycleStartMs: start, remainingDefinitionsCycleMs: refreshed ? success.at(-1).at - start : 0,
                  finalResident: resident(), method: 'DOM Refresh buttons; sequential source reload + saved SQL; bounded residency' };
              } finally { clearInterval(sampler); }
            }""")
            assert cycle["allDefinitionsExecuted"] == count and cycle["distinctSelectedSqlExecuted"] == count, cycle
            assert cycle["maxResidentDuringCycle"] <= 8 and cycle["finalResident"] == expected, cycle
            assert len(server.calls) == before, server.calls
            rows.append({"charts": count, "revisionsPerChart": 5, "metadataVisibleMs": metadata_ms,
                         **{key: value for key, value in seeded.items() if key != "id"}, **observed, "allDefinitionCycle": cycle})
        assert not errors, errors
        assert not server.errors and not server.calls, (server.errors, server.calls)
        print(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "browser": browser.version,
                          "url": URL, "environment": "Chromium headless; software GPU; warm page cache; fresh engine workers and fixture each reload",
                          "suggestionOptions": SUGGEST_OPTIONS if SUGGEST_OPTIONS is not None else "application defaults",
                          "inferenceCalls": len(server.calls), "costUsd": 0, "observations": rows}, indent=2), flush=True)
    except Exception:
        try:
            diagnostics = page.evaluate("""() => ({ workerErrors: window.__canvasWorkerErrors,
              wire: window.__canvasWire?.slice(-15),
              entries: [...(window.__timeBlastUi?.controller.entries?.values() ?? [])].map(({ slot, resident, ready, status, request }) => ({ slot, resident, ready, status, request })) })""")
        except Exception as diagnostic_error:
            diagnostics = {"diagnosticError": str(diagnostic_error)}
        print(json.dumps({"completed": rows, "errors": errors, **diagnostics}, indent=2), file=sys.stderr, flush=True)
        raise
    finally:
        browser.close()
        server.close()
