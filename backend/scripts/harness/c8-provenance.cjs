'use strict';
/**
 * Offline provenance and single-use lifecycle. Dependencies are trusted, synchronous functions.
 * Construction/open/begin throw on invalid input. stamp and decision methods always return a
 * frozen rejection on failure; any failure retires the transaction. end also retires it as failed.
 * A successful verification is terminal. Retired identifiers are never evicted: capacity exhaustion
 * closes the context. Identity uniqueness is scoped to this factory, not to other factories.
 */
const { randomBytes } = require('node:crypto');

const PENDING_DEPENDENCIES = Object.freeze([
  'Pending: physical backend identity, pid/backend_start verified against pg_stat_activity.',
  'Pending: server transaction identity (xid), not implemented.',
  'l0/l1 are unverified caller assertions here.',
]);
const CODES = Object.freeze({ provenance_not_issued: 3, provenance_cross_context: 3,
  provenance_replayed: 3, provenance_out_of_order: 3, provenance_state: 3,
  provenance_context_lost: 3, provenance_invalid: 3 });
const LIMITS = Object.freeze({ connections: 1000, transactionsPerConnection: 1000, identifiers: 10000 });
/** @typedef {keyof typeof CODES} Code */
/** @param {Code} code */
function deny(code) { return Object.freeze({ ok: false, code, exitCode: CODES[code] }); }
/** @returns {never} */
function invalid() { throw new Error('provenance_invalid'); }

/** Bounded frozen data snapshot. Descriptors reject accessors without calling them. The native
 * clone check rejects transparent and revoked proxies, including nested/nonenumerable values.
 * Nothing from the clone is used: the descriptor snapshot preserves null prototypes and keys.
 * @param {unknown} raw @returns {any} */
function snapshot(raw) {
  let budget = 10000;
  /** @param {unknown} value @param {number} depth @returns {any} */
  function copy(value, depth) {
    if (--budget < 0 || depth > 12) return invalid();
    if (value === null || value === undefined || typeof value === 'boolean') return value;
    if (typeof value === 'string') { if (value.length > 4096) return invalid(); return value; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) return invalid(); return value; }
    if (typeof value !== 'object') return invalid();
    const proto = Object.getPrototypeOf(value);
    const array = Array.isArray(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 2048) return invalid();
    /** @type {any} */
    const out = array ? [] : Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || key === '__proto__') return invalid();
      const d = descriptors[key];
      if (!Object.hasOwn(d, 'value')) return invalid();
      if (array && key === 'length') continue;
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= descriptors.length.value)) return invalid();
      out[key] = copy(d.value, depth + 1);
    }
    if (array && keys.length !== descriptors.length.value + 1) return invalid();
    structuredClone(value);
    return Object.freeze(out);
  }
  return copy(raw, 0);
}
/** @param {unknown} raw @param {string[]} keys @returns {any} */
function argumentsOf(raw, keys) {
  const value = snapshot(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return invalid();
  return value;
}

/**
 * @typedef {{authorize: (e: any) => any, revalidate: (p: any, e: any) => any,
 * verifyOutcome: (p: any, e: any) => any}} Policy
 * @param {{random?: (n: number) => Uint8Array, policy: Policy}} options
 */
function createProvenance(options) {
  // Function dependencies cannot be data-cloned. Resolve once; no caller-owned container is retained.
  if (!options || typeof options !== 'object') return invalid();
  const random = options.random === undefined ? randomBytes : options.random;
  const supplied = options.policy;
  if (typeof random !== 'function' || !supplied) return invalid();
  const policy = Object.freeze({ authorize: supplied.authorize, revalidate: supplied.revalidate,
    verifyOutcome: supplied.verifyOutcome });
  if (Object.values(policy).some(fn => typeof fn !== 'function')) return invalid();
  const ids = new Set();
  const issued = new WeakSet();
  /** @type {WeakMap<object, {owner: object, sequence: number, consumed: boolean}>} */
  const records = new WeakMap();
  let live = true;
  let allocating = false;
  let connections = 0;
  /** @param {string} prefix */
  function identifier(prefix) {
    if (!live || allocating || ids.size >= LIMITS.identifiers) { live = false; return invalid(); }
    allocating = true;
    try {
      const bytes = random(16);
      if (!(bytes instanceof Uint8Array)) return invalid();
      // Native typed-array iteration rejects proxies and ignores overridden length/iterator properties.
      const values = Array.from(Uint8Array.prototype.values.call(bytes));
      if (values.length !== 16 || !live) return invalid();
      const id = prefix + values.map(n => n.toString(16).padStart(2, '0')).join('');
      if (ids.has(id)) return invalid();
      ids.add(id);
      return id;
    } catch { live = false; return invalid(); }
    finally { allocating = false; }
  }
  /** @param {unknown} input */
  function openConnection(input) {
    if (!live) return invalid();
    const { pid } = argumentsOf(input, ['pid']);
    if (!Number.isSafeInteger(pid) || pid <= 0) return invalid();
    if (connections >= LIMITS.connections) { live = false; return invalid(); }
    const id = identifier('conn-');
    connections++;
    let connected = true;
    let beginning = false;
    let sequence = 0;
    let transactions = 0;
    /** @type {null | ((onlyIfBusy?: boolean) => void)} */
    let retireActive = null;
    const isLive = () => live && connected;
    function close() {
      connected = false;
      if (retireActive) retireActive();
    }
    /** @param {unknown} input */
    function beginTransaction(input) {
      if (!isLive() || beginning) { close(); return invalid(); }
      if (retireActive) { retireActive(true); return invalid(); }
      const { mode } = argumentsOf(input, ['mode']);
      if (mode !== 'acting' && mode !== 'assessment') return invalid();
      if (transactions >= LIMITS.transactionsPerConnection) { close(); return invalid(); }
      beginning = true;
      /** @type {string} */
      let transactionId;
      try {
        transactionId = identifier('txn-');
        if (!isLive()) return invalid();
      } catch { close(); return invalid(); }
      finally { beginning = false; }
      transactions++;
      const owner = Object.freeze({});
      let status = 'idle';
      let active = true;
      let busy = false;
      let last = 0;
      /** @type {any} */
      let plan;
      function retire() {
        active = false;
        plan = undefined;
        retireActive = null;
      }
      function end() {
        if (active) { status = 'failed'; retire(); }
      }
      // A rejected nested begin must retire a busy transaction even if the callback catches it.
      retireActive = (onlyIfBusy = false) => { if (!onlyIfBusy || busy) end(); };
      /** @param {Code} code */
      function fail(code) { end(); return deny(code); }
      function available() {
        if (!isLive() || !active) return fail('provenance_context_lost');
        if (busy) return fail('provenance_state');
        return null;
      }
      /** @param {unknown} body @returns {any} */
      function stamp(body) {
        const unavailable = available(); if (unavailable) return unavailable;
        busy = true;
        try {
          const data = snapshot(body);
          if (!data || typeof data !== 'object' || Array.isArray(data) ||
            ['connection', 'transaction', 'sequence'].some(key => Object.hasOwn(data, key))) return fail('provenance_invalid');
          if (!isLive() || !active) return fail('provenance_context_lost');
          if (sequence === Number.MAX_SAFE_INTEGER) { close(); return fail('provenance_context_lost'); }
          const next = sequence + 1;
          const evidence = Object.freeze({ ...data, connection: Object.freeze({ id, pid }),
            transaction: Object.freeze({ id: transactionId, open: true, readOnly: mode === 'assessment', lockTimeoutMs: 2000 }),
            sequence: next });
          issued.add(evidence);
          records.set(evidence, { owner, sequence: next, consumed: false });
          sequence = next;
          return evidence;
        } catch { return fail('provenance_invalid'); }
        finally { busy = false; }
      }
      /** @param {'authorize'|'revalidate'|'verifyOutcome'} operation @param {unknown} evidence @returns {any} */
      function decide(operation, evidence) {
        const unavailable = available(); if (unavailable) return unavailable;
        busy = true;
        try {
          if (!evidence || typeof evidence !== 'object' || !issued.has(evidence)) return fail('provenance_not_issued');
          const record = records.get(evidence);
          if (!record) return fail('provenance_not_issued');
          const consumed = record.consumed;
          record.consumed = true;
          if (record.owner !== owner) return fail('provenance_cross_context');
          if (consumed) return fail('provenance_replayed');
          if (record.sequence <= last) return fail('provenance_out_of_order');
          last = record.sequence;
          const expected = { authorize: 'idle', revalidate: 'authorized', verifyOutcome: 'revalidated' };
          if (status !== expected[operation]) return fail('provenance_state');
          if (mode === 'assessment') return fail('provenance_state');
          const result = snapshot(operation === 'authorize' ? policy.authorize(evidence) : policy[operation](plan, evidence));
          if (!isLive() || !active) return fail('provenance_context_lost');
          if (!result || typeof result.ok !== 'boolean' || typeof result.code !== 'string' ||
            (result.ok ? result.exitCode !== 0 : ![2, 3].includes(result.exitCode))) return fail('provenance_invalid');
          if (!result.ok) { end(); return result; }
          if (operation === 'verifyOutcome') { status = 'verified'; retire(); }
          else {
            if (!result.plan || typeof result.plan !== 'object' || Array.isArray(result.plan)) return fail('provenance_invalid');
            plan = snapshot(result.plan);
            status = operation === 'authorize' ? 'authorized' : 'revalidated';
          }
          return result;
        } catch { return fail('provenance_invalid'); }
        finally { busy = false; }
      }
      return Object.freeze({ stamp, authorize: (/** @type {unknown} */ evidence) => decide('authorize', evidence),
        revalidate: (/** @type {unknown} */ evidence) => decide('revalidate', evidence),
        verifyOutcome: (/** @type {unknown} */ evidence) => decide('verifyOutcome', evidence), end,
        state: () => { if (!isLive()) end(); return status; } });
    }
    return Object.freeze({ beginTransaction, close, markLost: close, isLive });
  }
  return Object.freeze({ openConnection });
}

module.exports = Object.freeze({ createProvenance, CODES, LIMITS, PENDING_DEPENDENCIES });
