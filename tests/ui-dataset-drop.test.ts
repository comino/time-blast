import { describe, expect, it } from 'vitest';
import { datasetFromFiles, datasetFromUrl, installDropZone } from '../src/ui/dataset-drop';
import { UiController } from '../src/ui/controller';
import type { DatasetSource } from '../src/engine/contracts';
import { FakeEngine, FakeHost, FakeRail } from './ui-fake-engine';

function dragEvent(type: string, files: File[]): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, dropEffect: 'none' } });
  return event;
}

describe('dataset drag and drop', () => {
  it('a dropped Parquet file becomes a dataset message to the engine', () => {
    const engine = new FakeEngine();
    const ui = new UiController(engine, new FakeHost(), new FakeRail());
    const target = new EventTarget(), highlights: boolean[] = [];
    installDropZone(target, source => ui.setDataset(source), active => highlights.push(active));
    const file = new File([new Uint8Array([1, 2, 3])], 'trips.parquet');
    target.dispatchEvent(dragEvent('dragenter', [file]));
    const over = dragEvent('dragover', [file]); target.dispatchEvent(over);
    const drop = dragEvent('drop', [new File(['x'], 'notes.txt'), file]);
    target.dispatchEvent(drop);
    expect(over.defaultPrevented).toBe(true);
    expect(drop.defaultPrevented).toBe(true);
    expect(highlights).toEqual([true, false]);
    expect(engine.messages('dataset')).toEqual([{ type: 'dataset', source: { kind: 'file', name: 'trips.parquet', file } }]);
  });

  it('rejects drops without a Parquet/CSV file', () => {
    const target = new EventTarget(), got: DatasetSource[] = [], rejected: string[] = [];
    installDropZone(target, s => got.push(s), undefined, names => rejected.push(names));
    target.dispatchEvent(dragEvent('drop', [new File(['x'], 'photo.png')]));
    expect(got).toEqual([]);
    expect(rejected).toEqual(['photo.png']);
  });

  it('accepts csv/tsv/parquet and parses dataset URLs', () => {
    expect(datasetFromFiles([new File([''], 'A.CSV')])?.name).toBe('A.CSV');
    expect(datasetFromFiles([new File([''], 'b.tsv.gz')])?.name).toBe('b.tsv.gz');
    expect(datasetFromFiles([])).toBeNull();
    expect(datasetFromUrl('https://data.example/dir/taxi%20trips.parquet?x=1')).toEqual({ kind: 'url', name: 'taxi trips.parquet', url: 'https://data.example/dir/taxi%20trips.parquet?x=1' });
    expect(datasetFromUrl('file:///etc/passwd')).toBeNull();
    expect(datasetFromUrl('not a url')).toBeNull();
  });
});
