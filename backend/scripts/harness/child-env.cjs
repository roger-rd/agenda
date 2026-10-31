'use strict';
const path = require('node:path');
const { CHILD_ENV_KEYS, PGPASSFILE_INERT } = require('./constants.cjs');
const { HarnessError } = require('./harness-error.cjs');
const { hasTokenFormat } = require('./run-token.cjs');
/** @param {unknown} tmpdir @returns {tmpdir is string} */
function validTmpdir(tmpdir) {
  return typeof tmpdir === 'string' && tmpdir.length <= 1024 && !tmpdir.includes('\0') && path.isAbsolute(tmpdir);
}
/** @param {{token: unknown, tmpdir?: unknown}} input @returns {Readonly<Record<string,string>>} */
function buildChildEnv({ token, tmpdir }) {
  if (!hasTokenFormat(token)) throw new HarnessError('H-TOKEN-FORMAT');
  /** @type {Record<string,string>} */
  const env = { NODE_ENV: 'test', AGENDA_DB_TEST_TOKEN: token, PGPASSFILE: PGPASSFILE_INERT, NO_COLOR: '1' };
  if (tmpdir !== undefined) {
    if (!validTmpdir(tmpdir)) throw new HarnessError('H-CHILD-TMPDIR');
    env.TMPDIR = tmpdir;
  }
  return Object.freeze(env);
}
/** @param {unknown} env @returns {void} */
function assertChildEnvShape(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(env))) throw new HarnessError('H-CHILD-ENV');
  const descriptors = Object.getOwnPropertyDescriptors(env);
  if (Reflect.ownKeys(env).some(key => typeof key !== 'string' || !CHILD_ENV_KEYS.includes(key)) ||
      Object.values(descriptors).some(d => !Object.hasOwn(d, 'value'))) throw new HarnessError('H-CHILD-ENV');
  const values = /** @type {Record<string,unknown>} */ (env);
  if (values.NODE_ENV !== 'test' || !hasTokenFormat(values.AGENDA_DB_TEST_TOKEN) ||
      values.PGPASSFILE !== PGPASSFILE_INERT || values.NO_COLOR !== '1' ||
      !['NODE_ENV', 'AGENDA_DB_TEST_TOKEN', 'PGPASSFILE', 'NO_COLOR'].every(key => Object.hasOwn(env, key)) ||
      (Object.hasOwn(env, 'TMPDIR') && !validTmpdir(values.TMPDIR))) throw new HarnessError('H-CHILD-ENV');
}
module.exports = Object.freeze({ buildChildEnv, assertChildEnvShape });
