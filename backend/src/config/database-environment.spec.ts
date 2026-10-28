import 'reflect-metadata';
import { validateDatabaseEnvironment, DatabaseRole } from './database-environment';
import { Environment, EnvironmentValidationError } from './env.validation';

const fake = { DATABASE_NAME: 'agenda_test', DATABASE_USER: 'agenda_test_app', DATABASE_PASSWORD: 'fake-password-for-unit-tests-0001' };
const validate = (input: Record<string, unknown>) => validateDatabaseEnvironment(input, { nodeEnv: 'test', role: 'app' });

describe('Validación de BD', () => {
  it.each(['development', 'test', 'production'] as Environment[])('acepta ambos roles en %s', nodeEnv => {
    for (const role of ['app', 'owner'] as DatabaseRole[]) {
      const suffix = nodeEnv === 'development' ? 'dev' : nodeEnv === 'test' ? 'test' : 'live';
      const config = validateDatabaseEnvironment({ ...fake, DATABASE_NAME: `agenda_${suffix}`,
        DATABASE_USER: `agenda_${suffix}_${role}` }, { nodeEnv, role });
      expect(config.poolMax).toBe(nodeEnv === 'test' ? 5 : 10);
      expect(config.port).toBe(5433);
      expect(config.host).toBe('127.0.0.1');
    }
  });
  it('agrega las obligatorias ausentes', () => {
    expect(() => validate({})).toThrow(EnvironmentValidationError);
    try { validate({}); } catch (error) {
      for (const key of ['DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD']) expect((error as Error).message).toContain(key);
    }
  });
  const invalid: [string, unknown][] = [
    ...['', 'a b', 'http://host', '999.999.999.999', '-host', 'a..b', ' localhost'].map(value => ['DATABASE_HOST', value] as [string, unknown]),
    ...['', 'abc', '3.5', '0', '-1', '65536', '0x50', ' 80 ', '80\n', '3000abc', 1.5, null].map(value => ['DATABASE_PORT', value] as [string, unknown]),
    ...['', '0', '21', '3.5', '1e1', ' 5 ', '5\n', null].map(value => ['DATABASE_POOL_MAX', value] as [string, unknown]),
    ...['DATABASE_NAME', 'DATABASE_USER'].flatMap(key => ['', 'Upper_test', '0_test', 'agenda_test\n', 'agenda_test_app\n', 'a-b_test', 'a'.repeat(64), null].map(value => [key, value] as [string, unknown])),
    ...['short', 'a'.repeat(129), 'a'.repeat(16) + ' ', 'a'.repeat(16) + '\n', 'a'.repeat(16) + '\u0000', 'a'.repeat(16) + '\u007f', null].map(value => ['DATABASE_PASSWORD', value] as [string, unknown]),
  ];
  it.each(invalid.map(([key, value], i) => ({ key, value, i })))('rechaza formato $key caso $i', ({ key, value }) => {
    expect(() => validate({ ...fake, [key]: value })).toThrow(`${key}:`);
  });
  it.each(['1', '65535'])('acepta límite de puerto %s', DATABASE_PORT => expect(validate({ ...fake, DATABASE_PORT }).port).toBe(Number(DATABASE_PORT)));
  it.each(['1', '20'])('acepta límite de pool %s', DATABASE_POOL_MAX => expect(validate({ ...fake, DATABASE_POOL_MAX }).poolMax).toBe(Number(DATABASE_POOL_MAX)));
  it.each([16, 128])('acepta longitud de contraseña %s', length => expect(validate({ ...fake, DATABASE_PASSWORD: 'a'.repeat(length) })).toBeDefined());
  it.each(['localhost', '::1', '127.0.0.1'])('acepta loopback %s', DATABASE_HOST => expect(validate({ ...fake, DATABASE_HOST }).host).toBe(DATABASE_HOST));
  it.each([
    ['development', 'app', 'DATABASE_NAME', 'agenda_test'], ['test', 'app', 'DATABASE_NAME', 'agenda_dev'],
    ['development', 'app', 'DATABASE_USER', 'agenda_test_app'], ['test', 'app', 'DATABASE_USER', 'agenda_dev_app'],
    ['production', 'app', 'DATABASE_NAME', 'agenda_dev'], ['production', 'app', 'DATABASE_NAME', 'agenda_test'],
    ['production', 'app', 'DATABASE_USER', 'agenda_dev_app'], ['production', 'app', 'DATABASE_USER', 'agenda_test_app'],
    ['test', 'app', 'DATABASE_USER', 'agenda_test_owner'], ['test', 'owner', 'DATABASE_USER', 'agenda_test_app'],
    ['test', 'app', 'DATABASE_HOST', 'db.example.com'], ['development', 'app', 'DATABASE_HOST', '192.168.1.1'],
  ] as [Environment, DatabaseRole, string, string][])('aísla %s/%s por %s', (nodeEnv, role, key, value) => {
    const suffix = nodeEnv === 'development' ? 'dev' : nodeEnv === 'test' ? 'test' : 'live';
    expect(() => validateDatabaseEnvironment({ ...fake, DATABASE_NAME: `agenda_${suffix}`,
      DATABASE_USER: `agenda_${suffix}_${role}`, [key]: value }, { nodeEnv, role })).toThrow(`${key}:`);
  });
  it('permite host remoto en producción', () => {
    expect(validateDatabaseEnvironment({ ...fake, DATABASE_NAME: 'agenda', DATABASE_USER: 'agenda_app',
      DATABASE_HOST: 'db.example.com' }, { nodeEnv: 'production', role: 'app' }).host).toBe('db.example.com');
  });
  it('agrega errores sin reflejar ningún valor recibido', () => {
    const keys = ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_POOL_MAX'];
    const input = Object.fromEntries(keys.map((key, i) => [key, `CANARIO_SECRETO_123_${i} `]));
    let message = '';
    try { validate(input); } catch (error) { message = (error as Error).message; }
    for (const key of keys) expect(message).toContain(`${key}:`);
    expect(message).not.toContain('CANARIO_SECRETO_123');
  });
  it('ignora desconocidas', () => expect(validate({ ...fake, unknown: 'CANARIO_SECRETO_123' })).toEqual(validate(fake)));
});
