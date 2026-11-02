'use strict';
/**
 * Pure authorization policy for removing a NON-EMPTY harness schema.
 *
 * Direction approved: controlled cleanup, never an unrestricted cascade. This module only DECIDES.
 * It produces no SQL, performs no I/O and is wired into no executor: the sweep and cleanup policies
 * keep using the plain, empty-only drop. A decision here is a precondition, never a command.
 *
 * Logical order of the three operations (enforced on the plan that travels between them):
 *   authorize(evidence)            -> plan{stage:'authorized',  authorizedSequence = sequence = a}
 *   revalidate(plan, evidence')    -> plan{stage:'revalidated', authorizedSequence = a, sequence = r > a}
 *   verifyOutcome(plan, observation) requires stage 'revalidated' and observation.sequence > r.
 * The same connection id, pid, transaction id and schema must appear in all three.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. The identifiers and the sequence are opaque values supplied by
 * the caller. This module checks that the evidence it is given is complete, mutually consistent, correctly
 * ordered and bound to one connection, one transaction and one schema. It does NOT prove that the evidence
 * is authentic or fresh: nothing here is cryptographic, the plan digest is a checksum that detects accidental
 * or naive alteration (anyone can recompute it), and provenance belongs to the trusted collector of S1-C.
 *
 * Contract, in the order it is applied:
 *   1. Evidence that authorizes   : who the schema is (pattern, mark, owner, run, lease, age) and that
 *                                   the connection that would act still holds L0 and L1 on the fixed target.
 *   2. Inventory and dependencies : complete, typed, de-duplicated and consistent with each other.
 *   3. Exclusion conditions       : kinds, owners, extensions, event triggers, default ACLs, external
 *                                   dependents, outbound dependencies, concurrency, size.
 *   4. Revalidation               : fresh evidence taken inside the acting transaction must reproduce the
 *                                   same fingerprint, context and order before anything may proceed.
 *   5. Outcome verification       : before COMMIT, the schema is gone, nothing remains in it, and the
 *                                   fingerprint of everything OUTSIDE it is unchanged. A notice count is
 *                                   only an upper-bound sanity check, never the guarantee.
 * Anything missing, malformed, contradictory, out of order or unknown fails closed.
 */
const { createHash } = require('node:crypto');
const { types } = require('node:util');
const { valid, validRun, parseMark } = require('./c8-names.cjs');
const { recognized } = require('./c8-gate.cjs');
const { MATRIX } = require('./c8-timeouts.cjs');
const { TARGET } = require('./c8-target.cjs');

const MAX_OBJECTS = 500;
const MAX_ITEMS = 2000;
const MAX_DEPTH = 6;
const MAX_KEYS = 64;
/** Per-field string bounds, by meaning. MAX.string is the coarse ceiling applied to every string. */
const MAX = Object.freeze({ string: 256, name: 63, owner: 63, comment: 96, kind: 32, coverage: 32, coverageItems: 64 });
const TOKEN = /^[A-Za-z0-9._-]{8,64}$(?![\s\S])/;
const HEX64 = /^[a-f0-9]{64}$(?![\s\S])/;
/** Kinds the approved DDL templates and fixtures can create. Everything else is foreign activity. */
const ALLOWED_KINDS = Object.freeze(['table', 'partitioned_table', 'view', 'matview', 'sequence', 'index',
  'function', 'procedure', 'type', 'domain']);
/** Catalogs whose rows must have been enumerated for the inventory to count as complete. */
const REQUIRED_COVERAGE = Object.freeze(['relations', 'routines', 'types', 'operators', 'collations', 'conversions',
  'opclasses', 'opfamilies', 'text_configs', 'text_dicts', 'text_parsers', 'text_templates', 'statistics', 'default_acls']);
const SYSTEM_SCHEMAS = Object.freeze(['pg_catalog', 'information_schema']);
const MODES = Object.freeze(['own', 'sweep']);
const ACTIONS = Object.freeze(['drop_plain', 'drop_controlled']);
const STAGES = Object.freeze(['authorized', 'revalidated']);
const PLAN_KEYS = Object.freeze(['action', 'authorizedSequence', 'connectionId', 'digest', 'fingerprint', 'kinds', 'mode',
  'objectCount', 'outsideFingerprint', 'pid', 'schema', 'sequence', 'stage', 'transactionId']);

/** exit 3 = uncertainty (unknown, incomplete, contradictory, out of order, lost); exit 2 = a finding that excludes the schema. */
const CODES = Object.freeze({
  ok: 0,
  drop_mode_invalid: 2, drop_identity_denied: 2, drop_age_denied: 2, drop_lease_denied: 2,
  drop_excluded_transaction: 2, drop_excluded_size: 2, drop_excluded_kind: 2, drop_excluded_owner: 2,
  drop_excluded_extension: 2, drop_excluded_external_dependents: 2, drop_excluded_outbound: 2,
  drop_excluded_event_trigger: 2, drop_excluded_default_acl: 2, drop_excluded_concurrency: 2,
  drop_target_unverified: 3, drop_lock_lost: 3, drop_evidence_unsafe: 3, drop_evidence_incomplete: 3,
  drop_evidence_contradictory: 3, drop_revalidation_mismatch: 3, drop_outcome_mismatch: 3,
  drop_plan_invalid: 3, drop_context_mismatch: 3, drop_order_violation: 3,
});

class Unsafe extends Error {}
class Incomplete extends Error {}
class Contradictory extends Error {}
class PlanInvalid extends Error {}

/** @param {string} code @param {'abort'|'rollback'} next */
function deny(code, next = 'abort') {
  return Object.freeze({ ok: false, code, exitCode: CODES[/** @type {keyof typeof CODES} */ (code)], next });
}

/** Deep, bounded, plain-data copy. Accessors, proxies, exotic prototypes, symbols, sparse arrays, non-finite
 * numbers and oversized strings are rejected without executing anything, so a later mutation of the caller's
 * object cannot change a decision that was already taken (no check/use gap).
 * @param {unknown} value @param {number} [depth] @returns {any} */
function plain(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new Unsafe();
  if (typeof value === 'string') { if (value.length > MAX.string) throw new Unsafe(); return value; }
  if (value === undefined || value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Unsafe(); return value; }
  if (typeof value !== 'object' || types.isProxy(value)) throw new Unsafe();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Unsafe();
    const length = descriptors.length && Object.hasOwn(descriptors.length, 'value') ? descriptors.length.value : -1;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ITEMS) throw new Unsafe();
    if (keys.length !== length + 1) throw new Unsafe();
    const out = [];
    for (let i = 0; i < length; i++) {
      const d = descriptors[String(i)];
      if (!d || !Object.hasOwn(d, 'value')) throw new Unsafe();
      out.push(plain(d.value, depth + 1));
    }
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if ((proto !== Object.prototype && proto !== null) || keys.length > MAX_KEYS) throw new Unsafe();
  /** @type {Record<string, unknown>} */
  const out = Object.create(null);
  for (const key of keys) {
    const d = descriptors[/** @type {string} */ (key)];
    if (typeof key !== 'string' || key.length > MAX.name || key === '__proto__' || !Object.hasOwn(d, 'value')) throw new Unsafe();
    out[key] = plain(d.value, depth + 1);
  }
  return out;
}

/** @param {unknown} v @returns {v is number} */
const count = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** @param {unknown} v @returns {v is number} */
const positive = v => count(v) && v > 0 && v <= 4294967295;
/** Monotonic observation counter supplied by the caller. @param {unknown} v @returns {v is number} */
const sequence = v => count(v) && v > 0;
/** @param {unknown} v @param {number} max @returns {v is string} */
const str = (v, max) => typeof v === 'string' && v.length <= max;
/** @param {unknown} v @returns {v is string} */
const token = v => typeof v === 'string' && TOKEN.test(v);
/** @param {unknown} v @returns {v is Record<string, any>} */
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Required-section accessor: missing or not an object means the evidence is incomplete.
 * @param {any} evidence @param {string} key */
function section(evidence, key) {
  const value = evidence[key];
  if (!record(value)) throw new Incomplete();
  return value;
}

/** @param {unknown} value */
function sha256(value) { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }

/** Canonical identity of everything the decision depended on. Any drift between two snapshots changes it.
 * @param {any} e @param {any[]} objects */
function fingerprintOf(e, objects) {
  const sorted = objects.map(o => [o.kind, o.oid, o.owner]).sort((a, b) => a[1] - b[1]);
  const outbound = e.dependents.outbound.map((/** @type {any} */ d) => [d.source, d.targetSchema, d.extension === true]).sort();
  return sha256({ v: 1, schema: e.schema.name, comment: e.schema.comment, owner: e.schema.owner, mode: e.mode,
    objects: sorted, outbound, outside: e.outside.fingerprint });
}

/** Builds the frozen plan and its checksum. The digest detects accidental or naive alteration only.
 * @param {Record<string, any>} f */
function buildPlan(f) {
  const kinds = Object.fromEntries(ALLOWED_KINDS.map(k => [k, f.kinds[k]]));
  const body = { action: f.action, schema: f.schema, mode: f.mode, objectCount: f.objectCount, kinds, pid: f.pid,
    connectionId: f.connectionId, transactionId: f.transactionId, stage: f.stage,
    authorizedSequence: f.authorizedSequence, sequence: f.sequence, fingerprint: f.fingerprint,
    outsideFingerprint: f.outsideFingerprint };
  return Object.freeze({ ...body, kinds: Object.freeze(kinds), digest: sha256(body) });
}

/** Structural validation of a plan received back from the caller. Throws PlanInvalid on any irregularity.
 * @param {unknown} raw @returns {Record<string, any>} */
function checkPlan(raw) {
  const p = plain(raw);
  if (!record(p) || Object.keys(p).sort().join() !== PLAN_KEYS.join()) throw new PlanInvalid();
  const k = p.kinds;
  if (!ACTIONS.includes(p.action) || !str(p.schema, MAX.name) || !valid(p.schema) || !MODES.includes(p.mode) ||
    !count(p.objectCount) || p.objectCount > MAX_OBJECTS || !positive(p.pid) || !token(p.connectionId) || !token(p.transactionId) ||
    !STAGES.includes(p.stage) || !sequence(p.authorizedSequence) || !sequence(p.sequence) ||
    typeof p.fingerprint !== 'string' || !HEX64.test(p.fingerprint) || typeof p.outsideFingerprint !== 'string' ||
    !HEX64.test(p.outsideFingerprint) || typeof p.digest !== 'string' || !HEX64.test(p.digest)) throw new PlanInvalid();
  if (!record(k) || Object.keys(k).sort().join() !== [...ALLOWED_KINDS].sort().join() ||
    !ALLOWED_KINDS.every(name => count(k[name])) || ALLOWED_KINDS.reduce((sum, name) => sum + k[name], 0) !== p.objectCount) throw new PlanInvalid();
  if ((p.action === 'drop_plain') !== (p.objectCount === 0)) throw new PlanInvalid();
  if (p.stage === 'authorized' ? p.authorizedSequence !== p.sequence : p.sequence <= p.authorizedSequence) throw new PlanInvalid();
  const { digest, ...body } = p;
  body.kinds = Object.fromEntries(ALLOWED_KINDS.map(name => [name, k[name]]));
  if (sha256({ action: body.action, schema: body.schema, mode: body.mode, objectCount: body.objectCount, kinds: body.kinds,
    pid: body.pid, connectionId: body.connectionId, transactionId: body.transactionId, stage: body.stage,
    authorizedSequence: body.authorizedSequence, sequence: body.sequence, fingerprint: body.fingerprint,
    outsideFingerprint: body.outsideFingerprint }) !== digest) throw new PlanInvalid();
  return p;
}

/** @param {any} e */
function checkIdentity(e) {
  if (!MODES.includes(e.mode)) return deny('drop_mode_invalid');
  const s = section(e, 'schema');
  if (!str(s.name, MAX.name) || !str(s.comment, MAX.comment) || !str(s.owner, MAX.owner)) throw new Incomplete();
  if (SYSTEM_SCHEMAS.includes(s.name) || s.name === 'public' || s.name.startsWith('pg_') || !valid(s.name)) return deny('drop_identity_denied');
  if (!recognized(/** @type {any} */ (s)) || s.owner !== TARGET.owner) return deny('drop_identity_denied');
  const markRun = parseMark(s.comment);
  if (e.mode === 'own' && (!validRun(e.runId) || markRun !== e.runId)) return deny('drop_identity_denied');
  if (e.mode === 'sweep' && e.runId !== undefined && !validRun(e.runId)) return deny('drop_identity_denied');
  if (s.leaseOwned !== true) return deny('drop_lease_denied');
  if (e.mode === 'sweep') {
    if (s.lease !== 'free') return deny('drop_lease_denied');
    if (!count(s.ageMs) || s.ageMs < MATRIX.sweepAge) return deny('drop_age_denied');
  }
  return null;
}

/** @param {any} e */
function checkInventory(e) {
  const inv = section(e, 'inventory');
  if (inv.complete !== true || !Array.isArray(inv.coverage) || !Array.isArray(inv.objects) || !count(inv.total)) throw new Incomplete();
  if (inv.coverage.length > MAX.coverageItems || inv.coverage.some((/** @type {unknown} */ c) => !str(c, MAX.coverage))) throw new Incomplete();
  if (!REQUIRED_COVERAGE.every(name => inv.coverage.includes(name))) throw new Incomplete();
  const dep = section(e, 'dependents');
  if (dep.complete !== true || !Array.isArray(dep.inbound) || !Array.isArray(dep.outbound)) throw new Incomplete();
  const ext = section(e, 'extensions'); if (ext.complete !== true || !count(ext.members)) throw new Incomplete();
  const evt = section(e, 'eventTriggers'); if (evt.complete !== true || !count(evt.count)) throw new Incomplete();
  const def = section(e, 'defaults'); if (def.complete !== true || !count(def.count)) throw new Incomplete();
  const out = section(e, 'outside');
  if (out.complete !== true || typeof out.fingerprint !== 'string' || !HEX64.test(out.fingerprint)) throw new Incomplete();
  // Consistency between independent pieces of evidence.
  if (inv.total !== inv.objects.length) throw new Contradictory();
  const oids = new Set();
  for (const o of inv.objects) {
    if (!record(o) || !str(o.kind, MAX.kind) || !str(o.owner, MAX.owner) || typeof o.extensionMember !== 'boolean' ||
      !str(o.schema, MAX.name) || !positive(o.oid)) throw new Incomplete();
    if (o.schema !== e.schema.name) throw new Contradictory();
    if (oids.has(o.oid)) throw new Contradictory();
    oids.add(o.oid);
  }
  for (const d of dep.inbound) {
    if (!record(d) || !positive(d.target) || !positive(d.source)) throw new Incomplete();
    if (!oids.has(d.target)) throw new Contradictory();
  }
  for (const d of dep.outbound) {
    if (!record(d) || !positive(d.source) || !str(d.targetSchema, MAX.name) || typeof d.extension !== 'boolean') throw new Incomplete();
    if (!oids.has(d.source)) throw new Contradictory();
  }
  if (inv.objects.length > MAX_OBJECTS) return deny('drop_excluded_size');
  if (inv.objects.some((/** @type {any} */ o) => !ALLOWED_KINDS.includes(o.kind))) return deny('drop_excluded_kind');
  if (inv.objects.some((/** @type {any} */ o) => o.owner !== TARGET.owner)) return deny('drop_excluded_owner');
  if (inv.objects.some((/** @type {any} */ o) => o.extensionMember) || ext.members > 0) return deny('drop_excluded_extension');
  if (dep.inbound.length > 0) return deny('drop_excluded_external_dependents');
  if (dep.outbound.some((/** @type {any} */ d) => d.extension || !SYSTEM_SCHEMAS.includes(d.targetSchema))) return deny('drop_excluded_outbound');
  if (evt.count > 0) return deny('drop_excluded_event_trigger');
  if (def.count > 0) return deny('drop_excluded_default_acl');
  return null;
}

/** Tri-valued, like the cleanup policy: unknown is uncertainty, a positive finding excludes.
 * @param {any} e */
function checkConcurrency(e) {
  const q = section(e, 'quiescence');
  if (!count(q.runSessions) || !Array.isArray(q.otherRolePids) || typeof q.foreignLocks !== 'boolean') throw new Incomplete();
  if (q.otherRolePids.some((/** @type {unknown} */ pid) => !positive(pid))) throw new Incomplete();
  if (q.runSessions !== 0 || q.otherRolePids.length !== 0 || q.foreignLocks !== false) return deny('drop_excluded_concurrency');
  return null;
}

/** @param {any} e */
function checkLiveness(e) {
  // Loss of the lock-holding connection invalidates every later destructive step, whatever else is true.
  if (e.l0 !== true || e.l1 !== true) return deny('drop_lock_lost');
  if (e.target !== true) return deny('drop_target_unverified');
  const c = section(e, 'connection');
  if (!positive(c.pid) || !token(c.id)) throw new Incomplete();
  const t = section(e, 'transaction');
  if (!token(t.id)) throw new Incomplete();
  if (!sequence(e.sequence)) throw new Incomplete();
  if (t.open !== true || t.readOnly !== false || t.lockTimeoutMs !== MATRIX.ownerLock) return deny('drop_excluded_transaction');
  return null;
}

/** @param {unknown} raw */
function snapshot(raw) {
  const e = plain(raw);
  if (!record(e)) throw new Incomplete();
  return e;
}

/** @param {unknown} error */
function classify(error) {
  if (error instanceof PlanInvalid) return 'drop_plan_invalid';
  if (error instanceof Contradictory) return 'drop_evidence_contradictory';
  if (error instanceof Incomplete) return 'drop_evidence_incomplete';
  return 'drop_evidence_unsafe';
}

/** Steps 1-3. Returns a frozen decision; on success `plan` describes WHAT may be done, never SQL.
 * @param {unknown} raw */
function authorize(raw) {
  try {
    const e = snapshot(raw);
    const alive = checkLiveness(e); if (alive) return alive;
    for (const check of [checkIdentity, checkInventory, checkConcurrency]) { const denied = check(e); if (denied) return denied; }
    const objects = e.inventory.objects;
    const kinds = Object.fromEntries(ALLOWED_KINDS.map(k => [k, objects.filter((/** @type {any} */ o) => o.kind === k).length]));
    const plan = buildPlan({
      action: objects.length === 0 ? 'drop_plain' : 'drop_controlled', schema: e.schema.name, mode: e.mode,
      objectCount: objects.length, kinds, pid: e.connection.pid, connectionId: e.connection.id, transactionId: e.transaction.id,
      stage: 'authorized', authorizedSequence: e.sequence, sequence: e.sequence,
      fingerprint: fingerprintOf(e, objects), outsideFingerprint: e.outside.fingerprint,
    });
    return Object.freeze({ ok: true, code: 'ok', exitCode: 0, next: 'proceed', plan });
  } catch (error) { return deny(classify(error)); }
}

/** Step 4. Fresh evidence, taken inside the acting transaction, must reproduce the plan exactly, belong to the
 * same connection, transaction and schema, and be observed AFTER the authorization. On success the returned plan
 * is in stage 'revalidated': only such a plan is accepted by verifyOutcome.
 * @param {unknown} rawPlan @param {unknown} rawFresh */
function revalidate(rawPlan, rawFresh) {
  let plan;
  try { plan = checkPlan(rawPlan); } catch (error) { return deny(classify(error)); }
  if (plan.stage !== 'authorized') return deny('drop_order_violation');
  const fresh = authorize(rawFresh);
  if (!fresh.ok) return fresh;
  const next = /** @type {any} */ (fresh).plan;
  if (next.connectionId !== plan.connectionId || next.pid !== plan.pid || next.transactionId !== plan.transactionId ||
    next.schema !== plan.schema || next.mode !== plan.mode) return deny('drop_context_mismatch');
  if (next.sequence <= plan.sequence) return deny('drop_order_violation');
  if (next.fingerprint !== plan.fingerprint || next.action !== plan.action || next.objectCount !== plan.objectCount ||
    next.outsideFingerprint !== plan.outsideFingerprint) return deny('drop_revalidation_mismatch');
  const revalidated = buildPlan({ ...next, stage: 'revalidated', authorizedSequence: plan.authorizedSequence, sequence: next.sequence });
  return Object.freeze({ ok: true, code: 'ok', exitCode: 0, next: 'proceed', plan: revalidated });
}

/** Step 5. Run before COMMIT, on a revalidated plan and an observation taken after it, in the same connection,
 * transaction and schema. Anything other than a clean, fully accounted outcome means ROLLBACK.
 * @param {unknown} rawPlan @param {unknown} rawObservation */
function verifyOutcome(rawPlan, rawObservation) {
  let plan;
  let o;
  try { plan = checkPlan(rawPlan); } catch (error) { return deny(classify(error), 'rollback'); }
  try { o = plain(rawObservation); } catch { return deny('drop_evidence_unsafe', 'rollback'); }
  try {
    if (plan.stage !== 'revalidated') return deny('drop_order_violation', 'rollback');
    if (!record(o)) return deny('drop_evidence_incomplete', 'rollback');
    if (o.l0 !== true || o.l1 !== true) return deny('drop_lock_lost', 'rollback');
    const c = o.connection; const t = o.transaction;
    if (!str(o.schema, MAX.name) || !record(c) || !token(c.id) || !positive(c.pid) || !record(t) || !token(t.id) ||
      typeof t.open !== 'boolean' || !sequence(o.sequence)) return deny('drop_evidence_incomplete', 'rollback');
    if (o.schema !== plan.schema || c.id !== plan.connectionId || c.pid !== plan.pid || t.id !== plan.transactionId ||
      t.open !== true) return deny('drop_context_mismatch', 'rollback');
    if (o.sequence <= plan.sequence) return deny('drop_order_violation', 'rollback');
    if (o.schemaAbsent !== true) return deny('drop_outcome_mismatch', 'rollback');
    const remaining = o.remaining;
    if (!record(remaining) || remaining.complete !== true || !count(remaining.total)) return deny('drop_evidence_incomplete', 'rollback');
    const outside = o.outside;
    if (!record(outside) || outside.complete !== true || typeof outside.fingerprint !== 'string' || !HEX64.test(outside.fingerprint)) return deny('drop_evidence_incomplete', 'rollback');
    if (remaining.total !== 0 || outside.fingerprint !== plan.outsideFingerprint) return deny('drop_outcome_mismatch', 'rollback');
    if (o.noticeCount !== undefined && o.noticeCount !== null) {
      // Sanity bound only: notices list a subset of the inventoried objects, never more.
      const bound = plan.action === 'drop_plain' ? 0 : plan.objectCount;
      if (!count(o.noticeCount) || o.noticeCount > bound) return deny('drop_outcome_mismatch', 'rollback');
    }
    return Object.freeze({ ok: true, code: 'ok', exitCode: 0, next: 'commit' });
  } catch { return deny('drop_evidence_unsafe', 'rollback'); }
}

module.exports = Object.freeze({ CODES, ALLOWED_KINDS, REQUIRED_COVERAGE, MAX_OBJECTS, MAX, authorize, revalidate, verifyOutcome });
