import { SafeTypeOrmLogger } from './safe-typeorm-logger';
const canary = 'CANARIO_SECRETO_123';
const sink = { warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const logger = new SafeTypeOrmLogger(sink);
beforeEach(() => jest.clearAllMocks());
it.each(['23505', '23503', '08006'])('filtra errores %s y selecciona nivel', code => {
  logger.logQueryError({ query: `INSERT ${canary}`, parameters: [canary], message: canary, stack: canary,
    driverError: { code, constraint: 'unique_name', table: 'content', detail: canary } }, `INSERT ${canary}`, [canary]);
  const method = code.startsWith('23') ? sink.warn : sink.error;
  expect(method).toHaveBeenCalledWith({ context: 'TypeORM', event: 'query_error', code, constraint: 'unique_name', table: 'content', verb: 'INSERT' }, 'Error de consulta de base de datos.');
  expect(JSON.stringify([sink.warn.mock.calls, sink.error.mock.calls])).not.toContain(canary);
});
it('admite el error directo de pg', () => {
  logger.logQueryError({ code: '23505' }, 'select contenido');
  expect(sink.warn.mock.calls[0][0].code).toBe('23505');
});
it.each([null, undefined, 42, canary, { driverError: { code: '23505\n', table: 'bad-name', constraint: canary } },
  new Proxy({}, { get() { throw new Error(canary); } })])('tolera entradas raras y descarta campos inválidos %#', error => {
  expect(() => logger.logQueryError(error, null)).not.toThrow();
  expect(sink.error.mock.calls[0][0]).toEqual({ context: 'TypeORM', event: 'query_error', verb: 'OTHER' });
});
it('solo registra duración y verbo en consultas lentas e ignora consultas normales', () => {
  logger.logQuerySlow(1500, ` UPDATE ${canary}`, [canary]);
  expect(sink.warn.mock.calls[0][0]).toEqual({ context: 'TypeORM', durationMs: 1500, verb: 'UPDATE' });
  logger.logQuery(canary, [canary]);
  expect(sink.warn).toHaveBeenCalledTimes(1);
  expect(sink.error).not.toHaveBeenCalled();
  expect(sink.debug).not.toHaveBeenCalled();
});
it.each(['log', 'schema', 'migration'])('debug %s trunca strings y solo describe tipos', method => {
  const emit = (value: unknown) => method === 'log' ? logger.log('warn', value) : method === 'schema' ? logger.logSchemaBuild(value) : logger.logMigration(value);
  emit('x'.repeat(200) + canary);
  expect(sink.debug.mock.calls[0][0]).toEqual({ context: 'TypeORM', message: 'x'.repeat(200) + '…' });
  for (const value of [{ secret: canary }, null, undefined, 42]) emit(value);
  expect(sink.debug.mock.calls.slice(1).map(call => call[0])).toEqual(['object', 'object', 'undefined', 'number'].map(type => ({ context: 'TypeORM', type })));
  expect(JSON.stringify(sink.debug.mock.calls)).not.toContain(canary);
});

import { registerSecret, resetSecretsForTests } from '../logging/secret-registry';
it('depura secretos y patrones antes del truncado', () => {
  const password = 'fake-password-for-unit-tests-0001';
  const release = registerSecret(password);
  try {
    logger.logMigration(`${password} token=CANARIO_TOKEN`);
    expect(sink.debug.mock.calls[0][0].message).toBe('[REDACTED] token=[REDACTED]');
  } finally { release(); resetSecretsForTests(); }
});
