'use strict';
/**
 * Pure assembler over the three offline layers: the normalized set (C3-B), its classification (C3-C) and its
 * reconciliation (C3-D). It draws an explicit boundary between STRUCTURALLY COHERENT evidence and AUTHENTICATED
 * evidence. It authenticates nothing: no identity of connection, transaction, snapshot or sequence is generated or
 * accepted, no attestation exists, C1 is neither imported nor used, and the result is not and cannot be used as a
 * body for the drop policy (different shape, no plan, no order, no executable instruction).
 *
 * Consistency: the classification and the reconciliation received are never trusted for looking valid. Both are
 * recomputed from the set with the existing pure functions and must be identical by content; the set itself must have
 * exactly the shape C3-B produces, with no extra property of any kind (so no identity claim can ride along). A pair
 * that does not match, an unreadable argument or any extra argument makes the assembly incoherent and withholds the
 * evidence. Coherence is still not authenticity: a faithful structural copy of a genuine set assembles identically.
 *
 * `evidence` is present only when the inputs are coherent and the aggregate state is not invalid; it holds each datum
 * once. The verdict is the worst of everything; eligible is always false and demonstration always not_demonstrated.
 */
const { types: { isProxy } } = require('node:util');
const { CATALOG } = require('./c8-evidence-queries.cjs');
const { classify } = require('./c8-evidence-classify.cjs');
const { reconcile } = require('./c8-evidence-reconcile.cjs');

const SET_KEYS = Object.freeze(['duplicates', 'missing', 'order', 'results', 'schema', 'verdict']);
const RESULT_KEYS = Object.freeze(['check', 'errorCode', 'id', 'nulls', 'rowCount', 'rows', 'schema', 'serverValidated', 'sqlSha256', 'values', 'verdict']);
const IDENTITY_CLAIM = Object.freeze(/connection|transaction|snapshot|sequence|session|backend|xid|lsn|attest|token/i);
/** Findings of the assembly itself; every one is invalid. */
const FINDINGS = Object.freeze({
  set_shape: 'invalid', identity_claim_rejected: 'invalid', classification_mismatch: 'invalid', reconciliation_mismatch: 'invalid',
  unexpected_argument: 'invalid',
});
/** What this stage can never establish, whatever the data say. */
const LIMITATIONS = Object.freeze({
  provenance_unbound: 'Observations are not bound to a real execution; a faithful structural copy assembles identically.',
  identities_unbound: 'No connection, transaction or sequence identity exists here; none supplied by a caller is accepted.',
  snapshot_unproven: 'Separately executed statements may have seen different snapshots.',
  quiescence_unproven: 'Sessions, locks and prepared transactions are structure only; quiescence is not established.',
  server_validation_pending: 'None of the 22 queries has been validated against PostgreSQL 16.',
  rows_hidden_when_not_valid: 'Rows of results that are not structurally valid are not exposed, so unmapped or NULL destinations survive only as a verdict.',
});
const PROVENANCE = Object.freeze({
  status: 'unauthenticated', authenticated: false,
  bindings: Object.freeze({ c1: 'unbound', connection: 'unbound', transaction: 'unbound', snapshot: 'unbound', sequence: 'unbound' }),
});

/** @param {any} value @returns {any} */
function freezeDeep(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}
/** @param {string} a @param {string} b */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Data-only copy: never runs caller code. @param {unknown} value @param {{n:number}} ctx @param {number} [depth] @returns {any} */
function snapshot(value, ctx, depth = 0) {
  if (++ctx.n > 600000 || depth > 12) throw new Error('hostile');
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value !== 'object' || isProxy(value)) throw new Error('hostile');
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error('hostile');
  const d = Object.getOwnPropertyDescriptors(value);
  /** @type {any} */ const out = array ? [] : {};
  for (const key of Reflect.ownKeys(d)) {
    if (typeof key !== 'string' || key === '__proto__' || !Object.hasOwn(d[key], 'value')) throw new Error('hostile');
    if (array && key === 'length') continue;
    out[key] = snapshot(d[key].value, ctx, depth + 1);
  }
  return out;
}
/** Own data keys of a plain object, or null when it is not one. @param {unknown} value @returns {string[]|null} */
function plainKeys(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const d = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(d);
  if (keys.some(k => typeof k !== 'string' || !Object.hasOwn(d[/** @type {string} */ (k)], 'value'))) return null;
  return /** @type {string[]} */ (keys);
}
/** @param {unknown} obj @param {string} key */
function own(obj, key) {
  if (plainKeys(obj) === null) return undefined;
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d && Object.hasOwn(d, 'value') ? d.value : undefined;
}

/** Exact-shape check of a C3-B set; reports every extra or missing key and any identity claim among them.
 * @param {unknown} set @param {(code:string, detail:string) => void} flag */
function checkSetShape(set, flag) {
  const keys = plainKeys(set);
  if (keys === null) { flag('set_shape', 'not_plain'); return; }
  const unexpected = (/** @type {string[]} */ list, /** @type {readonly string[]} */ expected, /** @type {string} */ where) => {
    for (const k of list.filter(x => !expected.includes(x))) { flag(IDENTITY_CLAIM.test(k) ? 'identity_claim_rejected' : 'set_shape', `${where}:${k}`); }
    for (const k of expected.filter(x => !list.includes(x))) flag('set_shape', `${where}:missing:${k}`);
  };
  unexpected(keys, SET_KEYS, 'set');
  const results = own(set, 'results');
  const resultKeys = plainKeys(results);
  if (resultKeys === null) { flag('set_shape', 'results'); return; }
  const known = new Set(CATALOG.map(q => q.id));
  for (const id of resultKeys) {
    if (!known.has(id)) { flag(IDENTITY_CLAIM.test(id) ? 'identity_claim_rejected' : 'set_shape', `results:${id}`); continue; }
    const rk = plainKeys(own(results, id));
    if (rk === null) { flag('set_shape', `result:${id}`); continue; }
    unexpected(rk, RESULT_KEYS, `result:${id}`);
  }
}

/** @param {unknown} normalizedSet @param {unknown} classification @param {unknown} reconciliation @param {...unknown} extra */
function assemble(normalizedSet, classification, reconciliation, ...extra) {
  /** @type {Map<string, {source:string,code:string,state:string,subject:string|null,detail:string|null}>} */
  const assemblyFindings = new Map();
  /** @param {string} code @param {string|null} [detail] */
  const flag = (code, detail = null) => {
    assemblyFindings.set(`${code}|${detail}`, { source: 'assembly', code, state: /** @type {Record<string,string>} */ (FINDINGS)[code], subject: null, detail });
  };
  if (extra.length > 0) flag('unexpected_argument', String(extra.length));
  checkSetShape(normalizedSet, flag);

  const expectedClassification = classify(normalizedSet);
  const expectedReconciliation = reconcile(normalizedSet, expectedClassification);
  /** @param {unknown} given @param {unknown} expected @param {string} code */
  const sameContent = (given, expected, code) => {
    try { if (JSON.stringify(snapshot(given, { n: 0 })) !== JSON.stringify(snapshot(expected, { n: 0 }))) flag(code, 'content'); } catch { flag(code, 'unreadable'); }
  };
  sameContent(classification, expectedClassification, 'classification_mismatch');
  sameContent(reconciliation, expectedReconciliation, 'reconciliation_mismatch');
  const coherent = assemblyFindings.size === 0;

  const c = /** @type {any} */ (expectedClassification);
  const r = /** @type {any} */ (expectedReconciliation);
  const inherited = [
    ...c.findings.map((/** @type {any} */ f) => ({ source: 'classification', ...f })),
    ...r.findings.map((/** @type {any} */ f) => ({ source: 'reconciliation', ...f })),
  ];
  const findings = [...inherited, ...assemblyFindings.values()].sort((a, b) => cmp(a.source, b.source) || cmp(a.code, b.code) || cmp(String(a.subject), String(b.subject)) || cmp(String(a.detail), String(b.detail)));
  const structural = !coherent ? 'invalid' : r.verdict.structural;
  const exclusions = [...new Set([...c.exclusions, ...r.exclusions])].sort();
  const withheld = !coherent || structural === 'invalid';
  return freezeDeep({
    coherent, schema: r.schema,
    evidence: withheld ? null : {
      inventory: r.inventory,
      objects: c.objects, routines: c.routines, types: c.types, companions: c.companions, toast: c.toast,
      dependencies: { edges: c.edges, cycles: c.cycles, closureClasses: c.closureClasses, summary: r.dependencies },
      observations: r.observations, concurrency: r.concurrency,
    },
    findings, exclusions, inputVerdict: r.inputVerdict,
    verdict: { structural, demonstration: 'not_demonstrated', status: structural === 'structurally_valid' ? 'not_demonstrated' : structural, eligible: false,
      reasons: [...r.verdict.reasons], excluded: exclusions.length > 0 },
    provenance: { ...PROVENANCE, structurallyCoherent: coherent },
    limitations: Object.keys(LIMITATIONS).sort(),
    serverValidated: false,
  });
}

module.exports = Object.freeze({ assemble, FINDINGS, LIMITATIONS, PROVENANCE, SET_KEYS, RESULT_KEYS, IDENTITY_CLAIM });
