import { createHash } from 'node:crypto';
import { BUDGET, COMMANDS, deriveLockKey, ERROR_CODES, EXIT, LOCK_KEY, LOCK_SEED, LOCK_TAG, LOOPBACK_HOSTS, SchemaRunnerError, SUMMARY_PREFIX, TARGET, asServerSeconds } from './schema-target';

describe('objetivo fijo del runner de esquema', () => {
  it('es un único objetivo congelado: la base de pruebas local', () => {
    expect(TARGET).toEqual({ env: 'test', database: 'agenda_test', port: 5433, owner: 'agenda_test_owner', app: 'agenda_test_app', schema: 'public', major: 16 });
    expect(Object.isFrozen(TARGET)).toBe(true);
    expect([...LOOPBACK_HOSTS]).toEqual(['127.0.0.1', '::1', 'localhost']);
    expect([...COMMANDS]).toEqual(['plan', 'apply', 'revert']);
    expect(EXIT).toEqual({ ok: 0, refused: 2, unconfirmed: 3 });
    expect(SUMMARY_PREFIX).toBe('AGENDA_SCHEMA_RUNNER ');
  });

  it('la clave del bloqueo es la derivación fijada, con etiqueta 4 y dentro de int64', () => {
    expect(deriveLockKey()).toBe(LOCK_KEY);
    expect(LOCK_KEY).toBe('4620462443122130743');
    expect(LOCK_SEED).toBe('agenda-cm/schema-runner/v1');
    const key = BigInt(LOCK_KEY);
    expect(key >= -(2n ** 63n) && key < 2n ** 63n).toBe(true);
    expect(BigInt.asUintN(64, key) >> 60n).toBe(LOCK_TAG);
    expect(LOCK_TAG).toBe(4n);
    const raw = createHash('sha256').update(LOCK_SEED).digest().readBigUInt64BE(0) & 0x0fff_ffff_ffff_ffffn;
    expect(BigInt(LOCK_KEY) & 0x0fff_ffff_ffff_ffffn).toBe(raw);
    expect(deriveLockKey('otra-semilla')).not.toBe(LOCK_KEY);
  });

  it('los presupuestos son coherentes entre sí', () => {
    expect(BUDGET.statementMs).toBeLessThan(BUDGET.executionMs);
    expect(BUDGET.executionMs + BUDGET.closeMs).toBeLessThan(BUDGET.hardExitMs);
    expect(BUDGET.lockMs).toBeLessThanOrEqual(BUDGET.statementMs);
    expect(asServerSeconds(BUDGET.statementMs)).toBe('15s');
    expect(asServerSeconds(BUDGET.lockMs)).toBe('5s');
    expect(asServerSeconds(BUDGET.idleInTransactionMs)).toBe('30s');
  });

  it('el error solo lleva un código cerrado', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    const error = new SchemaRunnerError('options_unsafe');
    expect(error.message).toBe('options_unsafe');
    expect(error.code).toBe('options_unsafe');
    expect(Object.keys(error).sort()).toEqual(['code', 'name']);
    expect(error.stack ?? '').not.toMatch(/password|secret/i);
  });
});
