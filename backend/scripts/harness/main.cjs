'use strict';
const realFs = require('node:fs');
const path = require('node:path');
const { EXIT, PACKAGE_NAME } = require('./constants.cjs');
const { HarnessError, CATALOG } = require('./harness-error.cjs');
const { isC8Ready } = require('./c8-contract.cjs');
const { types } = require('node:util');
const { buildSummary, formatSummaryLine } = require('./summary.cjs');
/** @type {(value:unknown)=>asserts value is import('./summary.cjs').Summary} */
const validateSummary = require('./summary.cjs').validateSummary;
/** @typedef {import('./redaction-stream.cjs').Sink} Sink */
/** @typedef {import('./supervisor.cjs').Options} SupervisorOptions */
/** @typedef {{argv:readonly string[],cwd:string,platform:string,packageRoot:string,out:Sink,err:Sink,
 * now?:()=>number,fs?:typeof realFs,exists?:(filename:string)=>boolean,
 * signals?:SupervisorOptions['signals'],randomBytes?:(size:number)=>Uint8Array,getuid?:()=>number,tmpdir?:string,
 * isReady?:typeof isC8Ready,spawn?:SupervisorOptions['spawn'],killGroup?:SupervisorOptions['killGroup'],
 * isGroupAlive?:SupervisorOptions['isGroupAlive'],timers?:SupervisorOptions['timers'],
 * graceMs?:number,postKillWaitMs?:number,watchdogMs?:number,
 * summaryBuilder?:typeof buildSummary}} Dependencies */
/** @type {()=>void} */
let terminateActive = () => {};
/** @type {WeakMap<Dependencies, Promise<number>>} */
const failures = new WeakMap();
/** @type {WeakMap<Dependencies, boolean>} */
const partialLines = new WeakMap();
function terminateNow() { terminateActive(); }
/** @param {Sink} sink @param {string} text */
async function emit(sink, text) { if (!sink.emit(Buffer.from(text))) await sink.drain(); }
/** @param {'W-1'|'W-2'|'W-3'|'W-4'} code @param {Dependencies} deps @param {string} [mode] */
function internalFailure(code, deps, mode = 'fast') {
  const existing = failures.get(deps);
  if (existing) return existing;
  const pending = Promise.resolve().then(async () => {
    try { terminateNow(); } catch { /* Nunca inspecciona el valor original. */ }
    try {
      await emit(deps.err, `${code}: ${CATALOG[code]}\n`);
      const summary = buildSummary({ mode, status: 'error', exitCode: EXIT.INTEGRITY, code, phase: 'internal', durationMs: 0 });
      validateSummary(summary);
      await emit(deps.out, (partialLines.get(deps) ? '\n' : '') + formatSummaryLine(summary) + '\n');
      partialLines.set(deps, false);
    } catch { /* Fallo del sumidero: no hay una salida cruda alternativa. */ }
    return EXIT.INTEGRITY;
  });
  failures.set(deps, pending);
  return pending;
}
/** @param {string} root @param {typeof realFs} fs */
function packageName(root, fs) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(path.join(root, 'package.json'), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) return false;
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      if (!Number.isInteger(count) || count < 0 || count > buffer.length - size) return false;
      size += count;
    }
    if (size > 65536) return false;
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))).name === PACKAGE_NAME;
  } finally { fs.closeSync(fd); }
}
/** @param {Dependencies} deps @returns {Promise<number>} */
async function main(deps) {
  let mode = 'fast';
  let phase = 'args';
  let started = 0;
  try {
    const now = deps.now ?? Date.now;
    started = now();
    /** @param {string} status @param {number} exitCode @param {string|null} code @param {string} at
     * @param {{sink:Sink,text:string}} [diagnostic] */
    const summary = async (status, exitCode, code, at, diagnostic) => {
      const existing = failures.get(deps);
      if (existing) return existing;
      let line;
      try {
        const value = (deps.summaryBuilder ?? buildSummary)({ mode, status, exitCode, code, phase: at, durationMs: Math.max(0, Math.floor(now() - started)) });
        validateSummary(value); line = formatSummaryLine(value) + '\n';
      } catch { return internalFailure('W-3', deps, mode); }
      if (diagnostic) await emit(diagnostic.sink, diagnostic.text);
      await emit(deps.out, (partialLines.get(deps) ? '\n' : '') + line);
      partialLines.set(deps, false);
      return exitCode;
    };
    /** @param {keyof typeof CATALOG} code */
    const precondition = async code => {
      return summary('not_ready', EXIT.PRECONDITION, code, phase, {
        sink: code === 'H-C8-PENDING' ? deps.out : deps.err, text: `${code}: ${CATALOG[code]}\n`,
      });
    };
    if (deps.argv.length === 1 && deps.argv[0] === '--slow') mode = 'slow';
    else if (deps.argv.length !== 0) return await precondition('H-ARGS');
    phase = 'platform';
    if (!['darwin', 'linux'].includes(deps.platform)) return await precondition('H-PLATFORM');
    phase = 'package';
    const fs = deps.fs ?? realFs;
    let validPackage;
    try { validPackage = fs.realpathSync(deps.cwd) === deps.packageRoot && packageName(deps.packageRoot, fs); }
    catch { return await precondition('H-PACKAGE'); }
    if (!validPackage) return await precondition('H-PACKAGE');
    phase = 'c8-gate';
    if (!(deps.isReady ?? isC8Ready)(deps.packageRoot, { exists: deps.exists ?? fs.existsSync }).ready) return await precondition('H-C8-PENDING');

    // Nada con efectos ni entornos se carga antes de la puerta C8.
    phase = 'env';
    const { readEnvFiles } = require('./env-files.cjs');
    const { mintToken } = require('./run-token.cjs');
    const { buildChildEnv } = require('./child-env.cjs');
    let secrets; let env;
    try {
      ({ secrets } = readEnvFiles({ root: deps.packageRoot, fs, platform: deps.platform, getuid: deps.getuid }));
      const token = mintToken({ now, randomBytes: deps.randomBytes ?? require('node:crypto').randomBytes });
      env = buildChildEnv({ token, tmpdir: deps.tmpdir });
    } catch (error) {
      if (types.isNativeError(error) && error instanceof HarnessError) return await precondition(error.code);
      return await internalFailure('W-1', deps, mode);
    }
    phase = 'run';
    const { supervise, terminateNow: terminate } = require('./supervisor.cjs');
    terminateActive = terminate;
    // Slow selecciona nombres de pruebas marcados [slow]; timeout fijo de 30 s.
    const argv = ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js', '--config', 'jest.db.config.js', '--runInBand', '--testTimeout', '30000'];
    if (mode === 'slow') argv.push('--testNamePattern', '\\[slow\\]');
    /** @type {Sink} */
    const childOut = {
      emit(buffer) {
        const accepted = deps.out.emit(buffer);
        if (buffer.length) partialLines.set(deps, buffer[buffer.length - 1] !== 10);
        return accepted;
      },
      drain: () => deps.out.drain(),
    };
    const result = await supervise({ argv, env, cwd: deps.packageRoot, secrets, sinks: { out: childOut, err: deps.err },
      spawn: deps.spawn, signals: deps.signals, killGroup: deps.killGroup, isGroupAlive: deps.isGroupAlive,
      timers: deps.timers, now, graceMs: deps.graceMs, postKillWaitMs: deps.postKillWaitMs, watchdogMs: deps.watchdogMs });
    const failure = failures.get(deps);
    if (failure) return await failure;
    if (result.code === 'W-2') return await internalFailure('W-2', deps, mode);
    phase = 'cleanup';
    const { scanPaths } = require('./post-scan.cjs');
    const results = path.join(deps.packageRoot, 'test-results');
    try { if ((deps.exists ?? fs.existsSync)(results)) scanPaths([results], secrets, { fs }); }
    catch (error) {
      if (types.isNativeError(error) && error instanceof HarnessError) {
        return await summary('error', EXIT.INTEGRITY, error.code, phase, {
          sink: deps.err, text: `${error.code}: ${CATALOG[error.code]}\n`,
        });
      }
      return await internalFailure('W-1', deps, mode);
    }
    return await summary(result.status, result.exitCode, result.code, result.phase);
  } catch { return await internalFailure('W-1', deps, mode); }
}
module.exports = Object.freeze({ main, internalFailure, terminateNow });
