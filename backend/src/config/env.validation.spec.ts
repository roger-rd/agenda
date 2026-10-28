import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { environments, logLevels, validateEnvironment as validate } from './env.validation';

function validateEnvironment(input: Record<string, unknown>) {
  const env = input.NODE_ENV ?? 'development';
  const suffix = env === 'production' ? 'live' : env === 'test' ? 'test' : 'dev';
  return validate({ DATABASE_NAME: `agenda_${suffix}`, DATABASE_USER: `agenda_${suffix}_app`,
    DATABASE_PASSWORD: 'fake-password-for-unit-tests-0001', ...input });
}

describe('Configuración', () => {
  it('aplica valores por defecto e ignora claves desconocidas', () => {
    expect(validateEnvironment({ unknown: 'secreto' })).toMatchObject({ NODE_ENV: 'development', HOST: '127.0.0.1', PORT: 3000, LOG_LEVEL: 'info' });
  });
  it.each(environments)('acepta entorno %s y selecciona nivel', NODE_ENV => {
    expect(validateEnvironment({ NODE_ENV }).LOG_LEVEL).toBe(NODE_ENV === 'test' ? 'silent' : 'info');
  });
  it.each(logLevels)('acepta nivel %s', LOG_LEVEL => expect(validateEnvironment({ LOG_LEVEL }).LOG_LEVEL).toBe(LOG_LEVEL));
  it.each(['1', '80', '3000', '65535'])('acepta puerto %s', PORT => expect(validateEnvironment({ PORT }).PORT).toBe(Number(PORT)));
  it.each(['', 'abc', '3000abc', '3.5', '0', '-1', '70000', '0x50', ' 80 '])('rechaza puerto %p', PORT => expect(() => validateEnvironment({ PORT })).toThrow('PORT: debe ser un entero entre 1 y 65535'));
  it.each(['localhost', 'example.com', 'a-b.test', '127.0.0.1', '::1'])('acepta host %s', HOST => expect(validateEnvironment({ HOST }).HOST).toBe(HOST));
  it.each(['', 'a b', ' localhost', 'http://host', 'x/path', 'x;cmd', '999.999.999.999', '-host', 'a..b'])('rechaza host %p', HOST => expect(() => validateEnvironment({ HOST })).toThrow('HOST:'));
  it('lista todas las reglas sin valores recibidos', () => {
    try { validateEnvironment({ NODE_ENV: 'staging', PORT: 'sk_live_SECRET123', LOG_LEVEL: 'bad', HOST: '' }); }
    catch (error) {
      const message = (error as Error).message;
      for (const key of ['NODE_ENV', 'HOST', 'PORT', 'LOG_LEVEL']) expect(message).toContain(`${key}:`);
      for (const value of ['staging', 'sk_live_SECRET123', 'bad']) expect(message).not.toContain(value);
      return;
    }
    throw new Error('Se esperaba error');
  });
  it('ofrece valores tipados', () => {
    const service = new AppConfigService(new ConfigService(validateEnvironment({ NODE_ENV: 'production', PORT: '4000' })));
    expect(service.env).toBe('production');
    expect(service.host).toBe('127.0.0.1');
    expect(service.port).toBe(4000);
    expect(service.logLevel).toBe('info');
    expect(service.isProduction).toBe(true);
    expect(service.isTest).toBe(false);
    expect(service.database.credentials.toJSON().password).toBe('[REDACTED]');
    expect(Object.values(service).join()).not.toContain('fake-password');
  });
});

describe('Integración de BD', () => {
  it('rechaza credenciales de migración y agrega errores escalares y de BD', () => {
    let message = '';
    try { validate({ NODE_ENV: 'CANARIO_SECRETO_123', PORT: 'CANARIO_SECRETO_123',
      DATABASE_PASSWORD: 'CANARIO_SECRETO_123 ', DATABASE_MIGRATION_USER: 'CANARIO_SECRETO_123',
      DATABASE_MIGRATION_PASSWORD: 'CANARIO_SECRETO_123' }); }
    catch (error) { message = (error as Error).message; }
    for (const key of ['NODE_ENV', 'PORT', 'DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD',
      'DATABASE_MIGRATION_USER', 'DATABASE_MIGRATION_PASSWORD']) expect(message).toContain(key);
    expect(message).not.toContain('CANARIO_SECRETO_123');
  });
  it('solo devuelve las cuatro variables escalares y DATABASE', () => {
    expect(Object.keys(validateEnvironment({ NODE_ENV: 'test' })).sort())
      .toEqual(['DATABASE', 'HOST', 'LOG_LEVEL', 'NODE_ENV', 'PORT']);
  });
});
