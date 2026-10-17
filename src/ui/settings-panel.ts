/** Runtime settings dialog: inference placement, dataset, coordinator config (live). */
import type { DatasetSource, InferencePlacement, WebGpuModel } from '../engine/contracts';
import type { CoordinatorConfig } from './controller';
import { datasetFromFiles, datasetFromUrl } from './dataset-drop';
import { coordinatorDefaults, datasetFromChoice, defaultInference, DEFAULT_MODEL_PROFILE, MODEL_PROFILES } from './defaults';
import { defaultMotion, type MotionSettings } from './motion';

export interface SettingsCallbacks {
  inference(placement: InferencePlacement): void;
  dataset(source: DatasetSource): void;
  config(patch: CoordinatorConfig): void;
  motion(value: MotionSettings): void;
}

export class SettingsPanel {
  private readonly dialog: HTMLDialogElement;
  private readonly form: HTMLFormElement;
  private dialFrame = 0;

  constructor(private readonly root: HTMLElement, private inference: InferencePlacement, config: CoordinatorConfig, private readonly callbacks: SettingsCallbacks, private readonly defaultEndpoint: string | undefined) {
    this.dialog = this.q<HTMLDialogElement>('settings-dialog');
    this.form = this.q<HTMLFormElement>('settings-form');
    const f = this.fields;
    const act = (name: string, fn: () => void) => root.querySelectorAll(`[data-action="${name}"]`).forEach(b => b.addEventListener('click', fn));
    act('settings', () => this.open());
    act('close-settings', () => this.dialog.close());
    act('apply-inference', () => this.applyInference());
    act('load-fixture', () => {
      const source = datasetFromChoice((f.fixture as HTMLSelectElement).value, import.meta.env.VITE_DATABASE_ENDPOINT as string | undefined);
      if (source) { this.error(''); callbacks.dataset(source); } else this.error('This dataset is not available in this build.');
    });
    act('load-url', () => {
      const source = datasetFromUrl((f.datasetUrl as HTMLInputElement).value);
      if (source) { this.error(''); callbacks.dataset(source); } else this.error('Enter an http(s) URL to a Parquet or CSV file.');
    });
    act('reset-settings', () => {
      const defaults = coordinatorDefaults();
      this.sync(defaults); callbacks.config(defaults);
      this.inference = defaultInference(defaultEndpoint); this.syncInference(); callbacks.inference(this.inference);
      const motion = defaultMotion(); this.syncMotion(motion); callbacks.motion(motion);
    });
    f.datasetFile.addEventListener('change', () => {
      const source = datasetFromFiles((f.datasetFile as HTMLInputElement).files);
      if (source) { this.error(''); callbacks.dataset(source); } else this.error('Choose a .parquet, .csv or .tsv file.');
    });
    f.inferenceKind.addEventListener('change', () => this.inferenceFields());
    f.modelProfile.addEventListener('change', () => this.modelDetail());
    for (const name of ['live', 'speculate', 'translationCache'] as const) f[name].addEventListener('change', () => callbacks.config({ [name]: (f[name] as HTMLInputElement).checked }));
    for (const name of ['motionGrow', 'motionCamera'] as const) f[name].addEventListener('change', () => callbacks.motion({
      grow: (f.motionGrow as HTMLInputElement).checked, camera: (f.motionCamera as HTMLInputElement).checked }));
    f.inferencePolicy.addEventListener('change', () => callbacks.config({ inferencePolicy: (f.inferencePolicy as HTMLSelectElement).value as 'latest' | 'restart' }));
    f.minChars.addEventListener('change', () => {
      const value = Math.round(Number((f.minChars as HTMLInputElement).value));
      if (Number.isFinite(value) && value >= 0 && value <= 500) callbacks.config({ minChars: value });
    });
    const dial = () => {
      const on = (f.latencyDialOn as HTMLInputElement).checked, ms = Number((f.latencyDialMs as HTMLInputElement).value);
      (f.latencyDialMs as HTMLInputElement).disabled = !on;
      this.q('latency-dial-value').textContent = on ? `${ms} ms` : 'off';
      if (this.dialFrame) return;
      // A dragged slider fires many input events; send at most one CONFIG per frame.
      this.dialFrame = requestAnimationFrame(() => {
        this.dialFrame = 0;
        callbacks.config({ latencyDialMs: (f.latencyDialOn as HTMLInputElement).checked ? Number((f.latencyDialMs as HTMLInputElement).value) : null });
      });
    };
    f.latencyDialMs.addEventListener('input', dial);
    f.latencyDialOn.addEventListener('change', dial);
    this.sync(config);
    this.syncInference();
  }

  open(): void { this.syncInference(); this.error(''); if (!this.dialog.open) this.dialog.showModal(); }

  /** Reflect a coordinator config in the form (no messages sent). */
  sync(config: CoordinatorConfig): void {
    const f = this.fields;
    if (config.live !== undefined) (f.live as HTMLInputElement).checked = config.live;
    if (config.speculate !== undefined) (f.speculate as HTMLInputElement).checked = config.speculate;
    if (config.translationCache !== undefined) (f.translationCache as HTMLInputElement).checked = config.translationCache;
    if (config.inferencePolicy) (f.inferencePolicy as HTMLSelectElement).value = config.inferencePolicy;
    if (config.minChars !== undefined) (f.minChars as HTMLInputElement).value = String(config.minChars);
    if (config.latencyDialMs !== undefined) {
      const on = config.latencyDialMs !== null;
      (f.latencyDialOn as HTMLInputElement).checked = on;
      (f.latencyDialMs as HTMLInputElement).disabled = !on;
      (f.latencyDialMs as HTMLInputElement).value = String(config.latencyDialMs ?? 50);
      this.q('latency-dial-value').textContent = on ? `${config.latencyDialMs} ms` : 'off';
    }
  }

  syncMotion(motion: MotionSettings): void {
    (this.fields.motionGrow as HTMLInputElement).checked = motion.grow;
    (this.fields.motionCamera as HTMLInputElement).checked = motion.camera;
  }

  get placement(): InferencePlacement { return this.inference; }

  private applyInference(): void {
    const f = this.fields;
    if ((f.inferenceKind as HTMLSelectElement).value === 'remote') {
      const endpoint = (f.inferenceEndpoint as HTMLInputElement).value.trim();
      try { const url = new URL(endpoint); if (!/^wss?:$|^https?:$/.test(url.protocol)) throw new Error(); }
      catch { this.error('Enter a ws(s):// or http(s):// inference endpoint.'); return; }
      this.inference = { kind: 'remote', endpoint };
    } else this.inference = { kind: 'webgpu', model: ((f.modelProfile as HTMLSelectElement).value || DEFAULT_MODEL_PROFILE) as WebGpuModel };
    this.error('');
    this.callbacks.inference(this.inference);
  }
  private syncInference(): void {
    const f = this.fields, p = this.inference;
    (f.inferenceKind as HTMLSelectElement).value = p.kind;
    (f.inferenceEndpoint as HTMLInputElement).value = p.kind === 'remote' ? p.endpoint : this.defaultEndpoint ?? '';
    (f.modelProfile as HTMLSelectElement).value = p.kind === 'webgpu' ? p.model : DEFAULT_MODEL_PROFILE;
    this.inferenceFields();
  }
  private inferenceFields(): void {
    const remote = (this.fields.inferenceKind as HTMLSelectElement).value === 'remote';
    (this.fields.inferenceEndpoint as HTMLElement).hidden = !remote;
    this.q('model-field').hidden = remote;
    this.modelDetail();
  }
  private modelDetail(): void {
    const id = (this.fields.modelProfile as HTMLSelectElement).value;
    this.q('model-detail').textContent = MODEL_PROFILES.find(p => p.id === id)?.detail ?? '';
  }
  private error(text: string): void { this.q('settings-error').textContent = text; }
  private get fields(): Record<string, HTMLElement> {
    const out: Record<string, HTMLElement> = {};
    for (const el of Array.from(this.form.elements) as HTMLInputElement[]) if (el.name) out[el.name] = el;
    return out;
  }
  private q<T extends HTMLElement = HTMLElement>(name: string): T { return this.root.querySelector<T>(`[data-el="${name}"]`)!; }
}
