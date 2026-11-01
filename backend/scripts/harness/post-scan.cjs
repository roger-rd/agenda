'use strict';
const realFs = require('node:fs');
const path = require('node:path');
const { HarnessError } = require('./harness-error.cjs');
const { createMatcher } = require('./redactor.cjs');
/** @typedef {Pick<typeof realFs, 'constants'|'lstatSync'|'openSync'|'fstatSync'|'readSync'|'closeSync'|'readdirSync'>} ScanFs */

/** Solo lectura, sin seguir enlaces ni cargar archivos completos.
 * El identificador de error es fijo: un nombre de archivo podría ser un secreto.
 * Los enlaces duros se analizan por cada nombre. FIFO, dispositivos y sockets
 * no son archivos de contenido: se cuentan como skippedSpecial sin abrirlos.
 * @param {readonly string[]} paths @param {readonly string[]} secrets
 * @param {{fs?:ScanFs,maxFileBytes?:number,maxDepth?:number,maxEntries?:number}} [options] */
function scanPaths(paths, secrets, { fs = realFs, maxFileBytes = 64 * 1024 * 1024, maxDepth = 8, maxEntries = 1000 } = {}) {
  const fail = () => new HarnessError('H-RDX-4', { file: 'scan-entry' });
  /** @template T @param {()=>T} action @returns {T} */
  const safe = action => { try { return action(); } catch { throw fail(); } };
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = safe(() => fs.constants);
  if (![maxFileBytes, maxDepth, maxEntries].every(value => Number.isSafeInteger(value) && value >= 0) || !O_NOFOLLOW || !O_NONBLOCK) throw fail();
  // Valida incluso si la lista o el directorio están vacíos.
  createMatcher(secrets);
  let entries = 0; let scanned = 0; let skippedLinks = 0; let skippedSpecial = 0; let hardLinked = 0;
  const block = Buffer.alloc(64 * 1024);
  /** @param {string} filename @param {number} depth */
  function visit(filename, depth) {
    if (++entries > maxEntries || depth > maxDepth) throw fail();
    const stat = safe(() => fs.lstatSync(filename));
    if (stat.isSymbolicLink()) { skippedLinks++; return; }
    if (stat.isDirectory()) {
      for (const entry of safe(() => fs.readdirSync(filename))) visit(path.join(filename, entry), depth + 1);
      return;
    }
    if (!stat.isFile()) { skippedSpecial++; return; }
    const fd = safe(() => fs.openSync(filename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
    try {
      const opened = safe(() => fs.fstatSync(fd));
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino ||
          !Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > maxFileBytes) throw fail();
      const matcher = createMatcher(secrets);
      let total = 0;
      for (;;) {
        const requested = Math.min(block.length, maxFileBytes - total + 1);
        const count = safe(() => fs.readSync(fd, block, 0, requested, null));
        if (!Number.isInteger(count) || count < 0 || count > requested) throw fail();
        if (!count) break;
        total += count;
        if (total > maxFileBytes) throw fail();
        if (matcher.feed(block.subarray(0, count))) throw new HarnessError('H-SCAN-HIT', { file: 'scan-entry' });
      }
      const final = safe(() => fs.fstatSync(fd));
      if (total !== opened.size || final.size !== opened.size || final.dev !== opened.dev || final.ino !== opened.ino ||
          final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) throw fail();
      scanned++;
      if (opened.nlink > 1) hardLinked++;
    } finally { safe(() => fs.closeSync(fd)); }
  }
  for (const filename of paths) visit(filename, 0);
  return Object.freeze({ scanned, skippedLinks, skippedSpecial, hardLinked });
}
module.exports = Object.freeze({ scanPaths });
