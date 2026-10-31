import { inspect } from 'node:util';
import { CATALOG, HarnessError } from '../../scripts/harness/harness-error.cjs';
import { THIRD_PARTY_SECRET } from './support/synthetic-secrets';

describe('HarnessError (UN-D17, UN-D8)', () => {
  it.each(Object.keys(CATALOG))('catálogo fijo %s (datos, no comportamiento B2)', code => {
    const error = new HarnessError(code, { key: 'DATABASE_HOST' });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('HarnessError');
    expect(error.message).toBe(CATALOG[code as keyof typeof CATALOG]);
    expect(error.toJSON()).toEqual({ code, fields: { key: 'DATABASE_HOST' } });
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.isFrozen(error.fields)).toBe(true);
    expect(Object.hasOwn(error, 'cause')).toBe(false);
  });
  it('no retiene el error externo al traducir por código', () => {
    const original = Object.assign(new Error(THIRD_PARTY_SECRET, { cause: new Error(THIRD_PARTY_SECRET) }), {
      driverError: { password: THIRD_PARTY_SECRET }, stack: THIRD_PARTY_SECRET,
    });
    expect(original.message).toBe(THIRD_PARTY_SECRET);
    const error = HarnessError.translate('H-ENV-READ');
    for (const value of [error.message, error.stack, JSON.stringify(error), inspect(error), String(error),
      JSON.stringify(Object.getOwnPropertyNames(error))]) expect(value).not.toContain(THIRD_PARTY_SECRET);
    expect(Object.getOwnPropertyNames(error).sort()).toEqual(['code', 'fields', 'message', 'name', 'stack']);
    expect('cause' in error).toBe(false);
    expect('driverError' in error).toBe(false);
  });
  it('acepta exclusivamente campos de diagnóstico tipados', () => {
    const fields = { host: 'localhost', port: 5433, database: 'synthetic_test', role: 'app', schema: 'public',
      phase: 'env', sqlstate: '08000', count: 1, durationMs: 0, mode: '600', file: 'app',
      key: 'DATABASE_HOST', line: 1, bytes: 8192 };
    expect(new HarnessError('H-ENV-READ', fields).fields).toEqual(fields);
    expect(Object.isFrozen(CATALOG)).toBe(true);
    expect(HarnessError.translate('H-ARGS')).not.toBe(HarnessError.translate('H-ARGS'));
  });
  it.each([{ password: THIRD_PARTY_SECRET }, { cause: THIRD_PARTY_SECRET }, { driverError: THIRD_PARTY_SECRET },
    { host: 'with space' }, { host: '\n' }, { host: 'ñ' }, { host: 'x'.repeat(129) }, { host: '' },
    { port: '5433' }, { count: 1.5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 }, { durationMs: -1 },
    { line: NaN }, { mode: 600 }, { [Symbol('unsafe')]: THIRD_PARTY_SECRET }])('rechaza campos inválidos sin eco %#', fields => {
    try { new HarnessError('H-ARGS', fields); throw new Error('No rechazado'); }
    catch (error) { expect(error).toBeInstanceOf(TypeError); expect(inspect(error)).not.toContain(THIRD_PARTY_SECRET); }
  });
  it('rechaza código desconocido y getters sin evaluarlos', () => {
    expect(() => new HarnessError(THIRD_PARTY_SECRET)).toThrow(TypeError);
    const get = jest.fn(() => THIRD_PARTY_SECRET);
    expect(() => new HarnessError('H-ARGS', Object.defineProperty({}, 'host', { get }))).toThrow(TypeError);
    expect(get).not.toHaveBeenCalled();
  });
});
