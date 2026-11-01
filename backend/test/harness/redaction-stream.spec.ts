import { PassThrough, Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { Redactor } from '../../scripts/harness/redactor.cjs';
import { createRedactionStream, RedactionGuard, RDX_FAILURE_LINE } from '../../scripts/harness/redaction-stream.cjs';
import { secretVariants } from '../../scripts/harness/secret-variants.cjs';
import { capture } from './support/sinks';
import { checkIsolatedMemory } from './support/memory-check';

const secret = 'SYN-Stream-Secret42';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('redaction-stream UN-R1 / UN-R2', () => {
  it.each(['destroy', 'emit'] as const)('F3 error del propio Transform vía %s produce RDX-2 una sola vez', async kind => {
    const output = capture(); const notify = jest.fn(); const source = new PassThrough();
    const stream = createRedactionStream(new Redactor([secret]), output.sink, { onFailure: notify });
    source.pipe(stream); source.write(secret.slice(0, 5));
    if (kind === 'destroy') stream.destroy(new Error(secret)); else stream.emit('error', new Error(secret));
    await tick();
    stream.emit('error', new Error(secret)); source.end(secret);
    await tick();
    expect(notify.mock.calls).toEqual([['RDX-2']]); expect(stream.destroyed).toBe(true);
    expect(output.bytes().length).toBe(0);
    source.destroy();
  });
  it('cerrojo compartido: una excepción corta ambos canales y notifica una sola vez', async () => {
    const out = capture(); const err = capture(); const notify = jest.fn();
    const guard = new RedactionGuard({ secrets: [secret], sinks: { out: out.sink, err: err.sink }, onFailure: notify,
      makeRedactor: () => ({ push() { throw new Error(secret); }, finish() { throw new Error(secret); } }) });
    const stdout = new PassThrough(); const stderr = new PassThrough();
    guard.connect(stdout, stderr);
    stdout.write(secret); stderr.write(secret); stdout.end(); stderr.end();
    await guard.settled();
    expect(out.text()).toBe('');
    expect(err.text()).toBe(RDX_FAILURE_LINE('RDX-1'));
    expect(notify.mock.calls).toEqual([['RDX-1']]);
    expect(guard.streams.every(stream => stream.destroyed)).toBe(true);
  });
  it.each(['error', 'close'] as const)('falla cerrado ante %s del origen', async event => {
    const output = capture(); const notify = jest.fn();
    const source = new PassThrough();
    const stream = createRedactionStream(new Redactor([secret]), output.sink, { onFailure: notify });
    source.pipe(stream);
    source.write(secret.slice(0, 5));
    if (event === 'error') source.emit('error', new Error(secret)); else source.destroy();
    await tick();
    source.end(secret);
    expect(notify.mock.calls).toEqual([[event === 'error' ? 'RDX-2' : 'RDX-3']]);
    expect(output.text()).toBe('');
    expect(stream.destroyed).toBe(true);
  });
  it('traduce excepciones en finish y fallos del sumidero o drain sin imprimirlos', async () => {
    for (const failure of ['finish', 'emit', 'drain']) {
      const notify = jest.fn();
      const filter = { push: () => Buffer.from('safe!'), finish: () => { if (failure === 'finish') throw secret; return Buffer.alloc(0); } };
      const sink = { emit: () => { if (failure === 'emit') throw secret; return failure !== 'drain'; },
        drain: async () => { throw secret; } };
      const stream = createRedactionStream(filter, sink, { onFailure: notify });
      stream.end(Buffer.from('input'));
      await tick();
      expect(notify.mock.calls).toEqual([[failure === 'finish' ? 'RDX-1' : 'RDX-4']]);
      expect(stream.destroyed).toBe(true);
    }
  });
  it('rechaza un registro inválido sin permitir salida cruda', async () => {
    const out = capture(); const err = capture(); const notify = jest.fn();
    const guard = new RedactionGuard({ secrets: ['short'], sinks: { out: out.sink, err: err.sink }, onFailure: notify });
    await guard.settled();
    expect(err.text()).toBe(RDX_FAILURE_LINE('RDX-4'));
    expect(out.text()).toBe(''); expect(notify).toHaveBeenCalledTimes(1);
  });
  it('propaga contrapresión real: el productor se detiene mientras drain está pendiente', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let produced = 0; let emitted = 0;
    const source = new Readable({ highWaterMark: 65536, read() { produced++; this.push(Buffer.alloc(65536, 0x78)); } });
    const stream = createRedactionStream(new Redactor([secret]), { emit: () => { emitted++; return false; }, drain: () => waiting }, { onFailure: jest.fn() });
    try {
      source.pipe(stream); await tick();
      const pausedAt = produced; await tick();
      expect(produced).toBe(pausedAt); expect(produced).toBeLessThanOrEqual(3); expect(emitted).toBe(1);
    } finally { source.destroy(); stream.destroy(); release(); }
  });
  it('redacta hijos reales: fragmentación, errores, cause, AggregateError, inspect y JSON en ambos canales', async () => {
    const out = capture(); const err = capture(); const notify = jest.fn();
    const code = `const s=${JSON.stringify(secret)};process.stdout.write(s.slice(0,8));process.stderr.write(s.slice(0,5));setTimeout(()=>{process.stdout.write(s.slice(8)+'!');process.stderr.write(s.slice(5)+'!');const e=new Error(s,{cause:new Error(s)});console.error(e);console.error(new AggregateError([e],s));process.stdout.write(JSON.stringify({message:s,cause:{message:s}}));throw e;},10);`;
    const child = spawn(process.execPath, ['-e', code], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
    const guard = new RedactionGuard({ secrets: [secret], sinks: { out: out.sink, err: err.sink }, onFailure: notify });
    try {
      guard.connect(child.stdout, child.stderr);
      const [exit] = await once(child, 'close'); await guard.settled();
      expect(exit).toBe(1); expect(notify).not.toHaveBeenCalled();
      for (const variant of secretVariants(secret)) { expect(out.bytes().includes(variant)).toBe(false); expect(err.bytes().includes(variant)).toBe(false); }
      expect(out.text()).toContain('[REDACTED]'); expect(err.text()).toContain('[REDACTED]');
    } finally { child.kill('SIGKILL'); guard.stop(); }
  });
  it('preserva binario y UTF-8 inválido', async () => {
    const output = capture(); const notify = jest.fn();
    const raw = Buffer.from([0xff, 0x80, 0, 0xfe]);
    const stream = createRedactionStream(new Redactor([secret]), output.sink, { onFailure: notify });
    stream.end(raw); await once(stream, 'finish');
    expect(output.bytes()).toEqual(raw); expect(notify).not.toHaveBeenCalled();
  });
  it('F1 memoria flujo: 10 MiB, contrapresión, cola <=128 KiB, retención <=4096, <5 s y consumo aislado', async () => {
    let produced = 0; let emitted = 0; let maxQueue = 0; let drains = 0; let emissions = 0; let maxPendingReads = 0;
    const source = new Readable({ highWaterMark: 65536, read() {
      if (produced === 160) { this.push(null); return; }
      produced++; maxPendingReads = Math.max(maxPendingReads, produced - emissions);
      this.push(Buffer.alloc(65536, 0x78));
    } });
    const filter = new Redactor([secret]);
    const stream = createRedactionStream(filter, {
      emit: buffer => { emissions++; emitted += buffer.length; maxQueue = Math.max(maxQueue, source.readableLength); return false; },
      drain: async () => { drains++; await tick(); const paused = produced; await tick(); expect(produced).toBe(paused); },
    }, { onFailure: code => { throw new Error(code); } });
    const start = performance.now();
    source.pipe(stream); await once(stream, 'finish');
    const elapsed = performance.now() - start;
    process.stdout.write(`STREAM_BENCH elapsedMs=${elapsed.toFixed(1)} queue=${maxQueue} retained=${filter.maxRetainedBytes} drains=${drains} pendingReads=${maxPendingReads}\n`);
    expect(emitted).toBe(10 * 1024 * 1024); expect(elapsed).toBeLessThan(5000);
    expect(maxQueue).toBeLessThanOrEqual(128 * 1024); expect(filter.maxRetainedBytes).toBeLessThanOrEqual(4096);
    expect(maxPendingReads).toBeLessThanOrEqual(2); expect(drains).toBeGreaterThanOrEqual(160); expect(drains).toBe(emissions);
    checkIsolatedMemory('stream');
  }, 20000);
});
