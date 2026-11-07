'use strict';
const { types: { isProxy } } = require('node:util');
/**
 * Manual, read-only validation tool for the 22 closed evidence queries (S2-bis/A3). One pg client, one
 * REPEATABLE READ READ ONLY transaction, a fixed 27-query plan, stop at the first failure, no retry, no
 * SAVEPOINT and no COMMIT. Results stay in memory; only a closed summary is printed. Nothing here
 * authenticates evidence: provenance stays unauthenticated, nothing is demonstrated, nothing is eligible and
 * serverValidated stays false. Harness modules, pg and the env reader load lazily, after authorization.
 */
const AUTHORIZATION = 'C8_EVIDENCE_VALIDATE_AUTHORIZED';
const REAL_AUTHORIZATION = 'C8_EVIDENCE_FIRST_REAL_RUN';
const SUMMARY_PREFIX = 'AGENDA_C8_EVIDENCE ';
const APPLICATION_NAME = 'agenda-c8-evidence';
const BEGIN_SQL = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const ROLLBACK_SQL = 'ROLLBACK';
/** Approved limits. Closed: a drift in the query catalog changes `rows` and is refused at load of the catalog. */
const BUDGET = Object.freeze({
  queries: 27, control: 2, statements: 29, rows: 13209, effectiveRows: 2000, authMembersRows: 600, memoryBytes: 8 * 1024 * 1024,
  connectMs: 5000, connectOuterMs: 5500, statementMs: 5000, statementOuterMs: 6000, lockMs: 2000, idleInTxMs: 15000,
  executionMs: 60000, rollbackMs: 3000, endMs: 3000, closeMs: 8000, hardExitMs: 75000,
});
/** Rows allowed for the preflight queries (the evidence ones are capped by their own LIMIT). */
const PREFLIGHT_ROWS = Object.freeze({ effective_coverage: 1, role_attrs: 2, auth_members: 600, database: 1, effective: 2000 });
/** @typedef {{id:string, source:'evidence'|'preflight', gate:null|'context'|'schema'|'coverage'|'privileges'}} Step */
/** @param {string} id @param {'evidence'|'preflight'} source @param {Step['gate']} [gate] @returns {Readonly<Step>} */
const step = (id, source, gate = null) => Object.freeze({ id, source, gate });
const PLAN = Object.freeze([
  step('ev_context', 'evidence', 'context'), step('ev_namespace', 'evidence', 'schema'), step('effective_coverage', 'preflight', 'coverage'),
  step('role_attrs', 'preflight'), step('auth_members', 'preflight'), step('database', 'preflight'),
  step('ev_role_membership', 'evidence'), step('ev_default_acl_schema', 'evidence'), step('ev_default_acl_global', 'evidence'),
  step('effective', 'preflight', 'privileges'),
  ...['ev_relations', 'ev_routines', 'ev_types', 'ev_namespace_catalog_counts', 'ev_companions', 'ev_closure', 'ev_external_dependents',
    'ev_extension_members', 'ev_event_triggers', 'ev_outside_census', 'ev_sessions', 'ev_target_relation_locks', 'ev_advisory_holders',
    'ev_prepared_xacts', 'ev_outbound_references', 'ev_companion_items', 'ev_internal_edges'].map(id => step(id, 'evidence')),
]);
/** SQL text pinned independently of the catalogs: any edit of a query forces a new review of this tool. */
const PINNED = Object.freeze({
  ev_context: '1e75233fc91705188f7a38893ad432c65c04ddf2f8a81bec3f183009962fbc6a',
  ev_namespace: '10b1ad773b716e94ce8eed6357b0acbea33b5a0e176eb9ef5f2c18658a3e8db7',
  ev_relations: 'c7030dd955267ff7bc25989461991a87250696582f0454fca61e750337d392e7',
  ev_routines: 'df1496cb040d4169a4d168cf4a5b51b38a32a89d5d23f92d3989ab7304195716',
  ev_types: '4a8f460d23eb16be0e9495259962b54f73db0b5dd27adf3f7ab439d2b8d48de3',
  ev_namespace_catalog_counts: 'dde8d36c90e27dc3ee4f459a6bdd78e993160ebb6fbfefbc2509665e55803014',
  ev_companions: '75c67807a5de6b6042de7ec46c3612fd52badf82e2542731693562df0f4e2612',
  ev_closure: 'fea30caa2dfa087d4ec07761d324cc1e5c8498a0697e2338a06ec82ca56ab4c9',
  ev_external_dependents: '907d266d9a95a753e5e878f0c9528761db1a65572b7016a88ce1e184a7855dcb',
  ev_extension_members: 'c0c5d41697c7514f246352ffacb861dd3c6a5fbaac132f34990ad4a73ff255ba',
  ev_event_triggers: '7b5ac81c4a9c0e3b0cceb61d515678daf3524e2eace81271bf0ddf31fc24a6bb',
  ev_role_membership: 'cd50e9ae7364e593c10eee9f599fd814cf43856bf654d56d9fb6b288bccaac5d',
  ev_default_acl_schema: '629589df14b53c240b029f763924de81757109efd384d8dddfbb52dfd457ef74',
  ev_default_acl_global: '88ad3cea66d71a13ab6ead109e15eae2fbefd6c37e8d8d6d6af9f02f50291461',
  ev_outside_census: '6007b6594445f679bc7df705075b713f9033f9df838faac75daa26afb78797ff',
  ev_sessions: '3aeaf29935e7f6767e0419de3c2c1228a3304b918319f67f940512f11909405d',
  ev_target_relation_locks: '0985bc2b3111e0f0115b484c3c33d49d00ae1ed140f0e16acf09108d49ed7a3c',
  ev_advisory_holders: '9f54dac3f55cc778e0da295c273e23ef3e1012f57bd95c96d812ae344d5fe1c4',
  ev_prepared_xacts: '19f45520fcf502b330cd6ccf9246cbeff940de8343ce12287ea89dce41aa1a26',
  ev_outbound_references: 'a0ee78043ef70af8b87d435a584437319e6d1abdf156f2a990acc0a0fcf21e9e',
  ev_companion_items: '5debce8398b432617b4549143a2c46e1461e2200c39d8cc63fb599fa76cb3e37',
  ev_internal_edges: 'e61115ac919f95038d882bfe187eac1697bd0db275bdd6d54c63d951941310fa',
  effective_coverage: '658a4886fee28e48e0842f7383e203830590637be77e9c3f6decd6f844f78719',
  role_attrs: '0b24c258bd48af11f906451d83b54d5bbbf6ece7ed12731b79dbedb95b5a31fd',
  auth_members: '6b6ab972f0c4919939d8db26cd54cad26e30e5c1c51a9452fd303af3afb4730a',
  database: '6200637a037061ba4e07d2ad728ba5d57c989edb44af80e133717967bb42a4bd',
  effective: 'c138a914b9dc4940bb4f1df51adef78be9eb29b62b1a78598661be253ed55abc',
});
/** Exit contract: 0 success; 3 identity unknown; 2 every other failure. */
const EXIT_CODES = Object.freeze({
  ok: 0, stage_not_authorized: 2, selection_invalid: 2, environment_invalid: 2, target_invalid: 2, connect_failed: 2, begin_failed: 2,
  catalog_invalid: 2, context_invalid: 2, schema_absent: 2, schema_not_authorized: 2, budget_exceeded: 2, memory_exceeded: 2, truncated: 2,
  query_failed: 2, time_exceeded: 2, gate_unknown: 2, gate_residual: 2, gate_default_acl: 2, close_failed: 2, interrupted: 2,
  internal_error: 2, identity_unknown: 3,
});
const OBSERVATION_ERRORS = Object.freeze(['timeout', 'permission', 'connection_lost', 'other']);
const STEP_STATUSES = Object.freeze(['ok', 'empty', 'truncated', 'failed', 'invalid', 'skipped']);
const ROLLBACK_STATES = Object.freeze(['not_needed', 'confirmed', 'unconfirmed', 'failed', 'timeout', 'skipped_in_flight', 'skipped_connection_lost']);
const END_STATES = Object.freeze(['not_needed', 'ok', 'timeout', 'error']);
const STRUCTURAL = Object.freeze(['structurally_valid', 'incomplete', 'unresolved', 'invalid']);

class Stop extends Error {
  /** @param {string} code */
  constructor(code) { super(code); this.code = code; }
}
const TIMED_OUT = Object.freeze({ timedOut: true });
const CANCELLED = Object.freeze({ cancelled: true });

/** @typedef {ReturnType<typeof load>} Lib */
/** @type {Lib|undefined} */ let cache;
function load() {
  const { hash } = require('node:crypto');
  const queries = require('./harness/c8-evidence-queries.cjs');
  const pre = require('./harness/c8-pg-queries.cjs');
  const adapter = require('./harness/c8-pg-adapter.cjs');
  const gate = require('./harness/c8-gate.cjs');
  const names = require('./harness/c8-names.cjs');
  const { TARGET, validate } = require('./harness/c8-target.cjs');
  const { MATRIX } = require('./harness/c8-timeouts.cjs');
  const states = require('./harness/c8-evidence-states.cjs');
  const { normalizeSet } = require('./harness/c8-evidence-normalize.cjs');
  const { classify, FINDINGS: CLASSIFY_FINDINGS } = require('./harness/c8-evidence-classify.cjs');
  const { reconcile, FINDINGS: RECONCILE_FINDINGS } = require('./harness/c8-evidence-reconcile.cjs');
  const { assemble, FINDINGS: ASSEMBLE_FINDINGS } = require('./harness/c8-evidence-assemble.cjs');
  const ids = queries.CATALOG.map((/** @type {{id:string}} */ q) => q.id);
  const planned = PLAN.filter(s => s.source === 'evidence').map(s => s.id);
  if (PLAN.length !== BUDGET.queries || new Set(PLAN.map(s => s.id)).size !== PLAN.length || ids.length !== 22 ||
    planned.length !== ids.length || ids.some((/** @type {string} */ id) => !planned.includes(id))) throw new Stop('catalog_invalid');
  let rows = 0;
  for (const s of PLAN) {
    const text = s.source === 'evidence' ? queries.get(s.id).sql : pre.lookup(s.id).sql;
    if (hash('sha256', text, 'hex') !== (/** @type {Record<string,string>} */ (PINNED))[s.id]) throw new Stop('catalog_invalid');
    if (s.source === 'evidence') {
      const entry = queries.get(s.id);
      if (entry.sqlSha256 !== (/** @type {Record<string,string>} */ (PINNED))[s.id] || entry.serverValidated !== false) throw new Stop('catalog_invalid');
      rows += entry.maxRows + 1;
    } else rows += (/** @type {Record<string,number>} */ (PREFLIGHT_ROWS))[s.id];
  }
  if (rows !== BUDGET.rows || BUDGET.statements !== BUDGET.queries + BUDGET.control) throw new Stop('catalog_invalid');
  if (BUDGET.statementMs > MATRIX.appStatement || BUDGET.lockMs > MATRIX.appLock || BUDGET.idleInTxMs > MATRIX.appIdleInTx ||
    BUDGET.connectMs > MATRIX.preflightConnection) throw new Stop('catalog_invalid');
  const allowed = new Set([BEGIN_SQL, ROLLBACK_SQL, ...PLAN.map(s => (s.source === 'evidence' ? queries.get(s.id).sql : pre.lookup(s.id).sql))]);
  return Object.freeze({ hash, queries, pre, adapter, gate, names, TARGET, validate, states, normalizeSet, classify, reconcile, assemble, allowed,
    vocab: Object.freeze({ classify: Object.keys(CLASSIFY_FINDINGS), reconcile: Object.keys(RECONCILE_FINDINGS), assemble: Object.keys(ASSEMBLE_FINDINGS) }) });
}
/** @returns {Lib} */
function lib() { cache = cache ?? load(); return cache; }

/** Own data properties only; never runs caller code. @param {unknown} obj @param {string} key @returns {any} */
function v(obj, key) {
  if (obj === null || typeof obj !== 'object' || isProxy(obj)) return undefined;
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d && Object.hasOwn(d, 'value') ? d.value : undefined;
}
/** @param {unknown} value @returns {number} */
const int = value => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);
/** @param {unknown} value @param {readonly string[]} list @param {string} fallback */
const oneOf = (value, list, fallback) => (typeof value === 'string' && list.includes(value) ? value : fallback);
/** @param {unknown} value @returns {Record<string,unknown>} */
function data(value) {
  try {
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return {};
    const d = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(d).some(k => !Object.hasOwn(Reflect.get(d, k), 'value'))) return {};
    return Object.fromEntries(Object.entries(d).map(([k, e]) => [k, e.value]));
  } catch { return {}; }
}
/** @param {unknown} value @returns {unknown[]} */
function list(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || !Array.isArray(value) || value.length > 64) return [];
  const d = Object.getOwnPropertyDescriptors(value);
  const out = [];
  for (let i = 0; i < value.length; i++) { const e = d[String(i)]; if (!e || !Object.hasOwn(e, 'value')) return []; out.push(e.value); }
  return out;
}
/** @param {unknown} value @param {readonly string[]} vocabulary @returns {Record<string,number>} */
function counts(value, vocabulary) {
  const out = /** @type {Record<string,number>} */ ({});
  for (const [k, n] of Object.entries(data(value))) if (vocabulary.includes(k) && int(n) > 0) out[k] = int(n);
  return out;
}
/** Closed projection: unknown keys, raw rows, SQL, names, oids and driver text never pass. @param {unknown} input */
function sanitizeSummary(input) {
  const x = data(input);
  const code = typeof x.code === 'string' && Object.hasOwn(EXIT_CODES, x.code) ? x.code : 'internal_error';
  const exitCode = EXIT_CODES[/** @type {keyof typeof EXIT_CODES} */ (code)];
  /** @type {Record<string, unknown>} */
  const out = { schemaVersion: 1, tool: 'c8-validate-evidence', status: code === 'ok' ? 'ok' : code === 'stage_not_authorized' ? 'disabled' : 'failed',
    code, exitCode, diagnosticOnly: code !== 'ok', phase: oneOf(x.phase, ['authorization', 'selection', 'environment', 'connect', 'begin', 'execution', 'close', 'offline', 'done'], 'authorization') };
  const sel = data(x.selection);
  if (typeof sel.digest === 'string' && /^[0-9a-f]{12}$/.test(sel.digest)) {
    out.selection = { valid: sel.valid === true, markMatched: sel.markMatched === true, ownerMatched: sel.ownerMatched === true, digest: sel.digest };
  }
  const b = data(x.budget);
  out.budget = { queries: int(b.queries), control: int(b.control), statements: int(b.statements), rows: int(b.rows), bytes: int(b.bytes),
    executionMs: int(b.executionMs), closeMs: int(b.closeMs) };
  const s = data(x.server);
  if (int(s.major) > 0) out.server = { major: int(s.major), minor: int(s.minor) };
  const g = data(x.gates);
  out.gates = Object.fromEntries(['context', 'schema', 'rows', 'privileges'].map(k => [k, typeof g[k] === 'boolean' ? g[k] : null]));
  const c = data(x.close);
  out.close = { rollback: oneOf(c.rollback, ROLLBACK_STATES, 'not_needed'), end: oneOf(c.end, END_STATES, 'not_needed') };
  out.queries = list(x.queries).flatMap(q => {
    const e = data(q);
    if (typeof e.id !== 'string' || !Object.hasOwn(PINNED, e.id)) return [];
    return [{ id: e.id, status: oneOf(e.status, STEP_STATUSES, 'skipped'), rows: int(e.rows), ms: int(e.ms),
      sql: (/** @type {Record<string,string>} */ (PINNED))[e.id].slice(0, 12) }];
  });
  if (x.otherNamespaces !== null && x.otherNamespaces !== undefined) out.otherNamespaces = int(x.otherNamespaces);
  out.probes = x.probes === null || x.probes === undefined ? null : projectProbes(x.probes);
  out.normalized = x.normalized === null || x.normalized === undefined ? null : projectVerdict(x.normalized);
  out.chain = x.chain === null || x.chain === undefined ? null : (() => {
    const ch = data(x.chain); const cl = lib().vocab;
    return { classification: projectChain(ch.classification, cl.classify), reconciliation: projectChain(ch.reconciliation, cl.reconcile),
      assembly: { ...projectChain(ch.assembly, cl.assemble), coherent: data(ch.assembly).coherent === true, evidence: data(ch.assembly).evidence === true && code === 'ok' } };
  })();
  Object.assign(out, { provenance: 'unauthenticated', demonstration: 'not_demonstrated', eligible: false, serverValidated: false });
  return out;
}
/** @param {unknown} value */
function projectVerdict(value) {
  const d = data(value);
  return { structural: oneOf(d.structural, STRUCTURAL, 'invalid'), reasons: list(d.reasons).filter(r => typeof r === 'string' && Object.hasOwn(lib().states.REASONS, r)).sort() };
}
/** @param {unknown} value @param {readonly string[]} vocabulary */
function projectChain(value, vocabulary) {
  const d = data(value);
  return { structural: oneOf(d.structural, STRUCTURAL, 'invalid'), findings: counts(d.findings, vocabulary),
    exclusions: list(d.exclusions).filter(e => typeof e === 'string' && vocabulary.includes(e)).sort() };
}
/** Probes carry only integers and booleans. @param {unknown} value */
function projectProbes(value) {
  const out = /** @type {Record<string, unknown>} */ ({});
  for (const [name, raw] of Object.entries(data(value))) {
    if (!/^[a-zA-Z0-9]{1,24}$/.test(name)) continue;
    if (raw === null) { out[name] = null; continue; }
    const d = data(raw);
    out[name] = Object.fromEntries(Object.entries(d).filter(([k]) => /^[a-zA-Z0-9]{1,24}$/.test(k))
      .map(([k, n]) => (typeof n === 'boolean' ? [k, n] : typeof n === 'object' && n !== null
        ? [k, Object.fromEntries(Object.entries(data(n)).filter(([kk]) => /^[a-zA-Z0-9]{1,24}$/.test(kk)).map(([kk, nn]) => [kk, int(nn)]))] : [k, int(n)])));
  }
  return out;
}

/** Longest flat array a column may hold (rolconfig holds a handful of settings). */
const MAX_ARRAY = 64;
/** Retained size of one column value without serializing it. Scalars, or a flat bounded array of scalars; anything else is refused.
 * @param {unknown} value @returns {number} */
function weighValue(value) {
  if (typeof value === 'string') return 16 + 2 * value.length;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return 8;
  if (typeof value !== 'object' || isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_ARRAY) throw new Stop('query_failed');
  const d = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(d).length !== value.length + 1) throw new Stop('query_failed');
  let bytes = 16;
  for (let i = 0; i < value.length; i++) {
    const e = d[String(i)];
    if (!e || !Object.hasOwn(e, 'value')) throw new Stop('query_failed');
    const item = e.value;
    if (typeof item === 'string') bytes += 8 + 16 + 2 * item.length;
    else if (item === null || typeof item === 'number' || typeof item === 'boolean') bytes += 8 + 8;
    else throw new Stop('query_failed');
  }
  return bytes;
}
/** Heuristic retained size of a result. @param {readonly unknown[]} rows */
function weigh(rows) {
  let bytes = 0;
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row) || isProxy(row)) throw new Stop('query_failed');
    const proto = Object.getPrototypeOf(row);
    if (proto !== Object.prototype && proto !== null) throw new Stop('query_failed');
    bytes += 32;
    for (const d of Object.values(Object.getOwnPropertyDescriptors(row))) {
      if (!Object.hasOwn(d, 'value')) throw new Stop('query_failed');
      bytes += weighValue(d.value);
    }
  }
  return bytes;
}
/** @param {unknown} err */
function sqlstate(err) {
  const code = v(err, 'code');
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}
/** @param {string|undefined} state */
function observationCode(state) {
  if (state === '57014' || state === '55P03') return 'timeout';
  if (state === '42501') return 'permission';
  if (state !== undefined && (state.startsWith('08') || state.startsWith('57P') || state === '25P03')) return 'connection_lost';
  return state === undefined ? 'connection_lost' : 'other';
}
/** @param {unknown} text @returns {number} */
function settingMs(text) {
  const m = typeof text === 'string' ? /^([0-9]+)(ms|s|min)$/.exec(text) : null;
  return m ? Number(m[1]) * (/** @type {Record<string,number>} */ ({ ms: 1, s: 1000, min: 60000 }))[m[2]] : NaN;
}

/** Session context gate (G1). Returns an error code or null. @param {unknown} row @param {unknown} clientPid */
function contextGate(row, clientPid) {
  const { TARGET } = lib();
  const version = v(row, 'server_version_num');
  if (v(row, 'database') !== TARGET.database || v(row, 'current_user') !== TARGET.app || v(row, 'session_user') !== TARGET.app) return 'context_invalid';
  if (typeof clientPid !== 'number' || !Number.isSafeInteger(clientPid) || v(row, 'pid') !== clientPid) return 'identity_unknown';
  if (typeof version !== 'string' || !/^16[0-9]{4}$/.test(version) || v(row, 'transaction_isolation') !== 'repeatable read' ||
    v(row, 'transaction_read_only') !== 'on' || v(row, 'in_recovery') !== false) return 'context_invalid';
  if (settingMs(v(row, 'statement_timeout')) !== BUDGET.statementMs || settingMs(v(row, 'lock_timeout')) !== BUDGET.lockMs ||
    settingMs(v(row, 'idle_in_transaction_session_timeout')) !== BUDGET.idleInTxMs) return 'context_invalid';
  return null;
}
/** Privilege gate (Gp): reuses the existing mappers and P6b; refuses a vacuous pass. Returns an error code or null.
 * @param {(id:string)=>readonly unknown[]|null} rowsOf @param {Record<string,unknown>} schemaRow */
function privilegeGate(rowsOf, schemaRow) {
  const L = lib();
  const attrs = L.adapter.mapRoleAttrs(rowsOf('role_attrs'));
  if (!attrs || typeof attrs.appOid !== 'number') return 'gate_unknown';
  const roles = L.adapter.mapRoles(rowsOf('ev_role_membership'), rowsOf('auth_members'), attrs.appOid);
  if (!roles.evaluable) return 'gate_unknown';
  const db = rowsOf('database');
  if (!db || db.length !== 1 || v(db[0], 'datname') !== L.TARGET.database) return 'gate_unknown';
  if (v(db[0], 'can_connect') !== true) return 'gate_unknown';
  if (v(db[0], 'can_create') !== false || v(db[0], 'can_temporary') !== false) return 'gate_residual';
  const global = L.gate.evaluateGlobalDefaultAcl(L.adapter.mapGlobalDefaultAcl(rowsOf('ev_default_acl_global')));
  if (!global.ok) return global.code;
  const schema = { name: schemaRow.name, comment: schemaRow.comment, owner: schemaRow.owner, ageMs: 0, lease: 'unknown', leaseOwned: false, empty: false };
  if (!L.gate.recognized(/** @type {any} */ (schema))) return 'gate_unknown';
  const privileges = L.adapter.mapPrivileges(rowsOf('effective'), rowsOf('effective_coverage'), rowsOf('ev_default_acl_schema'));
  const verdict = L.gate.evaluate([/** @type {any} */ (schema)], () => privileges, 'P6b', roles);
  return verdict.ok ? null : verdict.code;
}

/** Hypothesis probes over RAW rows (C3-B hides rows of non-valid results). Integers and booleans only.
 * @param {(id:string)=>readonly unknown[]|null} rowsOf */
function runProbes(rowsOf) {
  /** @type {Record<string, unknown>} */ const p = {};
  /** @param {string} name @param {()=>unknown} fn */
  const safe = (name, fn) => { try { p[name] = fn(); } catch { p[name] = null; } };
  safe('indexBacking', () => {
    const items = rowsOf('ev_companion_items'); const edges = rowsOf('ev_internal_edges'); const rels = rowsOf('ev_relations');
    if (!items || !edges || !rels) return null;
    const idx = new Set(rels.filter(r => v(r, 'relkind') === 'i').map(r => v(r, 'oid')));
    const backed = new Set(items.filter(i => v(i, 'item_kind') === 'constraint' && ['p', 'u', 'x'].includes(v(i, 'subtype')) &&
      v(i, 'related_classid') === 'pg_class' && idx.has(v(i, 'related_oid'))).map(i => v(i, 'related_oid')));
    const table = new Set(); const constraint = new Set();
    for (const e of edges) {
      if (v(e, 'source_classid') !== 'pg_class' || !backed.has(v(e, 'source_objid'))) continue;
      if (v(e, 'deptype') === 'a' && v(e, 'ref_classid') === 'pg_class') table.add(v(e, 'source_objid'));
      if (v(e, 'deptype') === 'i' && v(e, 'ref_classid') === 'pg_constraint') constraint.add(v(e, 'source_objid'));
    }
    return { backed: backed.size, withTableEdge: table.size, withConstraintEdge: constraint.size };
  });
  safe('composite', () => {
    const rels = rowsOf('ev_relations'); const edges = rowsOf('ev_internal_edges'); const types = rowsOf('ev_types');
    if (!rels || !edges || !types) return null;
    const comp = new Set(rels.filter(r => v(r, 'relkind') === 'c').map(r => v(r, 'oid')));
    const typeOf = new Map(types.filter(t => comp.has(v(t, 'typrelid'))).map(t => [v(t, 'oid'), v(t, 'typrelid')]));
    let reverse = 0; let forward = 0;
    for (const e of edges) {
      if (v(e, 'deptype') !== 'i') continue;
      if (v(e, 'source_classid') === 'pg_class' && comp.has(v(e, 'source_objid')) && v(e, 'ref_classid') === 'pg_type') reverse++;
      if (v(e, 'source_classid') === 'pg_type' && typeOf.has(v(e, 'source_objid')) && v(e, 'ref_classid') === 'pg_class') forward++;
    }
    return { composites: comp.size, reverseEdges: reverse, forwardEdges: forward };
  });
  safe('extensionClass', () => {
    const rows = rowsOf('ev_extension_members');
    if (!rows) return null;
    return { qualified: rows.filter(r => v(r, 'classid') === 'pg_catalog.pg_extension').length, unqualified: rows.filter(r => v(r, 'classid') === 'pg_extension').length };
  });
  safe('classSpelling', () => {
    const columns = /** @type {Record<string,string[]>} */ ({ ev_closure: ['classid'], ev_external_dependents: ['classid', 'refclassid'], ev_extension_members: ['classid'],
      ev_outbound_references: ['source_classid', 'group_classid', 'ref_classid'], ev_companion_items: ['item_classid', 'group_classid', 'related_classid'],
      ev_internal_edges: ['source_classid', 'ref_classid', 'source_group_classid', 'ref_group_classid'] });
    const seen = new Set(); let any = false;
    for (const [id, cols] of Object.entries(columns)) {
      const rows = rowsOf(id); if (!rows) continue; any = true;
      for (const r of rows) for (const c of cols) { const value = v(r, c); if (typeof value === 'string' && value !== '') seen.add(value); }
    }
    return any ? { distinct: seen.size, qualified: [...seen].filter(s => s.includes('.')).length } : null;
  });
  safe('unmappedTargets', () => {
    const out = rowsOf('ev_outbound_references'); const ext = rowsOf('ev_external_dependents'); const routines = rowsOf('ev_routines');
    if (!out && !ext) return null;
    const family = /** @type {Record<string,string>} */ ({ pg_class: 'relation', pg_proc: 'routine', pg_type: 'type', pg_constraint: 'companion', pg_trigger: 'companion',
      pg_rewrite: 'companion', pg_attrdef: 'companion', pg_policy: 'companion' });
    const by = { relation: 0, routine: 0, type: 0, companion: 0, other: 0 };
    for (const r of out ?? []) if (v(r, 'target_schema') === null) by[/** @type {keyof typeof by} */ (family[v(r, 'source_classid')] ?? 'other')]++;
    return { ...by, externalNull: (ext ?? []).filter(r => v(r, 'namespace') === null).length, routines: routines ? routines.length : 0 };
  });
  safe('rowTypes', () => {
    const rels = rowsOf('ev_relations'); const types = rowsOf('ev_types');
    if (!rels || !types) return null;
    const kind = new Map(rels.map(r => [v(r, 'oid'), v(r, 'relkind')]));
    const withType = new Set(types.filter(t => v(t, 'typrelid') !== 0).map(t => v(t, 'typrelid')));
    const by = { sequence: 0, index: 0, toast: 0, table: 0, view: 0, withoutType: 0 };
    for (const t of types) { const k = kind.get(v(t, 'typrelid')); if (k === 'S') by.sequence++; else if (k === 'i') by.index++; else if (k === 't') by.toast++; else if (k === 'r') by.table++; else if (k === 'v') by.view++; }
    for (const r of rels) if (['r', 'v'].includes(v(r, 'relkind')) && !withType.has(v(r, 'oid'))) by.withoutType++;
    return by;
  });
  safe('flags', () => {
    const rels = rowsOf('ev_relations'); const items = rowsOf('ev_companion_items');
    if (!rels || !items) return null;
    const has = (/** @type {string} */ kind) => new Set(items.filter(i => v(i, 'item_kind') === kind).map(i => v(i, 'group_oid')));
    const triggers = has('trigger'); const rules = has('rule');
    return { triggersFlagNoItem: rels.filter(r => v(r, 'relhastriggers') === true && !triggers.has(v(r, 'oid'))).length,
      rulesFlagNoItem: rels.filter(r => v(r, 'relhasrules') === true && !rules.has(v(r, 'oid'))).length,
      itemNoTriggerFlag: rels.filter(r => v(r, 'relhastriggers') === false && triggers.has(v(r, 'oid'))).length };
  });
  safe('toastNames', () => {
    const items = rowsOf('ev_companion_items');
    if (!items) return null;
    const toast = items.filter(i => v(i, 'item_kind') === 'toast_candidate');
    return { candidates: toast.length, expectedName: toast.filter(i => v(i, 'name') === `pg_toast_${v(i, 'group_oid')}`).length };
  });
  safe('sessions', () => {
    const rows = rowsOf('ev_sessions');
    return rows ? { total: rows.length, nullState: rows.filter(r => v(r, 'state') === null).length } : null;
  });
  safe('closure', () => {
    const rows = rowsOf('ev_closure');
    if (!rows) return null;
    const keys = new Set(rows.map(r => `${v(r, 'classid')}:${v(r, 'objid')}`));
    return { rows: rows.length, distinct: keys.size, maxDepth: rows.reduce((/** @type {number} */ m, r) => Math.max(m, int(v(r, 'depth'))), 0) };
  });
  return p;
}

/** @param {string[]} argv @param {boolean} real */
function authorize(argv, real) {
  if (!Array.isArray(argv) || argv.some(x => typeof x !== 'string')) return false;
  const keys = argv.map(x => x.split('=')[0]);
  if (new Set(keys).size !== keys.length || keys.some(k => !['--real', '--confirm', '--confirm-real', '--schema', '--run'].includes(k))) return false;
  return argv.includes('--real') && argv.includes(`--confirm=${AUTHORIZATION}`) && (!real || argv.includes(`--confirm-real=${REAL_AUTHORIZATION}`));
}
/** @param {string[]} argv @param {string} key */
function option(argv, key) {
  const found = argv.find(x => x.startsWith(`${key}=`));
  return found === undefined ? undefined : found.slice(key.length + 1);
}

/** @typedef {{set:(fn:()=>void, ms:number)=>unknown, clear:(handle:unknown)=>void}} Timers */
/** @typedef {{pgModule?:{Client:new(config:Record<string,unknown>)=>any}, readEnvFile?:()=>unknown, clock?:()=>number, timers?:Timers,
 * stdout?:(line:string)=>void, signals?:{on:(name:string,fn:()=>void)=>unknown, off:(name:string,fn:()=>void)=>unknown}}} Dependencies */
/** @returns {Record<string, unknown>} */
function defaultCredentials() {
  const { readEnvFile } = require('./harness/env-files.cjs');
  const result = readEnvFile('app', { root: require('node:path').resolve(__dirname, '..'), fs: require('node:fs'), getuid: process.getuid });
  const { host, port, database, user } = result.connection;
  return { host, port, database, user, password: result.secrets[0], major: 16 };
}

/** @param {string[]} argv @param {Dependencies} [deps] */
async function main(argv, deps = {}) {
  const output = deps.stdout ?? (line => { process.stdout.write(line); });
  const clock = deps.clock ?? (() => performance.now());
  /** @type {Timers} */
  const timers = deps.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(/** @type {any} */ (handle)) };
  const real = !deps.pgModule || !deps.readEnvFile;
  /** @type {Record<string, any>} */
  const state = { phase: 'authorization', code: null, queries: 0, control: 0, rows: 0, bytes: 0, executionMs: 0, closeMs: 0, selection: undefined, server: undefined,
    gates: { context: null, schema: null, rows: null, privileges: null }, rollback: 'not_needed', end: 'not_needed', steps: [], observed: new Map() };
  const finish = (/** @type {Record<string, unknown>} */ extra = {}) => {
    const code = state.code ?? (state.rollbackBad || state.endBad ? 'close_failed' : 'ok');
    if (code === 'stage_not_authorized') {
      const denied = sanitizeSummary({ code, phase: 'authorization' });
      output(`${SUMMARY_PREFIX}${JSON.stringify(denied)}\n`);
      return /** @type {number} */ (denied.exitCode);
    }
    const summary = sanitizeSummary({ code, phase: state.code === null && code === 'ok' ? 'done' : state.phase, selection: state.selection,
      budget: { queries: state.queries, control: state.control, statements: state.queries + state.control, rows: state.rows, bytes: state.bytes,
        executionMs: state.executionMs, closeMs: state.closeMs }, server: state.server, gates: state.gates, close: { rollback: state.rollback, end: state.end },
      queries: PLAN.map(s => state.steps.find((/** @type {{id:string}} */ e) => e.id === s.id) ?? { id: s.id, status: 'skipped', rows: 0, ms: 0 }), ...extra });
    output(`${SUMMARY_PREFIX}${JSON.stringify(summary)}\n`);
    return /** @type {number} */ (summary.exitCode);
  };
  if (!authorize(argv, real)) { state.code = 'stage_not_authorized'; return finish(); }
  const start = clock();
  const executionDeadline = start + BUDGET.executionMs;
  /** @type {()=>void} */ let cancel = () => {};
  const cancelled = new Promise(resolve => { cancel = () => resolve(CANCELLED); });
  let interrupted = false;
  const onSignal = () => { interrupted = true; cancel(); };
  const signals = deps.signals ?? process;
  /** @param {()=>unknown} work @param {number} ms @param {boolean} [cancellable] @returns {Promise<any>} */
  const bounded = (work, ms, cancellable = true) => new Promise((resolve, reject) => {
    let done = false;
    /** @param {boolean} ok @param {unknown} value */
    const settle = (ok, value) => { if (done) return; done = true; timers.clear(timer); (ok ? resolve : reject)(value); };
    const timer = timers.set(() => settle(false, TIMED_OUT), ms);
    if (cancellable) cancelled.then(() => settle(false, CANCELLED));
    try { Promise.resolve(work()).then(value => settle(true, value), error => settle(false, error)); } catch (error) { settle(false, error); }
  });
  /** Execution-time wrapper: one budget for everything until the last result. @param {()=>unknown} work @param {number} outer @returns {Promise<any>} */
  const within = async (work, outer) => {
    const left = executionDeadline - clock();
    if (left <= 0) throw new Stop('time_exceeded');
    try { return await bounded(work, Math.min(outer, left)); } catch (error) {
      if (error === TIMED_OUT) throw new Stop('time_exceeded');
      if (error === CANCELLED) throw new Stop('interrupted');
      throw error;
    }
  };
  /** Checked before anything is sent, so a refusal never leaves a statement in flight. */
  const ready = () => {
    if (interrupted) throw new Stop('interrupted');
    if (executionDeadline - clock() <= 0) throw new Stop('time_exceeded');
  };
  /** @type {any} */ let client = null;
  let txMayBeOpen = false; let inFlight = false; let connectionLost = false;
  /** @type {Record<string, unknown>} */ let schemaRow = {};
  /** @type {{schema:string, run:string}|undefined} */ let selection;
  signals.on('SIGINT', onSignal); signals.on('SIGTERM', onSignal);
  try {
    state.phase = 'selection';
    const L = lib();
    const schema = option(argv, '--schema'); const run = option(argv, '--run');
    if (!L.names.valid(schema) || !L.names.validRun(run)) throw new Stop('selection_invalid');
    selection = { schema, run };
    const sel = selection;
    const digest = L.hash('sha256', `${schema}:${run}`, 'hex').slice(0, 12);
    state.selection = { valid: true, markMatched: false, ownerMatched: false, digest };
    state.phase = 'environment';
    /** @type {Record<string, unknown>} */ let credentials;
    try { credentials = data(await within(async () => (deps.readEnvFile ?? defaultCredentials)(), 5000)); } catch (error) {
      if (error instanceof Stop) throw error;
      throw new Stop('environment_invalid');
    }
    try { L.validate(credentials, 'app'); } catch { throw new Stop('target_invalid'); }
    if (typeof credentials.password !== 'string' || credentials.password.length === 0) throw new Stop('environment_invalid');
    state.phase = 'connect';
    const pgModule = deps.pgModule ?? require('pg');
    client = new pgModule.Client({ host: L.TARGET.host, port: L.TARGET.port, database: L.TARGET.database, user: L.TARGET.app, password: credentials.password,
      connectionTimeoutMillis: BUDGET.connectMs, statement_timeout: BUDGET.statementMs, lock_timeout: BUDGET.lockMs,
      idle_in_transaction_session_timeout: BUDGET.idleInTxMs, options: '-c default_transaction_read_only=on', application_name: APPLICATION_NAME, ssl: false });
    if (typeof client.on === 'function') client.on('error', () => { connectionLost = true; });
    try { await within(() => client.connect(), BUDGET.connectOuterMs); } catch (error) {
      if (error instanceof Stop) throw error;
      throw new Stop('connect_failed');
    }
    /** @param {string} text */
    const control = async text => {
      if ((text !== BEGIN_SQL && text !== ROLLBACK_SQL) || !L.allowed.has(text)) throw new Stop('catalog_invalid');
      if (state.control >= BUDGET.control) throw new Stop('budget_exceeded');
      state.control++;
    };
    state.phase = 'begin';
    ready();
    await control(BEGIN_SQL);
    txMayBeOpen = true; inFlight = true;
    try { await within(() => client.query(BEGIN_SQL), BUDGET.statementOuterMs); inFlight = false; } catch (error) {
      if (error instanceof Stop) throw error;
      inFlight = false; txMayBeOpen = false; throw new Stop('begin_failed');
    }
    state.phase = 'execution';
    /** @param {string} id @returns {readonly unknown[]|null} */
    const rowsOf = id => { const o = state.observed.get(id); return o && o.status === 'rows' ? o.rows : null; };
    for (const s of PLAN) {
      const entry = { id: s.id, status: 'failed', rows: 0, ms: 0 };
      state.steps.push(entry);
      /** @type {string} */ let text; /** @type {unknown[]} */ let values; let cap;
      if (s.source === 'evidence') {
        const q = L.queries.get(s.id);
        const input = Object.fromEntries(q.params.map((/** @type {string} */ t) => [t, t === 'schema' ? sel.schema : t === 'app' ? L.TARGET.app : L.adapter.L0_KEY]));
        const built = L.queries.build(s.id, input);
        text = built.text; values = [...built.values]; cap = q.maxRows + 1;
      } else {
        const q = L.pre.lookup(s.id);
        values = q.paramTypes.map((/** @type {string} */ t) => (t === 'schema' ? sel.schema : L.TARGET.app));
        L.pre.assertAllowed(q.sql, values);
        text = q.sql; cap = (/** @type {Record<string,number>} */ (PREFLIGHT_ROWS))[s.id];
      }
      if (!L.allowed.has(text) || L.hash('sha256', text, 'hex') !== (/** @type {Record<string,string>} */ (PINNED))[s.id]) throw new Stop('catalog_invalid');
      if (state.queries >= BUDGET.queries) throw new Stop('budget_exceeded');
      ready();
      state.queries++;
      const began = clock();
      inFlight = true;
      let result;
      try { result = await within(() => client.query(text, values), BUDGET.statementOuterMs); inFlight = false; } catch (error) {
        entry.ms = Math.round(clock() - began);
        if (error instanceof Stop) throw error;
        inFlight = false;
        const code = observationCode(sqlstate(error));
        if (code === 'connection_lost') connectionLost = true;
        if (s.source === 'evidence') state.observed.set(s.id, { status: 'error', code });
        throw new Stop('query_failed');
      }
      entry.ms = Math.round(clock() - began);
      const rows = v(result, 'rows');
      if (!Array.isArray(rows)) throw new Stop('query_failed');
      entry.rows = rows.length;
      if (rows.length > cap || state.rows + rows.length > BUDGET.rows) { entry.status = 'invalid'; throw new Stop('budget_exceeded'); }
      state.rows += rows.length;
      state.bytes += weigh(rows);
      if (state.bytes > BUDGET.memoryBytes) { entry.status = 'invalid'; throw new Stop('memory_exceeded'); }
      const truncated = s.source === 'evidence' && rows.length === cap;
      // A truncated result is kept out of the probes: its rows are a partial observation, so the probes that need it are not evaluable.
      state.observed.set(s.id, { status: truncated ? 'truncated' : 'rows', rows });
      if (truncated) { entry.status = 'truncated'; throw new Stop('truncated'); }
      entry.status = rows.length === 0 ? 'empty' : 'ok';
      if (s.gate === 'context') {
        const row = rows.length === 1 ? rows[0] : null;
        const failure = row === null ? 'context_invalid' : contextGate(row, client.processID);
        if (failure) throw new Stop(failure);
        state.gates.context = true;
        const version = Number(v(row, 'server_version_num'));
        state.server = { major: Math.floor(version / 10000), minor: version % 10000 };
      } else if (s.gate === 'schema') {
        if (rows.length === 0) { state.gates.schema = false; throw new Stop('schema_absent'); }
        const row = rows.length === 1 ? rows[0] : null;
        const markMatched = row !== null && v(row, 'comment') === L.names.mark(sel.run);
        const ownerMatched = row !== null && v(row, 'owner') === L.TARGET.owner;
        state.selection = { ...state.selection, markMatched, ownerMatched };
        if (row === null || v(row, 'name') !== sel.schema || !markMatched || !ownerMatched) { state.gates.schema = false; throw new Stop('schema_not_authorized'); }
        state.gates.schema = true;
        schemaRow = { name: v(row, 'name'), comment: v(row, 'comment'), owner: v(row, 'owner') };
      } else if (s.gate === 'coverage') {
        const row = rows.length === 1 ? rows[0] : null;
        const [t, q, r] = ['tables', 'sequences', 'routines'].map(k => Number(v(row, k)));
        if (row === null || ![t, q, r].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Stop('gate_unknown');
        if (2 + 11 * t + 3 * q + r > BUDGET.effectiveRows) { state.gates.rows = false; throw new Stop('budget_exceeded'); }
        state.gates.rows = true;
      } else if (s.gate === 'privileges') {
        const failure = privilegeGate(rowsOf, schemaRow);
        state.gates.privileges = failure === null;
        if (failure) throw new Stop(failure);
      }
    }
    state.executionMs = Math.round(clock() - start);
  } catch (error) {
    state.executionMs = Math.round(clock() - start);
    state.code = error instanceof Stop ? (interrupted && error.code === 'interrupted' ? 'interrupted' : error.code) : 'internal_error';
  } finally {
    // Closing has its own budget and ignores cancellation: the transaction must get its ROLLBACK attempt.
    const closing = clock(); const closeDeadline = closing + BUDGET.closeMs;
    const left = (/** @type {number} */ cap) => Math.max(1, Math.min(cap, closeDeadline - clock()));
    const previous = state.phase;
    state.phase = 'close';
    if (client !== null) {
      if (!txMayBeOpen) state.rollback = 'not_needed';
      else if (connectionLost) state.rollback = 'skipped_connection_lost';
      else if (inFlight) state.rollback = 'skipped_in_flight';
      else if (state.control >= BUDGET.control) state.rollback = 'failed';
      else {
        state.control++;
        try {
          await bounded(() => client.query(ROLLBACK_SQL), left(BUDGET.rollbackMs), false);
          const status = typeof client.getTransactionStatus === 'function' ? client.getTransactionStatus() : undefined;
          state.rollback = status === 'I' ? 'confirmed' : 'unconfirmed';
        } catch (error) { state.rollback = error === TIMED_OUT ? 'timeout' : 'failed'; }
      }
      // Only a confirmed ROLLBACK, or no transaction ever started, is a verified close; end() succeeding proves nothing about it.
      state.rollbackBad = !['confirmed', 'not_needed'].includes(state.rollback);
      try { await bounded(() => client.end(), left(BUDGET.endMs), false); state.end = 'ok'; } catch (error) { state.end = error === TIMED_OUT ? 'timeout' : 'error'; }
      state.endBad = state.end !== 'ok';
    }
    state.closeMs = Math.round(clock() - closing);
    state.phase = state.code === null ? 'offline' : previous;
    signals.off('SIGINT', onSignal); signals.off('SIGTERM', onSignal);
  }
  // Offline stage: probes on RAW rows first, then normalize -> classify -> reconcile -> assemble. Nothing is printed raw.
  /** @type {Record<string, unknown>} */ const extra = {};
  try {
    const L = lib();
    /** @param {string} id @returns {readonly unknown[]|null} */
    const rowsOf = id => { const o = state.observed.get(id); return o && o.status === 'rows' ? o.rows : null; };
    extra.probes = runProbes(rowsOf);
    const census = rowsOf('ev_outside_census');
    const namespaceRow = census ? census.find(r => v(r, 'catalog') === 'namespace') : undefined;
    extra.otherNamespaces = namespaceRow && /^[0-9]{1,9}$/.test(v(namespaceRow, 'n')) ? Number(v(namespaceRow, 'n')) : null;
    if (state.code === null && selection) {
      const observations = L.queries.CATALOG.map((/** @type {any} */ q) => {
        const o = state.observed.get(q.id);
        const values = q.params.map((/** @type {string} */ t) => (t === 'schema' ? selection.schema : t === 'app' ? L.TARGET.app : L.adapter.L0_KEY));
        return { id: q.id, sqlSha256: q.sqlSha256, values, result: o.status === 'rows' ? { status: 'rows', rows: o.rows } : { status: 'error', code: OBSERVATION_ERRORS.includes(o.code) ? o.code : 'other' } };
      });
      const set = L.normalizeSet(observations);
      const classification = L.classify(set);
      const reconciliation = L.reconcile(set, classification);
      const assembly = L.assemble(set, classification, reconciliation);
      /** @param {any} r */
      const tally = r => { const f = /** @type {Record<string,number>} */ ({}); for (const x of r.findings) f[x.code] = (f[x.code] ?? 0) + 1; return f; };
      extra.normalized = { structural: set.verdict.structural, reasons: [...set.verdict.reasons] };
      extra.chain = {
        classification: { structural: classification.verdict.structural, findings: tally(classification), exclusions: classification.exclusions },
        reconciliation: { structural: reconciliation.verdict.structural, findings: tally(reconciliation), exclusions: reconciliation.exclusions },
        assembly: { structural: assembly.verdict.structural, coherent: assembly.coherent, evidence: assembly.evidence !== null,
          findings: tally({ findings: assembly.findings.filter((/** @type {any} */ f) => f.source === 'assembly') }), exclusions: assembly.exclusions },
      };
    }
  } catch { if (state.code === null) state.code = 'internal_error'; }
  state.observed.clear();
  return finish(extra);
}

/** Last-resort process backstop for the command line only. @param {{set:(fn:()=>void, ms:number)=>unknown, clear:(h:unknown)=>void, exit:(code:number)=>void, write:(line:string)=>void, ms:number}} deps */
function armHardExit(deps) {
  const handle = deps.set(() => {
    const summary = sanitizeSummary({ code: 'time_exceeded', phase: 'close', close: { rollback: 'failed', end: 'timeout' } });
    deps.write(`${SUMMARY_PREFIX}${JSON.stringify(summary)}\n`);
    deps.exit(2);
  }, deps.ms);
  return () => deps.clear(handle);
}

if (require.main === module) {
  const disarm = armHardExit({ set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(/** @type {any} */ (h)), exit: code => process.exit(code),
    write: line => { process.stdout.write(line); }, ms: BUDGET.hardExitMs });
  main(process.argv.slice(2)).then(code => { disarm(); process.stdout.write('', () => process.exit(code)); },
    () => { disarm(); process.stdout.write('', () => process.exit(2)); });
}
module.exports = Object.freeze({ AUTHORIZATION, REAL_AUTHORIZATION, SUMMARY_PREFIX, APPLICATION_NAME, BEGIN_SQL, ROLLBACK_SQL, BUDGET, PREFLIGHT_ROWS,
  PLAN, PINNED, EXIT_CODES, main, sanitizeSummary, runProbes, armHardExit, privilegeGate, contextGate, observationCode });
