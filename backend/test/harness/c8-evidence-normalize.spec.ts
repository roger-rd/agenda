/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { normalizeObservation, normalizeSet, parseDecimal, COLUMN_KINDS, NULL_MEANINGS, IDENTITY_KEYS, ERROR_CODES, LIMITS }
  from '../../scripts/harness/c8-evidence-normalize.cjs';
import { CATALOG, get } from '../../scripts/harness/c8-evidence-queries.cjs';
import { isVerdict, isEligible } from '../../scripts/harness/c8-evidence-states.cjs';
import { NAME } from './support/c8-pg-fakes';

type Q = typeof CATALOG[number];
const SCHEMA_B = 'uow_2611011200_def456_2';
const PARAMS: Record<string, unknown> = { schema: NAME, key: '4095698742242691401', app: 'agenda_test_app' };
const SAMPLE: Record<string, unknown> = { oidpos: 100, oid: 7, int4: 0, depth: 1, pid: 4242, decimal: '3', name: 'x_name', text: '',
  longtext: 'acl', timestamp: '2026-01-01 00:00:00+00', setting: 'on', classid: 'pg_class', classid0: '', char1: 'r', deptype: 'n',
  digest: 'f'.repeat(64), bool: true };
const kindsOf = (q: Q) => (COLUMN_KINDS as Record<string, Record<string, string>>)[q.id];
const rowFor = (q: Q, i = 0): Record<string, any> => ({
  ...Object.fromEntries(q.columns.map(c => [c.name, SAMPLE[kindsOf(q)[c.name]]])),
  ...((IDENTITY_KEYS as Record<string, string[]>)[q.id] ? { oid: 100 + i } : {}),
  ...(q.requiredKeys ? { [q.requiredKeys.column]: q.requiredKeys.values[i] } : {}),
});
const rowsFor = (q: Q, n = Math.max(1, q.cardinality.min)) => Array.from({ length: n }, (_, i) => rowFor(q, i));
const valuesFor = (q: Q, schema: unknown = NAME) => q.params.map(p => (p === 'schema' ? schema : PARAMS[p]));
const obs = (q: Q, rows: unknown = rowsFor(q), over: Record<string, unknown> = {}) => ({
  id: q.id, sqlSha256: q.sqlSha256, values: valuesFor(q), result: { status: 'rows', rows }, ...over });
const one = (id: string) => get(id);
const run = (id: string, rows: unknown, over: Record<string, unknown> = {}) => normalizeObservation(obs(one(id), rows, over));
const expectState = (r: any, structural: string, reasons: string[]) => {
  expect(r.verdict.structural).toBe(structural); expect([...r.verdict.reasons].sort()).toEqual([...reasons].sort());
  expect(r.verdict.eligible).toBe(false); expect(r.verdict.demonstration).toBe('not_demonstrated');
  if (structural !== 'structurally_valid') expect(r.rows).toBeNull();
};
const deepFrozen = (v: any): boolean => v === null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(deepFrozen));
const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/harness/c8-evidence-normalize.cjs'), 'utf8');

describe('S1-C/C3-B normalización: tablas de contrato de las 22 consultas', () => {
  it('COLUMN_KINDS cubre exactamente cada columna de cada consulta, con un tipo coherente con el catálogo', () => {
    expect(Object.keys(COLUMN_KINDS).sort()).toEqual(CATALOG.map(q => q.id).sort()); expect(CATALOG).toHaveLength(22);
    const numeric = ['oidpos', 'oid', 'int4', 'depth', 'pid'];
    for (const q of CATALOG) {
      expect(Object.keys(kindsOf(q)).sort()).toEqual(q.columns.map(c => c.name).sort());
      for (const c of q.columns) {
        const kind = kindsOf(q)[c.name];
        expect(Object.keys(SAMPLE)).toContain(kind);
        expect(c.type).toBe(numeric.includes(kind) ? 'number' : kind === 'bool' ? 'boolean' : 'string');
      }
    }
  });
  it('NULL_MEANINGS describe exactamente las columnas anulables y con significados cerrados', () => {
    for (const q of CATALOG) {
      const declared = Object.keys((NULL_MEANINGS as Record<string, Record<string, string>>)[q.id] ?? {}).sort();
      expect(declared).toEqual(q.columns.filter(c => c.nullable).map(c => c.name).sort());
      for (const meaning of Object.values((NULL_MEANINGS as Record<string, Record<string, string>>)[q.id] ?? {})) expect(['default', 'absent', 'unknown', 'unresolved']).toContain(meaning);
    }
  });
  it('IDENTITY_KEYS refiere columnas existentes; todo está congelado', () => {
    for (const [id, keys] of Object.entries(IDENTITY_KEYS)) for (const k of keys) expect(one(id).columns.map(c => c.name)).toContain(k);
    for (const v of [COLUMN_KINDS, NULL_MEANINGS, IDENTITY_KEYS, ERROR_CODES, LIMITS]) expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(jest.requireActual('../../scripts/harness/c8-evidence-normalize.cjs'))).toBe(true);
    expect(ERROR_CODES).toEqual(['timeout', 'permission', 'connection_lost', 'other']);
  });
});

describe('S1-C/C3-B normalización: observación válida de cada una de las 22 consultas', () => {
  it.each(CATALOG)('$id: estructuralmente válida, no demostrada, inmutable y sin identidad inventada', q => {
    const rows = rowsFor(q);
    const r = normalizeObservation(obs(q, rows));
    expectState(r, 'structurally_valid', []);
    expect(isVerdict(r.verdict)).toBe(true); expect(isEligible(r.verdict)).toBe(false);
    expect(r.verdict.status).toBe('not_demonstrated');
    expect(r).toMatchObject({ id: q.id, sqlSha256: q.sqlSha256, rowCount: rows.length, errorCode: null, serverValidated: false, nulls: [] });
    expect(r.schema).toBe(q.params.includes('schema') ? NAME : null);
    expect(r.values).toEqual(valuesFor(q));
    expect(r.rows).toEqual(rows); expect(deepFrozen(r)).toBe(true);
    expect(r.check).toEqual({ ok: true, truncated: false, code: 'ok', serverValidated: false });
    expect(Object.keys(r).sort()).toEqual(['check', 'errorCode', 'id', 'nulls', 'rowCount', 'rows', 'schema', 'serverValidated', 'sqlSha256', 'values', 'verdict']);
    expect(() => { (r as any).serverValidated = true; }).toThrow(TypeError);
    expect(() => { (r.rows as any[]).push({}); }).toThrow(TypeError);
  });
  it('el resultado no comparte referencias con la entrada: mutar la observación después no cambia el resultado', () => {
    const q = one('ev_relations'); const input = obs(q, rowsFor(q)); const r = normalizeObservation(input);
    (input.result.rows as any[])[0].relname = 'changed'; (input.values as any[])[0] = 'changed';
    expect(r.rows?.[0].relname).toBe('x_name'); expect(r.values[0]).toBe(NAME);
  });
});

describe('S1-C/C3-B normalización: identidad de consulta, hash SQL y parámetros', () => {
  it.each(CATALOG)('$id: un sqlSha256 incorrecto es inválido y no expone filas', q => {
    for (const hash of ['a'.repeat(64), '', q.sqlSha256.toUpperCase(), q.sqlSha256 + '0', CATALOG.find(o => o.id !== q.id)!.sqlSha256, 1, null]) {
      const r = normalizeObservation(obs(q, rowsFor(q), { sqlSha256: hash }));
      expectState(r, 'invalid', ['stale_sql']); expect(r.id).toBe(q.id);
    }
  });
  it.each(['ev_nope', '', '__proto__', 'constructor', 'toString', 'EV_CONTEXT', 'ev_context ', 1, null, undefined, {}, ['ev_context']])('id desconocido %#', id => {
    const r = normalizeObservation(obs(one('ev_context'), [], { id }));
    expectState(r, 'invalid', ['unknown_query']); expect(r.id).toBeNull(); expect(r.sqlSha256).toBeNull();
  });
  it('los valores de parámetros deben ser exactamente los que build acepta', () => {
    const q = one('ev_relations');
    for (const values of [[], [NAME, NAME], [NAME + 'x'], [NAME.toUpperCase()], [`${NAME}\n`], [null], [1], [{}], [[NAME]], 'x', null, {}]) {
      expectState(normalizeObservation(obs(q, [], { values })), 'invalid', ['params_mismatch']);
    }
    expectState(normalizeObservation(obs(one('ev_context'), rowsFor(one('ev_context')), { values: ['x'] })), 'invalid', ['params_mismatch']);
    expectState(normalizeObservation(obs(q, [], { values: undefined })), 'invalid', ['hostile_input']);
    expectState(normalizeObservation(obs(one('ev_role_membership'), [], { values: ['agenda_test_owner'] })), 'invalid', ['params_mismatch']);
    for (const key of ['01', '-0', '+1', 1, null, '9223372036854775808']) expectState(normalizeObservation(obs(one('ev_advisory_holders'), [], { values: [key] })), 'invalid', ['params_mismatch']);
    expectState(normalizeObservation(obs(one('ev_advisory_holders'), [], { values: ['0'] })), 'structurally_valid', []);
  });
});

describe('S1-C/C3-B normalización: filas inválidas y valores fuera de contrato', () => {
  const base = () => rowFor(one('ev_relations'));
  it('forma de columnas, NULL que invalida el contrato y tipos', () => {
    const { relname, ...missing } = base(); void relname;
    expectState(run('ev_relations', [missing]), 'invalid', ['column_shape']);
    expectState(run('ev_relations', [{ ...base(), extra: 1 }]), 'invalid', ['column_shape']);
    expectState(run('ev_relations', [{ ...base(), relname: null }]), 'invalid', ['null_contract_violation']);
    expectState(run('ev_relations', [{ ...base(), relispartition: 'yes' }]), 'invalid', ['column_type']);
    expectState(run('ev_relations', [{ ...base(), oid: '100' }]), 'invalid', ['column_type']);
    expectState(run('ev_relations', [{ ...base(), oid: NaN }]), 'invalid', ['number_out_of_range']);
    expectState(run('ev_relations', [{ ...base(), oid: Infinity }]), 'invalid', ['number_out_of_range']);
    expectState(run('ev_relations', [null]), 'invalid', ['rows_invalid']);
    expectState(run('ev_relations', [[1]]), 'invalid', ['rows_invalid']);
    expectState(run('ev_relations', [{ ...base(), oid: null, relname: 5 }]), 'invalid', ['column_type', 'null_contract_violation']);
  });
  it.each([0, -1, 1.5, 4294967296, Number.MAX_SAFE_INTEGER, 2 ** 53])('oid fuera de rango o no entero %s', oid => {
    expectState(run('ev_relations', [{ ...base(), oid }]), 'invalid', ['number_out_of_range']);
  });
  it('rangos por tipo de columna: oid admite 0, int4 y depth y pid sus límites', () => {
    expectState(run('ev_relations', [{ ...base(), reltoastrelid: 0 }]), 'structurally_valid', []);
    expectState(run('ev_relations', [{ ...base(), reltoastrelid: 4294967295 }]), 'structurally_valid', []);
    expectState(run('ev_relations', [{ ...base(), reltoastrelid: 4294967296 }]), 'invalid', ['number_out_of_range']);
    expectState(run('ev_closure', [{ ...rowFor(one('ev_closure')), objsubid: 2147483647 }]), 'structurally_valid', []);
    expectState(run('ev_closure', [{ ...rowFor(one('ev_closure')), objsubid: 2147483648 }]), 'invalid', ['number_out_of_range']);
    expectState(run('ev_closure', [{ ...rowFor(one('ev_closure')), objsubid: -1 }]), 'invalid', ['number_out_of_range']);
    for (const depth of [0, -1, 1.5]) expectState(run('ev_closure', [{ ...rowFor(one('ev_closure')), depth }]), 'invalid', ['number_out_of_range']);
    expectState(run('ev_closure', [{ ...rowFor(one('ev_closure')), depth: 33 }]), 'invalid', ['depth_frontier', 'number_out_of_range']);
    for (const pid of [0, -5, 2147483648]) expectState(run('ev_sessions', [{ ...rowFor(one('ev_sessions')), pid }]), 'invalid', ['number_out_of_range']);
  });
  it('decimales canónicos sin pérdida de precisión', () => {
    const row = (n: unknown) => [{ ...rowFor(one('ev_companions')), n }];
    for (const n of ['01', '-1', '1.0', '', ' 1', '1 ', '1e3', '+1', '9223372036854775808', '99999999999999999999']) expectState(run('ev_companions', row(n)), 'invalid', ['decimal_not_canonical']);
    for (const n of ['0', '7', '9223372036854775807']) {
      const r = run('ev_companions', row(n)); expectState(r, 'structurally_valid', []); expect(r.rows?.[0].n).toBe(n);
    }
    expect(parseDecimal('9223372036854775807')).toBe(9223372036854775807n); expect(parseDecimal('0')).toBe(0n);
    for (const bad of ['01', '', '-1', '9223372036854775808', 1 as never, null as never]) expect(() => parseDecimal(bad)).toThrow('evidence_normalize_decimal');
  });
  it('enumeraciones y formatos de texto', () => {
    expectState(run('ev_closure', [{ ...rowFor(one('ev_closure')), deptype: 'z' }]), 'invalid', ['enum_violation']);
    expectState(run('ev_closure', [{ ...rowFor(one('ev_closure')), deptype: 'N' }]), 'invalid', ['enum_violation']);
    for (const deptype of ['n', 'a', 'i', 'P', 'S', 'e', 'x']) expectState(run('ev_closure', [{ ...rowFor(one('ev_closure')), deptype }]), 'structurally_valid', []);
    for (const classid of ['PG_CLASS', 'pg class', '', 'pg_class;', '1abc']) expectState(run('ev_closure', [{ ...rowFor(one('ev_closure')), classid }]), 'invalid', ['column_type']);
    expectState(run('ev_relations', [{ ...base(), relkind: 'ab' }]), 'invalid', ['column_type']);
    expectState(run('ev_relations', [{ ...base(), relkind: '' }]), 'invalid', ['column_type']);
    expectState(run('ev_relations', [{ ...base(), relname: '' }]), 'invalid', ['column_type']);
    expectState(run('ev_outside_census', rowsFor(one('ev_outside_census')).map((r, i) => (i ? r : { ...r, digest: 'F'.repeat(64) }))), 'invalid', ['column_type']);
    expectState(run('ev_companion_items', [{ ...rowFor(one('ev_companion_items')), related_classid: 'BAD' }]), 'invalid', ['column_type']);
  });
  it('la columna vacía permitida (related_classid) y los textos vacíos se conservan', () => {
    const r = run('ev_companion_items', [{ ...rowFor(one('ev_companion_items')), related_classid: '', name: '' }]);
    expectState(r, 'structurally_valid', []); expect(r.rows?.[0].related_classid).toBe('');
  });
});

describe('S1-C/C3-B normalización: truncamiento, cardinalidad y fronteras', () => {
  const many = (id: string, n: number) => Array.from({ length: n }, (_, i) => rowFor(one(id), i));
  it('maxRows filas son válidas, maxRows+1 es incompleto y más allá es inválido o hostil', () => {
    const q = one('ev_relations');
    expectState(run(q.id, many(q.id, q.maxRows)), 'structurally_valid', []);
    const truncated = run(q.id, many(q.id, q.maxRows + 1));
    expectState(truncated, 'incomplete', ['truncated']); expect(truncated.rowCount).toBe(q.maxRows + 1);
    expect(truncated.check).toEqual({ ok: false, truncated: true, code: 'evidence_query_truncated', serverValidated: false });
    expectState(run(q.id, many(q.id, q.maxRows + 2)), 'invalid', ['rows_invalid']);
    expectState(run(q.id, many(q.id, q.maxRows + 3)), 'invalid', ['hostile_input']);
  });
  it.each(['ev_outbound_references', 'ev_companion_items', 'ev_internal_edges'])('%s: el truncamiento falla cerrado en su propio límite', id => {
    const q = one(id); const key = ['item_oid', 'source_objid'].find(k => q.columns.some(c => c.name === k)) as string;
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ ...rowFor(q), [key]: 100 + i }));
    expectState(run(id, rows(q.maxRows)), 'structurally_valid', []);
    expectState(run(id, rows(q.maxRows + 1)), 'incomplete', ['truncated']);
  });
  it('cardinalidad: consultas de una fila y censo exacto', () => {
    expectState(run('ev_context', []), 'invalid', ['cardinality']);
    expectState(run('ev_context', rowsFor(one('ev_context'), 2)), 'incomplete', ['truncated']);
    const census = rowsFor(one('ev_outside_census'));
    expectState(run('ev_outside_census', census), 'structurally_valid', []);
    expectState(run('ev_outside_census', census.slice(1)), 'invalid', ['cardinality']);
    expectState(run('ev_outside_census', [...census, { ...census[0], catalog: 'extra' }]), 'invalid', ['cardinality']);
    expectState(run('ev_outside_census', [...census.slice(1), census[1]]), 'invalid', ['cardinality']);
    expectState(run('ev_outside_census', []), 'invalid', ['cardinality']);
  });
  it('fronteras de profundidad y destinos no resueltos', () => {
    const closure = (depth: number) => [{ ...rowFor(one('ev_closure')), depth }];
    expectState(run('ev_closure', closure(16)), 'structurally_valid', []);
    expectState(run('ev_closure', closure(17)), 'incomplete', ['depth_frontier']);
    expectState(run('ev_closure', [...closure(1), ...closure(17).map(r => ({ ...r, objid: 2 }))]), 'incomplete', ['depth_frontier']);
    const external = (extra: Record<string, unknown> = {}) => [{ ...rowFor(one('ev_external_dependents')), ...extra }];
    expectState(run('ev_external_dependents', external({ namespace: null })), 'unresolved', ['unmapped_class']);
    expectState(run('ev_external_dependents', external({ namespace: null, depth: 17 })), 'unresolved', ['depth_frontier', 'unmapped_class']);
    expectState(run('ev_outbound_references', [{ ...rowFor(one('ev_outbound_references')), target_schema: null }]), 'unresolved', ['unmapped_class']);
    expectState(run('ev_outbound_references', [{ ...rowFor(one('ev_outbound_references')), deptype: 'e' }]), 'structurally_valid', []);
  });
});

describe('S1-C/C3-B normalización: NULL permitido, desconocido e inválido', () => {
  it('NULL permitido (por defecto o ausente) se registra con su significado y no degrada el estado', () => {
    const r = run('ev_namespace', [{ ...rowFor(one('ev_namespace')), comment: null, acl: null }]);
    expectState(r, 'structurally_valid', []);
    expect(r.nulls).toEqual([{ row: 0, column: 'comment', meaning: 'absent' }, { row: 0, column: 'acl', meaning: 'default' }]);
    expect(deepFrozen(r.nulls)).toBe(true);
    const locks = run('ev_target_relation_locks', [{ ...rowFor(one('ev_target_relation_locks')), pid: null }]);
    expectState(locks, 'structurally_valid', []); expect(locks.nulls).toEqual([{ row: 0, column: 'pid', meaning: 'absent' }]);
    const companion = run('ev_companion_items', [{ ...rowFor(one('ev_companion_items')), edge_deptype: null, edge_ref_subid: null }]);
    expectState(companion, 'structurally_valid', []);
    expect(companion.nulls.map((n: any) => n.meaning)).toEqual(['absent', 'absent']);
    expect(run('ev_relations', [{ ...rowFor(one('ev_relations')), acl: null }]).nulls).toEqual([{ row: 0, column: 'acl', meaning: 'default' }]);
  });
  it('NULL desconocido nunca se lee como ausencia: el resultado es no resuelto y sin filas', () => {
    for (const column of ['usename', 'application_name', 'backend_type', 'state', 'xact_start', 'wait_event_type']) {
      expectState(run('ev_sessions', [{ ...rowFor(one('ev_sessions')), [column]: null }]), 'unresolved', ['null_unknown']);
    }
    expectState(run('ev_context', [{ ...rowFor(one('ev_context')), backend_start: null }]), 'unresolved', ['null_unknown']);
    for (const column of ['membership', 'set_membership']) expectState(run('ev_role_membership', [{ ...rowFor(one('ev_role_membership')), [column]: null }]), 'unresolved', ['null_unknown']);
  });
  it('NULL en una columna no anulable invalida el contrato en las 22 consultas', () => {
    for (const q of CATALOG) {
      for (const c of q.columns.filter(col => !col.nullable)) {
        const rows = rowsFor(q); rows[0] = { ...rows[0], [c.name]: null };
        const r = normalizeObservation(obs(q, rows));
        expect(r.verdict.structural).toBe('invalid'); expect(r.rows).toBeNull();
        expect([...r.verdict.reasons]).toEqual(q.requiredKeys && c.name === q.requiredKeys.column ? ['null_contract_violation'] : ['null_contract_violation']);
      }
    }
  });
});

describe('S1-C/C3-B normalización: vacío, fallido y duplicados', () => {
  it('un resultado vacío es válido y distinto de una consulta fallida', () => {
    const empty = run('ev_relations', []);
    expectState(empty, 'structurally_valid', []); expect(empty.rowCount).toBe(0); expect(empty.rows).toEqual([]); expect(empty.errorCode).toBeNull();
    for (const code of ERROR_CODES) {
      const failed = normalizeObservation(obs(one('ev_relations'), [], { result: { status: 'error', code } }));
      expectState(failed, 'unresolved', ['query_failed']);
      expect(failed.errorCode).toBe(code); expect(failed.rowCount).toBeNull(); expect(failed.check).toBeNull(); expect(failed.rows).toBeNull();
    }
  });
  it.each([{ status: 'error', code: 'weird' }, { status: 'error' }, { status: 'error', code: 'timeout', rows: [] }, { status: 'rows' }, { status: 'rows', rows: [], code: 'x' },
    { status: 'ok', rows: [] }, { rows: [] }, { status: 'rows', rows: {} }, { status: 'rows', rows: 'x' }, { status: 'rows', rows: null }, null, [], 'x', 1, undefined])(
    'estructura de result malformada %#', result => {
      const r = normalizeObservation(obs(one('ev_relations'), [], { result }));
      expect(r.verdict.structural).toBe('invalid'); expect(['malformed_observation', 'hostile_input'].some(x => r.verdict.reasons.includes(x))).toBe(true); expect(r.rows).toBeNull();
    });
  it('filas repetidas y oids repetidos dentro de una misma consulta', () => {
    const row = rowFor(one('ev_relations'));
    expectState(run('ev_relations', [row, { ...row }]), 'invalid', ['duplicate_identity', 'duplicate_row']);
    expectState(run('ev_relations', [row, { ...row, relname: 'other' }]), 'invalid', ['duplicate_identity']);
    expectState(run('ev_relations', [row, { ...row, oid: 101 }]), 'structurally_valid', []);
    const edge = rowFor(one('ev_internal_edges'));
    expectState(run('ev_internal_edges', [edge, { ...edge }]), 'invalid', ['duplicate_row']);
    for (const [id, column] of [['ev_routines', 'proname'], ['ev_types', 'typname'], ['ev_event_triggers', 'evtname'], ['ev_default_acl_schema', 'oid']]) {
      const r = rowFor(one(id)); const rows = [r, column === 'oid' ? { ...r } : { ...r, [column]: 'other' }];
      expect(run(id, rows).verdict.reasons).toContain('duplicate_identity'); expect(run(id, rows).verdict.structural).toBe('invalid');
    }
    expect(one('ev_namespace').maxRows).toBe(1);
  });
  it('los mismos oid en catálogos distintos son identidades distintas y se conservan sin fusionar', () => {
    const edges = [rowFor(one('ev_internal_edges')), { ...rowFor(one('ev_internal_edges')), source_classid: 'pg_constraint' }];
    const r = run('ev_internal_edges', edges);
    expectState(r, 'structurally_valid', []); expect(r.rows?.map((x: any) => `${x.source_classid}:${x.source_objid}`)).toEqual(['pg_class:100', 'pg_constraint:100']);
    const closure = [rowFor(one('ev_closure')), { ...rowFor(one('ev_closure')), classid: 'pg_type' }];
    expectState(run('ev_closure', closure), 'structurally_valid', []);
    const items = [rowFor(one('ev_companion_items')), { ...rowFor(one('ev_companion_items')), edge_ref_subid: '2' }, { ...rowFor(one('ev_companion_items')), item_classid: 'pg_constraint' }];
    const kept = run('ev_companion_items', items); expectState(kept, 'structurally_valid', []); expect(kept.rowCount).toBe(3);
    const set = normalizeSet([obs(one('ev_relations'), [rowFor(one('ev_relations'))]), obs(one('ev_routines'), [rowFor(one('ev_routines'))])], { required: ['ev_relations', 'ev_routines'] });
    expect(set.verdict.structural).toBe('structurally_valid'); expect(Object.keys(set.results)).toEqual(['ev_relations', 'ev_routines']);
    expect(set.results.ev_relations.rows?.[0].oid).toBe(100); expect(set.results.ev_routines.rows?.[0].oid).toBe(100);
  });
});

describe('S1-C/C3-B normalización: entradas hostiles', () => {
  const q = one('ev_relations');
  const good = () => obs(q, rowsFor(q));
  const trap = jest.fn(() => { throw new Error('getter invoked'); });
  const revoked = (() => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; })();
  class Exotic { id = q.id; sqlSha256 = q.sqlSha256; values = valuesFor(q); result = { status: 'rows', rows: [] }; }
  const rejected = (r: any) => {
    expect(r.verdict.structural).toBe('invalid'); expect(r.rows).toBeNull();
    expect(r.verdict.reasons.some((x: string) => ['hostile_input', 'malformed_observation', 'unknown_query'].includes(x))).toBe(true);
  };
  it.each([null, undefined, 1, 'x', true, [], [good()], () => good(), Symbol('s'), 10n])('entrada que no es un registro: %#', input => {
    expect(() => normalizeObservation(input)).not.toThrow(); rejected(normalizeObservation(input));
  });
  it('proxies, accesores, símbolos, prototipos exóticos, claves ocultas o extra', () => {
    const cases: unknown[] = [
      new Proxy(good(), {}), revoked, new Exotic(), Object.create(good()),
      Object.defineProperty(good(), 'id', { get: trap, enumerable: true }),
      Object.defineProperty(good(), 'result', { get: trap, enumerable: true }),
      Object.defineProperty(good(), 'hidden', { value: 1, enumerable: false }),
      Object.defineProperty({ ...good() }, 'sqlSha256', { value: q.sqlSha256, enumerable: false }),
      { ...good(), [Symbol('s')]: 1 }, { ...good(), serverValidated: true }, { ...good(), demonstrated: true }, { ...good(), demonstration: 'demonstrated' },
      { ...good(), connection: { id: 'c', pid: 1 } }, { ...good(), transaction: { id: 't' } }, { ...good(), sequence: 1 },
      (({ id, ...rest }) => { void id; return rest; })(good()), (({ values, ...rest }) => { void values; return rest; })(good()),
    ];
    for (const input of cases) { expect(() => normalizeObservation(input)).not.toThrow(); rejected(normalizeObservation(input)); }
    expect(trap).not.toHaveBeenCalled();
  });
  it('niveles anidados: filas, celdas y valores hostiles', () => {
    const row = rowFor(q);
    const cases: unknown[] = [
      { ...good(), result: { status: 'rows', rows: new Proxy([row], {}) } },
      { ...good(), result: { status: 'rows', rows: [new Proxy(row, {})] } },
      { ...good(), result: { status: 'rows', rows: [Object.defineProperty({ ...row }, 'relname', { get: trap, enumerable: true })] } },
      { ...good(), result: { status: 'rows', rows: Object.defineProperty([row], '0', { get: trap, enumerable: true }) } },
      { ...good(), result: { status: 'rows', rows: [Object.create(row)] } },
      { ...good(), result: { status: 'rows', rows: [Object.assign(Object.create(null), row), { ...row, [Symbol('s')]: 1 }] } },
      { ...good(), result: { status: 'rows', rows: (() => { class Sub extends Array<unknown> {} const a = new Sub(); a.push(row); return a; })() } },
      { ...good(), result: { status: 'rows', rows: new Array(1) } },
      { ...good(), result: { status: 'rows', rows: [{ ...row, relname: undefined }] } },
      { ...good(), result: { status: 'rows', rows: [{ ...row, relname: 10n }] } },
      { ...good(), result: { status: 'rows', rows: [{ ...row, relname: () => 1 }] } },
      { ...good(), result: { status: 'rows', rows: [{ ...row, relname: Symbol('x') }] } },
      { ...good(), result: { status: 'rows', rows: [{ ...row, relname: { deep: [[[[[[1]]]]]] } }] } },
      { ...good(), result: { status: 'rows', rows: [{ ...row, relname: 'x'.repeat(LIMITS.string + 1) }] } },
      { ...good(), result: { status: 'rows', rows: [JSON.parse('{"__proto__": 1}')] } },
      { ...good(), values: new Proxy([NAME], {}) }, { ...good(), values: Object.defineProperty([NAME], '0', { get: trap, enumerable: true }) },
      { ...good(), values: [NAME, 1, 2, 3, 4, 5] },
    ];
    for (const input of cases) { expect(() => normalizeObservation(input)).not.toThrow(); rejected(normalizeObservation(input)); }
    expect(trap).not.toHaveBeenCalled();
  });
  it('la entrada no se modifica y no se retiene ninguna referencia a ella', () => {
    const input = good(); const copy = JSON.stringify(input); const r = normalizeObservation(input);
    expect(JSON.stringify(input)).toBe(copy); expect(r.rows).not.toBe(input.result.rows); expect(Object.isFrozen(input)).toBe(false);
  });
  it('ningún trap de Proxy ni código del llamador se ejecuta al inspeccionar, en ninguna posición; el Proxy nunca es evidencia', () => {
    const calls: string[] = [];
    const handler = new Proxy({}, { get: (_target, trap) => (...args: unknown[]) => { calls.push(String(trap)); return (Reflect as any)[trap](...args); } }) as ProxyHandler<any>;
    const P = (target: any): any => new Proxy(target, handler);
    const row = rowFor(q); const make = (): any => obs(q, [{ ...row }]);
    const revoke = (target: any): any => { const p = Proxy.revocable(target, handler); p.revoke(); return p.proxy; };
    const cases: unknown[] = [P(make()), { ...make(), values: P([NAME]) }, { ...make(), result: P({ status: 'rows', rows: [] }) },
      { ...make(), result: { status: 'rows', rows: P([{ ...row }]) } }, { ...make(), result: { status: 'rows', rows: [P({ ...row })] } },
      { ...make(), result: { status: 'rows', rows: [{ ...row, relname: P({}) }] } }, P(function () { return 1; }), P(class Anything {}), P(P(make())),
      revoke(make()), { ...make(), result: { status: 'rows', rows: revoke([]) } }, { ...make(), values: revoke([]) }];
    for (const input of cases) {
      const r = normalizeObservation(input);
      expect(r.verdict.structural).toBe('invalid'); expect(r.rows).toBeNull(); expect(r.verdict.eligible).toBe(false);
    }
    for (const set of [normalizeSet(P([make()])), normalizeSet([P(make())]), normalizeSet([make()], P({ required: ['ev_relations'] }) as never),
      normalizeSet([make()], { required: P(['ev_relations']) }), normalizeSet(revoke([make()]))]) expect(set.verdict.structural).toBe('invalid');
    expect(calls).toEqual([]);
    expect(normalizeObservation({ ...make(), result: { status: 'rows', rows: revoke([]) } }).verdict.reasons).toContain('malformed_observation');
    expect(normalizeObservation(P(make())).verdict.reasons).toContain('hostile_input');
    const spy = jest.fn(() => 'x');
    const evil: unknown[] = [{ ...make(), toString: spy }, { ...make(), toJSON: spy }, { ...make(), valueOf: spy }, { ...make(), then: spy },
      { ...make(), [Symbol.toPrimitive]: spy }, { ...make(), result: { status: 'rows', rows: [{ ...row, relname: spy }] } },
      { ...make(), result: { status: 'rows', rows: [{ ...row, relname: { toString: spy, valueOf: spy, toJSON: spy } }] } },
      Object.defineProperty(make(), 'result', { get: spy, enumerable: true })];
    for (const input of evil) expect(normalizeObservation(input).verdict.structural).toBe('invalid');
    expect(spy).not.toHaveBeenCalled();
  });
  it('propiedad con semilla fija: ninguna mutación aleatoria produce filas válidas fuera de contrato', () => {
    let seed = 0xc3b2;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8; };
    const pool: unknown[] = [null, -1, 0, 1.5, NaN, Infinity, 2 ** 40, 4294967296, '', 'x', '01', 'Z', true, false, {}, [], 'f'.repeat(64), 'pg_class', 'n'];
    for (let round = 0; round < 600; round++) {
      const query = CATALOG[next() % CATALOG.length];
      const rows = rowsFor(query); const column = query.columns[next() % query.columns.length].name; const index = next() % rows.length;
      rows[index] = { ...rows[index], [column]: pool[next() % pool.length] };
      const r = normalizeObservation(obs(query, rows));
      expect(r.verdict.eligible).toBe(false); expect(r.verdict.demonstration).toBe('not_demonstrated');
      if (r.verdict.structural === 'structurally_valid') {
        for (const c of query.columns) {
          const v = r.rows?.[index][c.name];
          if (v !== null) { expect(typeof v).toBe(c.type); if (c.type === 'number') expect(Number.isSafeInteger(v) && v >= 0 && v <= 4294967295).toBe(true); }
          else expect(c.nullable).toBe(true);
        }
      } else expect(r.rows).toBeNull();
    }
  });
});

describe('S1-C/C3-B normalización: conjuntos de observaciones', () => {
  const all = () => CATALOG.map(q => obs(q));
  it('las 22 válidas: estructuralmente válido, no demostrado, orden estable y un solo esquema', () => {
    const set = normalizeSet(all());
    expect(set.verdict).toMatchObject({ structural: 'structurally_valid', demonstration: 'not_demonstrated', status: 'not_demonstrated', eligible: false, reasons: [] });
    expect(set.order).toEqual(CATALOG.map(q => q.id)); expect(Object.keys(set.results)).toHaveLength(22);
    expect(set.missing).toEqual([]); expect(set.duplicates).toEqual([]); expect(set.schema).toBe(NAME);
    expect(deepFrozen(set)).toBe(true); expect(isVerdict(set.verdict)).toBe(true);
    for (const id of set.order) expect(set.results[id].id).toBe(id);
  });
  it('el orden de entrada no cambia el resultado', () => {
    const forward = normalizeSet(all()); const backward = normalizeSet([...all()].reverse());
    expect(backward.order).toEqual(forward.order); expect(backward.verdict).toEqual(forward.verdict);
    expect(Object.keys(backward.results).sort()).toEqual(Object.keys(forward.results).sort());
  });
  it('consultas ausentes son no resueltas, nunca ausencia de objetos', () => {
    const set = normalizeSet(all().filter(o => o.id !== 'ev_relations' && o.id !== 'ev_closure'));
    expect(set.missing).toEqual(['ev_relations', 'ev_closure']);
    expect(set.verdict).toMatchObject({ structural: 'unresolved', reasons: ['query_missing'] });
    expectState(set.results.ev_relations, 'unresolved', ['query_missing']);
    expect(normalizeSet([]).missing).toHaveLength(22); expect(normalizeSet([]).verdict.structural).toBe('unresolved');
    expect(normalizeSet(undefined as never).verdict.reasons).toEqual(['hostile_input', 'query_missing']);
  });
  it('consultas fallidas e inválidas se propagan conservadoramente', () => {
    const failed = all().map(o => (o.id === 'ev_sessions' ? { ...o, result: { status: 'error', code: 'timeout' } } : o));
    expect(normalizeSet(failed).verdict).toMatchObject({ structural: 'unresolved', reasons: ['query_failed'] });
    const mixed = all().map(o => (o.id === 'ev_sessions' ? { ...o, result: { status: 'error', code: 'timeout' } } : o.id === 'ev_context' ? { ...o, sqlSha256: 'a'.repeat(64) } : o));
    expect(normalizeSet(mixed).verdict).toMatchObject({ structural: 'invalid', reasons: ['query_failed', 'stale_sql'] });
    const truncated = all().map(o => (o.id === 'ev_relations' ? { ...o, result: { status: 'rows', rows: Array.from({ length: 501 }, (_, i) => ({ ...rowFor(one('ev_relations')), oid: 100 + i })) } } : o));
    expect(normalizeSet(truncated).verdict).toMatchObject({ structural: 'incomplete', reasons: ['truncated'] });
  });
  it('observaciones duplicadas: se conserva la primera y el conjunto es inválido', () => {
    const set = normalizeSet([...all(), obs(one('ev_relations'), [])]);
    expect(set.duplicates).toEqual(['ev_relations']); expect(set.verdict).toMatchObject({ structural: 'invalid', reasons: ['duplicate_observation'] });
    expect(set.results.ev_relations.rowCount).toBe(1);
  });
  it('esquemas objetivo distintos en un mismo conjunto son inválidos', () => {
    const mixed = all().map(o => (o.id === 'ev_types' ? { ...o, values: [SCHEMA_B] } : o));
    const set = normalizeSet(mixed);
    expect(set.verdict).toMatchObject({ structural: 'invalid', reasons: ['params_mismatch'] }); expect(set.schema).toBeNull();
  });
  it('entradas hostiles, demasiado grandes o desconocidas dentro del conjunto', () => {
    for (const input of [null, {}, 'x', 1, new Proxy([], {}), Object.defineProperty([], '0', { get: () => 1, enumerable: true }), Array.from({ length: LIMITS.observations + 1 }, () => obs(one('ev_context')))]) {
      const set = normalizeSet(input); expect(set.verdict.structural).toBe('invalid'); expect(set.verdict.reasons).toContain('hostile_input'); expect(set.missing).toHaveLength(22);
    }
    const unknown = normalizeSet([...all(), obs(one('ev_context'), [], { id: 'ev_nope' })]);
    expect(unknown.verdict).toMatchObject({ structural: 'invalid', reasons: ['malformed_observation', 'unknown_query'] });
    const bad = normalizeSet([...all(), { nonsense: true }]); expect(bad.verdict.structural).toBe('invalid');
  });
  it('opciones: subconjunto requerido, vacío, y rechazo de opciones ambiguas', () => {
    expect(normalizeSet([obs(one('ev_context'))], { required: ['ev_context'] }).verdict.structural).toBe('structurally_valid');
    expect(normalizeSet([], { required: [] }).verdict).toMatchObject({ structural: 'unresolved', reasons: ['no_observations'] });
    for (const options of [{ required: ['ev_nope'] }, { required: ['ev_context', 'ev_context'] }, { required: 'ev_context' }, { required: [1] }, { other: [] }, { required: [], extra: 1 }, null, new Proxy({}, {})]) {
      expect(normalizeSet([], options as never).verdict.structural).toBe('invalid');
    }
  });
  it('un conjunto con una observación fuera de los requeridos la conserva y la evalúa', () => {
    const set = normalizeSet(all(), { required: ['ev_context'] });
    expect(set.order).toEqual(CATALOG.map(q => q.id)); expect(set.verdict.structural).toBe('structurally_valid');
  });
});

describe('S1-C/C3-B normalización: sin demostración, sin atestaciones, sin identidades ni SQL', () => {
  it('ninguna consulta produce un resultado demostrado ni elegible', () => {
    for (const q of CATALOG) {
      const r = normalizeObservation(obs(q)); expect(r.verdict.demonstration).toBe('not_demonstrated'); expect(isEligible(r.verdict)).toBe(false);
      expect(r.serverValidated).toBe(false); expect(q.serverValidated).toBe(false);
    }
    const set = normalizeSet(all22()); expect(set.verdict.eligible).toBe(false); expect(isEligible(set.verdict)).toBe(false);
  });
  it('superficie estática: imports exactos, sin cuerpos autorizables, identidades, atestaciones ni SQL', () => {
    const ast = ts.createSourceFile('normalize.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports: string[] = [];
    (function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'require') imports.push((node.arguments[0] as ts.StringLiteral).text);
      ts.forEachChild(node, visit);
    })(ast);
    expect(imports).toEqual(['node:util', './c8-evidence-queries.cjs', './c8-evidence-states.cjs']);
    expect(source.startsWith("'use strict';")).toBe(true);
    expect(source).not.toMatch(/demonstration:\s*'demonstrated'|serverValidated:\s*true|authorize\(/);
    const names: string[] = [];
    (function visit(node: ts.Node) { if (ts.isIdentifier(node)) names.push(node.text); ts.forEachChild(node, visit); })(ast);
    expect(names.filter(n => /attest|body|authoriz|demonstrated/i.test(n))).toEqual([]);
    expect(source).not.toMatch(/randomBytes|connectionId|transactionId|pg_current_xact_id|c8-drop-policy|c8-provenance|process\.|console\./);
    expect(source).not.toMatch(/\b(?:DROP|CASCADE|INSERT|UPDATE|DELETE|ALTER|CREATE|GRANT|REVOKE|TRUNCATE|SELECT)\b/);
  });
});

function all22() { return CATALOG.map(q => obs(q)); }
