'use strict';
const { TARGET, validate } = require('./c8-target.cjs');
const { MATRIX } = require('./c8-timeouts.cjs');
const { LIMITS } = require('./c8-budget.cjs');
const { getQuery, assertAllowed, SYSTEM } = require('./c8-pg-queries.cjs');
const { mapIdentity, mapRoleAttrs, classifyPgError } = require('./c8-pg-adapter.cjs');
const AUTHORIZATION = 'C8_2B_LOCKS_AUTHORIZED';
const APPLICATION_NAME = 'agenda-c8-validate';
const BUDGETS = Object.freeze({ A: Object.freeze({ owner: 1, app: 1 }), B: Object.freeze({ owner: 1, app: 2 }) });
// Shared across connectors, so creating another connector cannot evade a peak limit.
const active = { A: { owner: 0, app: 0 }, B: { owner: 0, app: 0 } };
/** @typedef {{query:(sql:string,params:unknown[])=>Promise<{rows:unknown}>,connect:()=>Promise<unknown>,
 * end:()=>Promise<unknown>,destroy?:()=>void,processID?:number}} RawClient */
/** @typedef {{Client:new(config:Record<string,unknown>)=>RawClient}} PgModule */
/** Plain frozen errors deliberately have NO message, stack, cause, or driver object.
 * @param {string} code @param {unknown} [err] */
function failure(code, err) {
  const classified = classifyPgError(err, 'gate');
  return Object.freeze({ code, ...(classified.sqlstate ? { sqlstate: classified.sqlstate } : {}) });
}
/** @param {{pgModule?:PgModule,levelB?:{enabled:true,authorization:string}}} [options] */
function createConnector(options = {}) {
  const injected = options.pgModule;
  const levelB = options.levelB?.enabled === true && options.levelB.authorization === AUTHORIZATION;
  /** Credentials are plain own data properties. Level selects an independent A/B reservation.
   * @param {'owner'|'app'} role @param {unknown} credentials */
  async function connect(role, credentials) {
    let level = /** @type {'A'|'B'} */ ('A');
    /** @type {RawClient|undefined} */ let raw;
    let reserved = false; let closed = false;
    const release = () => { if (reserved) { active[level][role]--; reserved = false; } };
    const destroy = async () => {
      if (closed) return;
      closed = true;
      try {
        // Only injected fakes may destroy a transport. Real teardown uses pg.end().
        if (injected && raw?.destroy) raw.destroy();
        else if (raw) await raw.end();
      } catch { /* No driver detail escapes, budget still released. */ }
      finally { release(); }
    };
    try {
      validate(credentials, role);
      const data = /** @type {Record<string,unknown>} */ (credentials);
      const descriptors = Object.getOwnPropertyDescriptors(data);
      if (Object.values(descriptors).some(d => !Object.hasOwn(d, 'value')) ||
        typeof descriptors.password?.value !== 'string' || descriptors.password.value.length === 0) throw failure('credentials_invalid');
      if (descriptors.level && !['A', 'B'].includes(descriptors.level.value)) throw failure('query_disabled');
      level = descriptors.level?.value ?? 'A';
      if (level === 'B' && !levelB) throw failure('query_disabled');
      const owner = active.A.owner + active.B.owner; const app = active.A.app + active.B.app;
      if (active[level][role] >= BUDGETS[level][role] || owner + app >= 5 || owner + app >= LIMITS.preflight ||
        (role === 'owner' && (owner >= 2 || owner >= LIMITS.owner)) || (role === 'app' && app >= 3)) throw failure('budget_exceeded');
      active[level][role]++; reserved = true;
      // The only pg import, lazy and skipped with injection. No process/env/fs access.
      const pg = injected ?? /** @type {PgModule} */ (/** @type {unknown} */ (require('pg')));
      raw = new pg.Client({ host: TARGET.host, port: TARGET.port, database: TARGET.database, user: TARGET[role],
        password: descriptors.password.value, connectionTimeoutMillis: MATRIX.preflightConnection,
        statement_timeout: role === 'app' ? MATRIX.appStatement : MATRIX.ownerStatement,
        lock_timeout: role === 'app' ? MATRIX.appLock : MATRIX.ownerLock,
        idle_in_transaction_session_timeout: role === 'app' ? MATRIX.appIdleInTx : MATRIX.ownerIdleInTx,
        options: '-c default_transaction_read_only=on', application_name: APPLICATION_NAME, ssl: false });
      await raw.connect();
      const client = raw;
      /** @type {Promise<unknown>} */ let tail = Promise.resolve();
      let queries = 0;
      /** @param {string} id @param {unknown[]} [params] */
      function query(id, params = []) {
        // Capture parameters immediately; caller mutations cannot change validated input.
        /** @type {unknown[]} */ let values = []; let invalidParams = false;
        try {
          if (!Array.isArray(params)) throw null;
          values = Array.prototype.map.call(params, (/** @type {unknown} */ p) => Array.isArray(p) ? [...p] : p);
        } catch { invalidParams = true; }
        const next = tail.then(async () => {
          if (closed) throw failure('client_closed');
          if (++queries > (role === 'owner' ? 30 : 10)) { await destroy(); throw failure('budget_exceeded'); }
          let started = false; let result; let caught; let failed = false; let expected = false;
          try {
            if (invalidParams) throw failure('query_failed');
            const q = getQuery(id, { levelB: level === 'B' && levelB });
            assertAllowed(q.sql, values, { levelB: level === 'B' && levelB });
            if (!q.roles.includes(role)) throw failure('query_disabled');
            started = true; await client.query(SYSTEM.begin, []);
            if (id === 'probe_42809') await client.query(SYSTEM.savepoint, []);
            try { result = await client.query(q.sql, values); }
            catch (err) {
              if (id !== 'probe_42809' || classifyPgError(err, 'probe-42809').kind !== 'expected') throw err;
              await client.query(SYSTEM.rollbackProbe, []);
              expected = true;
            }
            if (id === 'probe_42809') await client.query(SYSTEM.releaseProbe, []);
          } catch (err) { caught = err; failed = true; }
          finally {
            if (started) try { await client.query(SYSTEM.rollback, []); }
            catch (err) { caught = err; failed = true; }
          }
          if (failed) { await destroy(); throw failure('query_failed', caught); }
          if (id === 'probe_42809') return Object.freeze(expected ? { expectedSqlstate: '42809' } : { probeFailed: true });
          /** @type {unknown} */ let rows;
          try {
            const descriptor = result && typeof result === 'object' ? Object.getOwnPropertyDescriptor(result, 'rows') : undefined;
            if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw null;
            rows = descriptor.value;
          } catch { await destroy(); throw failure('query_failed'); }
          const identity = id === 'identity' ? mapIdentity(rows, role) : null;
          if ((id === 'identity' && (!identity || identity.pid !== client.processID)) ||
            (id === 'role_attrs' && !mapRoleAttrs(rows))) { await destroy(); throw failure('identity_invalid'); }
          return rows;
        });
        tail = next.catch(() => undefined);
        return next;
      }
      if (!Number.isSafeInteger(client.processID) || /** @type {number} */ (client.processID) <= 0) throw failure('identity_invalid');
      return Object.freeze({ query, pid: /** @type {number} */ (client.processID),
        end: async () => { await tail; if (closed) return; closed = true;
          try { await client.end(); } catch (err) { throw failure('end_failed', err); } finally { release(); } },
        destroy: async () => { await tail; await destroy(); } });
    } catch (err) {
      await destroy();
      // Preserve ONLY our finite, known error codes. Never echo arbitrary driver strings.
      const code = err && typeof err === 'object' ? Object.getOwnPropertyDescriptor(err, 'code')?.value : undefined;
      throw failure(['credentials_invalid', 'query_disabled', 'budget_exceeded', 'identity_invalid', 'query_failed'].includes(code) ? code : 'connect_failed', err);
    }
  }
  return Object.freeze({ connect });
}
module.exports = Object.freeze({ AUTHORIZATION, APPLICATION_NAME, BUDGETS, createConnector });
