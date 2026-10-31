'use strict';
const realFs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { ENV_FILES, ENV_LIMITS, KNOWN_ENV_KEYS } = require('./constants.cjs');
const { HarnessError } = require('./harness-error.cjs');
/** @typedef {'app'|'owner'} Role */
/** @typedef {{host:string, port:number, database:string, user:string, poolMax:number}} Connection */
/** @typedef {{isFile:()=>boolean, nlink:number, uid:number, mode:number, size:number}} Stat */
/** @typedef {{constants: {O_RDONLY:number,O_NOFOLLOW:number,O_NONBLOCK:number},
 * openSync:(filename:string, flags:number)=>number, fstatSync:(fd:number)=>Stat,
 * readSync:(fd:number, buffer:Buffer, offset:number, length:number, position:number|null)=>number,
 * closeSync:(fd:number)=>void}} ReadFs */
/** @typedef {{root:string, platform?:string, fs?:ReadFs, getuid?:()=>number}} Dependencies */

/** Gramática propia; parseEnv es una comprobación adicional, nunca un reparador.
 * Se comparan todas las claves y valores, pero solo se devuelven claves conocidas.
 * @param {string} text @returns {Readonly<Record<string,string>>} */
function parseStrictEnv(text) {
  if (typeof text !== 'string') throw new HarnessError('H-ENV-PARSE');
  const normalized = text.replace(/\r\n/g, '\n');
  if (/[^\n\P{Cc}]/u.test(normalized)) throw new HarnessError('H-ENV-PARSE');
  const lines = normalized.split('\n');
  if (lines.length > ENV_LIMITS.maxLines) throw new HarnessError('H-ENV-SIZE');
  /** @type {Record<string,string>} */
  const all = Object.create(null);
  for (const line of lines) {
    if (line === '' || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    const key = line.slice(0, equals);
    const value = line.slice(equals + 1);
    if (equals < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$(?![\s\S])/.test(key) ||
        /[\s\p{Cc}]/u.test(value) || /^["'`]/.test(value)) throw new HarnessError('H-ENV-PARSE');
    if (KNOWN_ENV_KEYS.includes(key) && Object.hasOwn(all, key)) throw new HarnessError('H-ENV-DUP', { key });
    all[key] = value;
  }
  let parsed;
  try { parsed = parseEnv(normalized); } catch { throw new HarnessError('H-ENV-PARSE'); }
  const keys = Object.keys(all).sort();
  const actual = Object.keys(parsed).sort();
  if (keys.length !== actual.length || keys.some((key, i) => key !== actual[i] || all[key] !== parsed[key])) {
    throw new HarnessError('H-ENV-PARSE');
  }
  /** @type {Record<string,string>} */
  const known = {};
  for (const key of KNOWN_ENV_KEYS) if (Object.hasOwn(all, key)) known[key] = all[key];
  return Object.freeze(known);
}

/** @param {Record<string,unknown>} input @param {Role} role @returns {Readonly<Connection>} */
function validateStructure(input, role) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(ENV_FILES, role)) throw new HarnessError('H-ARGS');
  /** @param {string} key @returns {never} */
  const invalid = key => { throw new HarnessError(input[key] === undefined ? 'H-ENV-KEY' : 'H-ENV-VALUE', { key }); };
  /** @param {string} key @param {number} fallback @param {number} max @returns {number} */
  const integer = (key, fallback, max) => {
    const raw = input[key];
    const value = raw === undefined ? fallback : typeof raw === 'string' && /^[0-9]+$/.test(raw) && raw.trim() === raw ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) return invalid(key);
    return value;
  };
  const host = input.DATABASE_HOST === undefined ? '127.0.0.1' : input.DATABASE_HOST;
  // Para nodeEnv=test, la intersección con hostValidator son exactamente estos tres hosts.
  // Todos cumplen hostValidator; no hace falta importar node:net para aceptar otros hosts.
  if (typeof host !== 'string' || !['127.0.0.1', '::1', 'localhost'].includes(host)) return invalid('DATABASE_HOST');
  const port = integer('DATABASE_PORT', 5433, 65535);
  const database = input.DATABASE_NAME;
  if (typeof database !== 'string' || !/^[a-z][a-z0-9_]{0,62}$(?![\s\S])/.test(database) || !database.endsWith('_test')) return invalid('DATABASE_NAME');
  const user = input.DATABASE_USER;
  if (typeof user !== 'string' || !/^[a-z][a-z0-9_]{0,62}$(?![\s\S])/.test(user) || !user.startsWith('agenda_test_') || !user.endsWith(`_${role}`)) return invalid('DATABASE_USER');
  const password = input.DATABASE_PASSWORD;
  if (typeof password !== 'string' || password.length < 16 || password.length > 128 || /[\s\p{Cc}]/u.test(password)) return invalid('DATABASE_PASSWORD');
  const poolMax = integer('DATABASE_POOL_MAX', 5, 20);
  return Object.freeze({ host, port, database, user, poolMax });
}

/** @param {Role} role @param {Dependencies} deps
 * @returns {Readonly<{connection:Readonly<Connection>, secrets:readonly string[]}>} */
function readEnvFile(role, { root, platform = process.platform, fs = realFs, getuid = process.getuid }) {
  if (platform !== 'darwin' && platform !== 'linux') throw new HarnessError('H-PLATFORM');
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0') || !Object.hasOwn(ENV_FILES, role)) throw new HarnessError('H-ARGS');
  if (typeof getuid !== 'function') throw new HarnessError('H-PLATFORM');
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if (![O_RDONLY, O_NOFOLLOW, O_NONBLOCK].every(Number.isInteger) || !O_NOFOLLOW || !O_NONBLOCK) throw new HarnessError('H-PLATFORM');
  /** @type {number | undefined} */
  let fd;
  /** @type {InstanceType<typeof HarnessError> | undefined} */
  let failure;
  /** @type {Readonly<{connection:Readonly<Connection>, secrets:readonly string[]}> | undefined} */
  let result;
  try {
    try { fd = fs.openSync(path.join(root, ENV_FILES[role]), O_RDONLY | O_NOFOLLOW | O_NONBLOCK); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      throw new HarnessError(code === 'ELOOP' ? 'H-ENV-LINK' : 'H-ENV-READ');
    }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new HarnessError('H-ENV-TYPE');
    if (stat.nlink !== 1) throw new HarnessError('H-ENV-LINK');
    if (stat.uid !== getuid()) throw new HarnessError('H-ENV-OWNER');
    const mode = stat.mode & 0o7777;
    if (mode !== 0o600 && mode !== 0o400) throw new HarnessError('H-ENV-PERM', { mode: mode.toString(8) });
    if (stat.size > ENV_LIMITS.maxBytes) throw new HarnessError('H-ENV-SIZE');
    // Reserva acotada; leer hasta EOF o límite+1 detecta crecimiento posterior a fstat.
    const buffer = Buffer.alloc(ENV_LIMITS.maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(fd, buffer, bytes, Math.min(Math.max(stat.size + 1, 1), buffer.length - bytes), null);
      if (!Number.isInteger(count) || count < 0 || count > buffer.length - bytes) throw new HarnessError('H-ENV-READ');
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > ENV_LIMITS.maxBytes) throw new HarnessError('H-ENV-SIZE');
    let text;
    try {
      // ignoreBOM conserva U+FEFF para rechazarlo explícitamente.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes));
    } catch { throw new HarnessError('H-ENV-ENCODING'); }
    if (text.includes('\0') || text.includes('\uFEFF')) throw new HarnessError('H-ENV-ENCODING');
    const known = parseStrictEnv(text);
    const connection = validateStructure(known, role);
    const password = known.DATABASE_PASSWORD;
    if (typeof password !== 'string') throw new HarnessError('H-ENV-KEY', { key: 'DATABASE_PASSWORD' });
    result = Object.freeze({ connection, secrets: Object.freeze([password]) });
  } catch (error) {
    failure = error instanceof HarnessError ? error : new HarnessError('H-ENV-READ');
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { failure = failure ?? new HarnessError('H-ENV-READ'); }
    }
  }
  if (failure) throw failure;
  if (!result) throw new HarnessError('H-ENV-READ');
  return result;
}

/** @param {Dependencies} deps
 * @returns {Readonly<{app:Readonly<Connection>, owner:Readonly<Connection>, secrets:readonly string[]}>} */
function readEnvFiles(deps) {
  const app = readEnvFile('app', deps);
  const owner = readEnvFile('owner', deps);
  if (app.connection.host !== owner.connection.host || app.connection.port !== owner.connection.port || app.connection.database !== owner.connection.database) throw new HarnessError('H-ENV-MISMATCH');
  return Object.freeze({ app: app.connection, owner: owner.connection, secrets: Object.freeze([app.secrets[0], owner.secrets[0]]) });
}
module.exports = Object.freeze({ readEnvFiles, readEnvFile, parseStrictEnv, validateStructure });
