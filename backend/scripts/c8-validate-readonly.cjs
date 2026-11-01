'use strict';
const { types: { isProxy } } = require('node:util');
// Manual only. Rejections do not load providers or read environment files.
const AUTHORIZATION = 'C8_2B_EXPLICIT_AUTHORIZATION';
const LOCK_AUTHORIZATION = 'C8_2B_LOCKS_AUTHORIZED';
const REAL_AUTHORIZATION = 'C8_2B_FIRST_REAL_RUN';
// Exit contract: 0 success; 3 identity unknown/contradicted; 2 authorization,
// environment/target, transport/query, deadline/budget and policy/security findings.
const EXIT_CODES = Object.freeze({ ok: 0, stage_not_authorized: 2, environment_invalid: 2,
  target_invalid: 2, connect_failed: 2, query_failed: 2, time_exceeded: 2, budget_exceeded: 2,
  capacity_low: 2, roles_invalid: 2, gate_unknown: 2, gate_residual: 2, gate_default_acl: 2,
  sessions_other: 2, sessions_unknown: 2, probe_failed: 2, validation_failed: 2, close_failed: 2,
  identity_unknown: 3, identity_contradicted: 3 });
const STEP_IDS = Object.freeze(['identity', 'server', 'identity_evidence', 'role_attrs', 'numbackends',
  'role_membership', 'auth_members', 'default_acl_global', 'schemas', 'effective', 'effective_coverage',
  'default_acl_schema', 'sessions', 'key_roundtrip', 'timeout_probe', 'probe_42809',
  'database', 'advisory_try_lock', 'advisory_holders', 'advisory_unlock']);
/** @typedef {{query:(id:string,params?:unknown[])=>Promise<unknown>,end:()=>Promise<unknown>,pid:number}} Client */
/** @typedef {{connector?:{connect:(role:'owner'|'app',credentials:unknown)=>Promise<Client>},
 * readEnvFiles?:()=>Promise<{owner:Record<string,unknown>,app:Record<string,unknown>}>,
 * now?:()=>number,stdout?:(line:string)=>void,containerStartEpoch?:number}} Dependencies */
/** Own plain data only; accessors never execute. @param {unknown} input @returns {Record<string,unknown>} */
function data(input) {
  try {
    if (!input || typeof input !== 'object' || isProxy(input) || Array.isArray(input)) return {};
    const d = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(d).some(key => !Object.hasOwn(Reflect.get(d, key), 'value'))) return {};
    return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.value]));
  } catch { return {}; }
}
/** Snapshot arrays through own data descriptors: no proxy traps, index getters,
 * inherited elements or overridden iteration methods. Unknown means no steps.
 * @param {unknown} input @returns {unknown[]} */
function stepData(input) {
  if (!input || typeof input !== 'object' || isProxy(input) || !Array.isArray(input)) return [];
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some(key => !Object.hasOwn(Reflect.get(descriptors, key), 'value'))) return [];
  const result = [];
  for (let i = 0; i < input.length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return [];
    result.push(descriptor.value);
  }
  return result;
}
/** @param {unknown} value @returns {value is number} */
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
/** @param {unknown} value @returns {value is number} */
function count(value) { return finite(value) && Number.isSafeInteger(value) && value >= 0; }
/** @param {unknown} value */
function utc(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$(?![\s\S])/.test(value)) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z')) ? millis / 1000 : undefined;
}
/** Closed projection: unknown keys, raw rows, SQL, driver errors and names never pass.
 * Invalid status/code pairs collapse to validation_failed. @param {unknown} input */
function sanitizeSummary(input) {
  const x = data(input); const code = typeof x.code === 'string' && Object.hasOwn(EXIT_CODES, x.code) ? x.code : 'validation_failed';
  const exitCode = EXIT_CODES[/** @type {keyof typeof EXIT_CODES} */ (code)];
  const status = code === 'ok' ? 'ok' : code === 'stage_not_authorized' ? 'disabled' : 'failed';
  /** @type {Record<string,unknown>} */
  const out = { status, code, exitCode, level: 'A', checks: count(x.checks) ? x.checks : 0,
    steps: stepData(x.steps).flatMap(step => {
      const s = data(step); return typeof s.id === 'string' && STEP_IDS.includes(s.id) && typeof s.ok === 'boolean' ? [{ id: s.id, ok: s.ok }] : [];
    }) };
  const i = data(x.identity);
  if (count(i.major) && count(i.minor) && typeof i.addrClass === 'string' &&
    ['private', 'loopback', 'linklocal', 'null', 'public', 'invalid'].includes(i.addrClass) && utc(i.postmasterStartUtc) !== undefined &&
    finite(i.uptimeSeconds) && (i.containerDeltaSeconds === null || finite(i.containerDeltaSeconds))) {
    out.identity = { major: i.major, minor: i.minor, addrClass: i.addrClass, postmasterStartUtc: i.postmasterStartUtc,
      uptimeSeconds: i.uptimeSeconds, containerDeltaSeconds: i.containerDeltaSeconds };
  }
  /** @type {Record<string,unknown>} */ const params = {};
  const p = data(x.params);
  for (const role of ['owner', 'app']) {
    const values = data(p[role]);
    if (['statement', 'lock', 'idleInTx'].every(k => typeof values[k] === 'string' && /^[0-9]+(ms|s|min)$(?![\s\S])/.test(values[k]))) {
      params[role] = { statement: values.statement, lock: values.lock, idleInTx: values.idleInTx };
    }
  }
  out.params = params;
  const c = data(x.counts);
  /** @type {Record<string,number>} */ const counts = {};
  for (const key of ['schemasTotal', 'schemasRecognized', 'sessionsOther', 'numbackends', 'maxConnections', 'connectionsOpened', 'connectionsClosed']) {
    if (count(c[key])) counts[key] = c[key];
  }
  out.counts = counts;
  return out;
}
/** Lazy thunks: constructing these providers performs no fs access or pg load.
 * Secrets remain inside the reader; never return the secrets list to summaries. */
function defaultProviders() {
  return Object.freeze({
    connector: () => require('./harness/c8-pg-connect.cjs').createConnector(),
    readEnvFiles: async () => {
      const { readEnvFiles } = require('./harness/env-files.cjs');
      const result = readEnvFiles({ root: require('node:path').resolve(__dirname, '..'), fs: require('node:fs'), getuid: process.getuid });
      /** @param {'owner'|'app'} role @param {number} index */
      const credentials = (role, index) => {
        const { host, port, database, user } = result[role];
        return { host, port, database, user, password: result.secrets[index], major: 16 };
      };
      return { owner: credentials('owner', 1), app: credentials('app', 0) };
    },
  });
}
/** @param {string[]} argv @param {Dependencies} [deps] */
async function main(argv, deps = {}) {
  const output = deps.stdout ?? (line => process.stdout.write(line));
  /** @type {{id:string,ok:boolean}[]} */ const steps = [];
  /** @type {Record<string,number>} */ const counts = { connectionsOpened: 0, connectionsClosed: 0 };
  /** @type {Record<string,unknown>} */ const params = {};
  /** @type {unknown} */ let identity; let checks = 0;
  /** @param {string} code */
  const finish = code => {
    const summary = sanitizeSummary({ code, checks, steps, identity, params, counts });
    output(`AGENDA_C8_VALIDATE ${JSON.stringify(summary)}\n`);
    return /** @type {number} */ (summary.exitCode);
  };
  const allowed = ['--real', `--confirm=${AUTHORIZATION}`, '--level-b', `--confirm-b=${LOCK_AUTHORIZATION}`, `--confirm-real=${REAL_AUTHORIZATION}`];
  if (!Array.isArray(argv) || argv.some(x => typeof x !== 'string') ||
    new Set(argv.map(x => x.split('=')[0])).size !== argv.length ||
    argv.some(x => !allowed.includes(x) && !(x.startsWith('--container-start=') && utc(x.slice('--container-start='.length)) !== undefined))) return finish('stage_not_authorized');
  const hasB = argv.includes('--level-b'); const real = !deps.connector || !deps.readEnvFiles;
  if (!argv.includes('--real') || !argv.includes(`--confirm=${AUTHORIZATION}`) ||
    hasB !== argv.includes(`--confirm-b=${LOCK_AUTHORIZATION}`) ||
    (real && (!argv.includes(`--confirm-real=${REAL_AUTHORIZATION}`) || hasB))) return finish('stage_not_authorized');
  const argumentEpoch = argv.find(x => x.startsWith('--container-start='));
  const containerStartEpoch = argumentEpoch ? utc(argumentEpoch.slice('--container-start='.length)) : deps.containerStartEpoch;
  if ((deps.containerStartEpoch !== undefined && !finite(deps.containerStartEpoch)) ||
    (argumentEpoch && deps.containerStartEpoch !== undefined && containerStartEpoch !== deps.containerStartEpoch)) return finish('stage_not_authorized');
  const providers = real ? defaultProviders() : undefined;
  const connector = deps.connector ?? /** @type {NonNullable<typeof providers>} */ (providers).connector();
  const readEnvFiles = deps.readEnvFiles ?? /** @type {NonNullable<typeof providers>} */ (providers).readEnvFiles;
  const { mapIdentity, mapServer, mapRoleAttrs, mapIdentityEvidence, evaluateIdentityEvidence, mapGlobalDefaultAcl, mapSchemas, mapRoles,
    mapPrivileges, mapSessions, mapNumbackends, L0_KEY, observeL0 } = require('./harness/c8-pg-adapter.cjs');
  const { evaluate, evaluateGlobalDefaultAcl, recognized } = require('./harness/c8-gate.cjs');
  const { TARGET, validate } = require('./harness/c8-target.cjs');
  /** @type {Client[]} */ const clients = [];
  let code = 'validation_failed';
  const now = deps.now ?? Date.now; let start = 0;
  /** @param {string} reason @returns {never} */
  const abort = reason => { code = reason; throw null; };
  const deadline = () => {
    const time = now();
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(time) || time < start || time - start >= 30000) abort('time_exceeded');
  };
  /** @param {boolean} pass @param {string} [reason] */
  const check = (pass, reason = 'validation_failed') => { deadline(); if (!pass) abort(reason); checks++; };
  /** Bound every await, including cleanup; no retries or socket destruction.
   * @template T @param {()=>Promise<T>} work @param {boolean} [cleanup] @returns {Promise<T>} */
  const bounded = async (work, cleanup = false) => {
    if (!cleanup) deadline();
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer; const remaining = Math.max(1, 30000 - (now() - start));
    try {
      return await Promise.race([work(), new Promise(/** @param {(value:T)=>void} _resolve */ (_resolve, reject) => { timer = setTimeout(() => { code = 'time_exceeded'; reject(null); }, remaining); })]);
    } finally { clearTimeout(timer); }
  };
  /** @param {'owner'|'app'} role @param {Record<string,unknown>} credentials */
  const connect = async (role, credentials) => {
    let expired = false;
    try {
      const client = await bounded(async () => {
        const c = await connector.connect(role, credentials);
        if (expired) { await c.end(); throw null; }
        return c;
      });
      clients.push(client); counts.connectionsOpened++; deadline();
      let queries = 0;
      return { pid: client.pid, end: client.end,
        /** @param {string} id @param {unknown[]} [values] */
        query: async (id, values = []) => {
          deadline(); if (++queries > (role === 'owner' ? 30 : 10)) abort('budget_exceeded');
          const step = { id, ok: false }; steps.push(step);
          try { const result = await bounded(() => client.query(id, values)); deadline(); step.ok = true; return result; }
          catch (err) {
            if (code === 'time_exceeded' || code === 'budget_exceeded') throw null;
            const e = data(err);
            abort(e.code === 'identity_invalid' ? 'identity_unknown' : e.code === 'budget_exceeded' ? 'budget_exceeded' : 'query_failed');
          }
        } };
    } catch (err) {
      expired = true;
      if (code === 'time_exceeded') throw null;
      const e = data(err); abort(e.code === 'identity_invalid' ? 'identity_unknown' : e.code === 'budget_exceeded' ? 'budget_exceeded' : 'connect_failed');
    }
  };
  try {
    start = now(); deadline();
    code = 'environment_invalid'; const credentials = await bounded(readEnvFiles);
    code = 'target_invalid'; validate(credentials.owner, 'owner'); validate(credentials.app, 'app');
    code = 'validation_failed';
    const owner = await connect('owner', { ...credentials.owner, level: 'A' });
    /** @param {Client} client @param {'owner'|'app'} role */
    const collect = async (client, role) => {
      const id = mapIdentity(await client.query('identity'), role); check(id !== null && id.pid === client.pid, 'identity_unknown');
      const server = mapServer(await client.query('server')); check(server !== null, 'identity_unknown');
      if (!server) return abort('identity_unknown');
      const values = { statement: server.statementTimeout, lock: server.lockTimeout, idleInTx: server.idleInTransactionTimeout };
      check(Object.values(values).every(v => typeof v === 'string' && /^[0-9]+(ms|s|min)$(?![\s\S])/.test(v)), 'identity_unknown'); params[role] = values;
      if (role === 'owner') {
        counts.maxConnections = server.maxConnections;
        const evidence = mapIdentityEvidence(await client.query('identity_evidence'));
        const result = evaluateIdentityEvidence(evidence, containerStartEpoch);
        if (evidence) identity = { ...evidence, containerDeltaSeconds: containerStartEpoch === undefined ? null : evidence.postmasterStartEpoch - containerStartEpoch };
        check(result.ok, result.code);
      }
      const attrs = mapRoleAttrs(await client.query('role_attrs')); check(attrs !== null, 'identity_unknown'); return attrs;
    };
    const attrs = await collect(owner, 'owner');
    const numbackends = mapNumbackends(await owner.query('numbackends'));
    if (numbackends !== null) counts.numbackends = numbackends;
    check(numbackends !== null && counts.maxConnections - numbackends >= 10, 'capacity_low');
    const app = await connect('app', { ...credentials.app, level: 'A' }); await collect(app, 'app');
    const roles = mapRoles(await owner.query('role_membership', [TARGET.app]), await owner.query('auth_members'), /** @type {number} */ (attrs?.appOid));
    check(roles.evaluable && !roles.membership && !roles.setMembership, 'roles_invalid');
    const global = evaluateGlobalDefaultAcl(mapGlobalDefaultAcl(await owner.query('default_acl_global'))); check(global.ok, global.code);
    const schemas = mapSchemas(await owner.query('schemas'), now()); check(schemas !== null, 'gate_unknown');
    counts.schemasTotal = (schemas ?? []).length; counts.schemasRecognized = (schemas ?? []).filter(recognized).length;
    for (const schema of (schemas ?? []).filter(recognized)) {
      const p = mapPrivileges(await owner.query('effective', [schema.name, TARGET.app]),
        await owner.query('effective_coverage', [schema.name]), await owner.query('default_acl_schema', [schema.name]));
      const gate = evaluate([schema], () => p, 'P6b', roles); check(gate.ok, gate.code);
    }
    for (const id of ['effective', 'effective_coverage']) {
      const probe = 'uow_0000000000_probe0_0';
      const result = await owner.query(id, id === 'effective' ? [probe, TARGET.app] : [probe]);
      check(Array.isArray(result) && result.length === 0, 'probe_failed');
    }
    const sessions = mapSessions(await owner.query('sessions'), clients.map(c => c.pid));
    check(sessions.otherRolePids !== null && sessions.runSessions !== null, 'sessions_unknown');
    counts.sessionsOther = sessions.otherRolePids?.length ?? 0; check(counts.sessionsOther === 0, 'sessions_other');
    const round = await owner.query('key_roundtrip', [L0_KEY]);
    const row = Array.isArray(round) && round.length === 1 ? data(round[0]) : {};
    check(row.key === L0_KEY && row.reconstructed === L0_KEY &&
      row.classid === (BigInt(L0_KEY) >> 32n).toString() && row.objid === (BigInt(L0_KEY) & 4294967295n).toString());
    const timeout = await app.query('timeout_probe', [0.001]); check(Array.isArray(timeout), 'probe_failed');
    const probe = data(await app.query('probe_42809', [TARGET.app])); check(probe.expectedSqlstate === '42809', 'probe_failed');
    if (hasB) {
      const holder = await connect('owner', { ...credentials.owner, level: 'B' });
      const observer = await connect('app', { ...credentials.app, level: 'B' });
      const contender = await connect('app', { ...credentials.app, level: 'B' });
      const db = await owner.query('database', [TARGET.app]);
      check(Array.isArray(db) && db.length === 1 && Number.isSafeInteger(db[0].oid));
      const databaseOid = /** @type {{oid:number}[]} */ (db)[0].oid;
      const acquired = await holder.query('advisory_try_lock', [L0_KEY]);
      check(Array.isArray(acquired) && acquired.length === 1 && acquired[0].acquired === true);
      check(observeL0(await observer.query('advisory_holders', [L0_KEY]), { databaseOid, expectedPid: holder.pid })?.held === true);
      const collision = await contender.query('advisory_try_lock', [L0_KEY]);
      check(Array.isArray(collision) && collision.length === 1 && collision[0].acquired === false);
      const released = await holder.query('advisory_unlock', [L0_KEY]);
      check(Array.isArray(released) && released.length === 1 && released[0].unlocked === true);
    }
    deadline(); code = 'ok';
  } catch { /* Fixed codes only. */ }
  finally {
    for (const client of [...clients].reverse()) {
      try { await bounded(() => client.end(), true); counts.connectionsClosed++; }
      catch { if (code !== 'time_exceeded') code = 'close_failed'; }
    }
    try { deadline(); } catch { code = 'time_exceeded'; }
  }
  return finish(code);
}
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
module.exports = Object.freeze({ AUTHORIZATION, LOCK_AUTHORIZATION, REAL_AUTHORIZATION, EXIT_CODES, main, defaultProviders, sanitizeSummary });
