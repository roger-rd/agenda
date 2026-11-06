'use strict';
/**
 * Pure, deterministic, conservative reconciliation between a NORMALIZED observation set (C3-B) and its
 * CLASSIFICATION (C3-C). It looks for absences, contradictions, count differences and insufficient evidence.
 * It never invents objects to close a gap, never authenticates the set, never proves provenance, snapshot,
 * connection, transaction or quiescence, and never produces an authorizable body.
 *
 * Trust boundary: C3-B does not authenticate its results, so a fabricated set that carries genuine verdicts
 * and contract-conforming rows reconciles exactly like a real one. That is stated in `provenance` and
 * `unproven`; binding observations to C1 identity and sequence is reserved for C3-E. The classification passed
 * in is never trusted: it is recomputed from the set and must be identical, otherwise the pair is rejected.
 *
 * A reconciliation never relaxes a classification finding: its structural state is the worst of the set's
 * verdict, the classification and its own findings. `excluded` findings describe well-formed evidence of an
 * ineligible schema and do not worsen the structural state. eligible is always false and demonstration always
 * not_demonstrated.
 */
const { types: { isProxy } } = require('node:util');
const { checkRows, get } = require('./c8-evidence-queries.cjs');
const states = require('./c8-evidence-states.cjs');
const { parseDecimal } = require('./c8-evidence-normalize.cjs');
const { classify, NEEDED } = require('./c8-evidence-classify.cjs');

const CONCURRENCY = Object.freeze(['ev_context', 'ev_sessions', 'ev_target_relation_locks', 'ev_advisory_holders', 'ev_prepared_xacts']);
const REQUIRED = Object.freeze([...NEEDED, ...CONCURRENCY]);
const COUNT_FIELDS = Object.freeze(['class', 'proc', 'type', 'operator', 'collation', 'conversion', 'opclass', 'opfamily', 'ts_config',
  'ts_dict', 'ts_parser', 'ts_template', 'statistic_ext', 'default_acl', 'extension']);
const COUNT_ONLY = Object.freeze(['operator', 'collation', 'conversion', 'opclass', 'opfamily', 'ts_config', 'ts_dict', 'ts_parser',
  'ts_template', 'statistic_ext', 'default_acl']);
/** Relation kinds that own a row type. */
const ROW_TYPE_KINDS = Object.freeze(['table', 'view', 'unsupported_partitioned_table', 'unsupported_matview', 'unsupported_foreign_table',
  'unsupported_composite_type']);
/** Aspects this module can never prove, whatever the data say. */
const UNPROVEN = Object.freeze(['provenance', 'snapshot_identity', 'connection_identity', 'transaction_identity', 'quiescence', 'server_validation']);
const OBSERVATION_STATUS = Object.freeze(['executed_empty', 'executed_rows', 'absent', 'failed', 'truncated', 'invalid', 'insufficient']);
/** Closed finding vocabulary and the state each code implies. */
const FINDINGS = Object.freeze({
  counted_not_enumerated: 'excluded',
  observation_absent: 'unresolved', observation_failed: 'unresolved', observation_insufficient: 'unresolved', counts_missing: 'unresolved',
  count_exceeds_listed: 'unresolved', extension_count_mismatch: 'unresolved', row_type_missing: 'unresolved', array_type_missing: 'unresolved',
  flag_unmatched: 'unresolved', edge_missing: 'unresolved', closure_unaccounted: 'unresolved', inventory_not_in_closure: 'unresolved',
  companion_not_in_closure: 'unresolved', extension_member_unaccounted: 'unresolved', external_reference_unexplained: 'unresolved',
  lock_on_unlisted_relation: 'unresolved', prepared_lock_without_xact: 'unresolved',
  observation_truncated: 'incomplete', listed_exceeds_count: 'incomplete', external_not_in_closure: 'incomplete', edge_source_not_in_closure: 'incomplete',
  observation_invalid: 'invalid', input_malformed: 'invalid', classification_mismatch: 'invalid', count_without_schema: 'invalid',
  unknown_count_category: 'invalid', companion_without_flag: 'invalid', identity_in_scope_and_external: 'invalid', session_includes_self: 'invalid',
  lock_includes_self: 'invalid',
});

/** @param {unknown} obj @param {string} key */
function own(obj, key) {
  if (obj === null || typeof obj !== 'object' || isProxy(obj)) return undefined;
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d && Object.hasOwn(d, 'value') ? d.value : undefined;
}
/** @param {string} classid @param {number} oid */
const keyOf = (classid, oid) => `${classid}:${oid}`;
/** @param {any} value @returns {any} */
function freezeDeep(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}
/** @param {string} a @param {string} b */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Data-only copy: never runs caller code. @param {unknown} value @param {{n:number}} ctx @param {number} [depth] @returns {any} */
function snapshot(value, ctx, depth = 0) {
  if (++ctx.n > 400000 || depth > 10) throw new Error('hostile');
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value !== 'object' || isProxy(value)) throw new Error('hostile');
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error('hostile');
  const d = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(d);
  /** @type {any} */ const out = array ? [] : {};
  for (const key of keys) {
    if (typeof key !== 'string' || key === '__proto__' || !Object.hasOwn(d[key], 'value')) throw new Error('hostile');
    if (array && key === 'length') continue;
    out[key] = snapshot(d[key].value, ctx, depth + 1);
  }
  return out;
}

/** @param {unknown} normalizedSet @param {unknown} classification */
function reconcile(normalizedSet, classification) {
  /** @type {Map<string, {code:string,state:string,subject:string|null,detail:string|null}>} */
  const found = new Map();
  /** @param {string} code @param {string|null} [subject] @param {string|null} [detail] */
  const add = (code, subject = null, detail = null) => {
    found.set(`${code}|${subject}|${detail}`, { code, state: /** @type {Record<string,string>} */ (FINDINGS)[code], subject, detail });
  };
  /** @type {Record<string, readonly any[]|undefined>} */ const rows = {};
  /** @type {Record<string, {status:string,rowCount:number|null}>} */ const observed = {};
  const set = normalizedSet;
  let inputVerdict = null;
  if (set === null || typeof set !== 'object' || isProxy(set) || !states.isVerdict(own(set, 'verdict'))) add('input_malformed', null, 'set');
  else inputVerdict = own(set, 'verdict');
  const results = inputVerdict === null ? undefined : own(set, 'results');
  /** @param {string} id @param {string} status @param {number|null} [rowCount] */
  const mark = (id, status, rowCount = null) => {
    observed[id] = { status, rowCount };
    const code = { absent: 'observation_absent', failed: 'observation_failed', truncated: 'observation_truncated', invalid: 'observation_invalid', insufficient: 'observation_insufficient' }[status];
    if (code) add(code, id, null);
  };
  for (const id of REQUIRED) {
    const r = results === undefined || results === null || typeof results !== 'object' || isProxy(results) ? undefined : own(results, id);
    if (r === undefined) { mark(id, 'absent'); continue; }
    const verdict = own(r, 'verdict');
    if (!states.isVerdict(verdict) || own(r, 'id') !== id || own(r, 'serverValidated') !== false || own(r, 'sqlSha256') !== get(id).sqlSha256) { mark(id, 'invalid'); continue; }
    const v = /** @type {any} */ (verdict);
    if (v.structural === 'structurally_valid') {
      const data = own(r, 'rows');
      if (!Array.isArray(data) || !checkRows(id, data).ok) { mark(id, 'invalid'); continue; }
      rows[id] = data; mark(id, data.length === 0 ? 'executed_empty' : 'executed_rows', data.length);
    } else if (v.reasons.includes('query_missing')) mark(id, 'absent');
    else if (v.reasons.includes('query_failed')) mark(id, 'failed');
    else if (v.structural === 'invalid') mark(id, 'invalid');
    else if (v.reasons.includes('truncated')) mark(id, 'truncated');
    else mark(id, 'insufficient');
  }

  // The pair must match: the classification is recomputed from the set and compared by content.
  const expected = classify(set);
  let pairing = 'matched';
  try {
    if (JSON.stringify(snapshot(classification, { n: 0 })) !== JSON.stringify(snapshot(expected, { n: 0 }))) { pairing = 'mismatched'; add('classification_mismatch', null, 'content'); }
  } catch { pairing = 'mismatched'; add('classification_mismatch', null, 'unreadable'); }

  const objects = /** @type {any[]} */ (expected.objects);
  const routines = /** @type {any[]} */ (expected.routines);
  const types = /** @type {any[]} */ (expected.types);
  const companions = /** @type {any[]} */ (expected.companions);
  const edges = /** @type {any[]} */ (expected.edges);
  const toast = /** @type {any[]} */ (expected.toast);
  const relationKeys = new Set(objects.map(o => o.key));

  // --- inventory and counts
  const namespaceRows = rows.ev_namespace;
  const countsRows = rows.ev_namespace_catalog_counts;
  const present = namespaceRows ? namespaceRows.length === 1 : null;
  /** @type {Record<string, any>} */ const categories = {};
  /** @type {Record<string, any>} */ const counts = {};
  if (namespaceRows && countsRows) {
    if (!present && countsRows.length > 0) add('count_without_schema', null, null);
    if (present && countsRows.length === 0) add('counts_missing', null, null);
    const row = present && countsRows.length === 1 ? countsRows[0] : null;
    if (row) {
      if (Object.keys(row).length !== COUNT_FIELDS.length || !COUNT_FIELDS.every(f => Object.hasOwn(row, f))) add('unknown_count_category', null, null);
      /** @param {string} field @param {string} id @param {readonly any[]|undefined} list */
      const compare = (field, id, list) => {
        if (!list) return;
        const declared = parseDecimal(row[field]); const listed = BigInt(list.length);
        counts[field] = { declared: row[field], listed: list.length };
        if (declared > listed) add('count_exceeds_listed', field, `${id}`);
        else if (declared < listed) add('listed_exceeds_count', field, `${id}`);
      };
      compare('class', 'ev_relations', rows.ev_relations); compare('proc', 'ev_routines', rows.ev_routines); compare('type', 'ev_types', rows.ev_types);
      for (const field of COUNT_ONLY) {
        const n = parseDecimal(row[field]);
        categories[field] = { declared: row[field], enumerated: false };
        if (n > 0n) add('counted_not_enumerated', field, null);
      }
      if (rows.ev_extension_members) {
        const listed = new Set(rows.ev_extension_members.filter(m => m.classid === 'pg_extension').map(m => m.objid)).size;
        categories.extension = { declared: row.extension, enumerated: true, listed };
        if (parseDecimal(row.extension) !== BigInt(listed)) add('extension_count_mismatch', 'extension', null);
      }
    }
  }
  if (rows.ev_relations && rows.ev_types) {
    const rowTypes = new Set(rows.ev_types.filter(t => t.typrelid !== 0).map(t => t.typrelid));
    for (const o of objects) if (ROW_TYPE_KINDS.includes(o.kind) && !rowTypes.has(o.oid)) add('row_type_missing', o.key, null);
    const listedTypes = new Set(rows.ev_types.map(t => t.oid));
    for (const t of rows.ev_types) if (t.typarray !== 0 && !listedTypes.has(t.typarray)) add('array_type_missing', keyOf('pg_type', t.oid), null);
  }

  // --- companions against the flags of their relation (flags are hints, not counts)
  /** @type {Record<string, number>} */ const byRole = {};
  for (const c of companions) byRole[c.role] = (byRole[c.role] ?? 0) + 1;
  const ownerCount = (/** @type {string} */ role) => {
    /** @type {Map<string, number>} */ const m = new Map();
    for (const c of companions) if (c.role === role) m.set(c.ownerKey, (m.get(c.ownerKey) ?? 0) + 1);
    return m;
  };
  const rowSecurity = { enabled: 0, withPolicies: 0 };
  if (rows.ev_relations && rows.ev_companion_items) {
    const triggers = ownerCount('trigger'); const rules = ownerCount('rule'); const policies = ownerCount('policy');
    for (const o of objects) {
      const t = triggers.get(o.key) ?? 0; const r = rules.get(o.key) ?? 0;
      if (o.hasTriggers && t === 0) add('flag_unmatched', o.key, 'relhastriggers');
      if (!o.hasTriggers && t > 0) add('companion_without_flag', o.key, 'relhastriggers');
      if (o.hasRules && r === 0) add('flag_unmatched', o.key, 'relhasrules');
      if (!o.hasRules && r > 0) add('companion_without_flag', o.key, 'relhasrules');
      if (o.rowSecurity) { rowSecurity.enabled++; if ((policies.get(o.key) ?? 0) > 0) rowSecurity.withPolicies++; }
    }
  }

  // --- expected dependency edges of every recognized companion
  /** @type {Map<string, any[]>} */ const bySource = new Map();
  for (const e of edges) if (e.origin === 'internal') { const k = keyOf(e.source.classid, e.source.oid); bySource.set(k, [...(bySource.get(k) ?? []), e]); }
  /** @param {string} src @param {string} deptype @param {string} refKey @param {number|null} subid @param {string} role */
  const needEdge = (src, deptype, refKey, subid, role) => {
    const list = bySource.get(src) ?? [];
    if (!list.some(e => e.deptype === deptype && keyOf(e.ref.classid, e.ref.oid) === refKey && (subid === null || e.ref.subid === subid))) add('edge_missing', src, role);
  };
  if (rows.ev_internal_edges) {
    for (const o of objects) if (o.kind === 'sequence' && o.ownership && o.ownership.inScope) needEdge(o.key, o.ownership.mode === 'serial' ? 'a' : 'i', o.ownership.tableKey, o.ownership.column, 'sequence_owner');
    for (const t of types) {
      if (t.role === 'row_type' && t.ownerKey) needEdge(t.key, 'i', t.ownerKey, null, 'row_type');
      if (t.role === 'array_type') needEdge(t.key, 'i', t.elementKey, null, 'array_type');
    }
    for (const c of companions) {
      if (c.role === 'constraint' || c.role === 'policy') needEdge(c.key, 'a', c.ownerKey, null, c.role);
      else if (c.role === 'trigger' && c.internal === true && c.related) needEdge(c.key, 'i', c.related, null, 'trigger');
      else if (c.role === 'trigger' && c.internal === false) needEdge(c.key, 'a', c.ownerKey, null, 'trigger');
      else if (c.role === 'rule') needEdge(c.key, c.viewRule ? 'i' : 'a', c.ownerKey, null, 'rule');
      else if (c.role === 'attrdef' && c.column) needEdge(c.key, 'a', c.ownerKey, c.column, 'attrdef');
    }
  }

  // --- closure accounting
  const closureRows = rows.ev_closure;
  const externalRows = rows.ev_external_dependents;
  const memberRows = rows.ev_extension_members;
  /** @type {Set<string>} */ const inScope = new Set([...objects, ...routines, ...types].filter(x => !x.extensionMember).map(x => x.key));
  /** @type {Set<string>} */ const owned = new Set(companions.filter(c => c.role !== 'cross_schema_sequence').map(c => c.key));
  for (const c of companions) if (c.role === 'cross_schema_sequence') owned.add(c.key);
  for (const t of toast) {
    if (String(t.status).startsWith('candidate_matched')) owned.add(t.toastKey);
    if (t.status === 'candidate_matched_with_index' && t.toastIndexKey) owned.add(t.toastIndexKey);
  }
  /** @type {Set<string>} */ const externalKeys = new Set((externalRows ?? []).map(e => keyOf(e.classid, e.objid)));
  /** @type {Set<string>} */ const memberKeys = new Set((memberRows ?? []).map(m => keyOf(m.classid, m.objid)));
  const closure = { rows: closureRows ? closureRows.length : null, distinct: 0, unaccounted: 0, missing: 0 };
  /** @type {Set<string>} */ const closureKeys = new Set((closureRows ?? []).map(c => keyOf(c.classid, c.objid)));
  closure.distinct = closureKeys.size;
  if (closureRows) {
    const known = new Set([...inScope, ...owned, ...externalKeys, ...memberKeys, ...objects.filter(o => o.extensionMember).map(o => o.key)]);
    for (const k of closureKeys) if (!known.has(k)) { add('closure_unaccounted', k, null); closure.unaccounted++; }
    for (const k of inScope) if (!closureKeys.has(k)) { add('inventory_not_in_closure', k, null); closure.missing++; }
    if (rows.ev_companion_items) for (const k of owned) if (!closureKeys.has(k)) { add('companion_not_in_closure', k, null); closure.missing++; }
    for (const e of externalRows ?? []) {
      if (!closureKeys.has(keyOf(e.classid, e.objid))) add('external_not_in_closure', keyOf(e.classid, e.objid), null);
      const ref = keyOf(e.refclassid, e.refobjid);
      if (!closureKeys.has(ref) && !(namespaceRows && present && ref === keyOf('pg_namespace', namespaceRows[0].oid))) add('external_reference_unexplained', keyOf(e.classid, e.objid), ref);
    }
    for (const e of edges) {
      if (e.origin === 'external') continue;
      const k = keyOf(e.source.classid, e.source.oid);
      if (!closureKeys.has(k)) add('edge_source_not_in_closure', k, e.origin);
    }
  }
  if (externalRows) {
    const scoped = new Set([...inScope, ...companions.filter(c => c.role !== 'cross_schema_sequence').map(c => c.key)]);
    for (const k of externalKeys) if (scoped.has(k)) add('identity_in_scope_and_external', k, null);
  }
  if (memberRows) {
    const scoped = new Set([...inScope, ...owned, ...objects.map(o => o.key)]);
    for (const m of memberRows) {
      const k = keyOf(m.classid, m.objid);
      if (m.classid !== 'pg_extension' && !scoped.has(k)) add('extension_member_unaccounted', k, m.extension_name);
    }
  }

  // --- concurrency and context: structure only; nothing here proves quiescence or shared identity
  const context = rows.ev_context && rows.ev_context.length === 1 ? rows.ev_context[0] : null;
  const sessions = rows.ev_sessions; const locks = rows.ev_target_relation_locks;
  const holders = rows.ev_advisory_holders; const prepared = rows.ev_prepared_xacts;
  if (context && sessions && sessions.some(s => s.pid === context.pid)) add('session_includes_self', keyOf('pid', context.pid), null);
  if (context && locks && locks.some(l => l.pid === context.pid)) add('lock_includes_self', keyOf('pid', context.pid), null);
  if (locks && rows.ev_relations) for (const l of locks) if (!relationKeys.has(keyOf('pg_class', l.relation))) add('lock_on_unlisted_relation', keyOf('pg_class', l.relation), null);
  if (locks && prepared && prepared.length === 0 && locks.some(l => l.pid === null)) add('prepared_lock_without_xact', null, null);
  const concurrency = {
    queries: Object.fromEntries(CONCURRENCY.map(id => [id, observed[id]])),
    context: context ? { pid: context.pid, database: context.database, isolation: context.transaction_isolation, readOnly: context.transaction_read_only,
      backendStart: context.backend_start } : null,
    sessions: sessions ? { count: sessions.length } : null,
    locks: locks ? { count: locks.length, prepared: locks.filter(l => l.pid === null).length } : null,
    advisoryHolders: holders ? { count: holders.length } : null,
    preparedTransactions: prepared ? { count: prepared.length } : null,
    quiescence: 'unproven',
  };

  const findings = [...found.values()].sort((a, b) => cmp(a.code, b.code) || cmp(String(a.subject), String(b.subject)) || cmp(String(a.detail), String(b.detail)));
  const structuralFindings = findings.filter(f => f.state !== 'excluded');
  const classificationStructural = /** @type {any} */ (expected.verdict).structural;
  const structural = [inputVerdict ? /** @type {any} */ (inputVerdict).structural : 'unresolved', classificationStructural, ...structuralFindings.map(f => f.state)]
    .reduce((w, s) => (states.severity(s) > states.severity(w) ? s : w), 'structurally_valid');
  const exclusions = [...new Set([...expected.exclusions, ...findings.filter(f => f.state === 'excluded').map(f => f.code)])].sort();
  return freezeDeep({
    schema: expected.schema,
    inventory: { relations: objects.length, routines: routines.length, types: types.length, counts, categories, reconciled: structuralFindings.length === 0 && counts.class !== undefined },
    companions: { byRole, rowSecurity, toast: toast.map(t => ({ ownerKey: t.ownerKey, status: t.status })) },
    dependencies: { closure, internalEdges: edges.filter(e => e.origin === 'internal').length, outboundEdges: edges.filter(e => e.origin === 'outbound').length,
      externalEdges: edges.filter(e => e.origin === 'external').length, extensionMembers: memberRows ? memberRows.length : null },
    concurrency, observations: observed, pairing, provenance: 'unauthenticated', unproven: UNPROVEN,
    findings, exclusions, classification: { structural: classificationStructural, findings: expected.findings.length }, inputVerdict,
    verdict: { structural, demonstration: 'not_demonstrated', status: structural === 'structurally_valid' ? 'not_demonstrated' : structural, eligible: false,
      reasons: inputVerdict ? [.../** @type {any} */ (inputVerdict).reasons] : [], excluded: exclusions.length > 0 },
    serverValidated: false,
  });
}

module.exports = Object.freeze({ reconcile, REQUIRED, CONCURRENCY, FINDINGS, UNPROVEN, OBSERVATION_STATUS, COUNT_FIELDS, COUNT_ONLY, ROW_TYPE_KINDS });
