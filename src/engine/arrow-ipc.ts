/**
 * Decode Arrow IPC encapsulated messages one at a time, as DuckDB-Wasm hands them out
 * (one schema message, then one message per fetch). apache-arrow's RecordBatchReader reads
 * one message ahead, which would hold back every batch until the next one exists, so this
 * drives Message.decode + VectorLoader directly.
 *
 * Zero-copy: column buffers of the returned RecordBatch are views into `chunk` (verified in
 * tests/engine-database.test.ts). The only copy on the path is DuckDB-Wasm's own copy of each
 * message out of Wasm memory (bindings copyBuffer), which keeps the batch valid after the
 * next fetch reuses Wasm memory.
 */
import { makeData, Message, MessageHeader, RecordBatch, Schema, Struct, Vector } from 'apache-arrow';
import { VectorLoader } from 'apache-arrow/visitor/vectorloader';

export type Decoded = { kind: 'schema'; schema: Schema } | { kind: 'batch'; batch: RecordBatch } | { kind: 'dictionary' };

export class IpcMessageDecoder {
  schema?: Schema;
  private dictionaries = new Map<number, Vector>();

  decode(chunk: Uint8Array): Decoded {
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let at = 4, length = view.getInt32(0, true);
    if (length === -1) { length = view.getInt32(4, true); at = 8; }
    const message = Message.decode(chunk.subarray(at, at + length));
    const bodyStart = at + length;
    const body = chunk.subarray(bodyStart, bodyStart + Number(message.bodyLength));
    switch (message.headerType) {
      case MessageHeader.Schema: {
        const schema = message.header() as Schema;
        this.schema = schema;
        this.dictionaries = new Map();
        return { kind: 'schema', schema };
      }
      case MessageHeader.RecordBatch: {
        const schema = this.requireSchema();
        const header = message.header() as unknown as BatchHeader;
        const children = new VectorLoader(body, header.nodes, header.buffers, this.dictionaries, schema.metadataVersion)
          .visitMany(schema.fields);
        const data = makeData({ type: new Struct(schema.fields), length: Number(header.length), children, nullCount: 0 });
        return { kind: 'batch', batch: new RecordBatch(schema, data) };
      }
      case MessageHeader.DictionaryBatch: {
        const schema = this.requireSchema();
        const header = message.header() as unknown as { id: number; isDelta: boolean; data: BatchHeader };
        const type = schema.dictionaries.get(header.id)!;
        const data = new VectorLoader(body, header.data.nodes, header.data.buffers, this.dictionaries, schema.metadataVersion)
          .visitMany([type]);
        const previous = this.dictionaries.get(header.id);
        const vector = new Vector(data);
        this.dictionaries.set(header.id, (previous && header.isDelta ? previous.concat(vector) : vector).memoize());
        return { kind: 'dictionary' };
      }
      default:
        throw new Error(`unexpected Arrow IPC message type ${message.headerType}`);
    }
  }

  private requireSchema(): Schema {
    if (!this.schema) throw new Error('Arrow IPC batch before schema');
    return this.schema;
  }
}

interface BatchHeader {
  length: number | bigint;
  nodes: ConstructorParameters<typeof VectorLoader>[1];
  buffers: ConstructorParameters<typeof VectorLoader>[2];
}
