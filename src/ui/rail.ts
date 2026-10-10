/** Side rail: dataset chip, status pills, kept-question history, errors and the timing panel. */
import type { DatasetContext } from '../engine/contracts';
import type { ErrorInfo, RailView, StatusInfo } from './controller';
import { describeInferStats, formatMs, type InferStats, type RollingSummary, type TimingBreakdown } from './timing';

const COMPONENT_ALIASES: Record<string, string> = { model: 'inference', webllm: 'inference', duckdb: 'database', render: 'renderer' };
const MAX_HISTORY = 40, MAX_ERRORS = 4;
const integer = new Intl.NumberFormat('en');

export interface RailCallbacks { focusSlot(slot: number): boolean; notice(text: string): void }

export class Rail implements RailView {
  private readonly q = (name: string) => this.root.querySelector<HTMLElement>(`[data-el="${name}"]`)!;
  private readonly stageRows: HTMLLIElement[] = [];
  private errors = 0;

  constructor(private readonly root: HTMLElement, private readonly callbacks: RailCallbacks) {}

  status(s: StatusInfo): void {
    const component = COMPONENT_ALIASES[s.component] ?? s.component;
    const pills = this.q('status-pills');
    let pill = pills.querySelector<HTMLElement>(`[data-stage="${CSS.escape(component)}"]`);
    if (!pill) {
      pill = document.createElement('div'); pill.dataset.stage = component;
      pill.innerHTML = '<span class="stage-dot"></span><span></span><small></small>';
      pill.children[1].textContent = component; pills.append(pill);
    }
    pill.dataset.state = s.state === 'cold' ? 'cold' : s.state;
    const progress = typeof s.progress === 'number' ? ` · ${Math.round(s.progress * 100)}%` : '';
    pill.querySelector('small')!.textContent = `${s.label}${progress}`;
    pill.title = s.detail ?? s.label;
    if (component === 'database') this.q('dataset-dot').dataset.state = s.state;
  }

  context(c: DatasetContext): void {
    const rows = c.tables.reduce((n, t) => n + t.rows, 0), columns = c.tables.reduce((n, t) => n + t.columns.length, 0);
    this.q('dataset-title').textContent = c.name;
    this.q('dataset-name').textContent = c.description ?? c.name;
    this.q('dataset-sub').textContent = `${integer.format(rows)} rows · ${c.tables.length} ${c.tables.length === 1 ? 'table' : 'tables'} · ${columns} columns · ${c.dialect}`;
    this.q('dataset-badge').textContent = c.name.toUpperCase();
    this.q('dataset-dot').dataset.state = 'ready';
    this.q('examples').hidden = !/vessel/i.test(c.name);
  }

  timing(t: TimingBreakdown, summary: RollingSummary, stats: InferStats | undefined): void {
    this.q('timing-headline').textContent = formatMs(t.headline);
    this.q('timing-cache').hidden = !t.cacheHit;
    this.q('timing-meta').textContent = `request ${t.request} · r.${t.revision}${t.presented !== null ? ` · presented ${formatMs(t.presented)}` : ''}`;
    const list = this.q('timing-stages');
    const span = Math.max(1e-6, ...t.rows.map(r => r.offset));
    while (this.stageRows.length < t.rows.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="stage-name"></span><span class="stage-bar"><i></i></span><span class="stage-delta"></span><span class="stage-offset"></span>';
      list.append(li); this.stageRows.push(li);
    }
    this.stageRows.forEach((li, i) => {
      const row = t.rows[i]; li.hidden = !row; if (!row) return;
      const [name, bar, delta, offset] = li.children as unknown as HTMLElement[];
      name.textContent = row.label;
      const left = Math.max(0, (row.offset - row.delta) / span), width = Math.max(0, row.delta / span);
      (bar.firstElementChild as HTMLElement).style.cssText = `left:${(left * 100).toFixed(2)}%;width:${Math.max(.5, width * 100).toFixed(2)}%`;
      delta.textContent = i === 0 ? '' : `${row.delta >= 0 ? '+' : ''}${formatMs(row.delta)}`;
      offset.textContent = formatMs(row.offset);
      li.dataset.headline = String(row.label === 'first draw submitted');
    });
    if (stats) this.q('timing-infer').textContent = describeInferStats(stats);
    this.q('roll-median').textContent = formatMs(summary.median);
    this.q('roll-p95').textContent = formatMs(summary.p95);
    this.q('roll-count').textContent = String(summary.count);
  }

  inferStats(_request: number, s: InferStats, sessionCostUsd: number): void {
    this.q('timing-infer').textContent = describeInferStats(s);
    this.q('session-cost').textContent = `$${sessionCostUsd < 1 ? sessionCostUsd.toFixed(4) : sessionCostUsd.toFixed(2)}`;
  }

  error(e: ErrorInfo, request: number): void {
    const history = this.q('history');
    const p = document.createElement('p'); p.className = 'error-message';
    p.textContent = `${e.message}${request ? ` (request ${request})` : ''}`;
    if (e.detail) p.title = e.detail;
    history.append(p);
    if (++this.errors > MAX_ERRORS) { history.querySelector('.error-message')?.remove(); this.errors--; }
    this.scroll();
  }

  live(slot: number | null, revision: number): void {
    const state = this.q('draft-state'), dot = this.q('draft-dot');
    state.textContent = slot === null ? 'Ready when you are' : `Live view · r.${revision}`;
    dot.dataset.state = slot === null ? 'ready' : 'loading';
  }

  kept(slot: number, title: string): void {
    const history = this.q('history');
    const button = document.createElement('button'); button.className = 'history-question'; button.textContent = title || `View ${slot}`;
    button.addEventListener('click', () => { if (!this.callbacks.focusSlot(slot)) this.callbacks.notice('This view was removed from the canvas.'); });
    history.append(button);
    const questions = history.querySelectorAll('.history-question');
    if (questions.length > MAX_HISTORY) questions[0].remove();
    this.scroll();
  }

  /** Main-thread cost per keystroke (ms), shown in µs. */
  uiCost(medianMs: number | null): void {
    this.q('ui-cost').textContent = medianMs === null ? '—' : `${(medianMs * 1000).toFixed(0)} µs`;
  }

  private scroll(): void { const s = this.q('chat-scroll'); requestAnimationFrame(() => { s.scrollTop = s.scrollHeight; }); }
}
