'use strict';
/**
 * Pure normalizers from raw query observations to frozen, state-annotated results. No I/O, no SQL,
 * no connection or transaction identity (it neither invents nor reads any), no attestations.
 *
 * An observation is the exact record
 *   { id, sqlSha256, values, result: { status:'rows', rows } | { status:'error', code } }
 * for one of the closed-catalog queries. Nothing here is ever demonstrated against a server: every
 * result carries the not_demonstrated condition and rows are exposed only when structurally valid.
 *
 * Input reader: what is and is not claimed. Proxies are never inspected, only rejected. The first
 * operation on an object is util.types.isProxy, a native identity check that runs no trap; a Proxy
 * (revoked or not) becomes hostile_input. The one operation that precedes it is Array.isArray inside
 * readData, which on a Proxy also runs no trap (it follows the target; a revoked Proxy throws, and the
 * throw is caught as malformed_observation). Every other object is read through its own data
 * descriptors, never through [[Get]], so accessors, toString/toJSON/valueOf, symbols, then and
 * functions are never invoked: they are rejected (accessors, symbols, functions, extra keys).
 * Limits: this assumes unpatched built-ins (isProxy, Array.isArray, Object.getPrototypeOf,
 * Object.getOwnPropertyDescriptors, Reflect.ownKeys) and a clean Object.prototype; code already hostile
 * inside the process is out of scope. Objects from another realm or with a non-plain prototype are
 * rejected, which is conservative. A rejected input never becomes valid evidence: it yields an invalid
 * result without rows.
 */
const { types: { isProxy } } = require('node:util');
const { CATALOG, get, build, checkRows } = require('./c8-evidence-queries.cjs');
const states = require('./c8-evidence-states.cjs');

const ERROR_CODES = Object.freeze(['timeout', 'permission', 'connection_lost', 'other']);
const LIMITS = Object.freeze({ observations: 64, string: 8192, nodes: 200000, depth: 5, values: 4, diagnosed: 50 });
const U32 = 4294967295;
const I32 = 2147483647;
const I64 = 9223372036854775807n;
const DEPTYPES = Object.freeze(['n', 'a', 'i', 'P', 'S', 'e', 'x']);
const CLASSID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$(?![\s\S])/;

/** @param {unknown} v @param {number} min @param {number} max */
const intIn = (v, min, max) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
/** @param {unknown} v @param {number} min @param {number} max */
const strIn = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
/** @param {unknown} v */
const decimal = v => typeof v === 'string' && v.length <= 19 && /^(?:0|[1-9][0-9]*)$(?![\s\S])/.test(v) && BigInt(v) <= I64;

/** Value check per column kind and the reason raised when it fails. */
/** @param {(v: unknown) => boolean} ok @param {string} reason */
const kind = (ok, reason) => ({ ok, reason });
const KINDS = Object.freeze({
  oidpos: kind(v => intIn(v, 1, U32), 'number_out_of_range'),
  oid: kind(v => intIn(v, 0, U32), 'number_out_of_range'),
  int4: kind(v => intIn(v, 0, I32), 'number_out_of_range'),
  depth: kind(v => intIn(v, 1, 32), 'number_out_of_range'),
  pid: kind(v => intIn(v, 1, I32), 'number_out_of_range'),
  decimal: kind(decimal, 'decimal_not_canonical'),
  deptype: kind(v => typeof v === 'string' && DEPTYPES.includes(v), 'enum_violation'),
  name: kind(v => strIn(v, 1, 256), 'column_type'),
  text: kind(v => strIn(v, 0, 256), 'column_type'),
  longtext: kind(v => strIn(v, 0, LIMITS.string), 'column_type'),
  timestamp: kind(v => strIn(v, 1, 64), 'column_type'),
  setting: kind(v => strIn(v, 1, 64), 'column_type'),
  classid: kind(v => strIn(v, 1, 127) && CLASSID.test(/** @type {string} */ (v)), 'column_type'),
  classid0: kind(v => v === '' || (strIn(v, 1, 127) && CLASSID.test(/** @type {string} */ (v))), 'column_type'),
  char1: kind(v => typeof v === 'string' && /^[\x21-\x7e]$(?![\s\S])/.test(v), 'column_type'),
  digest: kind(v => typeof v === 'string' && /^[0-9a-f]{64}$(?![\s\S])/.test(v), 'column_type'),
  bool: kind(v => typeof v === 'boolean', 'column_type'),
});
/** Kind of every column of every catalog query. Anything missing here makes that query unusable. */
const COLUMN_KINDS = Object.freeze({
  ev_context: { pid: 'pid', backend_start: 'timestamp', database: 'name', current_user: 'name', session_user: 'name',
    transaction_read_only: 'setting', transaction_isolation: 'setting', lock_timeout: 'setting', statement_timeout: 'setting',
    idle_in_transaction_session_timeout: 'setting', server_version_num: 'setting', in_recovery: 'bool' },
  ev_namespace: { oid: 'oidpos', name: 'name', owner: 'name', comment: 'longtext', acl: 'longtext' },
  ev_relations: { oid: 'oidpos', relname: 'name', relkind: 'char1', owner: 'name', relispartition: 'bool', relpersistence: 'char1',
    reltoastrelid: 'oid', relhasrules: 'bool', relhastriggers: 'bool', relrowsecurity: 'bool', acl: 'longtext' },
  ev_routines: { oid: 'oidpos', proname: 'name', prokind: 'char1', owner: 'name', acl: 'longtext' },
  ev_types: { oid: 'oidpos', typname: 'name', typtype: 'char1', typrelid: 'oid', typarray: 'oid', owner: 'name' },
  ev_namespace_catalog_counts: { class: 'decimal', proc: 'decimal', type: 'decimal', operator: 'decimal', collation: 'decimal',
    conversion: 'decimal', opclass: 'decimal', opfamily: 'decimal', ts_config: 'decimal', ts_dict: 'decimal', ts_parser: 'decimal',
    ts_template: 'decimal', statistic_ext: 'decimal', default_acl: 'decimal', extension: 'decimal' },
  ev_companions: { kind: 'name', subtype: 'text', n: 'decimal' },
  ev_closure: { depth: 'depth', classid: 'classid', objid: 'oidpos', objsubid: 'int4', deptype: 'deptype' },
  ev_external_dependents: { depth: 'depth', classid: 'classid', objid: 'oidpos', objsubid: 'int4', deptype: 'deptype',
    refclassid: 'classid', refobjid: 'oidpos', namespace: 'name' },
  ev_extension_members: { extension_oid: 'oidpos', extension_name: 'name', classid: 'classid', objid: 'oidpos', objsubid: 'int4' },
  ev_event_triggers: { oid: 'oidpos', evtname: 'name', evtevent: 'text', evtenabled: 'char1', owner: 'name' },
  ev_role_membership: { oid: 'oidpos', membership: 'bool', set_membership: 'bool' },
  ev_default_acl_schema: { oid: 'oidpos' },
  ev_default_acl_global: { owner_role: 'name', object_type: 'char1', grantee_public: 'bool', grantee_app: 'bool' },
  ev_outside_census: { catalog: 'name', n: 'decimal', digest: 'digest' },
  ev_sessions: { pid: 'pid', usename: 'name', application_name: 'text', backend_type: 'name', state: 'text', xact_start: 'timestamp',
    wait_event_type: 'text' },
  ev_target_relation_locks: { pid: 'pid', locktype: 'name', mode: 'name', granted: 'bool', relation: 'oidpos' },
  ev_advisory_holders: { pid: 'pid', database: 'oidpos', mode: 'name', granted: 'bool' },
  ev_prepared_xacts: { gid: 'name', owner: 'name', database: 'name' },
  ev_outbound_references: { source_classid: 'classid', source_objid: 'oidpos', source_subid: 'int4', group_classid: 'classid',
    group_oid: 'oidpos', deptype: 'deptype', ref_classid: 'classid', ref_objid: 'oidpos', ref_subid: 'int4', target_schema: 'name' },
  ev_companion_items: { item_kind: 'name', item_classid: 'classid', item_oid: 'oidpos', item_namespace_oid: 'oidpos',
    group_classid: 'classid', group_oid: 'oidpos', related_classid: 'classid0', related_oid: 'oid', subtype: 'text', name: 'text',
    edge_deptype: 'deptype', edge_ref_subid: 'decimal', extension_edges: 'decimal' },
  ev_internal_edges: { source_classid: 'classid', source_objid: 'oidpos', source_subid: 'int4', source_group_classid: 'classid',
    source_group_oid: 'oidpos', deptype: 'deptype', ref_classid: 'classid', ref_objid: 'oidpos', ref_subid: 'int4',
    ref_group_classid: 'classid', ref_group_oid: 'oidpos' },
});
/**
 * What a NULL means, per nullable column. default/absent are legitimate and only recorded; unknown means
 * the value is hidden or undeterminable (never read as "nothing there"); unresolved means a destination
 * that could not be classified.
 */
const NULL_MEANINGS = Object.freeze({
  ev_context: { backend_start: 'unknown' },
  ev_namespace: { comment: 'absent', acl: 'default' },
  ev_relations: { acl: 'default' },
  ev_routines: { acl: 'default' },
  ev_role_membership: { membership: 'unknown', set_membership: 'unknown' },
  ev_sessions: { usename: 'unknown', application_name: 'unknown', backend_type: 'unknown', state: 'unknown', xact_start: 'unknown',
    wait_event_type: 'unknown' },
  ev_target_relation_locks: { pid: 'absent' },
  ev_advisory_holders: { pid: 'absent' },
  ev_external_dependents: { namespace: 'unresolved' },
  ev_outbound_references: { target_schema: 'unresolved' },
  ev_companion_items: { edge_deptype: 'absent', edge_ref_subid: 'absent' },
});
/** Columns that must be unique inside one result (a repeated identity is a contract breach, not data). */
const IDENTITY_KEYS = Object.freeze({
  ev_namespace: ['oid'], ev_relations: ['oid'], ev_routines: ['oid'], ev_types: ['oid'], ev_event_triggers: ['oid'],
  ev_default_acl_schema: ['oid'],
});

class Hostile extends Error {}
/** @returns {never} */
function hostile() { throw new Hostile('hostile'); }

/** Own data descriptors only; rejects proxies, accessors, symbols, hidden keys and exotic prototypes.
 * @param {unknown} value @param {boolean} array @returns {Record<string, PropertyDescriptor>} */
function ownData(value, array) {
  if (value === null || typeof value !== 'object' || isProxy(value)) return hostile();
  const proto = Object.getPrototypeOf(value);
  if (array ? !Array.isArray(value) || proto !== Array.prototype
    : Array.isArray(value) || (proto !== Object.prototype && proto !== null)) return hostile();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') return hostile();
    const d = descriptors[key];
    if (!Object.hasOwn(d, 'value') || (d.enumerable !== true && !(array && key === 'length'))) return hostile();
  }
  return descriptors;
}
/** Bounded deep copy of plain data into frozen values. Non-finite numbers pass through to be classified later.
 * @param {unknown} value @param {{nodes:number,maxArray:number}} ctx @param {number} [depth] @returns {any} */
function readData(value, ctx, depth = 0) {
  if (++ctx.nodes > LIMITS.nodes || depth > LIMITS.depth) return hostile();
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > LIMITS.string ? hostile() : value;
  if (typeof value !== 'object') return hostile();
  if (Array.isArray(value)) {
    const d = ownData(value, true);
    const length = d.length.value;
    if (length > ctx.maxArray || Reflect.ownKeys(d).length !== length + 1) return hostile();
    const out = [];
    for (let i = 0; i < length; i++) {
      const item = d[String(i)];
      if (!item) return hostile();
      out.push(readData(item.value, ctx, depth + 1));
    }
    return Object.freeze(out);
  }
  const d = ownData(value, false);
  const keys = Object.keys(d);
  if (keys.length > 40 || keys.includes('__proto__')) return hostile();
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of keys) out[key] = readData(d[key].value, ctx, depth + 1);
  return Object.freeze(out);
}

/** @typedef {typeof CATALOG[number]} Entry */
/** @typedef {Readonly<{row:number,column:string,meaning:string}>} NullNote */
/** @typedef {Readonly<{id: string|null, sqlSha256: string|null, values: readonly any[], schema: string|null,
 * verdict: ReturnType<typeof states.fromReasons>, rowCount: number|null, rows: readonly Record<string, any>[]|null,
 * nulls: readonly NullNote[], check: any, errorCode: string|null, serverValidated: false}>} NormalizedResult */
/** @param {Entry|null} entry @param {readonly string[]} reasons @param {Record<string, any>} [extra] @returns {NormalizedResult} */
function result(entry, reasons, extra = {}) {
  const verdict = states.fromReasons(reasons);
  const rows = verdict.structural === 'structurally_valid' ? extra.rows ?? null : null;
  return Object.freeze({
    id: entry ? entry.id : null, sqlSha256: entry ? entry.sqlSha256 : null, values: extra.values ?? Object.freeze([]),
    schema: extra.schema ?? null, verdict, rowCount: extra.rowCount ?? null, rows,
    nulls: rows ? extra.nulls ?? Object.freeze([]) : Object.freeze([]), check: extra.check ?? null,
    errorCode: extra.errorCode ?? null, serverValidated: false,
  });
}

/** Why checkRows judged the shape invalid, as precisely as the data allows.
 * @param {Entry} entry @param {readonly any[]} rows @returns {string[]} */
function diagnose(entry, rows) {
  const found = new Set();
  if (rows.length > entry.maxRows + 1) found.add('rows_invalid');
  for (const row of rows.slice(0, LIMITS.diagnosed)) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) { found.add('rows_invalid'); continue; }
    const keys = Object.keys(row);
    if (keys.length !== entry.columns.length || !entry.columns.every(c => Object.hasOwn(row, c.name))) { found.add('column_shape'); continue; }
    for (const c of entry.columns) {
      const v = row[c.name];
      if (v === null) { if (!c.nullable) found.add('null_contract_violation'); } else if (typeof v !== c.type) found.add('column_type');
      else if (c.type === 'number' && !Number.isFinite(v)) found.add('number_out_of_range');
    }
  }
  return found.size ? [...found] : ['rows_invalid'];
}
/** Value-level contract per column kind, NULL meanings and duplicate detection on shape-valid rows.
 * @param {Entry} entry @param {readonly any[]} rows */
function inspectRows(entry, rows) {
  const kinds = /** @type {Record<string, Record<string,string>>} */ (COLUMN_KINDS)[entry.id];
  const meanings = /** @type {Record<string, Record<string,string>>} */ (NULL_MEANINGS)[entry.id] ?? {};
  const reasons = new Set();
  /** @type {Readonly<{row:number,column:string,meaning:string}>[]} */
  const nulls = [];
  const seen = new Set();
  const identities = new Set();
  const keys = /** @type {Record<string, string[]>} */ (IDENTITY_KEYS)[entry.id];
  rows.forEach((row, index) => {
    for (const c of entry.columns) {
      const v = row[c.name];
      if (v === null) {
        const meaning = meanings[c.name];
        if (!meaning) reasons.add('null_contract_violation');
        else {
          nulls.push(Object.freeze({ row: index, column: c.name, meaning }));
          if (meaning === 'unknown') reasons.add('null_unknown');
          if (meaning === 'unresolved') reasons.add('unmapped_class');
        }
      } else {
        const kind = /** @type {Record<string, {ok:(v:unknown)=>boolean,reason:string}>} */ (KINDS)[kinds[c.name]];
        if (!kind) reasons.add('rows_invalid');
        else if (!kind.ok(v)) reasons.add(kind.reason);
      }
    }
    const fingerprint = JSON.stringify(entry.columns.map(c => row[c.name]));
    if (seen.has(fingerprint)) reasons.add('duplicate_row');
    seen.add(fingerprint);
    if (keys) {
      const identity = JSON.stringify(keys.map(k => row[k]));
      if (identities.has(identity)) reasons.add('duplicate_identity');
      identities.add(identity);
    }
  });
  for (const rule of entry.incompleteWhen) {
    const hit = rows.some(row => (rule.op === 'isNull' ? row[rule.column] === null
      : typeof row[rule.column] === 'number' && row[rule.column] >= rule.value));
    if (hit && rule.op === 'gte') reasons.add('depth_frontier');
    if (hit && rule.op === 'isNull') reasons.add('unmapped_class');
  }
  return { reasons: [...reasons], nulls: Object.freeze(nulls) };
}

/** @param {unknown} raw @returns {NormalizedResult} */
function observe(raw) {
  const top = ownData(raw, false);
  if (Object.keys(top).sort().join() !== 'id,result,sqlSha256,values') return result(null, ['malformed_observation']);
  const id = top.id.value;
  /** @type {Entry|null} */
  let entry = null;
  try { entry = typeof id === 'string' ? get(id) : null; } catch { entry = null; }
  if (!entry) return result(null, ['unknown_query']);
  if (top.sqlSha256.value !== entry.sqlSha256) return result(entry, ['stale_sql']);
  const values = readData(top.values.value, { nodes: 0, maxArray: LIMITS.values });
  if (!Array.isArray(values) || values.length !== entry.params.length) return result(entry, ['params_mismatch']);
  try {
    const built = build(id, Object.fromEntries(entry.params.map((type, i) => [type, values[i]])));
    if (built.values.some((v, i) => v !== values[i])) return result(entry, ['params_mismatch']);
  } catch { return result(entry, ['params_mismatch']); }
  const schemaAt = entry.params.indexOf('schema');
  const base = { values, schema: schemaAt >= 0 ? values[schemaAt] : null };
  const outcome = readData(top.result.value, { nodes: 0, maxArray: entry.maxRows + 2 });
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)) return result(entry, ['malformed_observation'], base);
  if (outcome.status === 'error') {
    if (Object.keys(outcome).sort().join() !== 'code,status' || !ERROR_CODES.includes(outcome.code)) return result(entry, ['malformed_observation'], base);
    return result(entry, ['query_failed'], { ...base, errorCode: outcome.code });
  }
  if (outcome.status !== 'rows' || Object.keys(outcome).sort().join() !== 'rows,status' || !Array.isArray(outcome.rows)) {
    return result(entry, ['malformed_observation'], base);
  }
  const rows = outcome.rows;
  const check = checkRows(entry.id, rows);
  const details = { ...base, rowCount: rows.length, check };
  if (check.code === 'evidence_query_invalid') return result(entry, diagnose(entry, rows), details);
  if (check.code === 'evidence_query_truncated') return result(entry, ['truncated'], details);
  if (check.code === 'evidence_query_cardinality') return result(entry, ['cardinality'], details);
  const inspected = inspectRows(entry, rows);
  return result(entry, inspected.reasons, { ...details, rows: Object.freeze(rows), nulls: inspected.nulls });
}

/** One observation to one frozen result. Never throws: a hostile or malformed input becomes an invalid result.
 * @param {unknown} observation */
function normalizeObservation(observation) {
  try { return observe(observation); } catch (error) { return result(null, [error instanceof Hostile ? 'hostile_input' : 'malformed_observation']); }
}

/** A set of observations, with missing and duplicated queries and a single target schema enforced.
 * @param {unknown} observations @param {{required?: readonly string[]}} [options] */
function normalizeSet(observations, options) {
  const verdicts = [];
  const setReasons = new Set();
  /** @type {Record<string, NormalizedResult>} */
  const results = {};
  const order = [];
  const duplicates = [];
  /** @type {string[]} */
  let required = CATALOG.map(q => q.id);
  try {
    if (options !== undefined) {
      const o = ownData(options, false);
      const keys = Object.keys(o);
      const list = keys.length === 1 && keys[0] === 'required' ? readData(o.required.value, { nodes: 0, maxArray: CATALOG.length }) : null;
      if (!Array.isArray(list) || new Set(list).size !== list.length || list.some(id => typeof id !== 'string' || !CATALOG.some(q => q.id === id))) {
        setReasons.add('malformed_observation');
      } else required = list;
    }
    const d = ownData(observations, true);
    const length = d.length.value;
    if (length > LIMITS.observations || Reflect.ownKeys(d).length !== length + 1) throw new Hostile('hostile');
    for (let i = 0; i < length; i++) {
      const item = d[String(i)];
      const r = normalizeObservation(item ? item.value : undefined);
      if (r.id === null) { verdicts.push(r.verdict); setReasons.add('malformed_observation'); continue; }
      if (Object.hasOwn(results, r.id)) { duplicates.push(r.id); setReasons.add('duplicate_observation'); continue; }
      results[r.id] = r; order.push(r.id);
    }
  } catch { setReasons.add('hostile_input'); }
  const missing = required.filter(id => !Object.hasOwn(results, id));
  for (const id of missing) {
    results[id] = result(get(id), ['query_missing']); order.push(id);
  }
  const schemas = [...new Set(order.map(id => results[id].schema).filter(s => s !== null))];
  if (schemas.length > 1) setReasons.add('params_mismatch');
  for (const id of order) verdicts.push(results[id].verdict);
  if (setReasons.size) verdicts.push(states.fromReasons([...setReasons]));
  const sorted = [...order].sort((a, b) => CATALOG.findIndex(q => q.id === a) - CATALOG.findIndex(q => q.id === b));
  return Object.freeze({ results: Object.freeze(results), order: Object.freeze(sorted), missing: Object.freeze(missing),
    duplicates: Object.freeze(duplicates), schema: schemas.length === 1 ? schemas[0] : null, verdict: states.combine(verdicts) });
}

/** Exact value of a canonical decimal column (no precision loss). @param {string} text */
function parseDecimal(text) {
  if (!decimal(text)) throw new TypeError('evidence_normalize_decimal');
  return BigInt(text);
}

module.exports = Object.freeze({ normalizeObservation, normalizeSet, parseDecimal, COLUMN_KINDS, NULL_MEANINGS, IDENTITY_KEYS, ERROR_CODES, LIMITS });
