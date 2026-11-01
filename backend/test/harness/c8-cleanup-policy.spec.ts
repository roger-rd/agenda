import { evaluate, cleanup } from '../../scripts/harness/c8-cleanup-policy.cjs';
import { fake, evidence, schema, NAME } from './support/c8-fakes';
describe('C8 limpieza E1–E5', () => {
  it('positivos obligatorios y secuencia con reconfirmación', () => {
    const f = fake(); f.auth.acquire(true); let checks = 0;
    expect(cleanup({ auth: f.auth, record: f.client.record, inspect: () => { checks++; return evidence(); } })).toEqual({ ok: true, code: 'ok', exitCode: 0 });
    expect(checks).toBe(2); expect(f.statements).toEqual(['BEGIN', 'SET LOCAL lock_timeout = 2000', `DROP SCHEMA "${NAME}"`, 'COMMIT']);
  });
  it.each([{ runSessions: null }, { runSessions: 1 }, { otherRolePids: null }, { otherRolePids: [99] },
    { foreignLocks: null }, { foreignLocks: true }, { numbackends: null }, { numbackends: 2 },
    { numbackends: -1 }, { numbackends: NaN }, { error: true }, { target: false },
    { schema: schema({ leaseOwned: false }) }, { schema: schema({ leaseOwned: true, owner: 'other' }) },
    { schema: schema({ leaseOwned: true, comment: 'other' }) }, { schema: schema({ leaseOwned: true, name: 'public' }) },
    { schema: schema({ leaseOwned: true, empty: false }) }, { runId: 'b'.repeat(32) }])('rechaza evidencia %#', override => {
    expect(evaluate(evidence(override))).toMatchObject({ ok: false, exitCode: 3 });
  });
  it('numbackends solo veta; jamás sustituye E4a/E4b y baseline sucia es exit 2', () => {
    expect(evaluate(evidence({ numbackends: 0, runSessions: null })).exitCode).toBe(3);
    expect(evaluate(evidence({ numbackends: 0, otherRolePids: null })).exitCode).toBe(3);
    expect(evaluate(evidence({ baselineClean: false }))).toEqual({ ok: false, code: 'baseline_dirty', exitCode: 2 });
    expect(evaluate(evidence({ numbackends: 0 })).ok).toBe(true);
  });
  it('reconfirma evidencia antes del DROP; cambio implica rollback', () => {
    const f = fake(); f.auth.acquire(true); let n = 0;
    const result = cleanup({ auth: f.auth, record: f.client.record, inspect: () => evidence({ runSessions: n++ === 0 ? 0 : null }) });
    expect(result.exitCode).toBe(3); expect(f.statements).toEqual(['BEGIN', 'SET LOCAL lock_timeout = 2000', 'ROLLBACK']);
  });
  it.each(['before', 'reconfirm', 'drop', 'commit'])('pérdida L0 %s, cero destructivas posteriores', point => {
    const f = fake(); f.auth.acquire(true); let checks = 0;
    if (point === 'before') f.lose();
    let lossIndex = f.statements.length;
    f.controls.before = sql => {
      if (point === 'drop' && sql.startsWith('DROP') || point === 'commit' && sql === 'COMMIT') { f.lose(); lossIndex = f.statements.length; }
    };
    const result = cleanup({ auth: f.auth, record: f.client.record, inspect: () => {
      if (++checks === 2 && point === 'reconfirm') { f.lose(); lossIndex = f.statements.length; } return evidence();
    } });
    expect(result).toEqual({ ok: false, code: 'lock_lost', exitCode: 3 });
    expect(f.statements.slice(lossIndex).filter(s => /^(DROP|REVOKE)/.test(s))).toEqual([]);
    f.regain(); expect(f.auth.acquire(true)).toBe(false); expect(f.terminated()).toBe(1);
  });
  it.each(['BEGIN', 'SET LOCAL lock_timeout = 2000', 'DROP', 'COMMIT'])('fallo cliente %s', stage => {
    const f = fake(); f.auth.acquire(true); f.controls.before = sql => { if (sql.startsWith(stage)) throw new Error('private'); };
    const result = cleanup({ auth: f.auth, record: f.client.record, inspect: evidence });
    expect(result).toEqual({ ok: false, code: 'cleanup_unknown', exitCode: 3 });
    expect(f.statements.filter(s => s.startsWith('DROP')).length).toBeLessThanOrEqual(1);
  });
});
