import { evaluate, recognized, writable, QUERY_CONTRACT, evaluateGlobalDefaultAcl } from '../../scripts/harness/c8-gate.cjs';
import { schema, privileges, RUN, fake } from './support/c8-fakes';
const roles = { evaluable: true, membership: false, setMembership: false };
describe('C8 puerta efectiva', () => {
  it('R admite cualquier run; W exige run propio y lease', () => {
    const s = schema(); expect(recognized(s)).toBe(true); expect(writable(s, RUN)).toBe(false);
    expect(writable({ ...s, leaseOwned: true }, RUN)).toBe(true);
    expect(writable({ ...s, leaseOwned: true }, 'b'.repeat(32))).toBe(false);
    for (const bad of [{ name: 'public' }, { comment: 'unmarked' }, { owner: 'other' }]) expect(recognized({ ...s, ...bad })).toBe(false);
  });
  it.each(['P6a', 'P6b', 'P6c'] as const)('puerta %s sin privilegios', phase => {
    expect(evaluate([schema()], privileges, phase, roles).ok).toBe(true);
  });
  it.each(['direct', 'inherited', 'public', 'column'] as const)('detecta origen %s en todos los objetos', flag => {
    for (const kind of ['schema', 'table', 'view', 'sequence', 'function', 'procedure']) {
      const p = privileges(); p.objects = [...p.objects, { ...p.objects[0], kind, [flag]: true }];
      expect(evaluate([schema()], () => p, 'P6a', roles).ok).toBe(true);
      for (const phase of ['P6b', 'P6c'] as const) expect(evaluate([schema()], () => p, phase, roles).ok).toBe(false);
    }
  });
  it.each(['membership', 'setMembership', 'grantable', 'defaultAcl'] as const)('rechaza estructura %s', flag => {
    const p = { ...privileges(), [flag]: true };
    for (const phase of ['P6a', 'P6b', 'P6c'] as const) expect(evaluate([schema()], () => p, phase, roles).ok).toBe(false);
  });
  it('membresía global se comprueba incluso sin esquemas', () => {
    expect(evaluate([], privileges, 'P6b', { ...roles, membership: true }).ok).toBe(false);
    expect(evaluate([], privileges, 'P6b', { ...roles, setMembership: true }).ok).toBe(false);
    expect(evaluate([], privileges, 'P6b', { ...roles, evaluable: false }).ok).toBe(false);
  });
  it.each([{ complete: false }, { evaluable: false }, { objects: [] },
    { objects: [{ ...privileges().objects[0], evaluable: false }] },
    { objects: [{ ...privileges().objects[0], kind: 'unknown' }] }])('fallo cerrado %#', override => {
    expect(evaluate([schema()], () => ({ ...privileges(), ...override }), 'P6b', roles).ok).toBe(false);
  });
  it('no confía en REVOKE exitoso, ni excluye R', () => {
    const f = fake(); const p = privileges(); p.objects = [{ ...p.objects[0], public: true }];
    f.setPrivileges(p); f.controls.revokeWorks = false;
    f.client.record('REVOKE ALL PRIVILEGES ON SCHEMA synthetic FROM PUBLIC');
    expect(evaluate(f.schemas(), f.client.inspect, 'P6b', roles).ok).toBe(false);
    expect(evaluate([schema()], () => { throw new Error('private details'); }, 'P6b', roles)).toEqual({ ok: false, code: 'gate_unknown', exitCode: 2 });
    expect(QUERY_CONTRACT.materialized).toContain('MATERIALIZED');
    expect(QUERY_CONTRACT.materialized).toContain('relations AS MATERIALIZED');
    expect(QUERY_CONTRACT.materialized).toContain("c.relkind IN ('r', 'p', 'v', 'm', 'f')");
    expect(QUERY_CONTRACT.materialized).toContain("WHERE c.relkind = 'S'");
    expect(QUERY_CONTRACT.materialized).toContain('has_any_column_privilege');
    expect(QUERY_CONTRACT.materialized).toContain('WITH GRANT OPTION');
    expect(QUERY_CONTRACT.materialized).not.toContain('...');
    expect(QUERY_CONTRACT.roles).toContain("'MEMBER'"); expect(QUERY_CONTRACT.roles).toContain("'SET'");
    expect(QUERY_CONTRACT.defaultsQuery).toContain('pg_default_acl');
    expect(QUERY_CONTRACT.effective).toContain('has_any_column_privilege'); expect(QUERY_CONTRACT.effective).toContain('pg_has_role');
  });
});

describe('H5 ACL global independiente de efectivos y ACL de esquema', () => {
  const global = { evaluable: true, entries: [{ ownerRole: 'agenda_test_owner', objectType: 'r', granteePublic: true, granteeApp: false }] };
  const clean = { evaluable: true, entries: [] };
  it.each([false, true])('global presente con efectivo residual=%s', residual => {
    const p = privileges(); p.objects[0].direct = residual;
    expect(evaluate([schema()], () => p, 'P6b', roles).code).toBe(residual ? 'gate_residual' : 'ok');
    expect(evaluateGlobalDefaultAcl(global)).toEqual({ ok: false, code: 'gate_default_acl', exitCode: 2 });
  });
  it('efectivo residual sin ACL global', () => {
    const p = privileges(); p.objects[0].direct = true;
    expect(evaluate([schema()], () => p, 'P6b', roles).code).toBe('gate_residual');
    expect(evaluateGlobalDefaultAcl(clean)).toEqual({ ok: true, code: 'ok', exitCode: 0 });
  });
  it('ACL de esquema no activa la global ni viceversa', () => {
    const p = { ...privileges(), defaultAcl: true };
    expect(evaluate([schema()], () => p, 'P6b', roles).ok).toBe(false);
    expect(evaluateGlobalDefaultAcl(clean).ok).toBe(true);
    expect(evaluate([schema()], privileges, 'P6b', roles).ok).toBe(true);
    expect(evaluateGlobalDefaultAcl(global).ok).toBe(false);
  });
  it.each([null, {}, { evaluable: false, entries: [] }, { evaluable: true, entries: null },
    { evaluable: true, entries: [null] }, { evaluable: true, entries: [{ ...global.entries[0], granteePublic: null }] },
    { evaluable: true, entries: [{ ...global.entries[0], objectType: 'unknown' }] }])('estructura desconocida %#', info => {
    expect(evaluateGlobalDefaultAcl(info)).toEqual({ ok: false, code: 'gate_unknown', exitCode: 2 });
  });
  it('otro rol se ignora; solo REVOKE no veta; grants app y PUBLIC sí', () => {
    expect(evaluateGlobalDefaultAcl({ ...global, entries: [{ ...global.entries[0], ownerRole: 'other' }] }).ok).toBe(true);
    expect(evaluateGlobalDefaultAcl({ ...global, entries: [{ ...global.entries[0], granteePublic: false }] }).ok).toBe(true);
    for (const ownerRole of ['agenda_test_owner', 'agenda_test_app']) expect(evaluateGlobalDefaultAcl({ ...global,
      entries: [{ ...global.entries[0], ownerRole, granteePublic: false, granteeApp: true }] }).code).toBe('gate_default_acl');
  });
});

describe('C8 puerta: gate_unknown (evidencia ausente o mal formada) frente a gate_residual (hallazgo evaluado)', () => {
  const unknown = { ok: false, code: 'gate_unknown', exitCode: 2 };
  const residual = { ok: false, code: 'gate_residual', exitCode: 2 };
  const phases = ['P6a', 'P6b', 'P6c'] as const;
  it.each(['membership', 'setMembership', 'grantable', 'defaultAcl'] as const)('%s verdadero en el esquema es residual en todas las fases', flag => {
    for (const phase of phases) expect(evaluate([schema()], () => ({ ...privileges(), [flag]: true }), phase, roles)).toEqual(residual);
  });
  it.each(['membership', 'setMembership'] as const)('%s verdadero en roles es residual y no inspecciona esquemas', flag => {
    const inspect = jest.fn(privileges);
    for (const phase of phases) expect(evaluate([schema()], inspect, phase, { ...roles, [flag]: true })).toEqual(residual);
    expect(inspect).not.toHaveBeenCalled();
  });
  it.each(['membership', 'setMembership', 'grantable', 'defaultAcl'] as const)('%s no booleano en el esquema es desconocido', flag => {
    for (const bad of [undefined, null, 'false', 0, 1, {}]) {
      expect(evaluate([schema()], () => ({ ...privileges(), [flag]: bad }), 'P6b', roles)).toEqual(unknown);
    }
  });
  it.each(['membership', 'setMembership'] as const)('%s no booleano en roles es desconocido', flag => {
    for (const bad of [undefined, null, 'false', 0, 1, {}]) {
      expect(evaluate([schema()], privileges, 'P6b', { ...roles, [flag]: bad } as never)).toEqual(unknown);
    }
  });
  it('roles no evaluables, fase inválida, esquema incompleto o inspección que lanza son desconocidos', () => {
    expect(evaluate([schema()], privileges, 'P6b', { ...roles, evaluable: false })).toEqual(unknown);
    expect(evaluate([schema()], privileges, 'P9' as never, roles)).toEqual(unknown);
    expect(evaluate([schema()], () => ({ ...privileges(), complete: false }), 'P6b', roles)).toEqual(unknown);
    expect(evaluate([schema()], () => ({ ...privileges(), evaluable: false }), 'P6b', roles)).toEqual(unknown);
    expect(evaluate([schema()], () => { throw new Error('private details'); }, 'P6b', roles)).toEqual(unknown);
  });
  it('un residuo evaluado no se disfraza de desconocido y viceversa: ambos cierran con salida 2 y códigos distintos', () => {
    const a = evaluate([schema()], () => ({ ...privileges(), defaultAcl: true }), 'P6b', roles);
    const b = evaluate([schema()], () => ({ ...privileges(), defaultAcl: 'x' as never }), 'P6b', roles);
    expect([a.exitCode, b.exitCode]).toEqual([2, 2]); expect(a.code).not.toBe(b.code);
  });
  it('los resultados están congelados', () => {
    expect(Object.isFrozen(evaluate([schema()], () => ({ ...privileges(), grantable: true }), 'P6b', roles))).toBe(true);
    expect(Object.isFrozen(evaluate([schema()], privileges, 'P9' as never, roles))).toBe(true);
  });
});
