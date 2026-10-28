import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { appConfigOptions } from './app.config';
import { DatabaseConnectionConfig } from './database-credentials';

const exists = jest.fn(() => true);
const read = jest.fn(() => Buffer.from('contenido ficticio'));
jest.unstable_mockModule('fs', () => ({ default: { existsSync: exists, readFileSync: read }, existsSync: exists, readFileSync: read }));

const password = 'fake-password-for-unit-tests-0001';
describe('Carga de .env', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => { process.env = {}; jest.clearAllMocks(); });
  afterEach(() => { process.env = { ...originalEnv }; });
  it.each(['development', 'production', undefined])('permite .env en %s', env => {
    expect(appConfigOptions(env).ignoreEnvFile).toBe(false);
  });
  it('test no consulta el archivo de entorno', async () => {
    process.env = { NODE_ENV: 'test', DATABASE_NAME: 'agenda_test', DATABASE_USER: 'agenda_test_app', DATABASE_PASSWORD: password };
    const parser = jest.fn(() => { throw new Error('No debe leer archivos en test'); });
    const { ConfigModule } = await import('@nestjs/config');
    await ConfigModule.forRoot({ ...appConfigOptions('test'), envFilePath: 'x', parser });
    expect(parser).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });
  it('ConfigModule real conserva DATABASE validado sin copiar la contraseña al proceso', async () => {
    const { ConfigModule, ConfigService } = await import('@nestjs/config');
    const { AppConfigService } = await import('./app-config.service');
    const parser = jest.fn(() => ({ NODE_ENV: 'development', DATABASE_NAME: 'agenda_dev',
      DATABASE_USER: 'agenda_dev_app', DATABASE_PASSWORD: password }));
    const configModule = await ConfigModule.forRoot({ ...appConfigOptions('development'), envFilePath: 'x', parser });
    expect(read).toHaveBeenCalledWith('x');
    const module = await Test.createTestingModule({ imports: [configModule], providers: [AppConfigService] }).compile();
    try {
      expect(parser).toHaveBeenCalledTimes(1);
      expect(process.env.DATABASE_PASSWORD).toBeUndefined();
      expect(process.env.DATABASE).toBeUndefined();
      const config = module.get(ConfigService);
      const database = config.get<DatabaseConnectionConfig>('DATABASE');
      expect(database).toBeInstanceOf(DatabaseConnectionConfig);
      expect(JSON.stringify(database)).not.toContain(password);
      process.env.DATABASE_PASSWORD = password;
      expect(config.get('DATABASE_PASSWORD')).toBeUndefined();
      expect(module.get(AppConfigService).database).toBe(database);
      expect(database?.credentials.revealPassword() === password).toBe(true);
    } finally { await module.close(); }
  });
});
