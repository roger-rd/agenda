'use strict';
const Module = require('node:module');
const path = require('node:path');
// Parámetro solo del precargado de pruebas; se retira antes de ejecutar test-db.
const target = process.argv.pop();
const secret = 'SYN-Initial-Load-Secret42';
const hostile = new Error(secret, { cause: { message: secret } });
Object.defineProperties(hostile, {
  stack: { value: secret }, privateValue: { value: secret },
  toString: { value: () => { throw new Error('hostile getter accessed'); } },
  toJSON: { get() { throw new Error('hostile getter accessed'); } },
  extra: { get() { throw new Error('hostile getter accessed'); } },
});
/** @typedef {{_load:(name:string,...args:unknown[])=>unknown}} Loader */
const loader = /** @type {Loader} */ (/** @type {unknown} */ (Module));
const original = loader._load;
loader._load = /** @param {string} name @param {unknown[]} args */ function (name, ...args) {
  if (name === 'node:path' && target === 'initialization') {
    return { ...path, resolve: () => { throw hostile; } };
  }
  if (name.endsWith('/' + target + '.cjs')) {
    // Si se retrasan los manejadores, esta aserción también rompe el proceso.
    if (!process.listenerCount('uncaughtException') || !process.listenerCount('unhandledRejection')) throw new Error('handlers missing');
    throw hostile;
  }
  return original.call(this, name, ...args);
};
