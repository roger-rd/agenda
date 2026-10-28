import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { environments, logLevels, validateEnvironment } from './env.validation';

describe('Configuración', () => {
  it('aplica valores por defecto e ignora claves desconocidas', () => {
    expect(validateEnvironment({ unknown: 'secreto' })).toEqual({ NODE_ENV: 'development', HOST: '127.0.0.1', PORT: 3000, LOG_LEVEL: 'info' });
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
  });
});
