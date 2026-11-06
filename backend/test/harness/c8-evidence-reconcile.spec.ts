/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { reconcile, REQUIRED, CONCURRENCY, FINDINGS, UNPROVEN, OBSERVATION_STATUS, COUNT_FIELDS, COUNT_ONLY, ROW_TYPE_KINDS }
  from '../../scripts/harness/c8-evidence-reconcile.cjs';
import { classify } from '../../scripts/harness/c8-evidence-classify.cjs';
import { normalizeSet } from '../../scripts/harness/c8-evidence-normalize.cjs';
import { get } from '../../scripts/harness/c8-evidence-queries.cjs';
import { NAME } from './support/c8-pg-fakes';

const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/harness/c8-evidence-reconcile.cjs'), 'utf8');
type World = Record<string, any[]>;

const SCOPE = 5000;
const TOAST_NS = 99;


const rel = (oid: number, relname: string, relkind: string, extra: Record<string, unknown> = {}) => ({ oid, relname, relkind, owner: 'agenda_test_owner',
  relispartition: false, relpersistence: 'p', reltoastrelid: 0, relhasrules: false, relhastriggers: false, relrowsecurity: false, acl: null, ...extra });
const typ = (oid: number, typname: string, typtype: string, typrelid: number, typarray: number) => ({ oid, typname, typtype, typrelid, typarray, owner: 'agenda_test_owner' });
const item = (kind: string, classid: string, oid: number, groupOid: number, extra: Record<string, unknown> = {}) => ({ item_kind: kind, item_classid: classid, item_oid: oid,
  item_namespace_oid: SCOPE, group_classid: 'pg_class', group_oid: groupOid, related_classid: '', related_oid: 0, subtype: '', name: `${kind}_${oid}`,
  edge_deptype: null, edge_ref_subid: null, extension_edges: '0', ...extra });
const GROUPS: Record<string, [string, number]> = {};
const group = (classid: string, oid: number, g: [string, number] = [classid, oid]) => { GROUPS[`${classid}:${oid}`] = g; };
const edge = (src: [string, number, number], ref: [string, number, number], deptype: string) => {
  const sg = GROUPS[`${src[0]}:${src[1]}`] ?? [src[0], src[1]]; const rg = GROUPS[`${ref[0]}:${ref[1]}`] ?? [ref[0], ref[1]];
  return { source_classid: src[0], source_objid: src[1], source_subid: src[2], source_group_classid: sg[0], source_group_oid: sg[1], deptype,
    ref_classid: ref[0], ref_objid: ref[1], ref_subid: ref[2], ref_group_classid: rg[0], ref_group_oid: rg[1] };
};
const outbound = (src: [string, number, number], ref: [string, number, number], deptype: string, targetSchema: string | null) => ({
  source_classid: src[0], source_objid: src[1], source_subid: src[2], group_classid: (GROUPS[`${src[0]}:${src[1]}`] ?? [src[0], src[1]])[0],
  group_oid: (GROUPS[`${src[0]}:${src[1]}`] ?? [src[0], src[1]])[1], deptype, ref_classid: ref[0], ref_objid: ref[1], ref_subid: ref[2], target_schema: targetSchema });
const ext = (depth: number, classid: string, objid: number, deptype: string, refclassid: string, refobjid: number, namespace: string | null) => ({
  depth, classid, objid, objsubid: 0, deptype, refclassid, refobjid, namespace });

/** A typical schema: two tables with PK, serial and identity sequences, a FK, a view, TOAST for both tables. */
function world(): World {
  for (const k of Object.keys(GROUPS)) delete GROUPS[k];
  const tables: [number, number][] = [[100, 100], [103, 103]];
  for (const oid of [100, 101, 102, 103, 104, 105, 106]) group('pg_class', oid);
  for (const [type, relation] of [[200, 100], [202, 103], [204, 106]]) group('pg_type', type, ['pg_class', relation]);
  for (const arr of [201, 203, 205]) group('pg_type', arr);
  for (const [c, t] of [[300, 100], [301, 103], [302, 103]]) group('pg_constraint', c, ['pg_class', t]);
  for (const [tg, t] of [[400, 100], [401, 100], [402, 103], [403, 103]]) group('pg_trigger', tg, ['pg_class', t]);
  group('pg_rewrite', 500, ['pg_class', 106]); group('pg_attrdef', 600, ['pg_class', 100]);
  void tables;
  const countsRow = Object.fromEntries(get('ev_namespace_catalog_counts').columns.map(c => [c.name, '0']));
  return {
    ev_namespace: [{ oid: SCOPE, name: NAME, owner: 'agenda_test_owner', comment: 'c', acl: null }],
    ev_relations: [rel(100, 't1', 'r', { reltoastrelid: 110, relhastriggers: true }), rel(101, 't1_pkey', 'i'), rel(102, 't1_id_seq', 'S'),
      rel(103, 't2', 'r', { reltoastrelid: 120, relhastriggers: true }), rel(104, 't2_pkey', 'i'), rel(105, 't2_gen_seq', 'S'), rel(106, 'v1', 'v', { relhasrules: true })],
    ev_routines: [],
    ev_types: [typ(200, 't1', 'c', 100, 201), typ(201, '_t1', 'b', 0, 0), typ(202, 't2', 'c', 103, 203), typ(203, '_t2', 'b', 0, 0), typ(204, 'v1', 'c', 106, 205), typ(205, '_v1', 'b', 0, 0)],
    ev_namespace_catalog_counts: [countsRow],
    ev_companion_items: [
      item('constraint', 'pg_constraint', 300, 100, { related_classid: 'pg_class', related_oid: 101, subtype: 'p', name: 't1_pkey' }),
      item('constraint', 'pg_constraint', 301, 103, { related_classid: 'pg_class', related_oid: 104, subtype: 'p', name: 't2_pkey' }),
      item('constraint', 'pg_constraint', 302, 103, { related_classid: 'pg_class', related_oid: 101, subtype: 'f', name: 't2_fk' }),
      ...[[400, 100], [401, 100], [402, 103], [403, 103]].map(([o, t]) => item('trigger', 'pg_trigger', o, t, { related_classid: 'pg_constraint', related_oid: 302, subtype: 'true' })),
      item('rule', 'pg_rewrite', 500, 106, { subtype: '1', name: '_RETURN' }),
      item('attrdef', 'pg_attrdef', 600, 100, { subtype: '1' }),
      item('sequence_owner', 'pg_class', 102, 100, { subtype: 'S', edge_deptype: 'a', edge_ref_subid: '1' }),
      item('sequence_owner', 'pg_class', 105, 103, { subtype: 'S', edge_deptype: 'i', edge_ref_subid: '1' }),
      item('toast_candidate', 'pg_class', 110, 100, { item_namespace_oid: TOAST_NS, subtype: 't', name: 'pg_toast_100', edge_deptype: 'i', edge_ref_subid: '0' }),
      item('toast_index_candidate', 'pg_class', 111, 100, { item_namespace_oid: TOAST_NS, related_classid: 'pg_class', related_oid: 110, subtype: 'i', name: 'pg_toast_100_index', edge_deptype: 'a', edge_ref_subid: '1' }),
      item('toast_index_candidate', 'pg_class', 111, 100, { item_namespace_oid: TOAST_NS, related_classid: 'pg_class', related_oid: 110, subtype: 'i', name: 'pg_toast_100_index', edge_deptype: 'a', edge_ref_subid: '2' }),
      item('toast_candidate', 'pg_class', 120, 103, { item_namespace_oid: TOAST_NS, subtype: 't', name: 'pg_toast_103', edge_deptype: 'i', edge_ref_subid: '0' }),
      item('toast_index_candidate', 'pg_class', 121, 103, { item_namespace_oid: TOAST_NS, related_classid: 'pg_class', related_oid: 120, subtype: 'i', name: 'pg_toast_103_index', edge_deptype: 'a', edge_ref_subid: '1' }),
    ],
    ev_internal_edges: [
      edge(['pg_class', 101, 0], ['pg_class', 100, 1], 'a'), edge(['pg_class', 101, 0], ['pg_constraint', 300, 0], 'i'),
      edge(['pg_class', 104, 0], ['pg_class', 103, 1], 'a'), edge(['pg_class', 104, 0], ['pg_constraint', 301, 0], 'i'),
      edge(['pg_constraint', 300, 0], ['pg_class', 100, 1], 'a'), edge(['pg_constraint', 301, 0], ['pg_class', 103, 1], 'a'),
      edge(['pg_constraint', 302, 0], ['pg_class', 103, 2], 'a'), edge(['pg_constraint', 302, 0], ['pg_class', 100, 1], 'n'), edge(['pg_constraint', 302, 0], ['pg_class', 101, 0], 'n'),
      ...[400, 401, 402, 403].map(o => edge(['pg_trigger', o, 0], ['pg_constraint', 302, 0], 'i')),
      edge(['pg_rewrite', 500, 0], ['pg_class', 106, 0], 'i'), edge(['pg_rewrite', 500, 0], ['pg_class', 100, 1], 'n'),
      edge(['pg_attrdef', 600, 0], ['pg_class', 100, 1], 'a'), edge(['pg_attrdef', 600, 0], ['pg_class', 102, 0], 'n'),
      edge(['pg_class', 102, 0], ['pg_class', 100, 1], 'a'), edge(['pg_class', 105, 0], ['pg_class', 103, 1], 'i'),
      edge(['pg_type', 200, 0], ['pg_class', 100, 0], 'i'), edge(['pg_type', 202, 0], ['pg_class', 103, 0], 'i'), edge(['pg_type', 204, 0], ['pg_class', 106, 0], 'i'),
      edge(['pg_type', 201, 0], ['pg_type', 200, 0], 'i'), edge(['pg_type', 203, 0], ['pg_type', 202, 0], 'i'), edge(['pg_type', 205, 0], ['pg_type', 204, 0], 'i'),
    ],
    ev_outbound_references: [],
    ev_external_dependents: [ext(1, 'pg_class', 110, 'i', 'pg_class', 100, 'pg_toast'), ext(2, 'pg_class', 111, 'a', 'pg_class', 110, 'pg_toast'),
      ext(1, 'pg_class', 120, 'i', 'pg_class', 103, 'pg_toast'), ext(2, 'pg_class', 121, 'a', 'pg_class', 120, 'pg_toast')],
    ev_extension_members: [],
    ev_closure: [],
  };
}

const PARAM: Record<string, unknown> = { schema: NAME, key: '4095698742242691401', app: 'agenda_test_app' };
const observation = (id: string, rows: unknown, over: Record<string, unknown> = {}) => {
  const q = get(id);
  return { id, sqlSha256: q.sqlSha256, values: q.params.map(p => PARAM[p]), result: { status: 'rows', rows }, ...over };
};
const closureFor = (w: World) => {
  const seen = new Map<string, any>();
  const put = (classid: string, objid: number, depth: number) => { const k = `${classid}:${objid}`; if (!seen.has(k)) seen.set(k, { depth, classid, objid, objsubid: 0, deptype: 'n' }); };
  for (const r of w.ev_relations) put('pg_class', r.oid, 1);
  for (const t of w.ev_types) put('pg_type', t.oid, 1);
  for (const r of w.ev_routines) put('pg_proc', r.oid, 1);
  for (const i of w.ev_companion_items) {
    if (i.item_kind === 'sequence_owner' && i.item_namespace_oid === SCOPE) continue;
    put(i.item_classid, i.item_oid, i.item_kind === 'toast_index_candidate' ? 3 : 2);
  }
  return [...seen.values()];
};
/** Typical schema plus counts, closure and the five concurrency/context observations. */
function world2(): World {
  const w = world();
  w.ev_namespace_catalog_counts[0].class = '7'; w.ev_namespace_catalog_counts[0].type = '6';
  w.ev_closure = closureFor(w);
  w.ev_context = [{ pid: 4242, backend_start: '2026-01-01 00:00:00+00', database: 'agenda_test', current_user: 'agenda_test_owner', session_user: 'agenda_test_owner',
    transaction_read_only: 'on', transaction_isolation: 'repeatable read', lock_timeout: '2s', statement_timeout: '10s', idle_in_transaction_session_timeout: '15s',
    server_version_num: '160015', in_recovery: false }];
  w.ev_sessions = []; w.ev_target_relation_locks = []; w.ev_advisory_holders = []; w.ev_prepared_xacts = [];
  return w;
}
const build = (w: World, over: Record<string, Record<string, unknown>> = {}) => {
  const ids = REQUIRED.filter(id => id in w);
  return normalizeSet(ids.map(id => observation(id, w[id], over[id])), { required: [...ids] });
};
const rec = (w: World, over: Record<string, Record<string, unknown>> = {}) => { const set = build(w, over); return reconcile(set, classify(set)); };
const mod = (fn: (w: World) => void, over: Record<string, Record<string, unknown>> = {}) => { const w = world2(); fn(w); return rec(w, over); };
const codes = (r: any) => [...new Set<string>(r.findings.map((f: any) => f.code))].sort();
const deepFrozen = (v: any): boolean => v === null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(deepFrozen));
const has = (r: any, structural: string, expected: string[]) => {
  expect(r.verdict.structural).toBe(structural); expect(codes(r)).toEqual(expect.arrayContaining(expected));
  expect(r.verdict.eligible).toBe(false); expect(r.verdict.demonstration).toBe('not_demonstrated'); expect(r.serverValidated).toBe(false);
};
const exact = (r: any, structural: string, expected: string[]) => { has(r, structural, expected); expect(codes(r)).toEqual([...expected].sort()); };
const findingOf = (r: any, code: string) => r.findings.filter((f: any) => f.code === code);

describe('S1-C/C3-D reconciliación: esquema típico coherente', () => {
  const set = build(world2()); const c = classify(set); const r = reconcile(set, c);
  it('sin hallazgos, no demostrado, no elegible, con lo no probado declarado', () => {
    expect(r.findings).toEqual([]); expect(r.exclusions).toEqual([]);
    expect(r.verdict).toEqual({ structural: 'structurally_valid', demonstration: 'not_demonstrated', status: 'not_demonstrated', eligible: false, reasons: [], excluded: false });
    expect(r.serverValidated).toBe(false); expect(r.pairing).toBe('matched'); expect(r.provenance).toBe('unauthenticated');
    expect(r.unproven).toEqual(['provenance', 'snapshot_identity', 'connection_identity', 'transaction_identity', 'quiescence', 'server_validation']);
    expect(r.classification).toEqual({ structural: 'structurally_valid', findings: 0 });
  });
  it('resúmenes de inventario, compañeros, dependencias y concurrencia', () => {
    expect(r.inventory).toMatchObject({ relations: 7, routines: 0, types: 6, reconciled: true });
    expect(r.inventory.counts).toEqual({ class: { declared: '7', listed: 7 }, proc: { declared: '0', listed: 0 }, type: { declared: '6', listed: 6 } });
    for (const f of COUNT_ONLY) expect(r.inventory.categories[f]).toEqual({ declared: '0', enumerated: false });
    expect(r.inventory.categories.extension).toEqual({ declared: '0', enumerated: true, listed: 0 });
    expect(r.companions.byRole).toEqual({ constraint: 3, trigger: 4, rule: 1, attrdef: 1 });
    expect(r.companions.rowSecurity).toEqual({ enabled: 0, withPolicies: 0 });
    expect(r.dependencies.closure).toMatchObject({ unaccounted: 0, missing: 0 }); expect(r.dependencies.closure.rows).toBe(r.dependencies.closure.distinct);
    expect(r.dependencies).toMatchObject({ outboundEdges: 0, externalEdges: 4, extensionMembers: 0 }); expect(r.dependencies.internalEdges).toBeGreaterThan(20);
    expect(r.concurrency.quiescence).toBe('unproven');
    expect(r.concurrency.queries.ev_context).toEqual({ status: 'executed_rows', rowCount: 1 });
    for (const id of CONCURRENCY.slice(1)) expect(r.concurrency.queries[id]).toEqual({ status: 'executed_empty', rowCount: 0 });
    expect(r.concurrency.context).toMatchObject({ pid: 4242, database: 'agenda_test', isolation: 'repeatable read' });
    expect(r.concurrency.sessions).toEqual({ count: 0 });
  });
  it('inmutable, determinista e independiente del orden de las filas', () => {
    expect(deepFrozen(r)).toBe(true);
    const w = world2(); for (const id of Object.keys(w)) w[id] = [...w[id]].reverse();
    expect(rec(w)).toEqual(r); expect(rec(world2())).toEqual(r);
    expect(Object.keys(r).sort()).toEqual(['classification', 'companions', 'concurrency', 'dependencies', 'exclusions', 'findings', 'inputVerdict', 'inventory', 'observations', 'pairing', 'provenance', 'schema', 'serverValidated', 'unproven', 'verdict']);
    expect(JSON.stringify(r)).not.toMatch(/"(plan|order|drop|body|authoriz\w*|connectionId|transactionId)"\s*:/i);
  });
  it('un esquema ausente y vacío es consistente', () => {
    const w = world2(); w.ev_namespace = []; w.ev_namespace_catalog_counts = []; for (const id of ['ev_relations', 'ev_types', 'ev_companion_items', 'ev_internal_edges', 'ev_external_dependents', 'ev_closure']) w[id] = [];
    const e = rec(w); exact(e, 'structurally_valid', []); expect(e.schema).toEqual({ name: null, oid: null, present: false });
  });
});

describe('S1-C/C3-D reconciliación: inventario y conteos', () => {
  const field = (name: string, value: string) => mod(w => { w.ev_namespace_catalog_counts[0][name] = value; });
  it.each([['class', '8'], ['proc', '1'], ['type', '7']])('conteo de %s mayor que lo enumerado: no se inventan objetos', (name, value) => {
    const r = field(name, value); has(r, 'unresolved', ['count_exceeds_listed']); expect(findingOf(r, 'count_exceeds_listed')[0].subject).toBe(name);
    expect(r.inventory.relations).toBe(7); expect(r.inventory.counts[name].declared).toBe(value);
  });
  it.each([['class', '6'], ['type', '5']])('conteo de %s menor que lo enumerado: divergencia incompleta', (name, value) => {
    const r = field(name, value); has(r, 'incomplete', ['listed_exceeds_count']);
  });
  it('rutinas listadas con conteo cero y viceversa', () => {
    const w = world2(); w.ev_routines = [{ oid: 800, proname: 'f', prokind: 'f', owner: 'agenda_test_owner', acl: null }]; w.ev_closure = closureFor(w);
    has(rec(w), 'incomplete', ['listed_exceeds_count']);
    const ok = world2(); ok.ev_routines = [{ oid: 800, proname: 'f', prokind: 'f', owner: 'agenda_test_owner', acl: null }]; ok.ev_namespace_catalog_counts[0].proc = '1'; ok.ev_closure = closureFor(ok);
    exact(rec(ok), 'structurally_valid', []);
  });
  it.each(COUNT_ONLY)('categoría solo-conteo %s mayor que 0: objetos no enumerables, nunca inventados', name => {
    const r = field(name, '3'); exact(r, 'structurally_valid', ['counted_not_enumerated']);
    expect(r.inventory.categories[name]).toEqual({ declared: '3', enumerated: false }); expect(r.verdict.excluded).toBe(true); expect(r.exclusions).toContain('counted_not_enumerated');
  });
  it('extensiones: el conteo se contrasta con los miembros de clase extensión', () => {
    has(field('extension', '1'), 'unresolved', ['extension_count_mismatch']);
    const r = mod(w => { w.ev_namespace_catalog_counts[0].extension = '1'; w.ev_extension_members = [{ extension_oid: 40, extension_name: 'e', classid: 'pg_extension', objid: 40, objsubid: 0 }]; w.ev_closure.push({ depth: 1, classid: 'pg_extension', objid: 40, objsubid: 0, deptype: 'n' }); });
    expect(codes(r)).not.toContain('extension_count_mismatch'); expect(r.inventory.categories.extension).toEqual({ declared: '1', enumerated: true, listed: 1 });
  });
  it('conteos sin esquema o esquema sin conteos', () => {
    has(mod(w => { w.ev_namespace_catalog_counts = []; }), 'unresolved', ['counts_missing']);
    has(mod(w => { w.ev_namespace = []; }), 'invalid', ['count_without_schema']);
  });
  it('tipos de fila y de arreglo que faltan', () => {
    const noRow = mod(w => { w.ev_types = w.ev_types.filter((t: any) => t.oid !== 200); w.ev_namespace_catalog_counts[0].type = '5'; });
    has(noRow, 'unresolved', ['row_type_missing']); expect(findingOf(noRow, 'row_type_missing')[0].subject).toBe('pg_class:100');
    const noArray = mod(w => { w.ev_types = w.ev_types.filter((t: any) => t.oid !== 201); w.ev_namespace_catalog_counts[0].type = '5'; });
    has(noArray, 'unresolved', ['array_type_missing']); expect(findingOf(noArray, 'array_type_missing')[0].subject).toBe('pg_type:200');
    expect(ROW_TYPE_KINDS).toContain('table'); expect(ROW_TYPE_KINDS).not.toContain('sequence'); expect(ROW_TYPE_KINDS).not.toContain('index');
  });
  it('categorías y campos de conteo cerrados', () => {
    expect(COUNT_FIELDS).toHaveLength(15); expect(new Set([...COUNT_ONLY, 'class', 'proc', 'type', 'extension']).size).toBe(15);
    expect(COUNT_FIELDS.slice().sort()).toEqual(get('ev_namespace_catalog_counts').columns.map(c => c.name).sort());
  });
});

describe('S1-C/C3-D reconciliación: compañeros y banderas', () => {
  const trig = (w: World) => w.ev_companion_items.filter((i: any) => i.item_kind === 'trigger');
  it('relhastriggers/relhasrules son pistas: bandera sin compañero queda sin resolver; compañero sin bandera es contradictorio', () => {
    const noTriggers = mod(w => { w.ev_companion_items = w.ev_companion_items.filter((i: any) => !(i.item_kind === 'trigger' && i.group_oid === 100)); });
    has(noTriggers, 'unresolved', ['flag_unmatched']); expect(findingOf(noTriggers, 'flag_unmatched')[0]).toMatchObject({ subject: 'pg_class:100', detail: 'relhastriggers' });
    const flagOff = mod(w => { w.ev_relations[0].relhastriggers = false; });
    has(flagOff, 'invalid', ['companion_without_flag']); expect(findingOf(flagOff, 'companion_without_flag')[0].detail).toBe('relhastriggers');
    has(mod(w => { w.ev_relations[6].relhasrules = false; }), 'invalid', ['companion_without_flag']);
    has(mod(w => { w.ev_companion_items = w.ev_companion_items.filter((i: any) => i.item_kind !== 'rule'); }), 'unresolved', ['flag_unmatched']);
    expect(trig(world2()).length).toBe(4);
  });
  it('una bandera verdadera sin compañeros no se interpreta como ausencia si la consulta está incompleta', () => {
    const r = mod(w => { w.ev_companion_items = []; }, { ev_companion_items: { result: { status: 'error', code: 'timeout' } } });
    expect(codes(r)).toContain('observation_failed'); expect(codes(r)).not.toContain('flag_unmatched'); expect(r.verdict.structural).toBe('unresolved');
    expect(r.observations.ev_companion_items.status).toBe('failed');
  });
  it('seguridad por filas: se resume, no se compara como conteo', () => {
    const r = mod(w => { w.ev_relations[0].relrowsecurity = true; w.ev_relations[3].relrowsecurity = true; w.ev_companion_items.push(item('policy', 'pg_policy', 700, 100, { subtype: '*' })); w.ev_closure.push({ depth: 2, classid: 'pg_policy', objid: 700, objsubid: 0, deptype: 'a' }); w.ev_internal_edges.push(edge(['pg_policy', 700, 0], ['pg_class', 100, 0], 'a')); });
    expect(r.companions.rowSecurity).toEqual({ enabled: 2, withPolicies: 1 }); expect(codes(r)).not.toContain('flag_unmatched');
  });
  it('aristas esperadas de cada compañero: una arista faltante es hallazgo, no seguridad', () => {
    const drop = (classid: string, oid: number, deptype?: string) => (w: World) => { w.ev_internal_edges = w.ev_internal_edges.filter((e: any) => !(e.source_classid === classid && e.source_objid === oid && (deptype === undefined || e.deptype === deptype))); };
    for (const [classid, oid, deptype, role] of [['pg_constraint', 300, 'a', 'constraint'], ['pg_class', 102, 'a', 'sequence_owner'], ['pg_class', 105, 'i', 'sequence_owner'],
      ['pg_type', 200, 'i', 'row_type'], ['pg_type', 201, 'i', 'array_type'], ['pg_attrdef', 600, 'a', 'attrdef'], ['pg_rewrite', 500, 'i', 'rule'], ['pg_trigger', 400, 'i', 'trigger']] as const) {
      const r = mod(drop(classid, oid, deptype)); has(r, 'unresolved', ['edge_missing']);
      expect(findingOf(r, 'edge_missing').map((f: any) => [f.subject, f.detail])).toContainEqual([`${classid}:${oid}`, role]);
    }
    has(mod(w => { w.ev_companion_items.push(item('policy', 'pg_policy', 700, 100, { subtype: '*' })); w.ev_closure.push({ depth: 2, classid: 'pg_policy', objid: 700, objsubid: 0, deptype: 'a' }); }), 'unresolved', ['edge_missing']);
  });
});

describe('S1-C/C3-D reconciliación: aristas con tipo o columna incorrectos', () => {
  it('una arista al propietario correcto pero con otro tipo de dependencia no cuenta como la esperada', () => {
    const r = mod(w => { w.ev_internal_edges.find((e: any) => e.source_classid === 'pg_constraint' && e.source_objid === 300 && e.ref_objid === 100).deptype = 'i'; });
    has(r, 'unresolved', ['edge_missing']); expect(findingOf(r, 'edge_missing')[0]).toMatchObject({ subject: 'pg_constraint:300', detail: 'constraint' });
  });
  it('una arista a otra columna no sustituye a la columna del valor por defecto ni de la secuencia propia', () => {
    const r = mod(w => { w.ev_internal_edges.find((e: any) => e.source_classid === 'pg_attrdef' && e.ref_objid === 100).ref_subid = 2; });
    has(r, 'unresolved', ['edge_missing']); expect(findingOf(r, 'edge_missing')[0]).toMatchObject({ subject: 'pg_attrdef:600', detail: 'attrdef' });
    const seq = mod(w => { w.ev_internal_edges.find((e: any) => e.source_classid === 'pg_class' && e.source_objid === 102 && e.ref_objid === 100).ref_subid = 2; });
    has(seq, 'unresolved', ['edge_missing']);
  });
});

describe('S1-C/C3-D reconciliación: cierre y dependencias', () => {
  const closureRow = (classid: string, objid: number, depth = 1) => ({ depth, classid, objid, objsubid: 0, deptype: 'n' });
  it('objetos del inventario o compañeros ausentes del cierre', () => {
    const noRelation = mod(w => { w.ev_closure = w.ev_closure.filter((c: any) => !(c.classid === 'pg_class' && c.objid === 100)); });
    has(noRelation, 'unresolved', ['inventory_not_in_closure']); expect(noRelation.dependencies.closure.missing).toBe(1);
    const noCompanion = mod(w => { w.ev_closure = w.ev_closure.filter((c: any) => !(c.classid === 'pg_constraint' && c.objid === 300)); });
    has(noCompanion, 'unresolved', ['companion_not_in_closure']);
    has(mod(w => { w.ev_closure = w.ev_closure.filter((c: any) => c.objid !== 110); }), 'unresolved', ['companion_not_in_closure']);
  });
  it('filas del cierre sin contabilizar y clases desconocidas', () => {
    const extra = mod(w => { w.ev_closure.push(closureRow('pg_class', 9999)); });
    has(extra, 'unresolved', ['closure_unaccounted']); expect(extra.dependencies.closure.unaccounted).toBe(1);
    const unknown = mod(w => { w.ev_closure.push(closureRow('pg_language', 12)); });
    has(unknown, 'unresolved', ['closure_unaccounted']); expect(findingOf(unknown, 'closure_unaccounted')[0].subject).toBe('pg_language:12');
    has(mod(w => { w.ev_closure.push(closureRow('pg_collation', 5)); }), 'unresolved', ['closure_unaccounted']);
  });
  it('un objeto miembro de extensión no se exige en el cierre', () => {
    const r = mod(w => { w.ev_extension_members.push({ extension_oid: 40, extension_name: 'e', classid: 'pg_class', objid: 101, objsubid: 0 }); w.ev_closure = w.ev_closure.filter((c: any) => c.objid !== 101); });
    expect(codes(r)).not.toContain('inventory_not_in_closure'); expect(codes(r)).not.toContain('closure_unaccounted');
  });
  it('dependientes externos: fuera del cierre, referencia sin explicar, o con la identidad de un objeto propio', () => {
    const notIn = mod(w => { w.ev_external_dependents.push(ext(1, 'pg_class', 950, 'n', 'pg_class', 100, 'other')); });
    has(notIn, 'incomplete', ['external_not_in_closure']); expect(codes(notIn)).not.toContain('external_reference_unexplained');
    const unexplained = mod(w => { w.ev_external_dependents.push(ext(1, 'pg_class', 950, 'n', 'pg_class', 777, 'other')); w.ev_closure.push(closureRow('pg_class', 950, 2)); });
    has(unexplained, 'unresolved', ['external_reference_unexplained']);
    const both = mod(w => { w.ev_external_dependents.push(ext(1, 'pg_constraint', 300, 'n', 'pg_class', 100, 'other')); });
    has(both, 'invalid', ['identity_in_scope_and_external']);
    const seed = mod(w => { w.ev_external_dependents.push(ext(1, 'pg_class', 951, 'n', 'pg_namespace', SCOPE, 'other')); w.ev_closure.push(closureRow('pg_class', 951)); });
    expect(codes(seed)).not.toContain('external_reference_unexplained'); expect(codes(seed)).not.toContain('external_not_in_closure');
  });
  it('aristas internas o salientes cuyo origen no está en el cierre; no se confía en una arista automática por sí sola', () => {
    has(mod(w => { w.ev_outbound_references.push(outbound(['pg_class', 777, 0], ['pg_type', 23, 0], 'n', 'pg_catalog')); }), 'unresolved', ['edge_source_not_in_closure']);
    const auto = mod(w => { w.ev_internal_edges.push(edge(['pg_class', 100, 0], ['pg_class', 103, 0], 'a')); });
    expect(auto.classification.structural).toBe('unresolved'); expect(auto.verdict.structural).toBe('unresolved'); expect(auto.verdict.eligible).toBe(false);
  });
  it('miembros de extensión que no corresponden a ningún objeto reconocido', () => {
    has(mod(w => { w.ev_extension_members.push({ extension_oid: 40, extension_name: 'e', classid: 'pg_class', objid: 9999, objsubid: 0 }); }), 'unresolved', ['extension_member_unaccounted']);
    const known = mod(w => { w.ev_extension_members.push({ extension_oid: 40, extension_name: 'e', classid: 'pg_class', objid: 100, objsubid: 0 }); });
    expect(codes(known)).not.toContain('extension_member_unaccounted'); expect(known.exclusions).toContain('extension_member');
  });
});

describe('S1-C/C3-D reconciliación: observaciones y concurrencia', () => {
  it('estados de observación cerrados', () => {
    expect(OBSERVATION_STATUS).toEqual(['executed_empty', 'executed_rows', 'absent', 'failed', 'truncated', 'invalid', 'insufficient']);
    expect(REQUIRED).toHaveLength(16); expect(CONCURRENCY).toHaveLength(5);
  });
  it.each(REQUIRED)('%s: ausente, fallida, inválida y vacía válida se distinguen', id => {
    const absent = (() => { const w = world2(); delete (w as any)[id]; return rec(w); })();
    expect(absent.observations[id].status).toBe('absent'); has(absent, id === 'ev_namespace' ? absent.verdict.structural : 'unresolved', ['observation_absent']);
    expect(['unresolved', 'invalid']).toContain(absent.verdict.structural);
    const failed = mod(() => undefined, { [id]: { result: { status: 'error', code: 'timeout' } } });
    expect(failed.observations[id].status).toBe('failed'); has(failed, id === 'ev_namespace' ? failed.verdict.structural : 'unresolved', ['observation_failed']);
    expect(['unresolved', 'invalid']).toContain(failed.verdict.structural);
    const invalid = mod(() => undefined, { [id]: { sqlSha256: 'a'.repeat(64) } });
    expect(invalid.observations[id].status).toBe('invalid'); has(invalid, 'invalid', ['observation_invalid']);
  });
  it('consulta ejecutada con cero filas no es lo mismo que ausente ni fallida', () => {
    const r = rec(world2());
    for (const id of CONCURRENCY.slice(1)) { expect(r.observations[id]).toEqual({ status: 'executed_empty', rowCount: 0 }); expect(codes(r)).toEqual([]); }
  });
  it('una consulta requerida pero sin observación queda ausente (resultado sintético del normalizador)', () => {
    const w = world2(); const ids = REQUIRED.filter(id => id !== 'ev_prepared_xacts');
    const set = normalizeSet(ids.map(id => observation(id, w[id])), { required: [...REQUIRED] });
    const r = reconcile(set, classify(set));
    expect(r.observations.ev_prepared_xacts).toEqual({ status: 'absent', rowCount: null }); has(r, 'unresolved', ['observation_absent']);
  });
  it('consultas truncadas e información insuficiente', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ pid: 9000 + i, usename: 'u', application_name: 'a', backend_type: 'client backend', state: 'idle', xact_start: '2026-01-01 00:00:00+00', wait_event_type: 'Client' }));
    const truncated = mod(w => { w.ev_sessions = many(501); }); expect(truncated.observations.ev_sessions.status).toBe('truncated'); has(truncated, 'incomplete', ['observation_truncated']);
    const insufficient = mod(w => { w.ev_sessions = [{ ...many(1)[0], state: null }]; }); expect(insufficient.observations.ev_sessions.status).toBe('insufficient'); has(insufficient, 'unresolved', ['observation_insufficient']);
    const noStart = mod(w => { w.ev_context[0].backend_start = null; }); expect(noStart.observations.ev_context.status).toBe('insufficient'); expect(noStart.concurrency.context).toBeNull();
  });
  it('nunca se afirma quiescencia ni identidad compartida, con o sin filas', () => {
    const empty = rec(world2()); expect(empty.concurrency.quiescence).toBe('unproven'); expect(empty.unproven).toEqual(expect.arrayContaining(['quiescence', 'snapshot_identity', 'connection_identity', 'transaction_identity']));
    const busy = mod(w => { w.ev_sessions = [{ pid: 9001, usename: 'agenda_test_app', application_name: 'x', backend_type: 'client backend', state: 'idle', xact_start: '2026-01-01 00:00:00+00', wait_event_type: 'Client' }]; });
    expect(busy.concurrency.quiescence).toBe('unproven'); expect(busy.concurrency.sessions).toEqual({ count: 1 });
  });
  it('consistencia estructural: el propio pid no aparece como sesión ni como bloqueo ajeno; relaciones desconocidas; bloqueos preparados', () => {
    const lock = (pid: number | null, relation: number) => ({ pid, locktype: 'relation', mode: 'AccessShareLock', granted: true, relation });
    has(mod(w => { w.ev_sessions = [{ pid: 4242, usename: 'u', application_name: 'a', backend_type: 'client backend', state: 'idle', xact_start: '2026-01-01 00:00:00+00', wait_event_type: 'Client' }]; }), 'invalid', ['session_includes_self']);
    has(mod(w => { w.ev_target_relation_locks = [lock(4242, 100)]; }), 'invalid', ['lock_includes_self']);
    has(mod(w => { w.ev_target_relation_locks = [lock(5001, 9999)]; }), 'unresolved', ['lock_on_unlisted_relation']);
    has(mod(w => { w.ev_target_relation_locks = [lock(null, 100)]; }), 'unresolved', ['prepared_lock_without_xact']);
    const ok = mod(w => { w.ev_target_relation_locks = [lock(null, 100), lock(5001, 103)]; w.ev_prepared_xacts = [{ gid: 'g1', owner: 'u', database: 'agenda_test' }]; });
    expect(codes(ok)).toEqual([]); expect(ok.concurrency.locks).toEqual({ count: 2, prepared: 1 }); expect(ok.concurrency.preparedTransactions).toEqual({ count: 1 });
    const holders = mod(w => { w.ev_advisory_holders = [{ pid: 4242, database: 5, mode: 'ExclusiveLock', granted: true }]; });
    expect(holders.concurrency.advisoryHolders).toEqual({ count: 1 }); expect(codes(holders)).toEqual([]);
  });
});

describe('S1-C/C3-D reconciliación: pareja conjunto-clasificación y entradas fabricadas', () => {
  it('una clasificación de otro conjunto, alterada o ilegible invalida la pareja', () => {
    const set = build(world2()); const c = classify(set);
    const other = world2(); other.ev_namespace[0].oid = 6000; other.ev_companion_items.forEach((i: any) => { if (i.item_namespace_oid === SCOPE) i.item_namespace_oid = 6000; });
    const otherSet = build(other);
    for (const wrong of [classify(otherSet), { ...c, schema: { ...c.schema, name: 'otro' } }, { ...c, findings: [{ code: 'x' }] }, { ...c, exclusions: ['x'] }]) {
      const r = reconcile(set, wrong); has(r, 'invalid', ['classification_mismatch']); expect(r.pairing).toBe('mismatched'); expect(findingOf(r, 'classification_mismatch')[0].detail).toBe('content');
    }
    const trap = jest.fn();
    for (const readable of [null, 1, 'x', []]) {
      const r = reconcile(set, readable as never); has(r, 'invalid', ['classification_mismatch']); expect(findingOf(r, 'classification_mismatch')[0].detail).toBe('content');
    }
    for (const hostile of [undefined, new Proxy(c, {}), Object.defineProperty({ ...c }, 'schema', { get: trap, enumerable: true }), Object.create(c), { ...c, [Symbol('s')]: 1 }]) {
      expect(() => reconcile(set, hostile as never)).not.toThrow(); const r = reconcile(set, hostile as never);
      has(r, 'invalid', ['classification_mismatch']); expect(findingOf(r, 'classification_mismatch')[0].detail).toBe('unreadable');
    }
    expect(trap).not.toHaveBeenCalled();
  });
  it('esquemas diferentes entre conjunto y clasificación se rechazan', () => {
    const a = build(world2()); const w = world2(); w.ev_namespace[0] = { ...w.ev_namespace[0], name: 'uow_2611011200_zzz999_9', oid: 7000 };
    const b = build(w);
    has(reconcile(a, classify(b)), 'invalid', ['classification_mismatch']); has(reconcile(b, classify(a)), 'invalid', ['classification_mismatch']);
  });
  it('un conjunto fabricado con veredictos genuinos copiados se reconcilia igual: la procedencia no se demuestra', () => {
    const set = build(world2()); const copy = { ...set, results: { ...set.results } };
    const real = reconcile(set, classify(set)); const fake = reconcile(copy, classify(copy));
    expect(fake).toEqual(real); expect(fake.provenance).toBe('unauthenticated'); expect(fake.verdict.demonstration).toBe('not_demonstrated'); expect(fake.verdict.eligible).toBe(false);
    expect(fake.unproven).toContain('provenance');
  });
  it('conjuntos hostiles o alterados no lanzan y no pasan a válidos', () => {
    const set = build(world2());
    const tampered = { ...set, results: { ...set.results, ev_relations: { ...set.results.ev_relations, rows: [{ extra: 1 }] } } };
    for (const bad of [null, undefined, 1, 'x', [], {}, new Proxy(set, {}), { ...set, verdict: { ...set.verdict } }, tampered,
      { ...set, results: { ...set.results, ev_relations: { ...set.results.ev_relations, serverValidated: true } } }]) {
      expect(() => reconcile(bad as never, classify(bad as never))).not.toThrow(); const r = reconcile(bad as never, classify(bad as never));
      expect(r.verdict.structural).not.toBe('structurally_valid'); expect(r.verdict.eligible).toBe(false); expect(r.findings.length).toBeGreaterThan(0);
    }
  });
  it('un conjunto que no es un conjunto normalizado se señala como mal formado en el propio reconciliador', () => {
    for (const bad of [null, undefined, 1, 'x', [], {}, new Proxy({}, {}), { verdict: {}, results: {} }]) {
      const r = reconcile(bad as never, classify(bad as never)); expect(codes(r)).toContain('input_malformed'); expect(r.verdict.structural).toBe('invalid');
    }
  });
  it('identidades repetidas y hallazgos de la clasificación se propagan sin relajarse', () => {
    const dup = mod(w => { w.ev_companion_items.push(item('constraint', 'pg_constraint', 300, 100, { related_classid: 'pg_class', related_oid: 101, subtype: 'p', name: 'otra' })); });
    expect(dup.classification.structural).toBe('invalid'); expect(dup.verdict.structural).toBe('invalid');
    const unsupported = mod(w => { w.ev_relations.push(rel(900, 'p', 'p')); w.ev_namespace_catalog_counts[0].class = '8'; w.ev_closure = closureFor(w); });
    expect(unsupported.exclusions).toContain('unsupported_kind'); expect(unsupported.verdict.excluded).toBe(true); expect(unsupported.verdict.structural).toBe('unresolved');
  });
});

describe('S1-C/C3-D reconciliación: vocabularios y superficie estática', () => {
  it('vocabularios cerrados y exports congelados', () => {
    expect(Object.isFrozen(jest.requireActual('../../scripts/harness/c8-evidence-reconcile.cjs'))).toBe(true);
    for (const v of [REQUIRED, CONCURRENCY, FINDINGS, UNPROVEN, OBSERVATION_STATUS, COUNT_FIELDS, COUNT_ONLY, ROW_TYPE_KINDS]) expect(Object.isFrozen(v)).toBe(true);
    for (const state of Object.values(FINDINGS)) expect(['excluded', 'incomplete', 'unresolved', 'invalid']).toContain(state);
    expect(UNPROVEN).toHaveLength(6);
  });
  it('imports exactos y sin identidades, atestaciones, cuerpos autorizables, planes ni SQL', () => {
    const ast = ts.createSourceFile('reconcile.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports: string[] = []; const names: string[] = [];
    (function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'require') imports.push((node.arguments[0] as ts.StringLiteral).text);
      if (ts.isIdentifier(node)) names.push(node.text);
      ts.forEachChild(node, visit);
    })(ast);
    expect(imports).toEqual(['node:util', './c8-evidence-queries.cjs', './c8-evidence-states.cjs', './c8-evidence-normalize.cjs', './c8-evidence-classify.cjs']);
    expect(source.startsWith("'use strict';")).toBe(true);
    expect(names.filter(n => /attest|authoriz|removalPlan|dropPlan|dropOrder|connectionId|transactionId|randomBytes/i.test(n))).toEqual([]);
    expect(source).not.toMatch(/pg_current_xact_id|c8-drop-policy|c8-provenance|serverValidated:\s*true|demonstration:\s*'demonstrated'|eligible:\s*true|process\.|console\./);
    expect(source).not.toMatch(/\b(?:DROP|CASCADE|INSERT|UPDATE|DELETE|ALTER|CREATE|GRANT|REVOKE|TRUNCATE|SELECT)\b/);
  });
});
