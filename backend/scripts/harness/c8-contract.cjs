'use strict';
const path = require('node:path');
// Rutas provisionales: C8 debe confirmar el contrato y habilitarlo expresamente.
/** @type {Readonly<{c8Implemented:boolean, requiredFiles:readonly string[]}>} */
const C8_CONTRACT = Object.freeze({ c8Implemented: false, requiredFiles: Object.freeze([
  'scripts/harness/preflight.cjs', 'scripts/harness/lease.cjs', 'scripts/harness/sweep.cjs',
  'test/db/global-setup.cjs', 'test/db/support/describe-db.ts',
]) });
/** @param {string} root @param {{exists: (filename: string) => boolean}} deps
 * @returns {Readonly<{ready: boolean, missing: readonly string[]}>} */
function isC8Ready(root, { exists }) {
  const missing = Object.freeze(C8_CONTRACT.requiredFiles.filter(file => !exists(path.join(root, file))));
  return Object.freeze({ ready: C8_CONTRACT.c8Implemented === true && missing.length === 0, missing });
}
module.exports = Object.freeze({ C8_CONTRACT, isC8Ready });
