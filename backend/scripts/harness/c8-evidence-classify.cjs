'use strict';
/**
 * Conservative, pure classifier over a NORMALIZED observation set (output of normalizeSet). No I/O, no SQL,
 * no connection or transaction identity, no attestations and no authorizable bodies. It decides which objects,
 * companions and dependencies are recognized, which need later reconciliation and which exclude the schema;
 * it never produces a removal plan or an order.
 *
 * Trust boundary: only results whose verdict was issued by the states module and whose rows still satisfy the
 * catalog contract are read. The normalizer does not brand its results, so a fabricated set that carries genuine
 * verdicts and contract-conforming rows cannot be told apart from a real one (known limit, see report). The
 * normalizer also hides the rows of non-valid results, so unmapped or NULL destinations are preserved only as
 * the input verdict (unmapped_class), never as rows.
 *
 * Findings carry one of four states. excluded: the evidence is well formed but the schema must not be eligible.
 * incomplete / unresolved / invalid: the classification itself is not trustworthy. Excluded findings never
 * worsen the structural state; the others do. eligible is always false and demonstration always not_demonstrated.
 */
const { types: { isProxy } } = require('node:util');
const { checkRows, get } = require('./c8-evidence-queries.cjs');
const states = require('./c8-evidence-states.cjs');
const { parseDecimal } = require('./c8-evidence-normalize.cjs');

const NEEDED = Object.freeze(['ev_namespace', 'ev_relations', 'ev_routines', 'ev_types', 'ev_namespace_catalog_counts',
  'ev_companion_items', 'ev_internal_edges', 'ev_outbound_references', 'ev_external_dependents', 'ev_extension_members', 'ev_closure']);
/** Closed finding vocabulary and the state each code implies. */
const FINDINGS = Object.freeze({
  unsupported_kind: 'excluded', unsupported_routine: 'excluded', unsupported_type: 'excluded', unsupported_class_present: 'excluded',
  user_trigger_present: 'excluded', user_rule_present: 'excluded', extension_member: 'excluded', external_dependent: 'excluded',
  cross_schema_reference: 'excluded', partition_dependency: 'excluded',
  input_unresolved: 'unresolved', unknown_relkind: 'unresolved', unknown_class: 'unresolved', edge_unknown_endpoint: 'unresolved',
  edge_unreconciled: 'unresolved', constraint_unresolved: 'unresolved', companion_unlinked: 'unresolved', type_orphan: 'unresolved',
  view_rule_missing: 'unresolved', sequence_owner_unresolved: 'unresolved', toast_unverified: 'unresolved',
  toast_index_unverified: 'unresolved', toast_unaccounted: 'unresolved',
  input_incomplete: 'incomplete',
  input_invalid: 'invalid', input_malformed: 'invalid', identity_conflict: 'invalid', duplicate_companion: 'invalid',
  sequence_multi_owner: 'invalid', toast_contradiction: 'invalid', edge_contradiction: 'invalid', edge_in_both: 'invalid',
  schema_absent_with_objects: 'invalid',
});
const RELKINDS = Object.freeze({ r: 'table', S: 'sequence', i: 'index', v: 'view', p: 'unsupported_partitioned_table',
  m: 'unsupported_matview', f: 'unsupported_foreign_table', c: 'unsupported_composite_type', t: 'unsupported_toast',
  I: 'unsupported_partitioned_index' });
const ADMITTED = Object.freeze(['table', 'sequence', 'index', 'view']);
const PROKINDS = Object.freeze({ f: 'unsupported_function', p: 'unsupported_procedure', a: 'unsupported_aggregate', w: 'unsupported_window' });
const TYPTYPES = Object.freeze({ b: 'base', c: 'composite', d: 'domain', e: 'enum', r: 'range', m: 'multirange', p: 'pseudo' });
const CLASS_KINDS = Object.freeze({ pg_class: 'relation', pg_proc: 'routine', pg_type: 'type', pg_constraint: 'companion', pg_trigger: 'companion',
  pg_rewrite: 'companion', pg_attrdef: 'companion', pg_policy: 'companion', pg_collation: 'unsupported', pg_operator: 'unsupported',
  pg_opclass: 'unsupported', pg_opfamily: 'unsupported', pg_extension: 'unsupported' });
const NATURE = Object.freeze({ n: 'normal', a: 'automatic', i: 'internal', P: 'partition', S: 'partition', e: 'extension', x: 'extension' });
const SYSTEM_SCHEMAS = Object.freeze(['pg_catalog', 'information_schema']);
const COMPANION_CLASS = Object.freeze({ constraint: 'pg_constraint', trigger: 'pg_trigger', rule: 'pg_rewrite', attrdef: 'pg_attrdef',
  policy: 'pg_policy', sequence_owner: 'pg_class', toast_candidate: 'pg_class', toast_index_candidate: 'pg_class' });
const BACKING = Object.freeze(['p', 'u', 'x']);
const CONSTRAINTS = Object.freeze({ p: 'primary_key', u: 'unique', x: 'exclusion', f: 'foreign_key', c: 'check', t: 'constraint_trigger' });
const COUNT_CLASSES = Object.freeze(['operator', 'collation', 'conversion', 'opclass', 'opfamily', 'ts_config', 'ts_dict', 'ts_parser',
  'ts_template', 'statistic_ext', 'default_acl', 'extension']);
/** Deptypes an object of a given role may legitimately have towards its owner. */
const EXPECT = Object.freeze({ index: ['a', 'i'], sequence: ['a', 'i'], row_type: ['i'], array_type: ['i'], constraint: ['a'],
  trigger: ['a', 'i'], rule: ['a', 'i'], attrdef: ['a'], policy: ['a'] });

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
/** Numeric-aware ordering of "class:oid[#subid]" keys. @param {string} a @param {string} b */
function cmpKey(a, b) {
  const [ca, ra] = a.split(':'); const [cb, rb] = b.split(':');
  return ca !== cb ? cmp(ca, cb) : cmp(String(ra).padStart(12, '0'), String(rb).padStart(12, '0'));
}
/** @param {string} text */
function positiveDecimal(text) { try { return parseDecimal(text) >= 1n; } catch { return false; } }

/** Iterative Tarjan over group keys. @param {string[]} nodes @param {Map<string, string[]>} adj */
function components(nodes, adj) {
  let counter = 0;
  /** @type {Map<string, number>} */ const idx = new Map();
  /** @type {Map<string, number>} */ const low = new Map();
  /** @type {Set<string>} */ const onStack = new Set();
  /** @type {string[]} */ const stack = [];
  /** @type {string[][]} */ const out = [];
  for (const start of nodes) {
    if (idx.has(start)) continue;
    /** @type {[string, number][]} */ const work = [[start, 0]];
    while (work.length) {
      const frame = work[work.length - 1]; const v = frame[0];
      if (frame[1] === 0 && !idx.has(v)) { idx.set(v, counter); low.set(v, counter); counter++; stack.push(v); onStack.add(v); }
      const next = adj.get(v) ?? [];
      if (frame[1] < next.length) {
        const w = next[frame[1]++];
        if (!idx.has(w)) work.push([w, 0]);
        else if (onStack.has(w)) low.set(v, Math.min(/** @type {number} */ (low.get(v)), /** @type {number} */ (idx.get(w))));
      } else {
        if (low.get(v) === idx.get(v)) {
          const component = []; let w;
          do { w = /** @type {string} */ (stack.pop()); onStack.delete(w); component.push(w); } while (w !== v);
          out.push(component);
        }
        work.pop();
        if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(/** @type {number} */ (low.get(p)), /** @type {number} */ (low.get(v)))); }
      }
    }
  }
  return out;
}

/** @param {unknown} set */
function classify(set) {
  /** @type {Map<string, {code:string,state:string,subject:string|null,detail:string|null}>} */
  const found = new Map();
  /** @param {string} code @param {string|null} [subject] @param {string|null} [detail] */
  const add = (code, subject = null, detail = null) => {
    found.set(`${code}|${subject}|${detail}`, { code, state: /** @type {Record<string,string>} */ (FINDINGS)[code], subject, detail });
  };
  /** @type {Record<string, readonly any[]|null>} */ const rows = {};
  let inputVerdict = null;
  if (set === null || typeof set !== 'object' || isProxy(set) || !states.isVerdict(own(set, 'verdict'))) add('input_malformed', null, 'set');
  else {
    inputVerdict = own(set, 'verdict');
    const results = own(set, 'results');
    for (const id of NEEDED) {
      const r = results === null || typeof results !== 'object' || isProxy(results) ? undefined : own(results, id);
      const verdict = own(r, 'verdict');
      if (r === undefined) { add('input_unresolved', id, 'missing'); rows[id] = null; continue; }
      if (!states.isVerdict(verdict) || own(r, 'id') !== id || own(r, 'serverValidated') !== false || own(r, 'sqlSha256') !== get(id).sqlSha256) {
        add('input_malformed', id, 'result'); rows[id] = null; continue;
      }
      const structural = /** @type {any} */ (verdict).structural;
      if (structural !== 'structurally_valid') {
        add(structural === 'incomplete' ? 'input_incomplete' : structural === 'invalid' ? 'input_invalid' : 'input_unresolved', id, 'verdict');
        rows[id] = null; continue;
      }
      const data = own(r, 'rows');
      if (!Array.isArray(data) || !checkRows(id, data).ok) { add('input_malformed', id, 'rows'); rows[id] = null; continue; }
      rows[id] = data;
    }
  }

  /** Registry of every recognized identity, keyed by class:oid (a bare oid is never an identity).
   * @type {Map<string, any>} */
  const registry = new Map();
  /** @param {any} entry */
  const register = entry => {
    const previous = registry.get(entry.key);
    if (previous) { add('identity_conflict', entry.key, `${previous.role}/${entry.role}`); return { ...entry, detached: true }; }
    registry.set(entry.key, entry); return entry;
  };

  const namespaceRows = rows.ev_namespace;
  const schemaOid = namespaceRows && namespaceRows.length === 1 ? namespaceRows[0].oid : null;
  const schemaName = namespaceRows && namespaceRows.length === 1 ? namespaceRows[0].name : null;
  const schemaPresent = namespaceRows ? namespaceRows.length === 1 : null;

  // --- main objects
  const objects = [];
  for (const r of rows.ev_relations ?? []) {
    const known = Object.hasOwn(RELKINDS, r.relkind);
    const kind = known ? /** @type {Record<string,string>} */ (RELKINDS)[r.relkind] : 'unknown';
    const admitted = ADMITTED.includes(kind) && r.relispartition === false && (r.relpersistence === 'p' || r.relpersistence === 'u');
    const entry = register({ key: keyOf('pg_class', r.oid), classid: 'pg_class', oid: r.oid, role: 'relation', kind, relkind: r.relkind,
      name: r.relname, owner: r.owner, persistence: r.relpersistence, partition: r.relispartition, toastOid: r.reltoastrelid,
      hasRules: r.relhasrules, hasTriggers: r.relhastriggers, rowSecurity: r.relrowsecurity, aclDefault: r.acl === null,
      admitted, constraintBacked: null, table: null, ownership: null, extensionMember: false });
    if (!known) add('unknown_relkind', entry.key, r.relkind);
    else if (!admitted) add('unsupported_kind', entry.key, r.relispartition ? 'partition' : kind);
    objects.push(entry);
  }
  if (schemaPresent === false && objects.length) add('schema_absent_with_objects', null, String(objects.length));

  // --- routines (recognized but never admitted)
  const routines = [];
  for (const r of rows.ev_routines ?? []) {
    const known = Object.hasOwn(PROKINDS, r.prokind);
    const entry = register({ key: keyOf('pg_proc', r.oid), classid: 'pg_proc', oid: r.oid, role: 'routine',
      kind: known ? /** @type {Record<string,string>} */ (PROKINDS)[r.prokind] : 'unknown', name: r.proname, owner: r.owner, admitted: false });
    if (known) add('unsupported_routine', entry.key, entry.kind); else add('unknown_class', entry.key, `prokind:${r.prokind}`);
    routines.push(entry);
  }

  // --- types: row and array types are companions of their element; anything else is an independent unsupported type
  const typeRows = rows.ev_types ?? [];
  /** @type {Map<number, number>} */ const arrayOf = new Map();
  for (const t of typeRows) if (t.typarray !== 0) arrayOf.set(t.typarray, t.oid);
  const types = [];
  for (const t of typeRows) {
    const key = keyOf('pg_type', t.oid);
    if (t.typrelid !== 0) {
      const relation = registry.get(keyOf('pg_class', t.typrelid));
      if (!relation) { add('type_orphan', key, 'row_type'); types.push(register({ key, classid: 'pg_type', oid: t.oid, role: 'row_type', kind: 'orphan_row_type', name: t.typname, ownerKey: null, admitted: false })); continue; }
      types.push(register({ key, classid: 'pg_type', oid: t.oid, role: 'row_type', kind: 'row_type', name: t.typname, ownerKey: relation.key, admitted: false }));
    } else if (arrayOf.has(t.oid)) {
      types.push(register({ key, classid: 'pg_type', oid: t.oid, role: 'array_type', kind: 'array_type', name: t.typname, elementKey: keyOf('pg_type', /** @type {number} */ (arrayOf.get(t.oid))), ownerKey: null, admitted: false }));
    } else {
      const known = Object.hasOwn(TYPTYPES, t.typtype);
      const entry = register({ key, classid: 'pg_type', oid: t.oid, role: 'independent_type', kind: known ? `unsupported_${/** @type {Record<string,string>} */ (TYPTYPES)[t.typtype]}_type` : 'unknown', name: t.typname, ownerKey: null, admitted: false });
      if (known) add('unsupported_type', key, entry.kind); else add('unknown_class', key, `typtype:${t.typtype}`);
      types.push(entry);
    }
  }
  for (const t of types) {
    if (t.role !== 'array_type') continue;
    const element = registry.get(t.elementKey);
    if (!element) add('type_orphan', t.key, 'array_type'); else t.ownerKey = element.ownerKey ?? null;
  }

  // --- companions
  const items = rows.ev_companion_items ?? [];
  const companions = [];
  /** @type {Map<string, any[]>} */ const byKind = new Map();
  for (const i of items) {
    const list = byKind.get(i.item_kind) ?? []; list.push(i); byKind.set(i.item_kind, list);
  }
  const known = new Set(Object.keys(COMPANION_CLASS));
  for (const kind of byKind.keys()) if (!known.has(kind)) add('unknown_class', null, `companion:${kind}`);
  /** @param {any} i @param {string} role */
  const owned = (i, role) => {
    if (i.item_classid !== /** @type {Record<string,string>} */ (COMPANION_CLASS)[i.item_kind]) { add('identity_conflict', keyOf(i.item_classid, i.item_oid), `class:${i.item_kind}`); return null; }
    if (i.group_classid !== 'pg_class') { add('companion_unlinked', keyOf(i.item_classid, i.item_oid), 'group_class'); return null; }
    const owner = registry.get(keyOf('pg_class', i.group_oid));
    if (!owner || owner.role !== 'relation') { add('companion_unlinked', keyOf(i.item_classid, i.item_oid), 'owner_not_found'); return null; }
    if (schemaOid !== null && i.item_namespace_oid !== schemaOid && !['sequence_owner', 'toast_candidate', 'toast_index_candidate'].includes(i.item_kind)) {
      add('identity_conflict', keyOf(i.item_classid, i.item_oid), 'namespace'); return null;
    }
    return { key: keyOf(i.item_classid, i.item_oid), classid: i.item_classid, oid: i.item_oid, role, kind: i.item_kind, subtype: i.subtype, name: i.name,
      ownerKey: owner.key, related: i.related_oid === 0 ? null : keyOf(i.related_classid, i.related_oid), admitted: false };
  };
  for (const i of byKind.get('constraint') ?? []) {
    const c = owned(i, 'constraint'); if (!c) continue;
    const entry = register(c); if (entry.detached) continue;
    entry.constraintKind = Object.hasOwn(CONSTRAINTS, i.subtype) ? /** @type {Record<string,string>} */ (CONSTRAINTS)[i.subtype] : 'unknown';
    entry.backingIndexKey = null; companions.push(entry);
    if (entry.constraintKind === 'unknown') add('constraint_unresolved', entry.key, `contype:${i.subtype}`);
    else if (BACKING.includes(i.subtype)) {
      const index = i.related_classid === 'pg_class' ? registry.get(keyOf('pg_class', i.related_oid)) : undefined;
      if (!index || index.kind !== 'index') add('constraint_unresolved', entry.key, 'backing_index_missing');
      else if (index.constraintBacked) add('duplicate_companion', index.key, 'index_backs_two_constraints');
      else { index.constraintBacked = entry.key; entry.backingIndexKey = index.key; }
    }
  }
  for (const i of byKind.get('trigger') ?? []) {
    const t = owned(i, 'trigger'); if (!t) continue;
    const entry = register(t); if (entry.detached) continue; companions.push(entry);
    if (i.subtype !== 'true' && i.subtype !== 'false') { add('companion_unlinked', entry.key, 'trigger_subtype'); continue; }
    entry.internal = i.subtype === 'true';
    if (!entry.internal) add('user_trigger_present', entry.key, null);
    else if (!entry.related || i.related_classid !== 'pg_constraint' || !registry.has(entry.related)) add('companion_unlinked', entry.key, 'trigger_constraint');
  }
  /** @type {Map<string, number>} */ const viewRules = new Map();
  for (const i of byKind.get('rule') ?? []) {
    const rule = owned(i, 'rule'); if (!rule) continue;
    const entry = register(rule); if (entry.detached) continue; companions.push(entry);
    const owner = registry.get(entry.ownerKey);
    entry.viewRule = i.subtype === '1' && owner.kind === 'view' && i.name === '_RETURN';
    if (entry.viewRule) viewRules.set(owner.key, (viewRules.get(owner.key) ?? 0) + 1); else add('user_rule_present', entry.key, null);
  }
  for (const o of objects) if (o.kind === 'view') {
    const n = viewRules.get(o.key) ?? 0;
    if (n === 0) add('view_rule_missing', o.key, null); else if (n > 1) add('duplicate_companion', o.key, 'view_rule');
  }
  /** @type {Set<string>} */ const defaults = new Set();
  for (const i of byKind.get('attrdef') ?? []) {
    const d = owned(i, 'attrdef'); if (!d) continue;
    const entry = register(d); if (entry.detached) continue; companions.push(entry);
    if (!positiveDecimal(i.subtype)) { add('companion_unlinked', entry.key, 'attrdef_column'); continue; }
    entry.column = Number(i.subtype);
    const slot = `${entry.ownerKey}#${i.subtype}`;
    if (defaults.has(slot)) add('duplicate_companion', entry.key, 'column_default'); defaults.add(slot);
  }
  for (const i of byKind.get('policy') ?? []) { const p = owned(i, 'policy'); const entry = p ? register(p) : null; if (entry && !entry.detached) companions.push(entry); }

  // --- owned sequences (serial 'a', identity 'i'); one owner per sequence
  /** @type {Map<string, any>} */ const ownership = new Map();
  for (const i of byKind.get('sequence_owner') ?? []) {
    const seqKey = keyOf(i.item_classid, i.item_oid);
    if (i.item_classid !== 'pg_class' || i.group_classid !== 'pg_class') { add('identity_conflict', seqKey, 'class:sequence_owner'); continue; }
    const table = registry.get(keyOf('pg_class', i.group_oid));
    const mode = i.edge_deptype === 'a' ? 'serial' : i.edge_deptype === 'i' ? 'identity' : null;
    if (!table || table.kind !== 'table' || mode === null || i.edge_ref_subid === null || !positiveDecimal(i.edge_ref_subid)) {
      add('sequence_owner_unresolved', seqKey, !table ? 'owner_not_found' : table.kind !== 'table' ? 'owner_not_table' : 'edge'); continue;
    }
    const owning = { tableKey: table.key, column: Number(i.edge_ref_subid), mode, inScope: schemaOid !== null && i.item_namespace_oid === schemaOid };
    const previous = ownership.get(seqKey);
    if (previous) {
      if (previous.tableKey !== owning.tableKey || previous.column !== owning.column || previous.mode !== owning.mode) add('sequence_multi_owner', seqKey, null);
      else add('duplicate_companion', seqKey, 'sequence_owner');
      continue;
    }
    ownership.set(seqKey, owning);
    const sequence = registry.get(seqKey);
    if (owning.inScope) {
      if (!sequence || sequence.kind !== 'sequence') add('identity_conflict', seqKey, 'sequence_not_listed'); else sequence.ownership = owning;
    } else if (sequence) add('identity_conflict', seqKey, 'sequence_namespace');
    else {
      const entry = register({ key: seqKey, classid: 'pg_class', oid: i.item_oid, role: 'cross_schema_sequence', kind: 'cross_schema_owned_sequence', name: i.name, ownerKey: table.key, ownership: owning, admitted: false });
      if (!entry.detached) companions.push(entry);
      add('cross_schema_reference', seqKey, 'owned_sequence');
    }
  }

  // --- TOAST: candidates only, each needing an unambiguous match with its owner table and external corroboration
  const external = rows.ev_external_dependents ?? [];
  /** @param {number} oid @param {number} refOid @param {string} deptype */
  const externalHas = (oid, refOid, deptype) => external.some(e => e.classid === 'pg_class' && e.objid === oid && e.refclassid === 'pg_class'
    && e.refobjid === refOid && e.deptype === deptype && e.namespace === 'pg_toast');
  const toast = [];
  /** @type {Map<number, number>} object oid -> the oid it must depend on */ const accountedToast = new Map();
  const toastRows = byKind.get('toast_candidate') ?? [];
  const toastIndexRows = byKind.get('toast_index_candidate') ?? [];
  const toastedTables = objects.filter(o => o.toastOid !== 0);
  const tableKeys = new Set(objects.map(o => o.key));
  for (const i of [...toastRows, ...toastIndexRows]) {
    if (i.group_classid !== 'pg_class' || !tableKeys.has(keyOf('pg_class', i.group_oid))) add(i.item_kind === 'toast_candidate' ? 'toast_unverified' : 'toast_index_unverified', keyOf(i.item_classid, i.item_oid), 'owner_not_found');
  }
  for (const table of toastedTables) {
    const subject = keyOf('pg_class', table.toastOid);
    const mine = toastRows.filter(i => i.group_oid === table.oid);
    const oids = [...new Set(mine.map(i => i.item_oid))];
    /** @type {{ownerKey: string, toastKey: string, toastIndexKey: string|null, status: string}} */
    const record = { ownerKey: table.key, toastKey: subject, toastIndexKey: null, status: 'unverified' };
    toast.push(record);
    if (table.kind !== 'table') { add('toast_unverified', subject, 'owner_not_table'); continue; }
    if (mine.length === 0) { add('toast_unverified', subject, 'candidate_missing'); continue; }
    if (oids.length !== 1 || oids[0] !== table.toastOid) { add('toast_contradiction', subject, 'candidate_oid'); continue; }
    const edges = mine.map(i => i.edge_deptype);
    if (edges.includes(null)) { add('toast_unverified', subject, 'edge_missing'); continue; }
    if (new Set(edges).size !== 1 || edges[0] !== 'i' || mine.some(i => i.edge_ref_subid !== '0')) { add('toast_contradiction', subject, 'edge'); continue; }
    if (mine.some(i => i.item_namespace_oid === schemaOid)) { add('toast_contradiction', subject, 'namespace'); continue; }
    if (mine.some(i => i.subtype !== 't') || mine.some(i => i.name !== `pg_toast_${table.oid}`)) { add('toast_unverified', subject, 'identity'); continue; }
    if (!externalHas(table.toastOid, table.oid, 'i')) { add('toast_unverified', subject, 'not_corroborated'); continue; }
    if (registry.has(subject)) { add('identity_conflict', subject, 'toast'); continue; }
    register({ key: subject, classid: 'pg_class', oid: table.toastOid, role: 'toast', kind: 'toast_candidate', ownerKey: table.key, admitted: false });
    record.status = 'candidate_matched'; accountedToast.set(table.toastOid, table.oid);
    const idx = toastIndexRows.filter(i => i.group_oid === table.oid && i.related_oid === table.toastOid);
    const indexOids = [...new Set(idx.map(i => i.item_oid))];
    if (idx.length === 0) { add('toast_index_unverified', subject, 'index_missing'); record.status = 'index_unverified'; continue; }
    if (indexOids.length !== 1) { add('toast_contradiction', subject, 'index_ambiguous'); record.status = 'index_unverified'; continue; }
    const indexKey = keyOf('pg_class', indexOids[0]);
    record.toastIndexKey = indexKey;
    if (idx.some(i => i.edge_deptype === null || !['a', 'i'].includes(i.edge_deptype))) { add('toast_index_unverified', indexKey, 'edge'); record.status = 'index_unverified'; continue; }
    if (idx.some(i => i.subtype !== 'i' || i.name !== `pg_toast_${table.oid}_index` || i.item_namespace_oid === schemaOid)) { add('toast_index_unverified', indexKey, 'identity'); record.status = 'index_unverified'; continue; }
    if (!externalHas(indexOids[0], table.toastOid, idx[0].edge_deptype)) { add('toast_index_unverified', indexKey, 'not_corroborated'); record.status = 'index_unverified'; continue; }
    if (registry.has(indexKey)) { add('identity_conflict', indexKey, 'toast_index'); record.status = 'index_unverified'; continue; }
    register({ key: indexKey, classid: 'pg_class', oid: indexOids[0], role: 'toast_index', kind: 'toast_index_candidate', ownerKey: table.key, admitted: false });
    record.status = 'candidate_matched_with_index'; accountedToast.set(indexOids[0], table.toastOid);
  }
  for (const i of [...toastRows, ...toastIndexRows]) {
    const owner = objects.find(o => o.oid === i.group_oid);
    if (owner && owner.toastOid === 0 && i.item_kind === 'toast_candidate') add('toast_unverified', keyOf('pg_class', i.item_oid), 'owner_has_no_toast');
  }

  // --- extension membership and unsupported classes present
  for (const e of rows.ev_extension_members ?? []) {
    const key = keyOf(e.classid, e.objid);
    add('extension_member', key, e.extension_name);
    const entry = registry.get(key); if (entry) entry.extensionMember = true;
  }
  const counts = rows.ev_namespace_catalog_counts?.[0];
  if (counts) for (const field of COUNT_CLASSES) if (parseDecimal(counts[field]) > 0n) add('unsupported_class_present', field, null);
  /** @type {Record<string, number>} */ const closureClasses = {};
  for (const c of rows.ev_closure ?? []) {
    const kind = Object.hasOwn(CLASS_KINDS, c.classid) ? /** @type {Record<string,string>} */ (CLASS_KINDS)[c.classid] : 'unknown';
    closureClasses[kind] = (closureClasses[kind] ?? 0) + 1;
    if (kind === 'unknown') add('unknown_class', c.classid, 'closure');
  }

  // --- dependencies
  const edges = [];
  /** @type {Map<string, Set<string>>} */ const edgeTypes = new Map();
  /** @type {Map<string, string>} */ const edgeOrigin = new Map();
  /** @param {any} src @param {any} ref @param {string} deptype @param {string} origin */
  const noteEdge = (src, ref, deptype, origin) => {
    const id = `${keyOf(src.classid, src.oid)}#${src.subid}>${keyOf(ref.classid, ref.oid)}#${ref.subid}`;
    const set = edgeTypes.get(id) ?? new Set(); set.add(deptype); edgeTypes.set(id, set);
    if (edgeOrigin.has(id) && edgeOrigin.get(id) !== origin) add('edge_in_both', id, null);
    edgeOrigin.set(id, origin);
    if (set.size > 1) add('edge_contradiction', id, [...set].sort().join(''));
    return id;
  };
  /** @param {string} classid */
  const classKnown = classid => {
    if (Object.hasOwn(CLASS_KINDS, classid)) return true;
    add('unknown_class', classid, 'edge'); return false;
  };
  const internalRows = rows.ev_internal_edges ?? [];
  // an index belongs to the single table its automatic edges point at
  /** @type {Map<string, Set<string>>} */ const indexTables = new Map();
  for (const e of internalRows) {
    const src = registry.get(keyOf(e.source_classid, e.source_objid));
    const ref = registry.get(keyOf(e.ref_classid, e.ref_objid));
    if (src && src.kind === 'index' && e.deptype === 'a' && ref && ref.kind === 'table') {
      const tables = indexTables.get(src.key) ?? new Set(); tables.add(ref.key); indexTables.set(src.key, tables);
    }
  }
  for (const [indexKey, tables] of indexTables) {
    const index = registry.get(indexKey);
    if (tables.size === 1) index.table = [...tables][0]; else add('edge_contradiction', indexKey, 'index_on_several_tables');
  }
  for (const o of objects) if (o.kind === 'index' && o.admitted && o.table === null && !indexTables.has(o.key)) add('companion_unlinked', o.key, 'index_without_table');
  /** Targets an automatic or internal edge of this object may point at, with the deptypes allowed.
   * @param {any} s @param {any} e */
  function reconciles(s, e) {
    const role = s.role === 'relation' ? s.kind : s.role;
    const allowedTypes = /** @type {Record<string, string[]>} */ (EXPECT)[role];
    if (!allowedTypes || !allowedTypes.includes(e.deptype)) return false;
    const target = keyOf(e.ref_classid, e.ref_objid);
    switch (role) {
      case 'index': return (e.deptype === 'a' && s.table === target) || (e.deptype === 'i' && s.constraintBacked === target);
      case 'sequence': return s.ownership !== null && s.ownership.tableKey === target && s.ownership.column === e.ref_subid
        && s.ownership.mode === (e.deptype === 'a' ? 'serial' : 'identity');
      case 'row_type': return s.ownerKey === target;
      case 'array_type': return s.elementKey === target;
      case 'constraint': case 'policy': return s.ownerKey === target;
      case 'trigger': return e.deptype === 'i' ? s.internal === true && s.related === target : s.ownerKey === target;
      case 'rule': return s.ownerKey === target;
      case 'attrdef': return s.ownerKey === target && s.column === e.ref_subid;
      default: return false;
    }
  }
  /** @type {Map<string, string[]>} */ const orderAdj = new Map();
  /** @type {Set<string>} */ const orderNodes = new Set();
  for (const e of internalRows) {
    const srcKey = keyOf(e.source_classid, e.source_objid); const refKey = keyOf(e.ref_classid, e.ref_objid);
    const src = registry.get(srcKey); const ref = registry.get(refKey);
    const nature = /** @type {Record<string,string>} */ (NATURE)[e.deptype];
    const okClasses = classKnown(e.source_classid) && classKnown(e.ref_classid);
    const id = noteEdge({ classid: e.source_classid, oid: e.source_objid, subid: e.source_subid }, { classid: e.ref_classid, oid: e.ref_objid, subid: e.ref_subid }, e.deptype, 'internal');
    if (okClasses && (!src || !ref)) add('edge_unknown_endpoint', id, !src ? 'source' : 'reference');
    if (nature === 'partition') add('partition_dependency', id, null);
    if (nature === 'extension') add('extension_member', id, 'edge');
    let reconciled = null;
    if (nature === 'automatic' || nature === 'internal') {
      reconciled = Boolean(src && ref && reconciles(src, e));
      if (!reconciled && src && ref) add('edge_unreconciled', id, nature);
    }
    const sourceGroup = keyOf(e.source_group_classid, e.source_group_oid); const refGroup = keyOf(e.ref_group_classid, e.ref_group_oid);
    if (nature === 'normal' && sourceGroup !== refGroup) {
      orderNodes.add(sourceGroup); orderNodes.add(refGroup);
      orderAdj.set(sourceGroup, [...new Set([...(orderAdj.get(sourceGroup) ?? []), refGroup])]);
    }
    edges.push({ id, origin: 'internal', scope: 'internal', nature, deptype: e.deptype, reconciled,
      source: { classid: e.source_classid, oid: e.source_objid, subid: e.source_subid }, ref: { classid: e.ref_classid, oid: e.ref_objid, subid: e.ref_subid },
      sourceGroup, refGroup, targetSchema: schemaName });
  }
  for (const e of rows.ev_outbound_references ?? []) {
    const srcKey = keyOf(e.source_classid, e.source_objid);
    const nature = /** @type {Record<string,string>} */ (NATURE)[e.deptype];
    classKnown(e.source_classid);
    const id = noteEdge({ classid: e.source_classid, oid: e.source_objid, subid: e.source_subid }, { classid: e.ref_classid, oid: e.ref_objid, subid: e.ref_subid }, e.deptype, 'outbound');
    if (!registry.has(srcKey)) add('edge_unknown_endpoint', id, 'source');
    let scope = 'cross_schema';
    if (nature === 'extension') { scope = 'extension'; add('extension_member', id, 'edge'); }
    else if (nature === 'partition') { scope = 'partition'; add('partition_dependency', id, null); }
    else if (SYSTEM_SCHEMAS.includes(e.target_schema) && nature === 'normal') scope = 'system';
    else if (nature === 'normal' || nature === 'automatic' || nature === 'internal') {
      add('cross_schema_reference', id, e.target_schema);
      if (nature !== 'normal') add('edge_unreconciled', id, nature);
    }
    edges.push({ id, origin: 'outbound', scope, nature, deptype: e.deptype, reconciled: nature === 'normal' ? null : false,
      source: { classid: e.source_classid, oid: e.source_objid, subid: e.source_subid }, ref: { classid: e.ref_classid, oid: e.ref_objid, subid: e.ref_subid },
      sourceGroup: keyOf(e.group_classid, e.group_oid), refGroup: null, targetSchema: e.target_schema });
  }
  for (const e of external) {
    const nature = /** @type {Record<string,string>} */ (NATURE)[e.deptype];
    const id = noteEdge({ classid: e.classid, oid: e.objid, subid: e.objsubid }, { classid: e.refclassid, oid: e.refobjid, subid: null }, e.deptype, 'external');
    const toastOwner = e.namespace === 'pg_toast' && e.classid === 'pg_class' && accountedToast.get(e.objid) === e.refobjid
      && (e.deptype === 'i' || e.deptype === 'a') && e.refclassid === 'pg_class';
    let scope = 'external_dependent';
    if (toastOwner) scope = 'toast_candidate';
    else {
      add('external_dependent', id, e.namespace);
      if (e.namespace === 'pg_toast') add('toast_unaccounted', id, null);
    }
    if (nature === 'partition') add('partition_dependency', id, null);
    if (nature === 'extension') add('extension_member', id, 'edge');
    classKnown(e.classid);
    edges.push({ id, origin: 'external', scope, nature, deptype: e.deptype, reconciled: toastOwner, depth: e.depth,
      source: { classid: e.classid, oid: e.objid, subid: e.objsubid }, ref: { classid: e.refclassid, oid: e.refobjid, subid: null },
      sourceGroup: null, refGroup: null, targetSchema: e.namespace });
  }
  const cycles = components([...orderNodes].sort(cmpKey), new Map([...orderAdj].map(([k, v]) => [k, [...v].sort(cmpKey)])))
    .filter(c => c.length > 1).map(c => ({ groups: c.sort(cmpKey) })).sort((a, b) => cmpKey(a.groups[0], b.groups[0]));

  // --- result
  const findings = [...found.values()].sort((a, b) => cmp(a.code, b.code) || cmp(String(a.subject), String(b.subject)) || cmp(String(a.detail), String(b.detail)));
  const exclusions = [...new Set(findings.filter(f => f.state === 'excluded').map(f => f.code))].sort();
  const worst = findings.filter(f => f.state !== 'excluded').reduce((w, f) => (states.severity(f.state) > states.severity(w) ? f.state : w),
    inputVerdict ? /** @type {any} */ (inputVerdict).structural : 'unresolved');
  const structural = worst;
  const reasons = inputVerdict ? [.../** @type {any} */ (inputVerdict).reasons] : [];
  const byOid = (/** @type {any} */ a, /** @type {any} */ b) => cmpKey(a.key, b.key);
  const slim = (/** @type {any} */ e) => ({ ...e });
  return freezeDeep({
    schema: { name: schemaName, oid: schemaOid, present: schemaPresent },
    objects: objects.map(slim).sort(byOid), routines: routines.map(slim).sort(byOid), types: types.map(slim).sort(byOid),
    companions: companions.map(slim).sort(byOid), toast: toast.sort((a, b) => cmpKey(a.ownerKey, b.ownerKey)),
    edges: edges.sort((a, b) => cmp(a.origin, b.origin) || cmp(a.id, b.id)), cycles, closureClasses,
    findings, exclusions, inputVerdict,
    verdict: { structural, demonstration: 'not_demonstrated', status: structural === 'structurally_valid' ? 'not_demonstrated' : structural,
      eligible: false, reasons, excluded: exclusions.length > 0 },
    serverValidated: false,
  });
}

module.exports = Object.freeze({ classify, NEEDED, FINDINGS, RELKINDS, ADMITTED, PROKINDS, TYPTYPES, CLASS_KINDS, NATURE, EXPECT });
