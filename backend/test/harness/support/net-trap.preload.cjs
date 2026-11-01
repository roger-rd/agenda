'use strict';
const fs = require('node:fs');
const Module = require('node:module');
/** @type {string[]} */
const opened = [];
const originalOpen = fs.openSync;
const originalRead = fs.readFileSync;
/** @param {unknown} filename */
const record = filename => {
  if (typeof filename !== 'string') return;
  opened.push(filename);
  if (/(?:^|[/\\])\.env(?:$|[.])/.test(filename)) throw new Error('Environment access blocked');
};
fs.openSync = (filename, flags, mode) => { record(filename); return originalOpen(filename, flags, mode); };
fs.readFileSync = /** @type {typeof fs.readFileSync} */ (
  /** @param {Parameters<typeof fs.readFileSync>[0]} filename
   * @param {Parameters<typeof fs.readFileSync>[1]} [options] */
  (filename, options) => { record(filename); return options === undefined ? originalRead(filename) : originalRead(filename, options); });
/** @typedef {{_load:(name:string,...args:unknown[])=>unknown}} Loader */
const loader = /** @type {Loader} */ (/** @type {unknown} */ (Module));
const originalLoad = loader._load;
loader._load = /** @param {string} name @param {unknown[]} args */ function (name, ...args) {
  if (/^(?:node:)?(?:net|dns|child_process|http|https|http2|tls|dgram)(?:\/|$)/.test(name)) throw new Error('Network/process access blocked');
  return originalLoad.call(this, name, ...args);
};
process.once('exit', () => {
  const modules = Object.keys(require.cache).filter(filename => filename.includes('/scripts/harness/')).map(filename => filename.split('/').at(-1)).sort();
  fs.writeSync(3, JSON.stringify({ opened, modules }));
});
