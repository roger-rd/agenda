import 'reflect-metadata';
import { jest } from '@jest/globals';
import { DataSource } from 'typeorm';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseConnectionConfig, DatabaseCredentials } from '../config/database-credentials';
import { databaseOptionsFactory, safeDataSourceFactory } from './database.module';
const config = { database: new DatabaseConnectionConfig('localhost', 5433, 'agenda_test',
  new DatabaseCredentials('agenda_test_app', 'fake-password-for-unit-tests-0001'), 5) } as AppConfigService;
const sink = { warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as PinoLogger;
it('fábrica usa exclusivamente configuración app y conserva opciones Nest', () => {
  expect(databaseOptionsFactory(config, sink)).toMatchObject({ username: 'agenda_test_app', database: 'agenda_test',
    retryAttempts: 3, retryDelay: 1000, verboseRetryLog: false, autoLoadEntities: true });
});
it('sanea errores antes del mecanismo de reintentos sin conectar', async () => {
  const initialize = jest.spyOn(DataSource.prototype, 'initialize').mockRejectedValue(new Error('CANARIO_SECRETO_123'));
  try {
    const options = databaseOptionsFactory(config, sink);
    try {
      await safeDataSourceFactory(options as ConstructorParameters<typeof DataSource>[0]);
      throw new Error('Se esperaba fallo');
    } catch (error) {
      expect((error as Error).message).toBe('No se pudo establecer la conexión con la base de datos.');
      expect((error as Error).stack).toBeUndefined();
      expect((error as Error).cause).toBeUndefined();
    }
    expect(initialize).toHaveBeenCalledTimes(1);
  } finally { initialize.mockRestore(); }
});

it('Nest realiza tres intentos y sus logs no reciben stack ni secretos', async () => {
  const { Logger } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { TypeOrmModule } = await import('@nestjs/typeorm');
  const initialize = jest.spyOn(DataSource.prototype, 'initialize').mockRejectedValue(new Error('CANARIO_SECRETO_123'));
  const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  try {
    await expect(Test.createTestingModule({ imports: [TypeOrmModule.forRootAsync({
      name: 'unit_retry',
      useFactory: () => ({ ...databaseOptionsFactory(config, sink), retryDelay: 1 }),
      dataSourceFactory: safeDataSourceFactory,
    })] }).compile()).rejects.toThrow('No se pudo establecer la conexión con la base de datos.');
    expect(initialize).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(3);
    for (const call of log.mock.calls) {
      expect(call[1]).toBeUndefined();
      expect(JSON.stringify(call)).not.toContain('CANARIO_SECRETO_123');
      expect(JSON.stringify(call)).not.toContain('agenda_test');
    }
  } finally { initialize.mockRestore(); log.mockRestore(); }
});

it.each([
  ['ECONNREFUSED', 'ECONNREFUSED'], ['ETIMEDOUT', 'ETIMEDOUT'], ['ENOTFOUND', 'ENOTFOUND'],
  ['28P01', '28P01'], ['3D000', '3D000'], ['57P03', '57P03'],
  [undefined, undefined], ['sk_live_x', undefined], ['eaddrinuse', undefined],
  ['28p01', undefined], ['28P0', undefined], ['28P011', undefined],
  [' EACCES', undefined], ['EACCES ', undefined], ['', undefined], ['E', undefined], [123, undefined], [null, undefined],
])('conserva solo el código seguro de conexión %#', async (code, expected) => {
  const original = Object.assign(new Error('CANARIO_SECRETO_123', { cause: new Error('CANARIO_SECRETO_123') }),
    { code, stack: 'CANARIO_SECRETO_123' });
  await expectSafeConnectionError(original, expected as string | undefined);
});

it('extrae el primer código válido de AggregateError', async () => {
  await expectSafeConnectionError(new AggregateError([
    null, { code: '28p01' }, { code: 'ECONNREFUSED', message: 'CANARIO_SECRETO_123' }, { code: 'ETIMEDOUT' },
  ], 'CANARIO_SECRETO_123', { cause: new Error('CANARIO_SECRETO_123') }), 'ECONNREFUSED');
});
it('AggregateError sin códigos válidos conserva el mensaje genérico', async () => {
  await expectSafeConnectionError(new AggregateError([null, { code: 'CANARIO_SECRETO_123' }], 'CANARIO_SECRETO_123'), undefined);
});

async function expectSafeConnectionError(original: unknown, code: string | undefined): Promise<void> {
  const { startupErrorMessage } = await import('../startup-error');
  const initialize = jest.spyOn(DataSource.prototype, 'initialize').mockRejectedValue(original);
  try {
    const options = databaseOptionsFactory(config, sink);
    const error: unknown = await safeDataSourceFactory(options as ConstructorParameters<typeof DataSource>[0])
      .then(() => { throw new Error('Se esperaba fallo'); }, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`No se pudo establecer la conexión con la base de datos${code ? ` (${code})` : ''}.`);
    expect((error as Error & { code?: string }).code).toBe(code);
    expect((error as Error).stack).toBeUndefined();
    expect((error as Error).cause).toBeUndefined();
    expect(startupErrorMessage(error)).toBe(`No se pudo iniciar el servidor${code ? ` (${code})` : ''}.`);
    expect(JSON.stringify(error)).not.toContain('CANARIO_SECRETO_123');
    expect(initialize).toHaveBeenCalledTimes(1);
  } finally { initialize.mockRestore(); }
}
