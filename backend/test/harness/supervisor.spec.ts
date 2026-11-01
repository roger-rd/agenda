import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import { supervise, terminateNow } from '../../scripts/harness/supervisor.cjs';
import type { Options } from '../../scripts/harness/supervisor.cjs';
import { capture } from './support/sinks';

const secret = 'SYN-Supervisor42';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function defaults(): Options {
  return { argv: ['-e', ''], env: {}, cwd: process.cwd(), secrets: [secret],
    sinks: { out: capture().sink, err: capture().sink }, signals: new EventEmitter() as Options['signals'],
    graceMs: 100, postKillWaitMs: 200, watchdogMs: 5000 };
}
function fake() {
  const child = Object.assign(new EventEmitter(), { pid: 43210, stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcess;
  let alive = true;
  const killGroup = jest.fn();
  const launch = jest.fn(() => child);
  const signals = new EventEmitter();
  const options: Options = { ...defaults(), spawn: launch as unknown as typeof spawn, killGroup, isGroupAlive: () => alive, signals: signals as Options['signals'] };
  const exit = (code: number | null = 0, signal: string | null = null) => {
    alive = false; child.stdout!.push(null); child.stderr!.push(null); child.emit('exit', code, signal);
  };
  return { child, options, signals, killGroup, launch, exit, setAlive: (value: boolean) => { alive = value; } };
}
function exists(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function gone(pid: number) {
  const deadline = Date.now() + 2000;
  while (exists(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  expect(exists(pid)).toBe(false);
}

describe('supervisor con dobles UN-D5 / UN-D16 / UN-R5 / UN-R6', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { terminateNow(); jest.useRealTimers(); });
  it.each([0, 1, 3])('mapea salida del hijo %i y fija opciones exactas de lanzamiento', async code => {
    const f = fake(); const promise = supervise(f.options); f.exit(code);
    await jest.runAllTimersAsync();
    expect((await promise).exitCode).toBe(code === 0 ? 0 : 1);
    expect(f.launch).toHaveBeenCalledWith(process.execPath, f.options.argv, { shell: false, env: {}, cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(f.signals.eventNames()).toEqual([]); expect(jest.getTimerCount()).toBe(0);
  });
  it.each([['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 143]] as const)('reenvía %s y retorna %i, respetando la gracia', async (signal, code) => {
    const f = fake(); const promise = supervise(f.options); f.signals.emit(signal);
    expect(f.killGroup.mock.calls).toEqual([[43210, 'SIGTERM']]);
    await jest.advanceTimersByTimeAsync(99); expect(f.killGroup).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1); expect(f.killGroup.mock.calls[1]).toEqual([43210, 'SIGKILL']);
    f.exit(null, 'SIGKILL'); await jest.advanceTimersByTimeAsync(50);
    expect((await promise).exitCode).toBe(code);
    expect(f.signals.eventNames()).toEqual([]); expect(jest.getTimerCount()).toBe(0);
  });
  it('segunda señal fuerza SIGKILL inmediatamente', async () => {
    const f = fake(); const promise = supervise(f.options);
    f.signals.emit('SIGINT'); f.signals.emit('SIGTERM');
    expect(f.killGroup.mock.calls).toEqual([[43210, 'SIGTERM'], [43210, 'SIGKILL']]);
    f.exit(null, 'SIGKILL'); await jest.runAllTimersAsync();
    expect((await promise).exitCode).toBe(130); expect(jest.getTimerCount()).toBe(0);
  });
  it.each([['SIGTERM', 143], ['SIGINT', 130]] as const)('EPERM transitorio en sondeo y señal conserva %s / %i hasta ESRCH', async (signal, code) => {
    const f = fake(); let probeCode = 'EPERM';
    const isGroupAlive = jest.fn(() => { throw Object.assign(new Error('synthetic'), { code: probeCode }); });
    const killGroup = jest.fn(() => { throw Object.assign(new Error('synthetic'), { code: 'EPERM' }); });
    const promise = supervise({ ...f.options, isGroupAlive, killGroup });
    f.signals.emit(signal);
    await jest.advanceTimersByTimeAsync(100);
    expect(killGroup.mock.calls).toHaveLength(2);
    expect(isGroupAlive.mock.calls.length).toBeGreaterThan(1);
    probeCode = 'ESRCH';
    await jest.advanceTimersByTimeAsync(50);
    expect(await promise).toMatchObject({ exitCode: code, status: 'aborted', code: null });
    expect(jest.getTimerCount()).toBe(0); expect(f.signals.eventNames()).toEqual([]);
  });
  it('EPERM persistente vence el plazo y devuelve H-GRP-LEAK, nunca éxito', async () => {
    const f = fake();
    const denied = () => { throw Object.assign(new Error('synthetic'), { code: 'EPERM' }); };
    const promise = supervise({ ...f.options, isGroupAlive: denied, killGroup: denied });
    let resolved = false; void promise.then(() => { resolved = true; });
    f.signals.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(299); expect(resolved).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await promise).toMatchObject({ exitCode: 3, code: 'H-GRP-LEAK' });
    expect(jest.getTimerCount()).toBe(0); expect(f.signals.eventNames()).toEqual([]);
  });
  it.each(['probe', 'signal'])('EINVAL en %s sigue siendo W-2 y no conserva el error', async kind => {
    const f = fake();
    const invalid = () => { throw Object.assign(new Error(secret, { cause: secret }), { code: 'EINVAL' }); };
    const promise = supervise({ ...f.options, ...(kind === 'probe' ? { isGroupAlive: invalid } : { killGroup: invalid }) });
    f.signals.emit('SIGTERM'); await jest.runAllTimersAsync();
    expect(await promise).toEqual({ exitCode: 4, status: 'error', code: 'W-2', phase: 'internal' });
    expect(jest.getTimerCount()).toBe(0);
  });
  it('vigila globalmente y limpia todos los temporizadores y manejadores', async () => {
    const f = fake(); const promise = supervise({ ...f.options, watchdogMs: 20 });
    await jest.advanceTimersByTimeAsync(20); expect(f.killGroup).toHaveBeenCalledWith(43210, 'SIGTERM');
    f.exit(1); await jest.advanceTimersByTimeAsync(1);
    expect(await promise).toMatchObject({ exitCode: 1, code: 'H-WATCHDOG' });
    expect(jest.getTimerCount()).toBe(0); expect(f.signals.eventNames()).toEqual([]);
  });
  it('espera postKillWait y detecta grupo residual con precedencia sobre señales', async () => {
    const f = fake(); const promise = supervise(f.options); let resolved = false; void promise.then(() => { resolved = true; });
    f.signals.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(299); expect(resolved).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await promise).toMatchObject({ exitCode: 3, code: 'H-GRP-LEAK', phase: 'cleanup' });
    expect(jest.getTimerCount()).toBe(0); expect(f.signals.eventNames()).toEqual([]);
  });
  it('precedencia 4 > 3 > señal > 1: fallo de filtro conserva 4 aunque persista el grupo', async () => {
    const f = fake(); const err = capture();
    const promise = supervise({ ...f.options, sinks: { out: { emit: () => { throw secret; }, drain: async () => {} }, err: err.sink } });
    f.child.stdout!.emit('data', Buffer.from('safe!')); f.signals.emit('SIGINT');
    await jest.advanceTimersByTimeAsync(300);
    expect(await promise).toMatchObject({ exitCode: 4, code: 'H-RDX-4' });
    expect(err.text()).toBe('salida suprimida: fallo del filtro de redacción (código RDX-4)\n');
    expect(jest.getTimerCount()).toBe(0);
  });
  it('grupo ya vacío evita SIGKILL y cancela la gracia', async () => {
    const f = fake(); const promise = supervise(f.options); f.signals.emit('SIGTERM'); f.exit();
    await jest.advanceTimersByTimeAsync(1); expect((await promise).exitCode).toBe(143);
    expect(f.killGroup.mock.calls).toEqual([[43210, 'SIGTERM']]); expect(jest.getTimerCount()).toBe(0);
  });
  it.each([secret, Symbol('synthetic'), null, Object.create(null), new Error(secret)])('traduce valores inesperados sin conservarlos %#', async thrown => {
    const f = fake(); f.launch.mockImplementation(() => { throw thrown; });
    const result = await supervise(f.options);
    expect(result).toEqual({ exitCode: 4, status: 'error', code: 'W-2', phase: 'internal' });
    expect(jest.getTimerCount()).toBe(0); expect(f.signals.eventNames()).toEqual([]);
  });
  it('objeto hostil no se inspecciona y termina un grupo existente ante fallo interno', async () => {
    const touched = jest.fn(() => { throw new Error(secret); });
    const hostile = new Proxy({}, { get: touched, getPrototypeOf: touched });
    const f = fake(); let probes = 0;
    const promise = supervise({ ...f.options, isGroupAlive: () => { if (++probes === 1) throw hostile; return false; } });
    f.child.emit('exit', 0, null);
    await jest.runAllTimersAsync();
    expect(await promise).toMatchObject({ exitCode: 4, code: 'W-2' });
    expect(f.killGroup).toHaveBeenCalledWith(43210, 'SIGKILL'); expect(touched).not.toHaveBeenCalled();
  });
});

describe('supervisor con procesos y señales reales', () => {
  afterEach(() => terminateNow());
  it.each([0, 1, 3])('hijo real sale %i', async code => {
    expect((await supervise({ ...defaults(), argv: ['-e', `process.exitCode=${code}`] })).exitCode).toBe(code ? 1 : 0);
  });
  it('señal ajena produce salida 1', async () => {
    expect((await supervise({ ...defaults(), argv: ['-e', "process.kill(process.pid,'SIGTERM')"] })).exitCode).toBe(1);
  });
  it('ignora SIGTERM y recibe SIGKILL tras la gracia; no queda el grupo', async () => {
    const signals = new EventEmitter(); let pid = 0; let ready!: () => void;
    const readiness = new Promise<void>(resolve => { ready = resolve; });
    const output = capture();
    const promise = supervise({ ...defaults(), signals: signals as Options['signals'], argv: ['-e', "process.on('SIGTERM',()=>{});process.stdout.write(''+process.pid);setInterval(()=>{},1000)"],
      sinks: { out: { emit: buffer => { output.sink.emit(buffer); pid = Number(output.text()); ready(); return true; }, drain: async () => {} }, err: capture().sink } });
    try {
      await readiness; const start = Date.now(); signals.emit('SIGTERM');
      expect((await promise).exitCode).toBe(143); expect(Date.now() - start).toBeGreaterThanOrEqual(90); await gone(pid);
    } finally { if (pid && exists(pid)) process.kill(-pid, 'SIGKILL'); }
  });
  it('nieto del mismo grupo muere con su padre y se comprueba su PID', async () => {
    const signals = new EventEmitter(); const pids: number[] = []; let ready!: () => void;
    const readiness = new Promise<void>(resolve => { ready = resolve; });
    const output = capture();
    const code = "const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});process.stdout.write('GRAND='+process.pid+'\\\\n');setInterval(()=>{},1000)\"],{env:{},stdio:['ignore','inherit','inherit']});process.stdout.write('PARENT='+process.pid+'\\n');setInterval(()=>{},1000);";
    const promise = supervise({ ...defaults(), signals: signals as Options['signals'], argv: ['-e', code], sinks: {
      out: { emit: buffer => { output.sink.emit(buffer); const matches = [...output.text().matchAll(/(?:PARENT|GRAND)=(\d+)/g)]; if (matches.length === 2) { pids.push(...matches.map(match => Number(match[1]))); ready(); } return true; }, drain: async () => {} }, err: capture().sink } });
    try {
      await readiness; signals.emit('SIGTERM'); expect((await promise).exitCode).toBe(143);
      for (const pid of new Set(pids)) await gone(pid);
    } finally { for (const pid of new Set(pids)) if (exists(pid)) process.kill(pid, 'SIGKILL'); }
  }, 10000);
  it('10 MiB de hijo real con contrapresión, secretos en ambos canales y vigilante real', async () => {
    let total = 0; const out = capture(); const err = capture();
    const code = `const s=${JSON.stringify(secret)};process.stderr.write(s);let n=160;function next(){while(n-->0){if(!process.stdout.write(Buffer.alloc(65536,120))){process.stdout.once('drain',next);return;}}process.stdout.write(s);}next();`;
    const result = await supervise({ ...defaults(), argv: ['-e', code], sinks: {
      out: { emit: buffer => { total += buffer.length; if (buffer.includes(Buffer.from('['))) out.sink.emit(buffer); expect(buffer.includes(Buffer.from(secret))).toBe(false); return false; }, drain: tick }, err: err.sink } });
    expect(result.exitCode).toBe(0); expect(total).toBe(10 * 1024 * 1024 + 10);
    expect(out.text()).toContain('[REDACTED]'); expect(err.text()).toBe('[REDACTED]');
    expect(await supervise({ ...defaults(), watchdogMs: 100, argv: ['-e', 'setInterval(()=>{},1000)'] })).toMatchObject({ exitCode: 1, code: 'H-WATCHDOG' });
  }, 10000);
  it.each([['SIGTERM', 143], ['SIGINT', 130]] as const)('extremo a extremo con %s real devuelve %i', async (signal, expected) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'support/run-supervisor.cjs')], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; let pid = 0;
    try {
      const closed = once(child, 'close');
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout.on('data', chunk => { text += chunk.toString(); const match = /CHILD_PID=(\d+)/.exec(text); if (match && !pid) { pid = Number(match[1]); resolve(); } });
      });
      child.kill(signal); const [code] = await closed;
      expect(code).toBe(expected); await gone(pid);
      expect(JSON.parse(text.trim().split('\n').at(-1)!)).toMatchObject({ exitCode: expected });
    } finally { child.kill('SIGKILL'); if (pid && exists(pid)) process.kill(-pid, 'SIGKILL'); }
  }, 10000);
});
