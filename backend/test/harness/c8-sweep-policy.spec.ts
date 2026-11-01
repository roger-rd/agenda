import { decide, recover } from '../../scripts/harness/c8-sweep-policy.cjs';
import { fake, schema, privileges, NAME } from './support/c8-fakes';
function ready(items = [schema()]) { const f = fake(items); f.auth.acquire(true); return f; }
describe('C8 recuperación', () => {
  it('lease live tiene código específico y no intenta adquisición ni sentencia', () => {
    const s = schema({ lease: 'live' }); expect(decide(s)).toBe('lease_live');
    const f = ready([s]); const acquire = jest.spyOn(f.client, 'acquire');
    expect(recover(f.schemas(), f)).toMatchObject({ code: 'lease_live', exitCode: 2, neutralized: 0, dropped: 0 });
    expect(acquire).not.toHaveBeenCalled(); expect(f.statements).toEqual([]);
  });
  it.each([0, 3600000])('pérdida L0 justo después del último COMMIT, edad %i', ageMs => {
    const f = ready([schema({ ageMs })]); const record = f.client.record;
    let commits = 0;
    f.client.record = sql => {
      if (sql === 'COMMIT') expect(f.auth.held()).toBe(true);
      record(sql); // COMMIT termina primero; no se lanza una excepción ni rollback.
      if (sql === 'COMMIT') { commits++; f.lose(); expect(f.auth.held()).toBe(false); }
    };
    expect(recover(f.schemas(), f)).toEqual({ code: 'lock_lost', exitCode: 3, dropped: 0,
      neutralized: 0, unchanged: 0, unknown: 0, states: [] });
    expect(commits).toBe(1); expect(f.statements.at(-1)).toBe('COMMIT'); expect(f.statements).not.toContain('ROLLBACK');
    expect(f.terminated()).toBe(1);
    if (ageMs === 0) expect(f.statements.filter(sql => sql.startsWith('REVOKE'))).toHaveLength(10);
    else { expect(f.statements).toContain(`DROP SCHEMA "${NAME}"`); expect(f.schemas()).toEqual([]); }
  });
  it.each([0, 3600000])('leaseOwned falso tras acquire impide incluso BEGIN, edad %i', ageMs => {
    const f = ready([schema({ ageMs })]); const refresh = f.client.refresh;
    const acquire = jest.spyOn(f.client, 'acquire'); let reads = 0;
    f.client.refresh = s => {
      const fresh = refresh(s); reads++;
      // Solo la lectura inmediatamente posterior a acquire contradice su éxito.
      // Lecturas posteriores volverían a decir true: las guardas tardías no bastan.
      if (reads === 2) { expect(fresh.leaseOwned).toBe(true); return { ...fresh, leaseOwned: false }; }
      return fresh;
    };
    expect(recover(f.schemas(), f)).toMatchObject({ code: 'recovery_failed', exitCode: 2, neutralized: 0, dropped: 0 });
    expect(acquire).toHaveBeenCalledTimes(1); expect(acquire.mock.results[0].value).toBe(true);
    expect(reads).toBe(2); expect(f.statements).toEqual([]);
  });
  it('estados explícitos y pérdida L1 durante neutralización', () => {
    const success = ready(); expect(recover(success.schemas(), success).states).toEqual(['neutralizado-y-verificado']);
    const f = ready(); const refresh = f.client.refresh; let lost = false;
    f.client.refresh = s => ({ ...refresh(s), ...(lost ? { leaseOwned: false } : {}) });
    f.controls.before = sql => { if (sql.startsWith('REVOKE')) lost = true; };
    expect(recover(f.schemas(), f).states).toEqual(['sin-cambios(rollback)']);
    expect(f.statements.filter(s => s.startsWith('REVOKE'))).toHaveLength(1);
    const unknown = ready(); unknown.controls.before = sql => { if (sql === 'COMMIT') throw new Error('private'); };
    expect(recover(unknown.schemas(), unknown).states).toEqual(['no-verificable']);
  });
  it.each([[3599999, 'neutralize'], [3600000, 'drop'], [3600001, 'drop'], [-1, 'recovery_failed'],
    [NaN, 'recovery_failed']])('borde edad %s', (age, action) => {
    expect(decide(schema({ ageMs: Number(age) }))).toBe(action);
  });
  it('lease vivo rechaza y esquema ajeno no se toca', () => {
    const f = ready([schema({ lease: 'live' })]); expect(recover(f.schemas(), f).exitCode).toBe(2); expect(f.statements).toEqual([]);
    const other = ready([schema({ owner: 'other' })]); expect(recover(other.schemas(), other).exitCode).toBe(0); expect(other.statements).toEqual([]);
  });
  it('neutraliza directos y PUBLIC en una transacción y verifica antes de COMMIT', () => {
    const f = ready(); const p = privileges(); p.objects = [{ ...p.objects[0], direct: true, public: true }]; f.setPrivileges(p);
    const order: string[] = []; f.controls.before = sql => { order.push(sql); };
    const inspect = f.client.inspect; f.client.inspect = s => { order.push('VERIFY'); return inspect(s); };
    expect(recover(f.schemas(), f)).toMatchObject({ exitCode: 0, neutralized: 1, dropped: 0 });
    expect(order[0]).toBe('BEGIN'); expect(order[1]).toBe('SET LOCAL lock_timeout = 2000');
    expect(order.filter(s => s.startsWith('REVOKE'))).toHaveLength(10);
    expect(order.filter(s => s.endsWith('FROM PUBLIC'))).toHaveLength(5);
    expect(order.slice(-2)).toEqual(['VERIFY', 'COMMIT']);
  });
  it.each(['inherited', 'column'] as const)('residuo %s detiene todo y revierte', flag => {
    const f = ready([schema(), schema({ name: NAME.replace(/1$/, '2'), ageMs: 3600000 })]);
    const p = privileges(); p.objects = [{ ...p.objects[0], direct: true, [flag]: true }]; f.setPrivileges(p);
    expect(recover(f.schemas(), f)).toMatchObject({ code: 'recovery_failed', exitCode: 2, unchanged: 1, dropped: 0 });
    expect(f.statements.at(-1)).toBe('ROLLBACK'); expect(f.statements.some(s => s.startsWith('DROP'))).toBe(false);
    expect(f.client.inspect(schema())).toEqual(p);
  });
  it.each(['membership', 'setMembership', 'grantable', 'defaultAcl'] as const)('estructura residual %s', flag => {
    const f = ready(); f.setPrivileges({ ...privileges(), [flag]: true });
    expect(recover(f.schemas(), f).code).toBe('recovery_failed'); expect(f.statements.at(-1)).toBe('ROLLBACK');
  });
  it.each(Array.from({ length: 10 }, (_, n) => n + 1))('fallo REVOKE %i/10: rollback y cero DROP posterior', nth => {
    const f = ready([schema(), schema({ name: NAME.replace(/1$/, '2'), ageMs: 3600000 })]);
    let revokes = 0; f.controls.before = sql => { if (sql.startsWith('REVOKE') && ++revokes === nth) throw new Error('sensitive'); };
    const p = privileges(); p.objects = [{ ...p.objects[0], direct: true }]; f.setPrivileges(p);
    const result = recover(f.schemas(), f);
    expect(result).toMatchObject({ code: 'recovery_failed', exitCode: 2, dropped: 0, unchanged: 1 });
    expect(revokes).toBe(nth); expect(f.statements.at(-1)).toBe('ROLLBACK'); expect(f.schemas()).toHaveLength(2);
    expect(f.client.inspect(schema())).toEqual(p); expect(JSON.stringify(result)).not.toContain('sensitive');
  });
  it.each(['verify', 'COMMIT', 'ROLLBACK'])('error %s no permite continuar', stage => {
    const f = ready([schema(), schema({ name: NAME.replace(/1$/, '2'), ageMs: 3600000 })]);
    if (stage === 'verify') f.client.inspect = () => { throw new Error('private'); };
    else f.controls.before = sql => { if (sql === stage || stage === 'ROLLBACK' && sql.startsWith('REVOKE')) throw new Error('private'); };
    const result = recover(f.schemas(), f);
    expect(result.code).toBe('recovery_failed'); expect(result.dropped).toBe(0);
    if (stage !== 'verify') expect(result.unknown).toBe(1);
    expect(f.statements.some(s => s.startsWith('DROP'))).toBe(false);
  });
  it('no-verificable y REVOKE mentiroso fallan cerrado', () => {
    for (const unknown of [true, false]) {
      const f = ready(); const p = privileges(); p.evaluable = !unknown;
      p.objects = [{ ...p.objects[0], public: true }]; f.setPrivileges(p); f.controls.revokeWorks = false;
      expect(recover(f.schemas(), f).code).toBe('recovery_failed'); expect(f.statements.at(-1)).toBe('ROLLBACK');
    }
  });
  it('DROP exige evidencias propias y edad inclusiva', () => {
    const f = ready([schema({ ageMs: 3600000 })]);
    expect(recover(f.schemas(), f)).toMatchObject({ exitCode: 0, dropped: 1 });
    expect(f.statements).toEqual(['BEGIN', 'SET LOCAL lock_timeout = 2000', `DROP SCHEMA "${NAME}"`, 'COMMIT']);
    for (const override of [{ empty: false }, { lease: 'unknown' as const }]) {
      const denied = ready([schema({ ageMs: 3600000, ...override })]);
      expect(recover(denied.schemas(), denied).exitCode).toBe(2); expect(denied.statements.some(s => s.startsWith('DROP'))).toBe(false);
    }
    for (const control of ['validTarget', 'canAcquire'] as const) {
      const denied = ready([schema({ ageMs: 3600000 })]); denied.controls[control] = false;
      expect(recover(denied.schemas(), denied).exitCode).toBe(2); expect(denied.statements).toEqual([]);
    }
  });
  it('cap 10 y presupuesto 30000 exactos', () => {
    const items = Array.from({ length: 11 }, (_, n) => schema({ name: NAME.replace(/1$/, String(n)) }));
    const tooMany = ready(items); expect(recover(tooMany.schemas(), tooMany).exitCode).toBe(2); expect(tooMany.statements).toEqual([]);
    const ten = ready(items.slice(0, 10)); expect(recover(ten.schemas(), ten).neutralized).toBe(10);
    const timeout = ready(); timeout.controls.before = sql => { if (sql === 'BEGIN') timeout.advance(30000); };
    expect(recover(timeout.schemas(), timeout).exitCode).toBe(2); expect(timeout.statements.some(s => s.startsWith('REVOKE'))).toBe(false);
  });
  it('pérdida de L0 durante recuperación corta operaciones posteriores y no revive', () => {
    const f = ready([schema(), schema({ name: NAME.replace(/1$/, '2'), ageMs: 3600000 })]);
    f.controls.before = sql => { if (sql.startsWith('REVOKE')) f.lose(); };
    expect(recover(f.schemas(), f).code).toBe('lock_lost');
    expect(f.statements.filter(s => /^(DROP|REVOKE)/.test(s))).toHaveLength(1);
    f.regain(); expect(f.auth.acquire(true)).toBe(false); expect(f.auth.held()).toBe(false);
    const before = f.statements.length; expect(recover(f.schemas(), f).exitCode).toBe(3); expect(f.statements).toHaveLength(before);
    expect(f.terminated()).toBe(1);
  });
});
