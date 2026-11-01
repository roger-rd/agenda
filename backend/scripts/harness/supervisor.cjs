'use strict';
const childProcess = require('node:child_process');
const { EXIT, TIMINGS } = require('./constants.cjs');
const { RedactionGuard } = require('./redaction-stream.cjs');
/** @typedef {import('./redaction-stream.cjs').Sink} Sink */
/** @typedef {{exitCode:number,status:string,code:string|null,phase:string}} Result */
/** @typedef {{spawn?:typeof childProcess.spawn, killGroup?:(pid:number,signal:NodeJS.Signals)=>void,
 * isGroupAlive?:(pid:number)=>boolean,argv:readonly string[],env:Readonly<Record<string,string>>,cwd:string,
 * secrets:readonly string[],sinks:{out:Sink,err:Sink},signals?:{on:(event:string,listener:()=>void)=>unknown,off:(event:string,listener:()=>void)=>unknown},
 * timers?:{setTimeout:typeof setTimeout,clearTimeout:typeof clearTimeout},now?:()=>number,
 * graceMs?:number,postKillWaitMs?:number,watchdogMs?:number}} Options */
/** @type {Set<()=>void>} */
const active = new Set();
/** Emergencia compartida con main y los manejadores W-4. */
function terminateNow() { for (const terminate of active) terminate(); }
/** Darwin puede devolver EPERM mientras el grupo propio contiene zombis o
 * miembros terminándose. Sigue vivo hasta ESRCH; el plazo conserva H-GRP-LEAK.
 * La misma traducción se aplica a los dobles inyectados.
 * @param {number} pid @param {(pid:number)=>boolean} probe */
function probeGroup(pid, probe) {
  try { return probe(pid); }
  catch (error) {
    const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw new Error('group-probe');
  }
}
/** @param {number} pid @param {NodeJS.Signals} signal
 * @param {(pid:number,signal:NodeJS.Signals)=>void} deliver */
function deliverGroup(pid, signal, deliver) {
  try { deliver(pid, signal); }
  catch (error) {
    const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    if (code === 'ESRCH' || code === 'EPERM') return;
    throw new Error('group-signal');
  }
}
/** @param {number} pid */
function groupAlive(pid) { return probeGroup(pid, value => { process.kill(-value, 0); return true; }); }
/** @param {number} pid @param {NodeJS.Signals} signal */
function signalGroup(pid, signal) { deliverGroup(pid, signal, (value, kind) => { process.kill(-value, kind); }); }
/** Sesión independiente. RESIDUAL: descendientes que ejecutan setsid salen del
 * grupo observado; no se afirma detectar ni terminar esos procesos.
 * @param {Options} options @returns {Promise<Readonly<Result>>} */
function supervise(options) {
  return new Promise(resolve => {
    const { spawn = childProcess.spawn, killGroup = signalGroup, isGroupAlive = groupAlive,
      signals = process, timers = { setTimeout, clearTimeout }, now = Date.now,
      graceMs = TIMINGS.graceMs, postKillWaitMs = TIMINGS.postKillWaitMs, watchdogMs = TIMINGS.watchdogMs } = options;
    /** @type {Result} */
    let result = { exitCode: EXIT.OK, status: 'ok', code: null, phase: 'run' };
    /** @type {import('node:child_process').ChildProcess|undefined} */
    let child;
    /** @type {InstanceType<typeof RedactionGuard>|undefined} */
    let guard;
    /** @type {Set<ReturnType<typeof setTimeout>>} */
    const pending = new Set();
    let done = false; let finishing = false; let terminating = false; let killed = false;
    let exited = false; let killDeadline = 0; let signalCount = 0;
    /** @param {number} code */
    const rank = code => code === 4 ? 5 : code === 3 ? 4 : code === 130 || code === 143 ? 3 : code === 1 ? 2 : 1;
    /** @param {Result} next */
    const choose = next => { if (rank(next.exitCode) > rank(result.exitCode)) result = next; };
    /** @param {()=>void} action @param {number} delay */
    const schedule = (action, delay) => {
      const timer = timers.setTimeout(() => { pending.delete(timer); if (!done) { try { action(); } catch { internal(); } } }, delay);
      pending.add(timer);
    };
    const cleanup = () => {
      for (const timer of pending) timers.clearTimeout(timer);
      pending.clear();
      signals.off('SIGINT', interrupt); signals.off('SIGTERM', terminate); signals.off('SIGHUP', terminate);
      active.delete(emergency);
    };
    const finish = () => {
      if (done || finishing) return;
      finishing = true;
      Promise.resolve().then(() => guard?.settled()).then(() => {
        if (done) return;
        done = true; cleanup(); resolve(Object.freeze(result));
      }, () => { finishing = false; internal(); });
    };
    const alive = () => child?.pid !== undefined && probeGroup(child.pid, isGroupAlive);
    const poll = () => {
      if (done) return;
      if (!alive()) {
        if (killed) { guard?.stop(); child?.stdout?.destroy(); child?.stderr?.destroy(); }
        if (exited || killed) finish();
        return;
      }
      if (killed && now() >= killDeadline) {
        choose({ exitCode: EXIT.CLEANUP, status: 'error', code: 'H-GRP-LEAK', phase: 'cleanup' });
        guard?.stop(); child?.stdout?.destroy(); child?.stderr?.destroy(); finish();
      } else schedule(poll, Math.min(50, killed ? Math.max(1, killDeadline - now()) : 50));
    };
    const force = () => {
      if (done || killed) return;
      killed = true; killDeadline = now() + postKillWaitMs;
      if (child?.pid !== undefined) deliverGroup(child.pid, 'SIGKILL', killGroup);
      poll();
    };
    const begin = () => {
      if (done || terminating) return;
      terminating = true;
      if (child?.pid !== undefined) deliverGroup(child.pid, 'SIGTERM', killGroup);
      schedule(force, graceMs);
      poll();
    };
    const emergency = () => { try { guard?.stop(); force(); } catch { internal(); } };
    const internal = () => {
      if (done) return;
      result = { exitCode: EXIT.INTEGRITY, status: 'error', code: 'W-2', phase: 'internal' };
      guard?.stop();
      try {
        if (!killed) { force(); return; }
      } catch { /* No se inspecciona, convierte ni conserva el valor lanzado. */ }
      child?.stdout?.destroy(); child?.stderr?.destroy(); finish();
    };
    /** @param {number} exitCode */
    const received = exitCode => {
      try {
        choose({ exitCode, status: 'aborted', code: null, phase: 'run' });
        if (++signalCount > 1) force(); else begin();
      } catch { internal(); }
    };
    const interrupt = () => received(EXIT.SIGINT);
    const terminate = () => received(EXIT.SIGTERM);
    try {
      active.add(emergency);
      signals.on('SIGINT', interrupt); signals.on('SIGTERM', terminate); signals.on('SIGHUP', terminate);
      guard = new RedactionGuard({ secrets: options.secrets, sinks: options.sinks, onFailure: code => {
        choose({ exitCode: EXIT.INTEGRITY, status: 'error', code: 'H-' + code, phase: 'run' });
        try { begin(); } catch { internal(); }
      } });
      if (guard.failed) { finish(); return; }
      child = spawn(process.execPath, [...options.argv], { shell: false, env: options.env, cwd: options.cwd,
        detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', internal);
      child.once('exit', (code, signal) => {
        try {
          exited = true;
          if (code !== 0 || signal) choose({ exitCode: EXIT.FAILED, status: 'failed', code: null, phase: 'run' });
          if (alive()) begin(); else finish();
        } catch { internal(); }
      });
      if (!child.stdout || !child.stderr) { internal(); return; }
      guard.connect(child.stdout, child.stderr);
      schedule(() => { choose({ exitCode: EXIT.FAILED, status: 'failed', code: 'H-WATCHDOG', phase: 'run' }); begin(); }, watchdogMs);
    } catch { internal(); }
  });
}
module.exports = Object.freeze({ supervise, terminateNow });
