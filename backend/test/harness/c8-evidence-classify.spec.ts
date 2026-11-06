/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { classify, NEEDED, FINDINGS, RELKINDS, ADMITTED, PROKINDS, TYPTYPES, CLASS_KINDS, NATURE, EXPECT }
  from '../../scripts/harness/c8-evidence-classify.cjs';
import { normalizeSet } from '../../scripts/harness/c8-evidence-normalize.cjs';
import { get } from '../../scripts/harness/c8-evidence-queries.cjs';
import { NAME } from './support/c8-pg-fakes';

const SCOPE = 5000;
const TOAST_NS = 99;
const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/harness/c8-evidence-classify.cjs'), 'utf8');
type World = Record<string, any[]>;

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
const observation = (id: string, rows: unknown, over: Record<string, unknown> = {}) => {
  const q = get(id);
  return { id, sqlSha256: q.sqlSha256, values: q.params.map(() => NAME), result: { status: 'rows', rows }, ...over };
};
const build = (w: World, over: Record<string, Record<string, unknown>> = {}) => normalizeSet(NEEDED.filter(id => id in w).map(id => observation(id, w[id], over[id])), { required: [...NEEDED].filter(id => id in w) });
const run = (w: World, over: Record<string, Record<string, unknown>> = {}) => classify(build(w, over));
const codes = (c: any) => c.findings.map((f: any) => f.code);
const deepFrozen = (v: any): boolean => v === null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(deepFrozen));
const mod = (fn: (w: World) => void) => { const w = world(); fn(w); return run(w); };
const only = (c: any, structural: string, expected: string[]) => { expect(c.verdict.structural).toBe(structural); expect([...new Set<string>(codes(c))].sort()).toEqual([...new Set(expected)].sort()); expect(c.verdict.eligible).toBe(false); expect(c.verdict.demonstration).toBe('not_demonstrated'); };

/** Consecuencias en cadena de una anomalía principal (aristas que dejan de reconciliarse, TOAST sin contabilizar). */
const CONSEQUENCES = new Set(['edge_unreconciled', 'edge_unknown_endpoint', 'external_dependent', 'toast_unaccounted']);
const primaryOnly = (c: any, structural: string, expected: string[]) => {
  expect(c.verdict.structural).toBe(structural);
  expect([...new Set<string>(codes(c))].filter(x => !CONSEQUENCES.has(x)).sort()).toEqual([...new Set(expected)].filter(x => !CONSEQUENCES.has(x)).sort());
  expect(c.verdict.eligible).toBe(false); expect(c.verdict.demonstration).toBe('not_demonstrated');
};

describe('S1-C/C3-C clasificación: esquema típico', () => {
  const c = run(world());
  it('todo reconocido, sin hallazgos, no demostrado y no elegible', () => {
    expect(c.findings).toEqual([]); expect(c.exclusions).toEqual([]);
    expect(c.verdict).toEqual({ structural: 'structurally_valid', demonstration: 'not_demonstrated', status: 'not_demonstrated', eligible: false, reasons: [], excluded: false });
    expect(c.serverValidated).toBe(false); expect(c.schema).toEqual({ name: NAME, oid: SCOPE, present: true });
  });
  it('objetos principales admitidos: tablas, secuencias, índices y vistas con identidad completa', () => {
    expect(c.objects.map((o: any) => [o.key, o.kind, o.admitted])).toEqual([['pg_class:100', 'table', true], ['pg_class:101', 'index', true],
      ['pg_class:102', 'sequence', true], ['pg_class:103', 'table', true], ['pg_class:104', 'index', true], ['pg_class:105', 'sequence', true], ['pg_class:106', 'view', true]]);
    for (const o of c.objects) expect(o).toMatchObject({ classid: 'pg_class', role: 'relation' });
  });
  it('serial e identity quedan vinculadas a su tabla y columna; los índices de restricción a su restricción', () => {
    const by = (key: string) => c.objects.find((o: any) => o.key === key);
    expect(by('pg_class:102').ownership).toEqual({ tableKey: 'pg_class:100', column: 1, mode: 'serial', inScope: true });
    expect(by('pg_class:105').ownership).toEqual({ tableKey: 'pg_class:103', column: 1, mode: 'identity', inScope: true });
    expect(by('pg_class:101')).toMatchObject({ constraintBacked: 'pg_constraint:300', table: 'pg_class:100' });
    expect(by('pg_class:104')).toMatchObject({ constraintBacked: 'pg_constraint:301', table: 'pg_class:103' });
  });
  it('tipos de fila y de arreglo son compañeros de su relación; compañeros con propietario', () => {
    const types = Object.fromEntries(c.types.map((t: any) => [t.key, t]));
    expect(types['pg_type:200']).toMatchObject({ role: 'row_type', ownerKey: 'pg_class:100', admitted: false });
    expect(types['pg_type:201']).toMatchObject({ role: 'array_type', ownerKey: 'pg_class:100', elementKey: 'pg_type:200' });
    expect(c.companions.filter((x: any) => x.role === 'constraint').map((x: any) => [x.key, x.constraintKind, x.backingIndexKey])).toEqual(
      [['pg_constraint:300', 'primary_key', 'pg_class:101'], ['pg_constraint:301', 'primary_key', 'pg_class:104'], ['pg_constraint:302', 'foreign_key', null]]);
    expect(c.companions.filter((x: any) => x.role === 'trigger')).toHaveLength(4);
    expect(c.companions.find((x: any) => x.role === 'rule')).toMatchObject({ viewRule: true, ownerKey: 'pg_class:106' });
    expect(c.companions.find((x: any) => x.role === 'attrdef')).toMatchObject({ column: 1, ownerKey: 'pg_class:100' });
  });
  it('TOAST y su índice son solo candidatos corroborados con su tabla; nunca seguros', () => {
    expect(c.toast).toEqual([{ ownerKey: 'pg_class:100', toastKey: 'pg_class:110', toastIndexKey: 'pg_class:111', status: 'candidate_matched_with_index' },
      { ownerKey: 'pg_class:103', toastKey: 'pg_class:120', toastIndexKey: 'pg_class:121', status: 'candidate_matched_with_index' }]);
    expect(JSON.stringify(c)).not.toMatch(/"safe"|"verified"|"accepted"/);
    expect(c.edges.filter((e: any) => e.origin === 'external').map((e: any) => [e.scope, e.reconciled])).toEqual(Array(4).fill(['toast_candidate', true]));
  });
  it('toda arista automática o interna queda reconciliada con su propietario; las normales no se presumen seguras', () => {
    const owned = c.edges.filter((e: any) => ['automatic', 'internal'].includes(e.nature) && e.origin === 'internal');
    expect(owned.length).toBeGreaterThan(15); expect(owned.every((e: any) => e.reconciled === true)).toBe(true);
    expect(c.edges.filter((e: any) => e.nature === 'normal').every((e: any) => e.reconciled === null)).toBe(true);
    for (const e of c.edges) expect(Object.keys(e.source).sort()).toEqual(['classid', 'oid', 'subid']);
  });
  it('sin ciclos, sin plan ni orden de borrado, y resultado inmutable y determinista', () => {
    expect(c.cycles).toEqual([]);
    expect(Object.keys(c).sort()).toEqual(['closureClasses', 'companions', 'cycles', 'edges', 'exclusions', 'findings', 'inputVerdict', 'objects', 'routines', 'schema', 'serverValidated', 'toast', 'types', 'verdict']);
    expect(JSON.stringify(c)).not.toMatch(/"(plan|order|drop|steps|sequence)"\s*:/i); expect(deepFrozen(c)).toBe(true);
    const w = world(); for (const id of Object.keys(w)) w[id] = [...w[id]].reverse();
    expect(run(w)).toEqual(c);
    expect(run(world())).toEqual(c);
  });
});

describe('S1-C/C3-C clasificación: objetos principales', () => {
  it('relkind y atributos: solo r, S, i, v ordinarios se admiten; el resto se excluye o queda sin resolver', () => {
    const c = mod(w => { w.ev_relations.push(rel(900, 'p', 'p'), rel(901, 'm', 'm'), rel(902, 'f', 'f'), rel(903, 'c', 'c'), rel(904, 't', 't'), rel(905, 'I', 'I'),
      rel(906, 'part', 'r', { relispartition: true }), rel(907, 'tmp', 'r', { relpersistence: 't' }), rel(908, 'unl', 'r', { relpersistence: 'u' }), rel(909, 'z', 'z')); });
    const by = Object.fromEntries(c.objects.map((o: any) => [o.oid, o]));
    for (const oid of [900, 901, 902, 903, 904, 905, 906, 907]) expect(by[oid].admitted).toBe(false);
    expect(by[908]).toMatchObject({ kind: 'table', admitted: true }); expect(by[909]).toMatchObject({ kind: 'unknown', admitted: false });
    expect(c.findings.filter((f: any) => f.code === 'unsupported_kind').map((f: any) => f.subject)).toHaveLength(8);
    expect(c.findings.filter((f: any) => f.code === 'unsupported_kind' && f.subject === 'pg_class:906')[0].detail).toBe('partition');
    expect(c.verdict.structural).toBe('unresolved'); expect(codes(c)).toContain('unknown_relkind'); expect(c.verdict.excluded).toBe(true);
  });
  it('solo exclusiones: estructura válida pero schema no elegible', () => {
    const c = mod(w => { w.ev_relations.push(rel(900, 'p', 'p')); });
    only(c, 'structurally_valid', ['unsupported_kind']); expect(c.exclusions).toEqual(['unsupported_kind']); expect(c.verdict.excluded).toBe(true);
  });
  it('funciones, procedimientos, agregados y ventanas se reconocen pero nunca se admiten', () => {
    const c = mod(w => { w.ev_routines = ['f', 'p', 'a', 'w'].map((k, i) => ({ oid: 800 + i, proname: `r${i}`, prokind: k, owner: 'agenda_test_owner', acl: null })); });
    only(c, 'structurally_valid', ['unsupported_routine']);
    expect(c.routines.map((r: any) => [r.kind, r.admitted])).toEqual([['unsupported_function', false], ['unsupported_procedure', false], ['unsupported_aggregate', false], ['unsupported_window', false]]);
    const bad = mod(w => { w.ev_routines = [{ oid: 800, proname: 'x', prokind: 'z', owner: 'o', acl: null }]; });
    only(bad, 'unresolved', ['unknown_class']);
  });
  it('tipos independientes, dominios, enumerados y pseudo-tipos no se admiten; huérfanos quedan sin resolver', () => {
    const c = mod(w => { w.ev_types.push(typ(700, 'e', 'e', 0, 0), typ(701, 'd', 'd', 0, 0), typ(702, 'r', 'r', 0, 0), typ(703, 'm', 'm', 0, 0), typ(704, 'p', 'p', 0, 0), typ(705, 'b', 'b', 0, 0)); });
    only(c, 'structurally_valid', ['unsupported_type']); expect(c.findings).toHaveLength(6);
    only(mod(w => { w.ev_types.push(typ(706, 'q', 'z', 0, 0)); }), 'unresolved', ['unknown_class']);
    only(mod(w => { w.ev_types.push(typ(707, 'orphan', 'c', 999, 0)); }), 'unresolved', ['type_orphan']);
  });
  it('un esquema ausente con objetos es contradictorio; ausente y vacío es consistente', () => {
    const w = world(); w.ev_namespace = [];
    expect(codes(run(w))).toContain('schema_absent_with_objects');
    const empty: World = { ...world(), ev_namespace: [], ev_relations: [], ev_types: [], ev_companion_items: [], ev_internal_edges: [], ev_external_dependents: [] };
    const c = run(empty); only(c, 'structurally_valid', []); expect(c.schema).toEqual({ name: null, oid: null, present: false });
  });
  it('clases con solo conteo (operadores, colaciones, ACL por defecto, extensiones…) excluyen el esquema', () => {
    for (const field of ['operator', 'collation', 'conversion', 'opclass', 'opfamily', 'ts_config', 'ts_dict', 'ts_parser', 'ts_template', 'statistic_ext', 'default_acl', 'extension']) {
      const c = mod(w => { w.ev_namespace_catalog_counts[0][field] = '2'; });
      only(c, 'structurally_valid', ['unsupported_class_present']); expect(c.findings[0].subject).toBe(field);
    }
    only(mod(w => { w.ev_namespace_catalog_counts[0].class = '9'; w.ev_namespace_catalog_counts[0].proc = '9'; }), 'structurally_valid', []);
  });
});

describe('S1-C/C3-C clasificación: compañeros', () => {
  it('restricciones: índice de respaldo, tipo desconocido, respaldo ausente o duplicado', () => {
    const find = (k: number) => (w: World) => w.ev_companion_items.find((i: any) => i.item_oid === k);
    primaryOnly(mod(w => { Object.assign(find(300)(w), { related_oid: 0 }); }), 'unresolved', ['constraint_unresolved']);
    primaryOnly(mod(w => { Object.assign(find(300)(w), { related_oid: 100 }); }), 'unresolved', ['constraint_unresolved']);
    primaryOnly(mod(w => { Object.assign(find(300)(w), { subtype: 'z' }); }), 'unresolved', ['constraint_unresolved']);
    primaryOnly(mod(w => { Object.assign(find(301)(w), { related_oid: 101 }); }), 'invalid', ['duplicate_companion']);
    const checks = mod(w => { w.ev_companion_items.push(item('constraint', 'pg_constraint', 310, 100, { subtype: 'c' }), item('constraint', 'pg_constraint', 311, 100, { subtype: 'u', related_classid: 'pg_class', related_oid: 102 })); });
    expect(codes(checks)).toEqual(['constraint_unresolved']);
  });
  it('disparadores internos y de usuario; reglas de vista y de usuario; valores por defecto; políticas', () => {
    primaryOnly(mod(w => { w.ev_companion_items.push(item('trigger', 'pg_trigger', 410, 100, { subtype: 'false', name: 'audit' })); }), 'structurally_valid', ['user_trigger_present']);
    primaryOnly(mod(w => { w.ev_companion_items.find((i: any) => i.item_oid === 400).subtype = 'maybe'; }), 'unresolved', ['companion_unlinked']);
    primaryOnly(mod(w => { w.ev_companion_items.find((i: any) => i.item_oid === 400).related_oid = 0; }), 'unresolved', ['companion_unlinked']);
    primaryOnly(mod(w => { w.ev_companion_items.find((i: any) => i.item_oid === 400).related_oid = 999; }), 'unresolved', ['companion_unlinked']);
    primaryOnly(mod(w => { w.ev_companion_items.push(item('rule', 'pg_rewrite', 510, 100, { subtype: '2', name: 'r_audit' })); }), 'structurally_valid', ['user_rule_present']);
    primaryOnly(mod(w => { w.ev_companion_items = w.ev_companion_items.filter((i: any) => i.item_oid !== 500); }), 'unresolved', ['view_rule_missing']);
    primaryOnly(mod(w => { w.ev_companion_items.push(item('rule', 'pg_rewrite', 511, 106, { subtype: '1', name: '_RETURN' })); }), 'invalid', ['duplicate_companion']);
    primaryOnly(mod(w => { w.ev_companion_items.find((i: any) => i.item_oid === 600).subtype = 'x'; }), 'unresolved', ['companion_unlinked']);
    primaryOnly(mod(w => { w.ev_companion_items.push(item('attrdef', 'pg_attrdef', 601, 100, { subtype: '1' })); }), 'invalid', ['duplicate_companion']);
    const policy = mod(w => { w.ev_companion_items.push(item('policy', 'pg_policy', 700, 100, { subtype: '*' })); });
    primaryOnly(policy, 'structurally_valid', []); expect(policy.companions.find((x: any) => x.role === 'policy')).toMatchObject({ ownerKey: 'pg_class:100', admitted: false });
  });
  it('propietario inexistente, catálogo incorrecto, namespace distinto o clase de compañero desconocida', () => {
    primaryOnly(mod(w => { w.ev_companion_items.push(item('attrdef', 'pg_attrdef', 602, 999, { subtype: '1' })); }), 'unresolved', ['companion_unlinked']);
    primaryOnly(mod(w => { w.ev_companion_items.find((i: any) => i.item_oid === 300).item_classid = 'pg_class'; }), 'invalid', ['identity_conflict']);
    primaryOnly(mod(w => { w.ev_companion_items.find((i: any) => i.item_oid === 300).item_namespace_oid = 6000; }), 'invalid', ['identity_conflict']);
    primaryOnly(mod(w => { w.ev_companion_items.find((i: any) => i.item_oid === 300).group_classid = 'pg_type'; }), 'unresolved', ['companion_unlinked']);
    primaryOnly(mod(w => { w.ev_companion_items.push(item('mystery', 'pg_class', 1, 100)); }), 'unresolved', ['unknown_class']);
  });
  it('secuencias propias: serial, identity y todos los casos que no se pueden vincular', () => {
    const seq = (w: World, oid: number) => w.ev_companion_items.find((i: any) => i.item_kind === 'sequence_owner' && i.item_oid === oid);
    primaryOnly(mod(w => { seq(w, 102).edge_ref_subid = '0'; }), 'unresolved', ['sequence_owner_unresolved']);
    primaryOnly(mod(w => { seq(w, 102).edge_deptype = null; seq(w, 102).edge_ref_subid = null; }), 'unresolved', ['sequence_owner_unresolved']);
    primaryOnly(mod(w => { seq(w, 102).edge_deptype = 'n'; }), 'unresolved', ['sequence_owner_unresolved']);
    primaryOnly(mod(w => { seq(w, 102).group_oid = 106; }), 'unresolved', ['sequence_owner_unresolved']);
    primaryOnly(mod(w => { seq(w, 102).group_oid = 999; }), 'unresolved', ['sequence_owner_unresolved']);
    primaryOnly(mod(w => { w.ev_companion_items.push(item('sequence_owner', 'pg_class', 102, 103, { subtype: 'S', edge_deptype: 'a', edge_ref_subid: '1', name: 'other' })); }), 'invalid', ['sequence_multi_owner']);
    primaryOnly(mod(w => { w.ev_companion_items.push(item('sequence_owner', 'pg_class', 102, 100, { subtype: 'S', edge_deptype: 'a', edge_ref_subid: '1', name: 'again' })); }), 'invalid', ['duplicate_companion']);
    primaryOnly(mod(w => { w.ev_companion_items.push(item('sequence_owner', 'pg_class', 750, 100, { subtype: 'S', edge_deptype: 'a', edge_ref_subid: '1' })); }), 'invalid', ['identity_conflict']);
    const cross = mod(w => { w.ev_companion_items.push(item('sequence_owner', 'pg_class', 760, 100, { item_namespace_oid: 6000, subtype: 'S', edge_deptype: 'a', edge_ref_subid: '2' })); });
    primaryOnly(cross, 'structurally_valid', ['cross_schema_reference']); expect(cross.companions.find((x: any) => x.key === 'pg_class:760')).toMatchObject({ kind: 'cross_schema_owned_sequence', admitted: false });
  });
  it('las aristas de serial/identity deben coincidir con el vínculo declarado', () => {
    const e = (w: World, src: number) => w.ev_internal_edges.find((x: any) => x.source_objid === src && x.source_classid === 'pg_class' && x.ref_classid === 'pg_class' && x.ref_objid !== 101);
    only(mod(w => { e(w, 102).ref_subid = 2; }), 'unresolved', ['edge_unreconciled']);
    only(mod(w => { e(w, 102).deptype = 'i'; }), 'unresolved', ['edge_unreconciled']);
    only(mod(w => { e(w, 105).deptype = 'a'; }), 'unresolved', ['edge_unreconciled']);
  });
});

describe('S1-C/C3-C clasificación: TOAST como candidato', () => {
  const t = (w: World, kind: string, oid: number) => w.ev_companion_items.filter((i: any) => i.item_kind === kind && i.item_oid === oid);
  it.each([
    ['sin candidato', (w: World) => { w.ev_companion_items = w.ev_companion_items.filter((i: any) => i.item_kind !== 'toast_candidate' || i.item_oid !== 110); }, 'unresolved', ['toast_unverified']],
    ['oid distinto de reltoastrelid', (w: World) => { t(w, 'toast_candidate', 110)[0].item_oid = 999; }, 'invalid', ['toast_contradiction']],
    ['dos candidatos distintos', (w: World) => { w.ev_companion_items.push({ ...t(w, 'toast_candidate', 110)[0], item_oid: 998, name: 'pg_toast_100' }); }, 'invalid', ['toast_contradiction']],
    ['sin arista', (w: World) => { Object.assign(t(w, 'toast_candidate', 110)[0], { edge_deptype: null, edge_ref_subid: null }); }, 'unresolved', ['toast_unverified']],
    ['arista no interna', (w: World) => { t(w, 'toast_candidate', 110)[0].edge_deptype = 'a'; }, 'invalid', ['toast_contradiction']],
    ['arista a una columna', (w: World) => { t(w, 'toast_candidate', 110)[0].edge_ref_subid = '1'; }, 'invalid', ['toast_contradiction']],
    ['aristas contradictorias', (w: World) => { w.ev_companion_items.push({ ...t(w, 'toast_candidate', 110)[0], edge_deptype: 'a', name: 'pg_toast_100' }); }, 'invalid', ['toast_contradiction']],
    ['nombre distinto', (w: World) => { t(w, 'toast_candidate', 110)[0].name = 'pg_toast_999'; }, 'unresolved', ['toast_unverified']],
    ['relkind distinto', (w: World) => { t(w, 'toast_candidate', 110)[0].subtype = 'r'; }, 'unresolved', ['toast_unverified']],
    ['en el mismo namespace', (w: World) => { t(w, 'toast_candidate', 110)[0].item_namespace_oid = SCOPE; }, 'invalid', ['toast_contradiction']],
    ['sin corroboración externa', (w: World) => { w.ev_external_dependents = w.ev_external_dependents.filter((e: any) => e.objid !== 110); }, 'unresolved', ['toast_unverified']],
    ['externo con ref distinta', (w: World) => { w.ev_external_dependents.find((e: any) => e.objid === 110).refobjid = 103; }, 'unresolved', ['external_dependent', 'toast_unaccounted', 'toast_unverified']],
    ['externo en otro namespace', (w: World) => { w.ev_external_dependents.find((e: any) => e.objid === 110).namespace = 'public'; }, 'unresolved', ['external_dependent', 'toast_unverified']],
  ] as const)('%s', (_name, mutate, structural, expected) => { primaryOnly(mod(mutate as any), structural, [...expected]); });
  it.each([
    ['índice ausente', (w: World) => { w.ev_companion_items = w.ev_companion_items.filter((i: any) => i.item_kind !== 'toast_index_candidate' || i.item_oid !== 111); }, 'unresolved', ['toast_index_unverified', 'external_dependent', 'toast_unaccounted']],
    ['dos índices distintos', (w: World) => { w.ev_companion_items.push({ ...t(w, 'toast_index_candidate', 111)[0], item_oid: 997, name: 'pg_toast_100_index' }); }, 'invalid', ['toast_contradiction', 'external_dependent', 'toast_unaccounted']],
    ['nombre del índice', (w: World) => { t(w, 'toast_index_candidate', 111).forEach(i => { i.name = 'otro'; }); }, 'unresolved', ['toast_index_unverified', 'external_dependent', 'toast_unaccounted']],
    ['arista del índice ausente', (w: World) => { t(w, 'toast_index_candidate', 111)[0].edge_deptype = null; }, 'unresolved', ['toast_index_unverified', 'external_dependent', 'toast_unaccounted']],
    ['arista del índice normal', (w: World) => { t(w, 'toast_index_candidate', 111).forEach(i => { i.edge_deptype = 'n'; }); }, 'unresolved', ['toast_index_unverified', 'external_dependent', 'toast_unaccounted']],
    ['índice sin corroboración', (w: World) => { w.ev_external_dependents = w.ev_external_dependents.filter((e: any) => e.objid !== 111); }, 'unresolved', ['toast_index_unverified']],
  ] as const)('índice: %s', (_name, mutate, structural, expected) => { primaryOnly(mod(mutate as any), structural, [...expected]); });
  it('estar en pg_toast no basta: sin tabla propietaria con reltoastrelid todo queda sin contabilizar', () => {
    const c = mod(w => { w.ev_relations[0].reltoastrelid = 0; });
    expect(codes(c)).toEqual(expect.arrayContaining(['toast_unverified', 'external_dependent', 'toast_unaccounted']));
    expect(c.toast.map((x: any) => x.ownerKey)).toEqual(['pg_class:103']); expect(c.verdict.structural).toBe('unresolved');
    const orphan = mod(w => { w.ev_external_dependents.push(ext(1, 'pg_class', 555, 'i', 'pg_class', 100, 'pg_toast')); });
    expect(codes(orphan)).toEqual(expect.arrayContaining(['external_dependent', 'toast_unaccounted']));
  });
  it('una fila externa de un TOAST ya reconocido pero con otra referencia no se acepta como candidato', () => {
    const c = mod(w => { w.ev_external_dependents.push(ext(1, 'pg_class', 110, 'i', 'pg_class', 103, 'pg_toast')); });
    expect(c.findings.filter((f: any) => f.code === 'external_dependent')).toHaveLength(1); expect(codes(c)).toContain('toast_unaccounted');
    expect(c.toast.map((x: any) => x.status)).toEqual(['candidate_matched_with_index', 'candidate_matched_with_index']);
  });
  it('un TOAST de objeto no tabla o sin filas de compañeros no es candidato', () => {
    primaryOnly(mod(w => { w.ev_relations.push(rel(130, 'mv', 'm', { reltoastrelid: 131 })); }), 'unresolved', ['toast_unverified', 'unsupported_kind']);
    primaryOnly(mod(w => { w.ev_companion_items = w.ev_companion_items.filter((i: any) => !i.item_kind.startsWith('toast')); w.ev_external_dependents = []; }), 'unresolved', ['toast_unverified']);
  });
});

describe('S1-C/C3-C clasificación: dependencias', () => {
  const internal = (w: World, ...rows: any[]) => { w.ev_internal_edges.push(...rows); };
  it('naturalezas: normal, automática, interna, de partición y de extensión', () => {
    expect(Object.fromEntries(Object.entries(NATURE))).toEqual({ n: 'normal', a: 'automatic', i: 'internal', P: 'partition', S: 'partition', e: 'extension', x: 'extension' });
    for (const deptype of ['P', 'S']) only(mod(w => internal(w, edge(['pg_class', 100, 0], ['pg_class', 103, 0], deptype))), 'structurally_valid', ['partition_dependency']);
    for (const deptype of ['e', 'x']) only(mod(w => internal(w, edge(['pg_class', 100, 0], ['pg_class', 103, 0], deptype))), 'structurally_valid', ['extension_member']);
  });
  it('clases desconocidas y extremos desconocidos nunca son benignos', () => {
    only(mod(w => internal(w, edge(['pg_language', 12, 0], ['pg_class', 100, 0], 'n'))), 'unresolved', ['unknown_class']);
    only(mod(w => internal(w, edge(['pg_class', 100, 0], ['pg_language', 12, 0], 'n'))), 'unresolved', ['unknown_class']);
    only(mod(w => internal(w, edge(['pg_class', 777, 0], ['pg_class', 100, 0], 'n'))), 'unresolved', ['edge_unknown_endpoint']);
    only(mod(w => internal(w, edge(['pg_class', 100, 0], ['pg_class', 778, 0], 'n'))), 'unresolved', ['edge_unknown_endpoint']);
    only(mod(w => internal(w, edge(['pg_collation', 5, 0], ['pg_class', 100, 0], 'n'))), 'unresolved', ['edge_unknown_endpoint']);
  });
  it('una arista automática o interna no es segura sin su propietario', () => {
    only(mod(w => internal(w, edge(['pg_class', 100, 0], ['pg_class', 103, 0], 'a'))), 'unresolved', ['edge_unreconciled']);
    only(mod(w => internal(w, edge(['pg_class', 106, 0], ['pg_class', 100, 0], 'i'))), 'unresolved', ['edge_unreconciled']);
    only(mod(w => internal(w, edge(['pg_class', 101, 0], ['pg_class', 103, 1], 'a'))), 'invalid', ['edge_contradiction', 'edge_unreconciled']);
    only(mod(w => internal(w, edge(['pg_type', 200, 0], ['pg_class', 103, 0], 'i'))), 'unresolved', ['edge_unreconciled']);
    only(mod(w => internal(w, edge(['pg_attrdef', 600, 0], ['pg_class', 100, 2], 'a'))), 'unresolved', ['edge_unreconciled']);
    only(mod(w => internal(w, edge(['pg_rewrite', 500, 0], ['pg_class', 100, 0], 'a'))), 'unresolved', ['edge_unreconciled']);
    only(mod(w => internal(w, edge(['pg_constraint', 300, 0], ['pg_class', 103, 0], 'a'))), 'unresolved', ['edge_unreconciled']);
    only(mod(w => internal(w, edge(['pg_class', 101, 0], ['pg_constraint', 301, 0], 'i'))), 'unresolved', ['edge_unreconciled']);
    expect(Object.keys(EXPECT).sort()).toEqual(['array_type', 'attrdef', 'constraint', 'index', 'policy', 'row_type', 'rule', 'sequence', 'trigger']);
  });
  it('un índice sin la arista automática a su tabla no se puede atribuir y queda sin resolver', () => {
    only(mod(w => { w.ev_internal_edges = w.ev_internal_edges.filter((e: any) => !(e.source_objid === 101 && e.source_classid === 'pg_class' && e.deptype === 'a')); }), 'unresolved', ['companion_unlinked']);
  });
  it('el tipo de dependencia debe ser el esperado para cada rol aunque apunte al propietario correcto', () => {
    const edgeOf = (w: World, classid: string, oid: number, ref: number) => w.ev_internal_edges.find((e: any) => e.source_classid === classid && e.source_objid === oid && e.ref_objid === ref);
    only(mod(w => { edgeOf(w, 'pg_type', 200, 100).deptype = 'a'; }), 'unresolved', ['edge_unreconciled']);
    only(mod(w => { edgeOf(w, 'pg_constraint', 300, 100).deptype = 'i'; }), 'unresolved', ['edge_unreconciled']);
    only(mod(w => { edgeOf(w, 'pg_attrdef', 600, 100).deptype = 'i'; }), 'unresolved', ['edge_unreconciled']);
  });
  it('aristas duplicadas, contradictorias o presentes en dos particiones son inválidas', () => {
    only(mod(w => internal(w, edge(['pg_class', 100, 0], ['pg_class', 103, 0], 'n'), edge(['pg_class', 100, 0], ['pg_class', 103, 0], 'a'))), 'invalid', ['edge_contradiction', 'edge_unreconciled']);
    only(mod(w => { internal(w, edge(['pg_class', 100, 0], ['pg_class', 103, 0], 'n')); w.ev_outbound_references.push(outbound(['pg_class', 100, 0], ['pg_class', 103, 0], 'n', 'pg_catalog')); }), 'invalid', ['edge_in_both']);
  });
  it('referencias salientes: sistema permitido, otros esquemas pendientes, extensión y partición', () => {
    const c = mod(w => { w.ev_outbound_references.push(outbound(['pg_class', 100, 1], ['pg_type', 23, 0], 'n', 'pg_catalog')); });
    only(c, 'structurally_valid', []); expect(c.edges.find((e: any) => e.origin === 'outbound')).toMatchObject({ scope: 'system', targetSchema: 'pg_catalog', reconciled: null });
    only(mod(w => { w.ev_outbound_references.push(outbound(['pg_class', 100, 1], ['pg_type', 23, 0], 'n', 'information_schema')); }), 'structurally_valid', []);
    only(mod(w => { w.ev_outbound_references.push(outbound(['pg_class', 100, 1], ['pg_type', 900, 0], 'n', 'public')); }), 'structurally_valid', ['cross_schema_reference']);
    only(mod(w => { w.ev_outbound_references.push(outbound(['pg_class', 100, 1], ['pg_type', 900, 0], 'a', 'public')); }), 'unresolved', ['cross_schema_reference', 'edge_unreconciled']);
    only(mod(w => { w.ev_outbound_references.push(outbound(['pg_class', 100, 0], ['pg_extension', 7, 0], 'e', 'public')); }), 'structurally_valid', ['extension_member']);
    only(mod(w => { w.ev_outbound_references.push(outbound(['pg_class', 100, 0], ['pg_class', 7, 0], 'P', 'public')); }), 'structurally_valid', ['partition_dependency']);
    only(mod(w => { w.ev_outbound_references.push(outbound(['pg_class', 888, 0], ['pg_type', 23, 0], 'n', 'pg_catalog')); }), 'unresolved', ['edge_unknown_endpoint']);
  });
  it('destinos nulos o sin mapa se conservan como veredicto no resuelto (las filas no se exponen)', () => {
    const c = mod(w => { w.ev_outbound_references.push(outbound(['pg_class', 100, 0], ['pg_language', 12, 0], 'n', null)); });
    expect(c.verdict.structural).toBe('unresolved'); expect(c.verdict.reasons).toContain('unmapped_class'); expect(codes(c)).toEqual(['input_unresolved']);
    expect(c.edges.filter((e: any) => e.origin === 'outbound')).toEqual([]);
  });
  it('dependientes externos y miembros de extensión excluyen el esquema', () => {
    only(mod(w => { w.ev_external_dependents.push(ext(1, 'pg_class', 950, 'n', 'pg_class', 100, 'other')); }), 'structurally_valid', ['external_dependent']);
    only(mod(w => { w.ev_external_dependents.push(ext(1, 'pg_language', 12, 'n', 'pg_class', 100, 'other')); }), 'unresolved', ['external_dependent', 'unknown_class']);
    const c = mod(w => { w.ev_extension_members.push({ extension_oid: 40, extension_name: 'ext', classid: 'pg_class', objid: 100, objsubid: 0 }); });
    only(c, 'structurally_valid', ['extension_member']); expect(c.objects[0].extensionMember).toBe(true);
    const closure = mod(w => { w.ev_closure.push({ depth: 1, classid: 'pg_class', objid: 100, objsubid: 0, deptype: 'n' }, { depth: 1, classid: 'pg_language', objid: 12, objsubid: 0, deptype: 'n' }, { depth: 1, classid: 'pg_collation', objid: 5, objsubid: 0, deptype: 'n' }); });
    only(closure, 'unresolved', ['unknown_class']); expect(closure.closureClasses).toEqual({ relation: 1, unknown: 1, unsupported: 1 });
  });
});

describe('S1-C/C3-C clasificación: identidades por catálogo y ciclos', () => {
  it('el mismo OID en catálogos distintos son identidades distintas; el mismo (catálogo, OID) en dos roles es un conflicto', () => {
    const c = mod(w => { w.ev_relations.push(rel(300, 'twin', 'r')); w.ev_routines = [{ oid: 100, proname: 'f', prokind: 'f', owner: 'o', acl: null }];
      w.ev_types.push(typ(100, 'en', 'e', 0, 0)); });
    expect(c.findings.map((f: any) => f.code)).not.toContain('identity_conflict');
    const keys = [...c.objects, ...c.routines, ...c.types, ...c.companions].map((x: any) => x.key);
    expect(keys).toEqual(expect.arrayContaining(['pg_class:100', 'pg_class:300', 'pg_constraint:300', 'pg_proc:100', 'pg_type:100'])); expect(new Set(keys).size).toBe(keys.length);
    primaryOnly(mod(w => { w.ev_relations[0].reltoastrelid = 101; w.ev_companion_items.filter((i: any) => i.item_oid === 110).forEach((i: any) => { i.item_oid = 101; }); w.ev_external_dependents.find((e: any) => e.objid === 110).objid = 101; }),
      'invalid', ['identity_conflict']);
  });
  it('dos filas distintas con la misma identidad de compañero son un conflicto y la segunda no se incorpora', () => {
    const c = mod(w => { w.ev_companion_items.push(item('constraint', 'pg_constraint', 300, 100, { related_classid: 'pg_class', related_oid: 101, subtype: 'p', name: 'otra' })); });
    expect(codes(c)).toContain('identity_conflict'); expect(c.verdict.structural).toBe('invalid');
    expect(c.companions.filter((x: any) => x.key === 'pg_constraint:300')).toHaveLength(1);
    expect(c.companions.find((x: any) => x.key === 'pg_constraint:300').name).toBe('t1_pkey');
  });
  const cycleWorld = (w: World) => {
    w.ev_companion_items.push(item('constraint', 'pg_constraint', 303, 100, { related_classid: 'pg_class', related_oid: 104, subtype: 'f', name: 't1_fk' }));
    group('pg_constraint', 303, ['pg_class', 100]);
    w.ev_internal_edges.push(edge(['pg_constraint', 303, 0], ['pg_class', 100, 1], 'a'), edge(['pg_constraint', 303, 0], ['pg_class', 103, 1], 'n'), edge(['pg_constraint', 303, 0], ['pg_class', 104, 0], 'n'));
  };
  it('claves foráneas mutuas forman un ciclo de aristas normales entre grupos (sin plan)', () => {
    const c = mod(cycleWorld);
    only(c, 'structurally_valid', []); expect(c.cycles).toEqual([{ groups: ['pg_class:100', 'pg_class:103'] }]);
    expect(c.edges.filter((e: any) => e.sourceGroup === 'pg_class:100' && e.refGroup === 'pg_class:103' && e.nature === 'normal')).toHaveLength(1);
  });
  it('una clave foránea a la propia tabla, una cadena o aristas automáticas no son ciclos', () => {
    expect(mod(w => { group('pg_constraint', 304, ['pg_class', 100]); w.ev_companion_items.push(item('constraint', 'pg_constraint', 304, 100, { related_classid: 'pg_class', related_oid: 101, subtype: 'f' }));
      w.ev_internal_edges.push(edge(['pg_constraint', 304, 0], ['pg_class', 100, 1], 'a'), edge(['pg_constraint', 304, 0], ['pg_class', 100, 1], 'n')); }).cycles).toEqual([]);
    expect(run(world()).cycles).toEqual([]);
    expect(mod(w => { w.ev_internal_edges.push(edge(['pg_class', 100, 0], ['pg_class', 103, 0], 'a'), edge(['pg_class', 103, 0], ['pg_class', 100, 0], 'a')); }).cycles).toEqual([]);
  });
  it('ciclos de tres relaciones y varios ciclos independientes se identifican de forma determinista', () => {
    const c = mod(w => { w.ev_relations.push(rel(107, 't3', 'r'), rel(108, 't4', 'r'), rel(109, 't5', 'r'));
      for (const o of [107, 108, 109]) group('pg_class', o);
      w.ev_internal_edges.push(edge(['pg_class', 100, 1], ['pg_class', 103, 1], 'n'), edge(['pg_class', 103, 1], ['pg_class', 107, 1], 'n'), edge(['pg_class', 107, 1], ['pg_class', 100, 1], 'n'),
        edge(['pg_class', 108, 1], ['pg_class', 109, 1], 'n'), edge(['pg_class', 109, 1], ['pg_class', 108, 1], 'n')); });
    expect(c.cycles).toEqual([{ groups: ['pg_class:100', 'pg_class:103', 'pg_class:107'] }, { groups: ['pg_class:108', 'pg_class:109'] }]);
  });
});

describe('S1-C/C3-C clasificación: entradas incompletas, fallidas y malformadas', () => {
  it.each([
    ['inválida (hash SQL)', { sqlSha256: 'a'.repeat(64) }, 'invalid', 'input_invalid'],
    ['truncada', { result: { status: 'rows', rows: Array.from({ length: 501 }, (_, i) => rel(2000 + i, `r${i}`, 'r')) } }, 'unresolved', 'input_incomplete'],
    ['fallida', { result: { status: 'error', code: 'timeout' } }, 'unresolved', 'input_unresolved'],
  ])('ev_relations %s', (_n, over, structural, code) => {
    const c = run(world(), { ev_relations: over as any });
    expect(c.verdict.structural).toBe(structural); expect(codes(c)).toContain(code); expect(c.objects).toEqual([]); expect(c.verdict.eligible).toBe(false);
  });
  it('cada consulta necesaria no válida se propaga con su estado', () => {
    for (const id of NEEDED) {
      const c = run(world(), { [id]: { result: { status: 'error', code: 'permission' } } });
      expect(['unresolved', 'invalid']).toContain(c.verdict.structural); expect(c.findings.some((f: any) => f.code === 'input_unresolved' && f.subject === id)).toBe(true); expect(c.verdict.eligible).toBe(false);
    }
  });
  it('una consulta necesaria ausente es no resuelta', () => {
    const w = world(); delete (w as any).ev_closure;
    const c = classify(normalizeSet(NEEDED.filter(id => id in w).map(id => observation(id, w[id])), { required: NEEDED.filter(id => id in w) }));
    expect(c.findings).toEqual([{ code: 'input_unresolved', state: 'unresolved', subject: 'ev_closure', detail: 'missing' }]);
  });
  it('un conjunto fabricado o con resultados alterados se rechaza sin lanzar', () => {
    const real = build(world());
    const forged: any[] = [null, undefined, 1, 'x', [], {}, { verdict: {}, results: {} }, new Proxy(real, {}),
      { ...real, verdict: { ...real.verdict } }, { ...real, results: new Proxy(real.results, {}) },
      { ...real, results: { ...real.results, ev_relations: { ...real.results.ev_relations, verdict: { ...real.results.ev_relations.verdict } } } },
      { ...real, results: { ...real.results, ev_relations: { ...real.results.ev_relations, serverValidated: true } } },
      { ...real, results: { ...real.results, ev_relations: { ...real.results.ev_relations, sqlSha256: 'a'.repeat(64) } } },
      { ...real, results: { ...real.results, ev_relations: { ...real.results.ev_relations, id: 'ev_types' } } },
      { ...real, results: { ...real.results, ev_relations: { ...real.results.ev_relations, rows: [{ extra: 1 }] } } },
      { ...real, results: { ...real.results, ev_relations: { ...real.results.ev_relations, rows: 'x' } } }];
    for (const input of forged) {
      expect(() => classify(input)).not.toThrow(); const c = classify(input);
      expect(c.verdict.eligible).toBe(false); expect(c.verdict.demonstration).toBe('not_demonstrated');
      expect(c.verdict.structural === 'invalid' || c.verdict.structural === 'unresolved').toBe(true); expect(c.findings.length).toBeGreaterThan(0);
    }
  });
  it('las filas alteradas de un resultado genuino se detectan por consulta y se señalan como mal formadas', () => {
    const real = build(world());
    for (const rows of [[{ extra: 1 }], 'x', [{ ...real.results.ev_relations.rows![0], oid: 'x' }]]) {
      const c = classify({ ...real, results: { ...real.results, ev_relations: { ...real.results.ev_relations, rows } } });
      expect(c.findings).toContainEqual({ code: 'input_malformed', state: 'invalid', subject: 'ev_relations', detail: 'rows' });
      expect(c.objects).toEqual([]); expect(c.verdict.structural).not.toBe('structurally_valid');
    }
  });
  it('los accesores del conjunto no se invocan', () => {
    const real = build(world()); const trap = jest.fn();
    const hostile = Object.defineProperty({ ...real }, 'verdict', { get: trap, enumerable: true });
    const results = Object.defineProperty({ ...real.results }, 'ev_relations', { get: trap, enumerable: true });
    classify(hostile); classify({ ...real, results }); expect(trap).not.toHaveBeenCalled();
  });
});

describe('S1-C/C3-C clasificación: vocabularios y superficie estática', () => {
  it('vocabularios cerrados y exports congelados', () => {
    expect(Object.isFrozen(jest.requireActual('../../scripts/harness/c8-evidence-classify.cjs'))).toBe(true);
    for (const v of [NEEDED, FINDINGS, RELKINDS, ADMITTED, PROKINDS, TYPTYPES, CLASS_KINDS, NATURE, EXPECT]) expect(Object.isFrozen(v)).toBe(true);
    expect(ADMITTED).toEqual(['table', 'sequence', 'index', 'view']); expect(NEEDED).toHaveLength(11);
    for (const state of Object.values(FINDINGS)) expect(['excluded', 'incomplete', 'unresolved', 'invalid']).toContain(state);
    for (const id of NEEDED) expect(get(id)).toBeDefined();
  });
  it('imports exactos y sin cuerpos autorizables, planes, atestaciones, identidades ni SQL', () => {
    const ast = ts.createSourceFile('classify.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports: string[] = []; const names: string[] = [];
    (function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'require') imports.push((node.arguments[0] as ts.StringLiteral).text);
      if (ts.isIdentifier(node)) names.push(node.text);
      ts.forEachChild(node, visit);
    })(ast);
    expect(imports).toEqual(['node:util', './c8-evidence-queries.cjs', './c8-evidence-states.cjs', './c8-evidence-normalize.cjs']);
    expect(source.startsWith("'use strict';")).toBe(true);
    expect(names.filter(n => /attest|authoriz|removalPlan|dropPlan|dropOrder|connectionId|transactionId/i.test(n))).toEqual([]);
    expect(source).not.toMatch(/randomBytes|pg_current_xact_id|c8-drop-policy|c8-provenance|serverValidated:\s*true|demonstration:\s*'demonstrated'|eligible:\s*true|process\.|console\./);
    expect(source).not.toMatch(/\b(?:DROP|CASCADE|INSERT|UPDATE|DELETE|ALTER|CREATE|GRANT|REVOKE|TRUNCATE|SELECT)\b/);
  });
});
