'use strict';
const { TIMINGS } = require('./constants.cjs');
const { HarnessError } = require('./harness-error.cjs');
/** @typedef {{now: () => number}} Clock Reloj en milisegundos desde epoch. */
/** @param {unknown} token @returns {token is string} */
function hasTokenFormat(token) {
  return typeof token === 'string' && /^[0-9a-f]{32}\.[0-9]{10,11}$(?![\s\S])/.test(token);
}
/** @param {Clock & {randomBytes: (size: number) => Uint8Array}} deps @returns {string} */
function mintToken({ now, randomBytes }) {
  const bytes = randomBytes(16);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new HarnessError('H-TOKEN-FORMAT');
  const token = `${Buffer.from(bytes).toString('hex')}.${Math.floor(now() / 1000)}`;
  if (!hasTokenFormat(token)) throw new HarnessError('H-TOKEN-FORMAT');
  return token;
}
/** @param {unknown} token @param {Clock} deps
 * @returns {Readonly<{ok:true, runId:string, issuedAt:number} | {ok:false, code:'H-TOKEN-FORMAT'|'H-TOKEN-EXPIRED'|'H-TOKEN-FUTURE'}>} */
function verifyToken(token, { now }) {
  if (!hasTokenFormat(token)) return Object.freeze({ ok: false, code: 'H-TOKEN-FORMAT' });
  const [runId, epoch] = token.split('.');
  const issuedAt = Number(epoch);
  const seconds = Math.floor(now() / 1000);
  if (!Number.isSafeInteger(seconds)) return Object.freeze({ ok: false, code: 'H-TOKEN-FORMAT' });
  if (issuedAt > seconds + TIMINGS.tokenFutureSkewSeconds) return Object.freeze({ ok: false, code: 'H-TOKEN-FUTURE' });
  if (seconds - issuedAt > TIMINGS.tokenTtlSeconds) return Object.freeze({ ok: false, code: 'H-TOKEN-EXPIRED' });
  return Object.freeze({ ok: true, runId, issuedAt });
}
module.exports = Object.freeze({ mintToken, verifyToken, hasTokenFormat });
