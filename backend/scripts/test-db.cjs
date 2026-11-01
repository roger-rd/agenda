'use strict';
// Respaldo autónomo: catálogo y resumen pueden ser precisamente la carga fallida.
const INITIAL_DIAGNOSTIC = 'W-1: Fallo interno del envoltorio.\n';
const INITIAL_FAST = 'AGENDA_TEST_DB_SUMMARY {"schemaVersion":1,"tool":"test-db","mode":"fast","status":"error","exitCode":4,"code":"W-1","phase":"internal","durationMs":0}\n';
const INITIAL_SLOW = 'AGENDA_TEST_DB_SUMMARY {"schemaVersion":1,"tool":"test-db","mode":"slow","status":"error","exitCode":4,"code":"W-1","phase":"internal","durationMs":0}\n';
let fatal = false;
let initialReported = false;
let slow = false;
/** @type {typeof import('./harness/main.cjs')|undefined} */
let runtime;
/** @type {import('./harness/main.cjs').Dependencies|undefined} */
let deps;
/** @param {NodeJS.WriteStream} stream @param {string} text */
const standardOutput = (stream, text) => { stream.write(text); };
const initialFailure = () => {
  fatal = true;
  if (initialReported) return;
  initialReported = true;
  try { standardOutput(process.stderr, INITIAL_DIAGNOSTIC); } catch { /* Sin canal crudo alternativo. */ }
  try { standardOutput(process.stdout, slow ? INITIAL_SLOW : INITIAL_FAST); } catch { /* Sin eco del error. */ }
  process.exitCode = 4;
};
const fail = () => {
  if (fatal) return;
  if (!runtime || !deps) { initialFailure(); return; }
  fatal = true;
  void runtime.internalFailure('W-4', deps, slow ? 'slow' : 'fast').then(code => { process.exitCode = code; }, () => { process.exitCode = 4; });
};
// Instalados antes de cualquier require, incluido el de path.
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
/** @param {NodeJS.WriteStream} stream */
const sink = stream => ({
  /** @param {Buffer} buffer */
  emit: buffer => stream.write(buffer),
  drain: () => new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(undefined); };
    const failed = () => { cleanup(); reject(new Error('sink')); };
    const cleanup = () => { stream.off('drain', done); stream.off('error', failed); stream.off('close', failed); };
    stream.once('drain', done); stream.once('error', failed); stream.once('close', failed);
    if (stream.destroyed) failed();
  }),
});
try {
  const argv = process.argv.slice(2);
  slow = argv.length === 1 && argv[0] === '--slow';
  const path = require('node:path');
  const api = require('./harness/main.cjs');
  runtime = api;
  deps = { argv, cwd: process.cwd(), platform: process.platform,
    packageRoot: path.resolve(__dirname, '..'), out: sink(process.stdout), err: sink(process.stderr), signals: process };
  if (!fatal) void api.main(deps).then(code => { if (!fatal) process.exitCode = code; }, fail);
} catch { initialFailure(); }
