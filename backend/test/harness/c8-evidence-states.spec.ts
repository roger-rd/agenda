import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import * as states from '../../scripts/harness/c8-evidence-states.cjs';

const { STRUCTURAL, DEMONSTRATION, STATUS, REASONS, fromReasons, combine, isVerdict, isEligible, severity, reasonState } = states;
const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/harness/c8-evidence-states.cjs'), 'utf8');

describe('S1-C/C3-B estados de evidencia: vocabulario cerrado', () => {
  it('exports congelados y vocabularios exactos y ordenados por gravedad', () => {
    const actual = jest.requireActual<Record<string, unknown>>('../../scripts/harness/c8-evidence-states.cjs');
    expect(Object.isFrozen(actual)).toBe(true);
    expect(Object.keys(actual).sort()).toEqual(['DEMONSTRATION', 'REASONS', 'STATUS', 'STRUCTURAL', 'combine', 'fromReasons',
      'isEligible', 'isVerdict', 'reasonState', 'severity']);
    expect(STRUCTURAL).toEqual(['structurally_valid', 'incomplete', 'unresolved', 'invalid']);
    expect(DEMONSTRATION).toEqual(['demonstrated', 'not_demonstrated']);
    expect(STATUS).toEqual(['valid_demonstrated', 'not_demonstrated', 'incomplete', 'unresolved', 'invalid']);
    for (const v of [STRUCTURAL, DEMONSTRATION, STATUS, REASONS]) expect(Object.isFrozen(v)).toBe(true);
    STRUCTURAL.forEach((state, index) => expect(severity(state)).toBe(index));
  });
  it('los 23 códigos de razón son estables y cada uno implica un estado estructural cerrado', () => {
    expect(REASONS).toEqual({
      hostile_input: 'invalid', malformed_observation: 'invalid', unknown_query: 'invalid', stale_sql: 'invalid',
      params_mismatch: 'invalid', duplicate_observation: 'invalid', duplicate_row: 'invalid', duplicate_identity: 'invalid',
      rows_invalid: 'invalid', column_shape: 'invalid', column_type: 'invalid', null_contract_violation: 'invalid',
      number_out_of_range: 'invalid', decimal_not_canonical: 'invalid', enum_violation: 'invalid', cardinality: 'invalid',
      no_observations: 'unresolved', query_missing: 'unresolved', query_failed: 'unresolved', unmapped_class: 'unresolved',
      null_unknown: 'unresolved', truncated: 'incomplete', depth_frontier: 'incomplete',
    });
    for (const [code, state] of Object.entries(REASONS)) { expect(STRUCTURAL).toContain(state); expect(reasonState(code)).toBe(state); }
    expect(Object.values(REASONS)).not.toContain('structurally_valid');
  });
  it.each(['nope', '', 'toString', '__proto__', 'constructor', null, undefined, 1, {}])('rechaza razón o estado desconocido %#', value => {
    expect(() => reasonState(value as string)).toThrow('evidence_states_input');
    expect(() => severity(value as string)).toThrow('evidence_states_input');
    expect(() => fromReasons([value as string])).toThrow('evidence_states_input');
  });
});

describe('S1-C/C3-B estados: veredictos y elegibilidad', () => {
  it('sin razones es estructuralmente válido pero NO demostrado ni elegible', () => {
    const v = fromReasons([]);
    expect(v).toEqual({ structural: 'structurally_valid', demonstration: 'not_demonstrated', status: 'not_demonstrated', reasons: [], eligible: false });
    expect(Object.isFrozen(v)).toBe(true); expect(Object.isFrozen(v.reasons)).toBe(true);
    expect(isVerdict(v)).toBe(true); expect(isEligible(v)).toBe(false);
  });
  it('la elegibilidad exige validez estructural Y demostración; la demostración no rescata un estado peor', () => {
    const ok = fromReasons([], { demonstration: 'demonstrated' });
    expect(ok).toMatchObject({ status: 'valid_demonstrated', eligible: true }); expect(isEligible(ok)).toBe(true);
    for (const code of Object.keys(REASONS)) {
      const bad = fromReasons([code], { demonstration: 'demonstrated' });
      expect(bad.eligible).toBe(false); expect(bad.status).toBe(REASONS[code as keyof typeof REASONS]); expect(isEligible(bad)).toBe(false);
    }
  });
  it('el estado es el peor de sus razones; las razones salen únicas y ordenadas', () => {
    const v = fromReasons(['truncated', 'query_failed', 'truncated', 'depth_frontier']);
    expect(v.structural).toBe('unresolved'); expect(v.reasons).toEqual(['depth_frontier', 'query_failed', 'truncated']);
    expect(fromReasons(['depth_frontier', 'truncated']).structural).toBe('incomplete');
    expect(fromReasons(['depth_frontier', 'cardinality', 'query_failed']).structural).toBe('invalid');
    expect(fromReasons(['query_failed']).status).toBe('unresolved');
  });
  it.each([undefined, null, 'truncated', {}, new Array(65).fill('truncated')])('fromReasons rechaza una lista inválida %#', codes => {
    expect(() => fromReasons(codes as never)).toThrow('evidence_states_input');
  });
  it.each(['yes', null, 1, {}])('rechaza una demostración desconocida %#', demonstration => {
    expect(() => fromReasons([], { demonstration: demonstration as never })).toThrow('evidence_states_input');
  });
  it('por omisión nunca es demostrado', () => {
    expect(fromReasons([], undefined).demonstration).toBe('not_demonstrated');
    expect(fromReasons([], {}).demonstration).toBe('not_demonstrated');
  });
});

describe('S1-C/C3-B estados: agregación conservadora y determinista', () => {
  const sample = () => [fromReasons([]), fromReasons(['truncated']), fromReasons(['null_unknown', 'unmapped_class']), fromReasons([])];
  it('gana el peor estado, unión ordenada de razones, demostrado solo si todos lo están', () => {
    const all = combine(sample());
    expect(all).toMatchObject({ structural: 'unresolved', demonstration: 'not_demonstrated', status: 'unresolved', eligible: false });
    expect(all.reasons).toEqual(['null_unknown', 'truncated', 'unmapped_class']);
    expect(combine([fromReasons([]), fromReasons([])])).toMatchObject({ structural: 'structurally_valid', status: 'not_demonstrated', eligible: false });
    const demonstrated = (reasons: string[] = []) => fromReasons(reasons, { demonstration: 'demonstrated' });
    expect(combine([demonstrated(), demonstrated()])).toMatchObject({ status: 'valid_demonstrated', eligible: true });
    expect(combine([demonstrated(), fromReasons([])])).toMatchObject({ demonstration: 'not_demonstrated', eligible: false });
    expect(combine([demonstrated(), demonstrated(['cardinality'])]).eligible).toBe(false);
  });
  it('un conjunto vacío es no resuelto, nunca válido', () => {
    expect(combine([])).toMatchObject({ structural: 'unresolved', reasons: ['no_observations'], eligible: false });
  });
  it('el resultado no depende del orden ni de repeticiones (propiedad con semilla fija)', () => {
    let seed = 0xc3b;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8; };
    const codes = Object.keys(REASONS);
    for (let round = 0; round < 200; round++) {
      const list = Array.from({ length: 1 + (next() % 6) }, () => fromReasons(Array.from({ length: next() % 4 }, () => codes[next() % codes.length])));
      const shuffled = [...list].sort(() => (next() % 3) - 1);
      const a = combine(list); const b = combine(shuffled); const c = combine([...list, ...list]);
      expect(b).toEqual(a); expect(c).toEqual(a);
      expect(a.structural).toBe(list.map(v => v.structural).sort((x, y) => severity(y) - severity(x))[0]);
      expect(a.structural).toBe(a.reasons.length ? a.reasons.map(r => reasonState(r)).sort((x, y) => severity(y) - severity(x))[0] : 'structurally_valid');
    }
  });
  it.each([null, undefined, {}, 'x', [{}], [null], [{ structural: 'structurally_valid', demonstration: 'demonstrated', status: 'valid_demonstrated', reasons: [], eligible: true }]])(
    'combine rechaza entradas que no son veredictos emitidos por el módulo %#', input => {
      expect(() => combine(input as never)).toThrow('evidence_states_input');
    });
  it('un veredicto clonado, esparcido o serializado deja de serlo y nunca es elegible', () => {
    const real = fromReasons([], { demonstration: 'demonstrated' });
    for (const copy of [{ ...real }, structuredClone(real), JSON.parse(JSON.stringify(real)), Object.create(real), new Proxy(real, {})]) {
      expect(isVerdict(copy)).toBe(false); expect(isEligible(copy)).toBe(false);
      expect(() => combine([copy])).toThrow('evidence_states_input');
    }
    expect(isVerdict(null)).toBe(false); expect(isVerdict('x')).toBe(false); expect(isVerdict(undefined)).toBe(false);
  });
  it('los veredictos son inmutables', () => {
    const v = fromReasons(['truncated']);
    expect(() => { (v as { eligible: boolean }).eligible = true; }).toThrow(TypeError);
    expect(() => { (v.reasons as string[]).push('x'); }).toThrow(TypeError);
    expect(() => { (v as { status: string }).status = 'valid_demonstrated'; }).toThrow(TypeError);
  });
});

describe('S1-C/C3-B estados: superficie estática', () => {
  it('sin I/O, sin dependencias, sin SQL ni identidades', () => {
    const ast = ts.createSourceFile('states.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const calls: string[] = [];
    (function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'require') calls.push(node.getText(ast));
      ts.forEachChild(node, visit);
    })(ast);
    expect(calls).toEqual([]);
    expect(source.startsWith("'use strict';")).toBe(true);
    expect(source).not.toMatch(/\b(?:DROP|CASCADE|INSERT|UPDATE|DELETE|ALTER|CREATE|GRANT|REVOKE|TRUNCATE|SELECT)\b|pg_current_xact_id|randomBytes|process\.|console\./i);
    expect(source).not.toMatch(/connectionId|transactionId|c8-drop-policy|c8-provenance/);
  });
});
