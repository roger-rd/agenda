'use strict';
const { createHash } = require('node:crypto');
const { valid } = require('./c8-names.cjs');
const TAGS = Object.freeze({ lease: 1, 'test-lock': 2, harness: 3 });
/** @typedef {(preimage:string)=>Uint8Array} Hash */
/** @param {string} preimage */
function sha256(preimage) { return createHash('sha256').update(preimage, 'utf8').digest(); }
/** Registro por run obligatorio para detectar colisiones intra-dominio. Una colisión
 * envenena irreversiblemente el registro; nunca se elige otra clave ni se reintenta.
 * @param {Hash} [hash] */
function createRegistry(hash = sha256) {
  /** @type {Map<string,string>} */
  const seen = new Map(); let failed = false;
  /** @param {string} purpose @param {string} name @param {string} [subkey] */
  function key(purpose, name, subkey) {
    if (failed) throw new Error('key_collision');
    if (!Object.hasOwn(TAGS, purpose) || (purpose === 'harness' ? name !== 'global-run' : !valid(name)) ||
      (purpose === 'test-lock' ? typeof subkey !== 'string' || !/^[a-z0-9_-]{1,32}$(?![\s\S])/.test(subkey) : subkey !== undefined)) throw new Error('key_invalid');
    const preimage = `agenda-test/v1/${purpose}/${name}${subkey === undefined ? '' : `/${subkey}`}`;
    const bytes = hash(preimage);
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('hash_invalid');
    const u = Buffer.from(bytes).readBigUInt64BE(0);
    const tag = TAGS[/** @type {keyof typeof TAGS} */ (purpose)];
    const result = BigInt.asIntN(64, (u & 0x0FFFFFFFFFFFFFFFn) | (BigInt(tag) << 60n)).toString();
    if (seen.has(result) && seen.get(result) !== preimage) { failed = true; throw new Error('key_collision'); }
    seen.set(result, preimage); return result;
  }
  return Object.freeze({ key });
}
module.exports = Object.freeze({ TAGS, createRegistry });
