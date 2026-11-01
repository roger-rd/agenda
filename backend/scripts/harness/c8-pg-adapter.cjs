'use strict';
const { valid } = require('./c8-names.cjs');
const { TARGET } = require('./c8-target.cjs');
const { createRegistry } = require('./c8-lease-key.cjs');
const { evaluateGlobalDefaultAcl } = require('./c8-gate.cjs');
const L0_KEY = createRegistry().key('harness', 'global-run');
/** @typedef {Record<string,unknown>} Row */
/** Only plain data evidence; accessors/proxies/errors become unknown at boundaries.
 * @param {unknown} input @returns {Row[]|null} */
function rows(input) {
  try {
    if (!Array.isArray(input)) return null;
    const snapshot = [];
    for (const row of input) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      const descriptors = Object.getOwnPropertyDescriptors(row);
      if (Object.values(descriptors).some(d => !Object.hasOwn(d, 'value'))) return null;
      snapshot.push(Object.fromEntries(Object.entries(descriptors).map(([key, d]) => [key, d.value])));
    }
    return snapshot;
  } catch { return null; }
}
/** @param {unknown} input */
function single(input) { const r = rows(input); return r?.length === 1 ? r[0] : null; }
/** @param {unknown} n @returns {n is number} */
function pid(n) { return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 2147483647; }
/** @param {unknown} value */
function count(value) {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$(?![\s\S])/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
/** @param {unknown} input @param {'owner'|'app'} role */
function mapIdentity(input, role) {
  const r = single(input);
  if (!r || !['owner', 'app'].includes(role) || r.database !== TARGET.database || r.current_user !== TARGET[role] ||
    r.session_user !== TARGET[role] || r.read_only !== 'on' || r.recovery !== false || !pid(r.pid)) return null;
  return Object.freeze({ database: TARGET.database, user: TARGET[role], pid: r.pid, readOnly: true, recovery: false });
}
/** @param {unknown} input */
function mapServer(input) {
  const r = single(input); if (!r) return null;
  const version = count(r.version); const max = count(r.max_connections);
  if (version === null || Math.floor(version / 10000) !== 16 || max === null || max < 1 ||
    !['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'idle_session_timeout', 'search_path'].every(k => typeof r[k] === 'string' && r[k] !== '')) return null;
  return Object.freeze({ major: 16, version, maxConnections: max,
    statementTimeout: r.statement_timeout, lockTimeout: r.lock_timeout,
    idleInTransactionTimeout: r.idle_in_transaction_session_timeout, idleSessionTimeout: r.idle_session_timeout, searchPath: r.search_path });
}
// C0 S1: session startup parameters override these role defaults.
// Exact app-only allowlist; no normalization, duplicate entries or other settings.
const APP_ROLE_CONFIG = Object.freeze(['statement_timeout=30s', 'lock_timeout=5s',
  'idle_in_transaction_session_timeout=60s']);
/** @param {unknown} config @param {unknown} role */
function validRoleConfig(config, role) {
  if (config === null) return true;
  if (!Array.isArray(config)) return false;
  if (config.length === 0) return true;
  return role === TARGET.app && new Set(config).size === config.length &&
    Array.from(config).every(entry => typeof entry === 'string' && APP_ROLE_CONFIG.includes(entry));
}
/** @param {unknown} input */
function mapRoleAttrs(input) {
  const r = rows(input);
  if (!r || r.length !== 2 || new Set(r.map(x => x.rolname)).size !== 2) return null;
  for (const x of r) {
    if ((x.rolname !== TARGET.owner && x.rolname !== TARGET.app) || !pid(x.oid) ||
      !['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'].every(k => x[k] === false) ||
      x.rolcanlogin !== true || typeof x.rolconnlimit !== 'number' || !Number.isSafeInteger(x.rolconnlimit) || x.rolconnlimit < -1 ||
      !validRoleConfig(x.rolconfig, x.rolname)) return null;
  }
  if (r[0].oid === r[1].oid) return null;
  return Object.freeze({ evaluable: true, ownerOid: r.find(x => x.rolname === TARGET.owner)?.oid,
    appOid: r.find(x => x.rolname === TARGET.app)?.oid });
}
const EMPTY_FIELDS = Object.freeze(['relations', 'routines', 'types', 'operators', 'collations', 'conversions',
  'opclasses', 'opfamilies', 'text_configs', 'text_dicts', 'text_parsers', 'text_templates', 'defaults']);
/** Best effort only: DROP without CASCADE remains authoritative in C8.6.
 * @param {unknown} input */
function emptyHint(input) { const r = single(input); return !!r && EMPTY_FIELDS.every(k => count(r[k]) === 0); }
/** @param {string} name @param {number} now */
function age(name, now) {
  if (!valid(name) || !Number.isSafeInteger(now)) return NaN;
  const stamp = name.slice(4, 14);
  const time = Date.UTC(2000 + Number(stamp.slice(0, 2)), Number(stamp.slice(2, 4)) - 1,
    Number(stamp.slice(4, 6)), Number(stamp.slice(6, 8)), Number(stamp.slice(8, 10)));
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(2, 16).replace(/[-T:]/g, '') !== stamp || now < time) return NaN;
  return now - time;
}
/** @param {unknown} input @param {number} now
 * @param {Record<string,{lease?:unknown,leaseOwned?:unknown,emptyRows?:unknown}>} [evidence]
 * @returns {import('./c8-gate.cjs').Schema[]|null} */
function mapSchemas(input, now, evidence = {}) {
  const r = rows(input); if (!r || new Set(r.map(x => x.name)).size !== r.length) return null;
  const result = [];
  for (const x of r) {
    if (typeof x.name !== 'string' || typeof x.owner !== 'string' || (x.comment !== null && typeof x.comment !== 'string')) return null;
    const e = Object.hasOwn(evidence, x.name) ? evidence[x.name] : {};
    const lease = e.lease === 'free' || e.lease === 'live' ? e.lease : 'unknown';
    result.push({ name: x.name, owner: x.owner, comment: x.comment === null ? '' : x.comment, ageMs: age(x.name, now),
      lease, leaseOwned: lease !== 'unknown' && e.leaseOwned === true, empty: emptyHint(e.emptyRows) });
  }
  return /** @type {import('./c8-gate.cjs').Schema[]} */ (result);
}
const EXPECTED = Object.freeze({ schema: Object.freeze(['USAGE', 'CREATE']),
  table: Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  column: Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']),
  sequence: Object.freeze(['USAGE', 'SELECT', 'UPDATE']), routine: Object.freeze(['EXECUTE']) });
/** Keep EVERY row, including NULL and duplicates, but reject incomplete/ambiguous coverage.
 * column is residual evidence, never an object-type marker. Original kind drives coverage.
 * @param {unknown} input @param {unknown} coverage @param {unknown} [defaults]
 * @returns {import('./c8-gate.cjs').Privileges} */
function mapPrivileges(input, coverage, defaults = []) {
  const r = rows(input); const c = single(coverage); const d = mapDefaultAclSchema(defaults);
  let complete = !!r && !!c; let evaluable = complete && d !== null;
  /** @type {Map<string,Set<string>>} */ const groups = new Map();
  /** @type {Record<string,Set<unknown>>} */ const oids = { schema: new Set(), table: new Set(), column: new Set(), sequence: new Set(), routine: new Set() };
  const objects = (r ?? []).map(x => {
    const kind = typeof x.kind === 'string' ? x.kind : '';
    const expected = EXPECTED[/** @type {keyof typeof EXPECTED} */ (kind)];
    const good = !!expected && pid(x.oid) && typeof x.privilege === 'string' && expected.includes(x.privilege) &&
      typeof x.effective === 'boolean' && typeof x.is_grantable === 'boolean';
    if (!good) evaluable = false;
    if (!expected || !pid(x.oid) || typeof x.privilege !== 'string' || !expected.includes(x.privilege)) complete = false;
    else {
      const key = `${kind}:${x.oid}`; const set = groups.get(key) ?? new Set();
      if (set.has(x.privilege)) complete = false;
      set.add(x.privilege); groups.set(key, set); oids[kind].add(x.oid);
    }
    return { kind: kind === 'column' ? 'table' : kind === 'routine' ? 'function' : kind,
      evaluable: good, direct: kind !== 'column' && x.effective === true,
      inherited: false, public: false, column: kind === 'column' && x.effective === true };
  });
  for (const [key, set] of groups) {
    const kind = /** @type {keyof typeof EXPECTED} */ (key.split(':')[0]);
    if (set.size !== EXPECTED[kind].length) complete = false;
  }
  if (!c || !pid(c.schema_oid) || oids.schema.size !== 1 || !oids.schema.has(c.schema_oid) ||
    count(c.tables) !== oids.table.size || count(c.sequences) !== oids.sequence.size || count(c.routines) !== oids.routine.size ||
    [...oids.sequence].some(oid => oids.table.has(oid)) || oids.column.size !== oids.table.size || [...oids.table].some(oid => !oids.column.has(oid))) complete = false;
  return { complete, evaluable: evaluable && complete, membership: false, setMembership: false,
    grantable: (r ?? []).some(x => x.is_grantable === true), defaultAcl: d === true, objects };
}
/** Full membership closure uses every edge; SET closure uses only set_option edges.
 * inherit_option is validated, not confused with MEMBER (transitive regardless of INHERIT).
 * @param {unknown} input @param {unknown} memberships @param {number} appOid */
function mapRoles(input, memberships, appOid) {
  const unknown = { evaluable: false, membership: false, setMembership: false };
  const r = rows(input); const edges = rows(memberships);
  if (!r || r.length === 0 || !edges || !pid(appOid) || new Set(r.map(x => x.oid)).size !== r.length) return unknown;
  const known = new Set([appOid, ...r.map(x => x.oid)]);
  if (r.some(x => !pid(x.oid) || x.oid === appOid || typeof x.membership !== 'boolean' || typeof x.set_membership !== 'boolean')) return unknown;
  const seen = new Set();
  for (const e of edges) {
    const key = `${e.member}:${e.roleid}`;
    if (!pid(e.member) || !pid(e.roleid) || e.member === e.roleid || !known.has(e.member) || !known.has(e.roleid) || seen.has(key) ||
      !['inherit_option', 'set_option', 'admin_option'].every(k => typeof e[k] === 'boolean')) return unknown;
    seen.add(key);
  }
  /** @param {boolean} setOnly */
  const closure = setOnly => {
    const reached = new Set([appOid]); let changed = true;
    while (changed) { changed = false; for (const e of edges) {
      if (reached.has(/** @type {number} */ (e.member)) && (!setOnly || e.set_option === true) && !reached.has(/** @type {number} */ (e.roleid))) {
        reached.add(/** @type {number} */ (e.roleid)); changed = true;
      }
    } }
    return reached;
  };
  const member = closure(false); const set = closure(true);
  if (r.some(x => x.membership !== member.has(/** @type {number} */ (x.oid)) || x.set_membership !== set.has(/** @type {number} */ (x.oid)))) return unknown;
  return { evaluable: true, membership: member.size > 1, setMembership: set.size > 1 };
}
/** @param {unknown} input @returns {boolean|null} */
function mapDefaultAclSchema(input) {
  const r = rows(input); if (!r || r.some(x => !pid(x.oid)) || new Set(r.map(x => x.oid)).size !== r.length) return null;
  return r.length > 0;
}
/** @param {unknown} input */
function mapGlobalDefaultAcl(input) {
  const r = rows(input);
  const entries = (r ?? []).map(x => ({ ownerRole: x.owner_role, objectType: x.object_type,
    granteePublic: x.grantee_public, granteeApp: x.grantee_app }));
  const info = { evaluable: r !== null, entries };
  return { ...info, evaluable: evaluateGlobalDefaultAcl(info).code !== 'gate_unknown' };
}
/** NULL application_name makes E4a unknown without destroying E4b role evidence.
 * @param {unknown} input @param {readonly number[]} [ownPids] @param {string} [applicationName] */
function mapSessions(input, ownPids = [], applicationName = 'agenda-c8-validate') {
  const unknown = { otherRolePids: null, runSessions: null };
  const r = rows(input);
  if (!r || ownPids.some(x => !pid(x)) || new Set(ownPids).size !== ownPids.length ||
    new Set(r.map(x => x.pid)).size !== r.length || r.some(x => !pid(x.pid) || x.datname !== TARGET.database || x.backend_type !== 'client backend' ||
      (x.usename !== TARGET.owner && x.usename !== TARGET.app) ||
      !(x.application_name === null || typeof x.application_name === 'string'))) return unknown;
  return { otherRolePids: r.filter(x => !ownPids.includes(/** @type {number} */ (x.pid))).map(x => /** @type {number} */ (x.pid)),
    runSessions: r.some(x => x.application_name === null) ? null : r.filter(x => x.application_name === applicationName && !ownPids.includes(/** @type {number} */ (x.pid))).length };
}
/** @param {unknown} input @param {readonly number[]} [ownPids] @param {boolean|null} [foreignLease] */
function mapBaseline(input, ownPids = [], foreignLease = null) { return { ...mapSessions(input, ownPids), foreignLease }; }
/** @param {unknown} input */
function mapNumbackends(input) { const r = single(input); return r ? count(r.numbackends) : null; }
/** @param {unknown} input @param {number} databaseOid @param {readonly string[]} names @param {readonly number[]} [ownPids] */
function mapRelationLocks(input, databaseOid, names, ownPids = []) {
  const r = rows(input);
  if (!r || !pid(databaseOid) || names.some(n => !valid(n)) || ownPids.some(n => !pid(n)) || r.some(x =>
    !pid(x.pid) || x.database !== databaseOid || !pid(x.relation) || typeof x.granted !== 'boolean' || !names.includes(/** @type {string} */ (x.name)))) return null;
  return r.some(x => !ownPids.includes(/** @type {number} */ (x.pid)));
}
/** @param {unknown} input @param {{databaseOid:number,expectedPid?:number,child?:boolean,ownPid?:number}} options */
function observeL0(input, options) {
  const r = rows(input);
  if (!r || !pid(options.databaseOid) || (options.expectedPid !== undefined && !pid(options.expectedPid)) ||
    (options.child === true && !pid(options.ownPid))) return null;
  if (r.length === 0) return { held: false, pid: 0 };
  if (r.length !== 1) return null;
  const x = r[0];
  if (typeof x.key !== 'string' || !/^[1-9][0-9]*$(?![\s\S])/.test(x.key) || BigInt(x.key) !== BigInt(L0_KEY) ||
    x.locktype !== 'advisory' || x.database !== options.databaseOid || x.objsubid !== 1 || x.granted !== true ||
    x.usename !== TARGET.owner || !pid(x.pid) || (options.expectedPid !== undefined && x.pid !== options.expectedPid) ||
    (options.child === true && x.pid === options.ownPid)) return null;
  return { held: true, pid: x.pid };
}
/** No external message/stack/cause is ever copied. Missing error on negative probe FAILS.
 * @param {unknown} err @param {'probe-42809'|'gate'} expectation */
function classifyPgError(err, expectation) {
  let sqlstate;
  try {
    const descriptor = err && typeof err === 'object' ? Object.getOwnPropertyDescriptor(err, 'code') : undefined;
    if (descriptor && typeof descriptor.value === 'string' && /^[0-9A-Z]{5}$(?![\s\S])/.test(descriptor.value)) sqlstate = descriptor.value;
  } catch { /* unknown */ }
  const expected = expectation === 'probe-42809' && sqlstate === '42809';
  return Object.freeze({ kind: expected ? 'expected' : 'unexpected', code: expected ? 'ok' : 'gate_unknown',
    exitCode: expected ? 0 : 2, ...(sqlstate ? { sqlstate } : {}) });
}
/** C8.1 policies are SYNCHRONOUS. C8.6 needs an explicit evidence snapshot or
 * policy refactor; never hand these promises to inspect()/observe()/roles().
 * @typedef {(id:string,params:unknown[])=>Promise<unknown>} Run */
/** @param {Run} run @param {'owner'|'app'} role */
async function collectIdentity(run, role) {
  return { identity: mapIdentity(await run('identity', []), role), server: mapServer(await run('server', [])),
    roles: mapRoleAttrs(await run('role_attrs', [])) };
}
/** @param {Run} run @param {string} name */
async function collectPrivileges(run, name) {
  return mapPrivileges(await run('effective', [name, TARGET.app]), await run('effective_coverage', [name]), await run('default_acl_schema', [name]));
}
/** @param {Run} run @param {{databaseOid:number,expectedPid?:number,child?:boolean,ownPid?:number}} options */
async function collectL0(run, options) { return observeL0(await run('advisory_holders', [L0_KEY]), options); }
module.exports = Object.freeze({ L0_KEY, EMPTY_FIELDS, EXPECTED, mapIdentity, mapServer, mapRoleAttrs, mapSchemas,
  mapPrivileges, mapRoles, mapDefaultAclSchema, mapGlobalDefaultAcl, mapSessions, mapBaseline,
  mapNumbackends, mapRelationLocks, observeL0, classifyPgError, collectIdentity, collectPrivileges, collectL0 });
