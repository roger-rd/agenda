'use strict';
const { Readable } = require('node:stream');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { Redactor } = require('../../../scripts/harness/redactor.cjs');
const { createRedactionStream } = require('../../../scripts/harness/redaction-stream.cjs');
const blockBytes = 64 * 1024;
const blockCount = 160;
const tick = () => new Promise(resolve => setImmediate(resolve));
/** @typedef {{rss:number,heapUsed:number,arrayBuffers:number}} Memory */
/** @returns {Memory} */
function memory() {
  const { rss, heapUsed, arrayBuffers } = process.memoryUsage();
  return { rss, heapUsed, arrayBuffers };
}
/** El control usa los mismos bloques y sumidero, copiando sin redacción.
 * Memoria viva: GC antes de CADA observación. Presión sin GC: solo informativa.
 * @param {'redactor'|'stream'} mode @param {boolean} protectedMode @param {boolean} live */
async function sample(mode, protectedMode, live) {
  if (typeof global.gc !== 'function') throw new Error('gc required');
  global.gc();
  const before = memory(); const peak = { ...before };
  const start = performance.now();
  let bytes = 0; let maxQueue = 0; let drains = 0;
  const filter = protectedMode ? new Redactor(['SYN-Memory-Secret42', 'SYN-Memory-Other43']) : null;
  const redactor = filter ?? { push: (/** @type {Uint8Array} */ chunk) => Buffer.from(chunk), finish: () => Buffer.alloc(0) };
  const observe = () => {
    if (live) {
      if (typeof global.gc !== 'function') throw new Error('gc required');
      global.gc();
    }
    const current = memory();
    for (const key of /** @type {(keyof Memory)[]} */ (Object.keys(peak))) peak[key] = Math.max(peak[key], current[key]);
  };
  if (mode === 'redactor') {
    const block = Buffer.alloc(blockBytes, 0x78);
    for (let i = 0; i < blockCount; i++) { bytes += redactor.push(block).length; observe(); await tick(); drains++; }
    bytes += redactor.finish().length;
  } else {
    let produced = 0;
    const source = new Readable({ highWaterMark: blockBytes, read() { this.push(produced++ < blockCount ? Buffer.alloc(blockBytes, 0x78) : null); } });
    const stream = createRedactionStream(redactor, {
      emit(buffer) { bytes += buffer.length; maxQueue = Math.max(maxQueue, source.readableLength); observe(); return false; },
      async drain() { drains++; await tick(); },
    }, { onFailure: () => { throw new Error('pipeline failed'); } });
    source.pipe(stream); await once(stream, 'finish');
  }
  observe();
  const growth = { rss: peak.rss - before.rss, heapUsed: peak.heapUsed - before.heapUsed, arrayBuffers: peak.arrayBuffers - before.arrayBuffers };
  return { before, peak, growth, bytes, elapsedMs: performance.now() - start, maxQueue, maxRetained: filter?.maxRetainedBytes ?? 0, drains };
}
async function run() {
  if (typeof global.gc !== 'function') {
    process.stderr.write('memory benchmark requires --expose-gc\n');
    process.exitCode = 1;
    return;
  }
  const argument = process.argv[2];
  if (argument !== 'redactor' && argument !== 'stream') throw new Error('invalid mode');
  const mode = argument;
  /** @param {boolean} live */
  async function collect(live) {
    const samples = [];
    for (let i = 0; i < 3; i++) {
      // Alternar orden evita favorecer siempre al mismo lado por el allocator.
      if (i % 2 === 0) { const control = await sample(mode, false, live); samples.push({ control, pipeline: await sample(mode, true, live) }); }
      else { const pipeline = await sample(mode, true, live); samples.push({ pipeline, control: await sample(mode, false, live) }); }
    }
    return samples;
  }
  const live = await collect(true);
  // Carga SEPARADA, sin GC forzado durante observaciones: NO tiene umbrales.
  const allocationPressureInformative = await collect(false);
  process.stdout.write(JSON.stringify({ mode, live, allocationPressureInformative }) + '\n');
}
void run().catch(() => { process.stderr.write('memory benchmark failed\n'); process.exitCode = 1; });
