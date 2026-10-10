/** Drag-and-drop a Parquet/CSV file anywhere on the page → DatasetSource. */
import type { DatasetSource } from '../engine/contracts';

const ACCEPTED = /\.(parquet|pq|csv|tsv)(\.gz)?$/i;

export function isDatasetFile(file: { name: string }): boolean { return ACCEPTED.test(file.name); }

export function datasetFromFiles(files: ArrayLike<File> | null | undefined): DatasetSource | null {
  if (!files) return null;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (isDatasetFile(file)) return { kind: 'file', name: file.name, file };
  }
  return null;
}

export function datasetFromUrl(raw: string): DatasetSource | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? url.hostname);
  return { kind: 'url', name, url: url.href };
}

const carriesFiles = (event: DragEvent): boolean => !!event.dataTransfer && Array.from(event.dataTransfer.types ?? []).includes('Files');

/** Listens on `target` (usually window). `highlight` toggles a page-wide drop hint. */
export function installDropZone(target: EventTarget, onSource: (source: DatasetSource) => void, highlight: (active: boolean) => void = () => {}, onReject: (names: string) => void = () => {}): () => void {
  const controller = new AbortController(), signal = controller.signal;
  let depth = 0;
  target.addEventListener('dragenter', event => {
    if (!carriesFiles(event as DragEvent)) return;
    depth++; highlight(true);
  }, { signal });
  target.addEventListener('dragover', event => {
    const drag = event as DragEvent;
    if (!carriesFiles(drag)) return;
    drag.preventDefault();
    if (drag.dataTransfer) drag.dataTransfer.dropEffect = 'copy';
  }, { signal });
  target.addEventListener('dragleave', event => {
    if (!carriesFiles(event as DragEvent)) return;
    depth = Math.max(0, depth - 1); if (!depth) highlight(false);
  }, { signal });
  target.addEventListener('drop', event => {
    const drag = event as DragEvent;
    if (!carriesFiles(drag)) return;
    drag.preventDefault(); depth = 0; highlight(false);
    const files = drag.dataTransfer?.files;
    const source = datasetFromFiles(files);
    if (source) onSource(source);
    else onReject(Array.from(files ?? []).map(f => f.name).join(', ') || 'nothing');
  }, { signal });
  return () => controller.abort();
}
