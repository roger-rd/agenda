import type { Sink } from '../../../scripts/harness/redaction-stream.cjs';

export function capture() {
  const chunks: Buffer[] = [];
  const sink: Sink = { emit: buffer => { chunks.push(Buffer.from(buffer)); return true; }, drain: async () => {} };
  return { sink, chunks, bytes: () => Buffer.concat(chunks), text: () => Buffer.concat(chunks).toString() };
}
