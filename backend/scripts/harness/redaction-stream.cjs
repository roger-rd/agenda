'use strict';
const { Transform } = require('node:stream');
const { Redactor } = require('./redactor.cjs');
/** @typedef {{emit:(buffer:Buffer)=>boolean, drain:()=>Promise<void>}} Sink */
/** @typedef {{push:(chunk:Uint8Array)=>Buffer, finish:()=>Buffer}} Filter */
/** @typedef {'RDX-1'|'RDX-2'|'RDX-3'|'RDX-4'} FailureCode */
/** @param {FailureCode} code */
function RDX_FAILURE_LINE(code) { return `salida suprimida: fallo del filtro de redacción (código ${code})\n`; }

/** Transform sumidero: jamás convierte chunks a texto. La callback retiene la
 * contrapresión hasta que el sumidero confirme drain.
 * @param {Filter} redactor @param {Sink} sink
 * @param {{onFailure:(code:FailureCode)=>void}} options */
function createRedactionStream(redactor, sink, { onFailure }) {
  let failed = false;
  /** @type {Map<import('node:stream').Readable, ()=>void>} */
  const sources = new Map();
  /** @param {FailureCode} code */
  const fail = code => {
    if (failed) return;
    failed = true;
    filter.destroy();
    onFailure(code);
  };
  /** @param {Buffer} buffer @param {import('node:stream').TransformCallback} done */
  const emit = (buffer, done) => {
    if (failed) { done(); return; }
    try {
      if (buffer.length && !sink.emit(buffer)) {
        Promise.resolve().then(() => sink.drain()).then(() => { done(); }, () => { fail('RDX-4'); done(); });
      } else done();
    } catch { fail('RDX-4'); done(); }
  };
  const filter = new Transform({
    decodeStrings: true,
    transform(chunk, _encoding, done) {
      if (failed) { done(); return; }
      let buffer;
      try { buffer = redactor.push(chunk); }
      catch { fail('RDX-1'); done(); return; }
      emit(buffer, done);
    },
    flush(done) {
      if (failed) { done(); return; }
      let buffer;
      try { buffer = redactor.finish(); }
      catch { fail('RDX-1'); done(); return; }
      emit(buffer, done);
    },
  });
  filter.on('error', () => fail('RDX-2'));
  filter.on('pipe', source => {
    let ended = source.readableEnded;
    const end = () => { ended = true; };
    const error = () => fail('RDX-2');
    const close = () => { if (!ended) fail('RDX-3'); };
    source.once('end', end); source.on('error', error); source.once('close', close);
    sources.set(source, () => { source.off('end', end); source.off('error', error); source.off('close', close); source.unpipe(filter); });
  });
  filter.once('close', () => { for (const cleanup of sources.values()) cleanup(); sources.clear(); });
  return filter;
}

class RedactionGuard {
  /** @param {{secrets:readonly string[], sinks:{out:Sink,err:Sink}, onFailure:(code:FailureCode)=>void,
   * makeRedactor?:(secrets:readonly string[])=>Filter}} options */
  constructor({ secrets, sinks, onFailure, makeRedactor = values => new Redactor(values) }) {
    this.failed = false;
    /** @type {import('node:stream').Transform[]} */
    this.streams = [];
    this.diagnostic = Promise.resolve();
    /** @param {FailureCode} code */
    this.fail = code => {
      if (this.failed) return;
      this.failed = true;
      this.stop();
      try {
        if (!sinks.err.emit(Buffer.from(RDX_FAILURE_LINE(code)))) this.diagnostic = Promise.resolve().then(() => sinks.err.drain()).catch(() => {});
      } catch { /* Un sumidero roto no permite otro canal crudo. */ }
      onFailure(code);
    };
    try {
      this.streams.push(createRedactionStream(makeRedactor(secrets), sinks.out, { onFailure: this.fail }));
      this.streams.push(createRedactionStream(makeRedactor(secrets), sinks.err, { onFailure: this.fail }));
    } catch { this.fail('RDX-4'); }
  }
  /** @param {import('node:stream').Readable} out @param {import('node:stream').Readable} err */
  connect(out, err) {
    if (this.failed) { out.destroy(); err.destroy(); return; }
    out.pipe(this.streams[0]); err.pipe(this.streams[1]);
  }
  stop() { for (const stream of this.streams) stream.destroy(); }
  async settled() {
    await Promise.all(this.streams.map(stream => stream.writableFinished || stream.destroyed ? Promise.resolve() :
      new Promise(resolve => { const done = () => { stream.off('finish', done); stream.off('close', done); resolve(undefined); }; stream.once('finish', done); stream.once('close', done); })));
    await this.diagnostic;
  }
}
module.exports = Object.freeze({ createRedactionStream, RDX_FAILURE_LINE, RedactionGuard });
