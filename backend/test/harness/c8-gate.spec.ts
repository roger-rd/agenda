import { evaluate, recognized, writable, QUERY_CONTRACT } from '../../scripts/harness/c8-gate.cjs';
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
