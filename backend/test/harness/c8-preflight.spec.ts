import { authorization, preflight } from '../../scripts/harness/c8-preflight.cjs';
import { recover } from '../../scripts/harness/c8-sweep-policy.cjs';
import { cleanup } from '../../scripts/harness/c8-cleanup-policy.cjs';
import { evaluate } from '../../scripts/harness/c8-gate.cjs';
import { fake, privileges, evidence, schema } from './support/c8-fakes';
describe('C8 preflight simulado', () => {
  it('P6a propaga el código de la puerta y no alcanza P7 ni recuperación', () => {
    const f = fake(); f.setPrivileges({ ...privileges(), evaluable: false });
    const gate = evaluate(f.schemas(), f.client.inspect, 'P6a', f.client.roles());
    expect(gate.ok).toBe(false);
    expect(preflight(f)).toEqual({ code: gate.code, exitCode: 2, executable: false });
    expect(f.phases).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6a']);
    expect(f.statements).toEqual([]);
  });
  it.each(['direct', 'inherited', 'public', 'column', 'unknown'] as const)('P6b rechaza %s después de recuperación exitosa', origin => {
    const f = fake(); const residual = privileges();
    if (origin === 'unknown') residual.evaluable = false;
    else residual.objects = [{ ...residual.objects[0], [origin]: true }];
    // Las órdenes REVOKE retornan sin error. La lectura final revela evidencia
    // que no estaba en la instantánea usada para verificar la recuperación.
    f.controls.revokeWorks = false;
    f.controls.phase = phase => {
      if (phase === 'P6b') {
        expect(f.statements.at(-1)).toBe('COMMIT');
        f.setPrivileges(residual);
      }
    };
    expect(preflight(f)).toEqual({ code: origin === 'unknown' ? 'gate_unknown' : 'gate_residual', exitCode: 2, executable: false });
    expect(f.phases).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6a', 'P7', 'P8', 'P6b']);
    expect(f.statements.filter(sql => sql.startsWith('REVOKE'))).toHaveLength(10);
    expect(f.statements.at(-1)).toBe('COMMIT'); expect(f.statements).not.toContain('ROLLBACK');
    expect(f.client.inspect(schema())).toEqual(residual);
    // Los cuatro residuos revocables sí pasarían P6a: aísla cambiar la fase final.
    expect(evaluate(f.schemas(), f.client.inspect, 'P6a', f.client.roles()).ok).toBe(origin !== 'unknown');
  });
  it.each([{ user: 'agenda_test_owner' }, { port: 5432 }, { database: 'agenda_dev' }])('appTarget inválido %# se rechaza aunque owner sea correcto', override => {
    const f = fake(); Object.assign(f.appTarget, override);
    expect(preflight(f)).toEqual({ code: 'preflight_failed', exitCode: 2, executable: false });
    expect(f.phases).toEqual(['P1']); expect(f.auth.state()).toBe('new'); expect(f.statements).toEqual([]);
  });
  it.each([
    ['P1', 29999, true], ['P1', 30000, false], ['P1', 300000, false],
    ['P9', 29999, true], ['P9', 30000, false], ['P9', 300000, false],
  ] as const)('presupuesto total en %s a %i ms', (boundary, elapsed, ok) => {
    const f = fake(); f.controls.phase = phase => { if (phase === boundary) f.advance(elapsed); };
    expect(preflight(f)).toEqual({ code: ok ? 'ok' : 'preflight_failed', exitCode: ok ? 0 : 2, executable: ok });
    // P9 aísla el límite total: recuperación ya terminó, su deadline no lo enmascara.
    if (boundary === 'P9') { expect(f.phases.at(-1)).toBe('P9'); expect(f.statements.at(-1)).toBe('COMMIT'); }
    else if (!ok) { expect(f.phases).toEqual(['P1']); expect(f.statements).toEqual([]); }
  });
  it.each([6, 7])('P7 aplica límite literal de conexiones preflight: %i', connections => {
    const f = fake(); f.budget.preflight = connections;
    expect(preflight(f)).toEqual(connections === 6 ? { code: 'ok', exitCode: 0, executable: true } :
      { code: 'preflight_failed', exitCode: 2, executable: false });
    expect(f.phases.at(-1)).toBe(connections === 6 ? 'P9' : 'P7');
    if (connections === 7) expect(f.statements).toEqual([]);
  });
  it('capacidad y presupuesto total se validan antes del plan', () => {
    const f = fake(); f.budget.app = 21;
    expect(preflight(f).executable).toBe(false); expect(f.statements).toEqual([]);
    const timed = fake(); timed.controls.phase = phase => { if (phase === 'P8') timed.advance(30000); };
    expect(preflight(timed).executable).toBe(false); expect(timed.statements).toEqual([]);
  });
  it('orden normativo y L0 mantenido al devolver el plan', () => {
    const f = fake(); const order: string[] = []; f.controls.phase = phase => { order.push(phase); };
    f.tryL0 = () => { order.push('L0'); return true; };
    expect(preflight(f)).toEqual({ code: 'ok', exitCode: 0, executable: true });
    expect(order).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'L0', 'P6a', 'P7', 'P8', 'P6b', 'P9']);
    expect(f.auth.held()).toBe(true);
  });
  it.each(['P1', 'P2', 'P3', 'P4', 'P5'])('fallo %s no adquiere L0 ni recupera', phase => {
    const f = fake(); f.phase = value => value !== phase;
    expect(preflight(f).exitCode).toBe(2); expect(f.auth.state()).toBe('new'); expect(f.statements).toEqual([]);
  });
  it('destino incorrecto no adquiere L0', () => {
    const f = fake(); f.target.major = 15;
    expect(preflight(f).executable).toBe(false); expect(f.auth.state()).toBe('new'); expect(f.statements).toEqual([]);
  });
  it('try-lock sin espera: ocupado no reintenta', () => {
    const f = fake(); let tries = 0; f.tryL0 = () => { tries++; return false; };
    expect(preflight(f)).toEqual({ code: 'run_in_progress', exitCode: 2, executable: false });
    expect(tries).toBe(1); expect(f.phases).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']); expect(f.statements).toEqual([]);
  });
  it.each([true, false])('P7 sesiones/lease ajenos %s', session => {
    const f = fake(); f.baseline = () => ({ otherRolePids: session ? [999] : [], foreignLease: !session });
    expect(preflight(f)).toEqual({ code: session ? 'baseline_dirty' : 'lease_live', exitCode: 2, executable: false });
    expect(f.statements).toEqual([]); expect(f.phases.at(-1)).toBe('P7');
  });
  it('recuperación no verificable y residual impiden plan/Jest', () => {
    const f = fake(); const p = privileges(); p.objects = [{ ...p.objects[0], public: true }]; f.setPrivileges(p); f.controls.revokeWorks = false;
    expect(preflight(f)).toEqual({ code: 'recovery_failed', exitCode: 2, executable: false });
    expect(f.phases.at(-1)).toBe('P8'); expect(f.statements.at(-1)).toBe('ROLLBACK');
  });
  it.each(['P6a', 'P7', 'P8', 'P6b', 'P9'])('pérdida L0 tras %s invalida plan', phase => {
    const f = fake(); let lossIndex = 0;
    f.controls.phase = p => { if (p === phase) { f.lose(); lossIndex = f.statements.length; } };
    expect(preflight(f)).toEqual({ code: 'lock_lost', exitCode: 3, executable: false });
    expect(f.statements.slice(lossIndex).filter(s => /^(REVOKE|DROP)/.test(s))).toEqual([]);
    expect(f.terminated()).toBe(1); f.regain(); expect(f.auth.acquire(true)).toBe(false);
  });
  it('pérdida durante Jest simulado termina grupo e impide barrido y limpieza', () => {
    const f = fake([schema({ ageMs: 3600000 })]);
    expect(preflight(f).executable).toBe(true); f.lose(); f.regain();
    const before = f.statements.length;
    expect(recover([schema()], f).exitCode).toBe(3);
    expect(cleanup({ auth: f.auth, record: f.client.record, inspect: evidence }).code).toBe('lock_lost');
    expect(f.statements).toHaveLength(before); expect(f.terminated()).toBe(1);
  });
  it.each([100, 0, -1, NaN])('hijo rechaza pid L0 %s', pid => {
    let terminated = 0;
    const auth = authorization({ child: true, pid: 100, observe: () => ({ held: true, pid }), terminate: () => { terminated++; } });
    expect(auth.acquire(true)).toBe(false); expect(auth.state()).toBe('unknown'); expect(terminated).toBe(1);
  });
  it('hijo exige otro pid y observación desconocida no revive', () => {
    let unknown = false;
    const auth = authorization({ child: true, pid: 100, observe: () => unknown ? null : ({ held: true, pid: 101 }), terminate: () => {} });
    expect(auth.acquire(true)).toBe(true); unknown = true; expect(auth.held()).toBe(false);
    unknown = false; expect(auth.acquire(true)).toBe(false); expect(auth.held()).toBe(false);
  });
});
