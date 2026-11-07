/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { assemble, FINDINGS, LIMITATIONS, PROVENANCE, SET_KEYS, RESULT_KEYS, IDENTITY_CLAIM } from '../../scripts/harness/c8-evidence-assemble.cjs';
import { reconcile, REQUIRED } from '../../scripts/harness/c8-evidence-reconcile.cjs';
import { classify } from '../../scripts/harness/c8-evidence-classify.cjs';
import { normalizeSet } from '../../scripts/harness/c8-evidence-normalize.cjs';
import * as policy from '../../scripts/harness/c8-drop-policy.cjs';
import { get } from '../../scripts/harness/c8-evidence-queries.cjs';
import { NAME } from './support/c8-pg-fakes';

const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/harness/c8-evidence-assemble.cjs'), 'utf8');
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
const codes = (r: any) => [...new Set<string>(r.findings.map((f: any) => f.code))].sort();
const deepFrozen = (v: any): boolean => v === null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(deepFrozen));


/** Los tres insumos coherentes de un mundo, más el ensamblado. */
const trio = (w: World, over: Record<string, Record<string, unknown>> = {}) => {
  const set = build(w, over); const c = classify(set); const r = reconcile(set, c);
  return { set, c, r, a: assemble(set, c, r) };
};
const tmod = (fn: (w: World) => void, over: Record<string, Record<string, unknown>> = {}) => { const w = world2(); fn(w); return trio(w, over); };
const withheldOk = (a: any, detailCodes: string[]) => {
  expect(a.coherent).toBe(false); expect(a.evidence).toBeNull(); expect(a.verdict.structural).toBe('invalid'); expect(a.verdict.status).toBe('invalid');
  expect(a.verdict.eligible).toBe(false); expect(a.verdict.demonstration).toBe('not_demonstrated'); expect(a.provenance.status).toBe('unauthenticated');
  expect(a.provenance.structurallyCoherent).toBe(false); expect(a.serverValidated).toBe(false);
  expect(codes(a)).toEqual(expect.arrayContaining(detailCodes));
  // Los hallazgos propios del ensamblado son exactamente los esperados: sin consecuencias espurias de aceptar un argumento sin contrastar.
  if (detailCodes.length > 0) expect([...new Set<string>(a.findings.filter((f: any) => f.source === 'assembly').map((f: any) => f.code))].sort()).toEqual([...detailCodes].sort());
};

describe('S1-C/C3-E ensamblado: conjunto estructuralmente coherente', () => {
  const { set, c, r, a } = trio(world2());
  it('coherente, sin hallazgos, con frontera de procedencia explícita', () => {
    expect(a.coherent).toBe(true); expect(a.findings).toEqual([]); expect(a.exclusions).toEqual([]);
    expect(a.verdict).toEqual({ structural: 'structurally_valid', demonstration: 'not_demonstrated', status: 'not_demonstrated', eligible: false, reasons: [], excluded: false });
    expect(a.provenance).toEqual({ status: 'unauthenticated', authenticated: false, structurallyCoherent: true,
      bindings: { c1: 'unbound', connection: 'unbound', transaction: 'unbound', snapshot: 'unbound', sequence: 'unbound' } });
    expect(a.serverValidated).toBe(false); expect(a.schema).toEqual(r.schema);
    expect(a.limitations).toEqual(['identities_unbound', 'provenance_unbound', 'quiescence_unproven', 'rows_hidden_when_not_valid', 'server_validation_pending', 'snapshot_unproven']);
    expect(a.inputVerdict).toBe(set.verdict);
  });
  it('reúne cada dato una sola vez: la evidencia reutiliza las estructuras de entrada', () => {
    expect(Object.keys(a.evidence).sort()).toEqual(['companions', 'concurrency', 'dependencies', 'inventory', 'objects', 'observations', 'routines', 'toast', 'types']);
    expect(a.evidence.objects).toEqual(c.objects); expect(a.evidence.companions).toEqual(c.companions); expect(a.evidence.toast).toEqual(c.toast);
    expect(a.evidence.dependencies.edges).toEqual(c.edges); expect(a.evidence.dependencies.cycles).toEqual(c.cycles);
    expect(a.evidence.dependencies.summary).toEqual(r.dependencies); expect(a.evidence.inventory).toEqual(r.inventory);
    expect(a.evidence.observations).toEqual(r.observations); expect(a.evidence.concurrency).toEqual(r.concurrency);
    expect(a.evidence.concurrency.quiescence).toBe('unproven');
    expect(JSON.stringify(a).split('"inputVerdict"').length).toBe(2);
  });
  it('inmutable y determinista, independiente del orden de las filas', () => {
    expect(deepFrozen(a)).toBe(true);
    const w = world2(); for (const id of Object.keys(w)) w[id] = [...w[id]].reverse();
    expect(trio(w).a).toEqual(a); expect(trio(world2()).a).toEqual(a);
    expect(Object.keys(a).sort()).toEqual(['coherent', 'evidence', 'exclusions', 'findings', 'inputVerdict', 'limitations', 'provenance', 'schema', 'serverValidated', 'verdict']);
  });
  it('un esquema ausente y vacío es coherente y válido', () => {
    const w = world2(); w.ev_namespace = []; w.ev_namespace_catalog_counts = []; for (const id of ['ev_relations', 'ev_types', 'ev_companion_items', 'ev_internal_edges', 'ev_external_dependents', 'ev_closure']) w[id] = [];
    const e = trio(w).a; expect(e.coherent).toBe(true); expect(e.findings).toEqual([]); expect(e.verdict.structural).toBe('structurally_valid');
    expect(e.schema).toEqual({ name: null, oid: null, present: false }); expect(e.evidence.objects).toEqual([]);
  });
});

describe('S1-C/C3-E ensamblado: nunca es un cuerpo autorizable ni un plan', () => {
  const { a } = trio(world2());
  it('la política real lo rechaza y su forma no es la de la evidencia de la política', () => {
    const d = policy.authorize(a); expect(d.ok).toBe(false); expect(d.exitCode).toBe(3);
    for (const k of ['mode', 'runId', 'target', 'l0', 'l1', 'inventory', 'dependents', 'extensions', 'eventTriggers', 'defaults', 'outside', 'quiescence', 'connection', 'transaction', 'sequence']) expect(Object.keys(a)).not.toContain(k);
    expect(a.schema).toEqual({ name: NAME, oid: SCOPE, present: true });
  });
  it('sin identidades, atestaciones, planes, órdenes ni instrucciones ejecutables', () => {
    expect(JSON.stringify(a)).not.toMatch(/"(plan|order|drop|steps|body|authoriz\w*|connectionId|transactionId|snapshotId|attestation)"\s*:/i);
    expect(JSON.stringify(a)).not.toMatch(/\b(DROP|CASCADE|ALTER|CREATE|GRANT|REVOKE|TRUNCATE|DELETE|INSERT|UPDATE)\b/);
    expect(IDENTITY_CLAIM.test('connectionId')).toBe(true); expect(IDENTITY_CLAIM.test('sequence')).toBe(true); expect(IDENTITY_CLAIM.test('relations')).toBe(false);
  });
});

describe('S1-C/C3-E ensamblado: pareja alterada, ajena o fabricada', () => {
  const base = trio(world2());
  const other = (() => { const w = world2(); w.ev_namespace[0].oid = 6000; w.ev_companion_items.forEach((i: any) => { if (i.item_namespace_oid === SCOPE) i.item_namespace_oid = 6000; }); return trio(w); })();
  it.each([
    ['clasificación de otro conjunto', () => assemble(base.set, other.c, base.r), ['classification_mismatch']],
    ['reconciliación de otro conjunto', () => assemble(base.set, base.c, other.r), ['reconciliation_mismatch']],
    ['ambas de otro conjunto', () => assemble(base.set, other.c, other.r), ['classification_mismatch', 'reconciliation_mismatch']],
    ['argumentos intercambiados', () => assemble(base.set, base.r, base.c), ['classification_mismatch', 'reconciliation_mismatch']],
    ['clasificación alterada', () => assemble(base.set, { ...base.c, exclusions: ['x'] }, base.r), ['classification_mismatch']],
    ['clasificación con veredicto elegible', () => assemble(base.set, { ...base.c, verdict: { ...base.c.verdict, eligible: true } }, base.r), ['classification_mismatch']],
    ['reconciliación alterada', () => assemble(base.set, base.c, { ...base.r, provenance: 'authenticated' }), ['reconciliation_mismatch']],
    ['reconciliación con quiescencia probada', () => assemble(base.set, base.c, { ...base.r, concurrency: { ...base.r.concurrency, quiescence: 'proven' } }), ['reconciliation_mismatch']],
    ['reconciliación sin hallazgos ocultando uno', () => { const t = tmod(w => { w.ev_namespace_catalog_counts[0].class = '8'; }); return assemble(t.set, t.c, { ...t.r, findings: [] }); }, ['reconciliation_mismatch']],
    ['clasificación que oculta una exclusión', () => { const t = tmod(w => { w.ev_relations.push(rel(900, 'p', 'p')); w.ev_namespace_catalog_counts[0].class = '8'; w.ev_closure = closureFor(w); }); return assemble(t.set, { ...t.c, exclusions: [], findings: [] }, t.r); }, ['classification_mismatch']],
  ] as const)('%s', (_n, run, expected) => { withheldOk(run(), [...expected]); });
  it('argumentos faltantes, nulos o de tipo incorrecto', () => {
    for (const args of [[], [base.set], [base.set, base.c], [base.set, null, null], [null, null, null], [undefined, undefined, undefined], ['x', 'y', 'z'], [{}, {}, {}], [[], [], []]]) {
      expect(() => (assemble as any)(...args)).not.toThrow(); const a = (assemble as any)(...args);
      expect(a.coherent).toBe(false); expect(a.evidence).toBeNull(); expect(a.verdict.eligible).toBe(false);
    }
  });
  it('un argumento adicional se rechaza: no se aceptan identidades aportadas por el llamador', () => {
    const a = (assemble as any)(base.set, base.c, base.r, { connection: { id: 'c1', pid: 1 }, transaction: { id: 't1' }, sequence: 1 });
    withheldOk(a, ['unexpected_argument']);
  });
  it('un conjunto con propiedades adicionales o identidades de conexión/transacción/snapshot/secuencia se rechaza', () => {
    for (const key of ['connection', 'transaction', 'snapshot', 'sequence', 'connectionId', 'transactionId', 'backend', 'xid', 'attestation', 'token']) {
      const claimed = { ...base.set, [key]: { id: 'abc12345', pid: 1 } };
      const a = assemble(claimed, classify(claimed), reconcile(claimed, classify(claimed)));
      withheldOk(a, ['identity_claim_rejected']);
      const inner = { ...base.set, results: { ...base.set.results, ev_context: { ...base.set.results.ev_context, [key]: 1 } } };
      withheldOk(assemble(inner, classify(inner), reconcile(inner, classify(inner))), ['identity_claim_rejected']);
    }
    const extraKey = { ...base.set, extra: 1 };
    withheldOk(assemble(extraKey, classify(extraKey), reconcile(extraKey, classify(extraKey))), ['set_shape']);
    const extraResult = { ...base.set, results: { ...base.set.results, ev_unknown: base.set.results.ev_context } };
    withheldOk(assemble(extraResult, classify(extraResult), reconcile(extraResult, classify(extraResult))), ['set_shape']);
    const missing = (({ order, ...rest }) => { void order; return rest; })(base.set);
    withheldOk(assemble(missing, classify(missing), reconcile(missing, classify(missing))), ['set_shape']);
  });
  it('forma de results y de cada resultado: no planos, nulos o con identidades en el nombre', () => {
    const run = (set: any) => assemble(set, classify(set), reconcile(set, classify(set)));
    withheldOk(run({ ...base.set, results: [] }), ['set_shape']);
    withheldOk(run({ ...base.set, results: null }), ['set_shape']);
    withheldOk(run({ ...base.set, results: new Proxy(base.set.results, {}) }), ['set_shape']);
    withheldOk(run({ ...base.set, results: { ...base.set.results, ev_context: null } }), ['set_shape']);
    withheldOk(run({ ...base.set, results: { ...base.set.results, ev_context: [] } }), ['set_shape']);
    for (const key of ['connection', 'snapshot', 'sequence', 'transactionId']) withheldOk(run({ ...base.set, results: { ...base.set.results, [key]: base.set.results.ev_context } }), ['identity_claim_rejected']);
  });
  it('una copia estructural fiel de un conjunto genuino ensambla idéntica: la coherencia no es autenticidad', () => {
    const copy = { ...base.set, results: { ...base.set.results } };
    const a = assemble(copy, classify(copy), reconcile(copy, classify(copy)));
    expect(a).toEqual(base.a); expect(a.provenance.status).toBe('unauthenticated'); expect(a.provenance.authenticated).toBe(false);
    expect(a.limitations).toContain('provenance_unbound'); expect(a.verdict.demonstration).toBe('not_demonstrated');
  });
  it('resultados alterados con veredictos o filas que ya no cumplen el contrato se retienen sin evidencia', () => {
    for (const results of [
      { ...base.set.results, ev_relations: { ...base.set.results.ev_relations, rows: [{ extra: 1 }] } },
      { ...base.set.results, ev_relations: { ...base.set.results.ev_relations, verdict: { ...base.set.results.ev_relations.verdict } } },
      { ...base.set.results, ev_relations: { ...base.set.results.ev_relations, serverValidated: true } },
      { ...base.set.results, ev_relations: { ...base.set.results.ev_relations, sqlSha256: 'a'.repeat(64) } },
    ]) {
      const forged = { ...base.set, results };
      const a = assemble(forged, classify(forged), reconcile(forged, classify(forged)));
      expect(a.evidence).toBeNull(); expect(a.verdict.structural).toBe('invalid'); expect(a.verdict.eligible).toBe(false);
    }
  });
});

describe('S1-C/C3-E ensamblado: observaciones y dependencias inconsistentes', () => {
  it('consultas ausentes, fallidas, truncadas o inválidas se conservan con su estado', () => {
    const failed = tmod(() => undefined, { ev_sessions: { result: { status: 'error', code: 'timeout' } } }).a;
    expect(failed.coherent).toBe(true); expect(failed.verdict.structural).toBe('unresolved'); expect(failed.evidence.observations.ev_sessions.status).toBe('failed');
    expect(failed.findings.filter((f: any) => f.source === 'reconciliation').map((f: any) => f.code)).toContain('observation_failed');
    const many = Array.from({ length: 501 }, (_, i) => ({ pid: 9000 + i, usename: 'u', application_name: 'a', backend_type: 'client backend', state: 'idle', xact_start: '2026-01-01 00:00:00+00', wait_event_type: 'Client' }));
    const truncated = tmod(w => { w.ev_sessions = many; }).a;
    expect(truncated.verdict.structural).toBe('incomplete'); expect(truncated.evidence.observations.ev_sessions.status).toBe('truncated');
    const absent = (() => { const w = world2(); delete (w as any).ev_prepared_xacts; return trio(w).a; })();
    expect(absent.verdict.structural).toBe('unresolved'); expect(absent.evidence.observations.ev_prepared_xacts.status).toBe('absent');
    const invalid = tmod(() => undefined, { ev_sessions: { sqlSha256: 'a'.repeat(64) } }).a;
    expect(invalid.coherent).toBe(true); expect(invalid.verdict.structural).toBe('invalid'); expect(invalid.evidence).toBeNull();
    const empty = trio(world2()).a; expect(empty.evidence.observations.ev_sessions).toEqual({ status: 'executed_empty', rowCount: 0 });
  });
  it('los hallazgos de cada capa se conservan con su origen y las exclusiones se unen', () => {
    const t = tmod(w => { w.ev_companion_items.push(item('trigger', 'pg_trigger', 410, 100, { subtype: 'false', name: 'audit' })); w.ev_closure.push({ depth: 2, classid: 'pg_trigger', objid: 410, objsubid: 0, deptype: 'a' }); w.ev_internal_edges.push(edge(['pg_trigger', 410, 0], ['pg_class', 100, 0], 'a')); w.ev_namespace_catalog_counts[0].operator = '2'; });
    expect(t.a.coherent).toBe(true); expect(t.a.exclusions).toEqual(['counted_not_enumerated', 'unsupported_class_present', 'user_trigger_present']);
    expect(t.a.findings.some((f: any) => f.source === 'classification' && f.code === 'user_trigger_present')).toBe(true);
    expect(t.a.findings.some((f: any) => f.source === 'reconciliation' && f.code === 'counted_not_enumerated')).toBe(true);
    expect(t.a.verdict.excluded).toBe(true); expect(t.a.verdict.structural).toBe('structurally_valid');
  });
  it('compañeros y dependencias inconsistentes empeoran el veredicto agregado sin relajar nada', () => {
    const missingEdge = tmod(w => { w.ev_internal_edges = w.ev_internal_edges.filter((e: any) => !(e.source_classid === 'pg_constraint' && e.source_objid === 300 && e.deptype === 'a')); }).a;
    expect(missingEdge.verdict.structural).toBe('unresolved'); expect(missingEdge.findings.map((f: any) => `${f.source}:${f.code}`)).toContain('reconciliation:edge_missing');
    const dup = tmod(w => { w.ev_companion_items.push(item('constraint', 'pg_constraint', 300, 100, { related_classid: 'pg_class', related_oid: 101, subtype: 'p', name: 'otra' })); }).a;
    expect(dup.coherent).toBe(true); expect(dup.verdict.structural).toBe('invalid'); expect(dup.evidence).toBeNull();
    expect(dup.findings.map((f: any) => `${f.source}:${f.code}`)).toContain('classification:identity_conflict');
    const flag = tmod(w => { w.ev_relations[0].relhastriggers = false; }).a;
    expect(flag.verdict.structural).toBe('invalid'); expect(flag.evidence).toBeNull(); expect(flag.verdict.eligible).toBe(false);
  });
});

describe('S1-C/C3-E ensamblado: entradas hostiles', () => {
  const base = trio(world2());
  it('conjuntos, clasificaciones y reconciliaciones hostiles no lanzan ni ejecutan código del llamador', () => {
    const trap = jest.fn();
    const hostileSets: unknown[] = [null, undefined, 1, 'x', [], new Proxy(base.set, {}), Object.defineProperty({ ...base.set }, 'verdict', { get: trap, enumerable: true }),
      Object.defineProperty({ ...base.set }, 'results', { get: trap, enumerable: true }), { ...base.set, results: new Proxy(base.set.results, {}) },
      Object.create(base.set), { ...base.set, [Symbol('s')]: 1 }];
    for (const hostile of hostileSets) { expect(() => assemble(hostile as never, base.c, base.r)).not.toThrow(); withheldOk(assemble(hostile as never, base.c, base.r), []); }
    const hostileOthers: unknown[] = [null, undefined, 1, 'x', [], new Proxy(base.c, {}), Object.defineProperty({ ...base.c }, 'schema', { get: trap, enumerable: true }), Object.create(base.c), { ...base.c, [Symbol('s')]: 1 }];
    for (const hostile of hostileOthers) {
      withheldOk(assemble(base.set, hostile as never, base.r), ['classification_mismatch']);
      withheldOk(assemble(base.set, base.c, hostile as never), ['reconciliation_mismatch']);
    }
    expect(trap).not.toHaveBeenCalled();
  });
  it('ninguna combinación hostil produce evidencia ni elegibilidad', () => {
    const pool: unknown[] = [null, undefined, 1, 'x', [], {}, base.set, base.c, base.r, new Proxy({}, {})];
    for (const x of pool) for (const y of pool) for (const z of pool) {
      const a = assemble(x as never, y as never, z as never);
      if (!(x === base.set && y === base.c && z === base.r)) expect(a.coherent).toBe(false);
      expect(a.verdict.eligible).toBe(false); expect(a.verdict.demonstration).toBe('not_demonstrated'); expect(a.serverValidated).toBe(false);
      expect(a.provenance.status).toBe('unauthenticated');
    }
  });
});

describe('S1-C/C3-E ensamblado: vocabularios y superficie estática', () => {
  it('vocabularios cerrados y exports congelados', () => {
    expect(Object.isFrozen(jest.requireActual('../../scripts/harness/c8-evidence-assemble.cjs'))).toBe(true);
    for (const v of [FINDINGS, LIMITATIONS, PROVENANCE, PROVENANCE.bindings, SET_KEYS, RESULT_KEYS]) expect(Object.isFrozen(v)).toBe(true);
    for (const state of Object.values(FINDINGS)) expect(state).toBe('invalid');
    expect(Object.keys(LIMITATIONS)).toHaveLength(6); expect(SET_KEYS).toEqual(['duplicates', 'missing', 'order', 'results', 'schema', 'verdict']);
    expect(REQUIRED).toHaveLength(16); expect(RESULT_KEYS).toHaveLength(11);
    expect(Object.values(PROVENANCE.bindings).every(v => v === 'unbound')).toBe(true);
  });
  it('imports exactos, sin C1, sin política, sin identidades, atestaciones, planes ni SQL', () => {
    const ast = ts.createSourceFile('assemble.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports: string[] = []; const names: string[] = [];
    (function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'require') imports.push((node.arguments[0] as ts.StringLiteral).text);
      if (ts.isIdentifier(node)) names.push(node.text);
      ts.forEachChild(node, visit);
    })(ast);
    expect(imports).toEqual(['node:util', './c8-evidence-queries.cjs', './c8-evidence-classify.cjs', './c8-evidence-reconcile.cjs']);
    expect(source.startsWith("'use strict';")).toBe(true);
    expect(names.filter(n => /authoriz|removalPlan|dropPlan|dropOrder|randomBytes|createProvenance|openConnection|beginTransaction|stamp/i.test(n))).toEqual([]);
    expect(source).not.toMatch(/c8-drop-policy|c8-provenance|pg_current_xact_id|serverValidated:\s*true|demonstration:\s*'demonstrated'|eligible:\s*true|authenticated:\s*true|process\.|console\./);
    expect(source).not.toMatch(/\b(?:DROP|CASCADE|INSERT|UPDATE|DELETE|ALTER|CREATE|GRANT|REVOKE|TRUNCATE|SELECT)\b/);
  });
});
