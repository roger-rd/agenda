import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseError } from 'pg';
import { QueryFailedError, TypeORMError, EntityNotFoundError, OptimisticLockVersionMismatchError, CannotExecuteNotConnectedError, ConnectionIsNotSetError } from 'typeorm';
import { classifyDatabaseError, createOperationContext, isOperationContext, OperationContext } from './database-failure';
import { CONNECTION_CODES, CONNECTION_MESSAGES } from './sqlstate';
const cases = [
  ['23505', 'unique_violation', 'not_applied'], ['23503', 'foreign_key', 'not_applied'], ['23502', 'not_null', 'not_applied'], ['23514', 'check_violation', 'not_applied'], ['23P01', 'exclusion_violation', 'not_applied'], ['23000', 'integrity_other', 'not_applied'],
  ...['22P02', '22001', '22003'].map(c => [c, 'data_exception', 'not_applied']),
  ...['40001', '40P01'].map(c => [c, 'transaction_conflict', 'not_applied']),
  ['40003', 'connection', 'unknown'], ['55P03', 'lock_timeout', 'not_applied'], ['57014', 'statement_timeout', 'not_applied'],
  ...['57P01', '57P02', '08006', '08003'].map(c => [c, 'connection', 'unknown']),
  ...['57P03', '08001', '08004'].map(c => [c, 'connection', 'not_started']),
  ['53300', 'resource', 'not_started'], ['53100', 'resource', 'not_applied'], ['53200', 'resource', 'not_applied'],
  ['42501', 'permission_misconfig', 'not_applied'], ...['42703', '42P01', '25000', '25P02'].map(c => [c, 'programming', 'not_applied']),
  ...['0A000', 'XX000', 'XX001', 'P0001', '58000'].map(c => [c, 'internal', 'unknown']), ['99999', 'unknown', 'unknown'],
];
it.each(cases)('SQLSTATE %s → %s / %s', (code, category, outcome) => {
  const driver = Object.assign(new DatabaseError('CANARIO_MSG', 1, 'error'), { code, severity: 'ERROR', constraint: 'p_email_key', table: 'p', column: 'n', routine: '_bt_check_unique', detail: 'CANARIO_DETAIL' });
  for (const e of [driver, new QueryFailedError('INSERT CANARIO_SQL', ['CANARIO_PARAM'], driver)]) {
    const result = classifyDatabaseError(e);
    expect(result).toMatchObject({ category, outcome, retryable: code === '40001' || code === '40P01', sqlState: code });
    expect(JSON.stringify(result)).not.toContain('CANARIO_');
    for (const key of ['message', 'detail', 'query', 'parameters', 'routine']) expect(result).not.toHaveProperty(key);
  }
});
it.each(['p_email_key', 'p_pkey', 'p_edad_check', 'c_pid_fk'])('conserva restricción real %s', constraint => {
  expect(classifyDatabaseError(new QueryFailedError('INSERT CANARIO_SQL', [], Object.assign(new DatabaseError('CANARIO_MSG', 1, 'error'), { code: '23505', constraint })))).toHaveProperty('constraint', constraint);
});
it.each(['INSERT', 'UPDATE', 'DELETE'])('FK real %s mantiene siempre tabla hija', verb => {
  const driver = Object.assign(new DatabaseError('CANARIO_MSG', 1, 'error'), { code: '23503', table: 'c', constraint: 'c_pid_fk', routine: 'ri_ReportViolation' });
  expect(classifyDatabaseError(new QueryFailedError(`${verb} CANARIO_SQL`, [], driver))).toMatchObject({ category: 'foreign_key', table: 'c', verb });
});
it.each(Object.entries(CONNECTION_MESSAGES))('mensaje exacto %s', (message, outcome) => {
  expect(classifyDatabaseError(new Error(message))).toMatchObject({ category: 'connection', outcome, retryable: false });
  expect(classifyDatabaseError(new Error(message + '.'))).toBeUndefined();
});
it.each(Object.entries(CONNECTION_CODES))('código de sistema %s', (code, outcome) => expect(classifyDatabaseError(Object.assign(new Error('CANARIO_MSG'), { code }))).toMatchObject({ category: 'connection', outcome }));
it('ancla de las siete cadenas en pg/pg-pool instalados', () => {
  const lib = dirname(require.resolve('pg'));
  const source = readdirSync(lib).filter(f => f.endsWith('.js')).map(f => readFileSync(join(lib, f), 'utf8')).join('\n') + readFileSync(require.resolve('pg-pool'), 'utf8');
  for (const message of Object.keys(CONNECTION_MESSAGES)) expect(source).toContain(message);
});
it.each([
  [new EntityNotFoundError('CANARIO_ENTITY', { id: 'CANARIO_ID' }), 'not_found', 'not_applied'],
  [new OptimisticLockVersionMismatchError('CANARIO_ENTITY', 1, 2), 'optimistic_lock', 'not_applied'],
  [new CannotExecuteNotConnectedError(), 'connection', 'not_started'],
  [new ConnectionIsNotSetError('CANARIO_DRIVER'), 'connection', 'not_started'],
  [new TypeORMError('CANARIO_WHERE'), 'programming', 'unknown'],
])('familia ORM %#', (e, category, outcome) => {
  expect(classifyDatabaseError(e)).toMatchObject({ category, outcome, retryable: false });
  expect(JSON.stringify(classifyDatabaseError(e))).not.toContain('CANARIO_');
});
it('AggregateError inspecciona solo cinco elementos y el primer código reconocido', () => {
  expect(classifyDatabaseError(new AggregateError([{}, { code: 'ECONNRESET' }, { code: 'ECONNREFUSED' }]))).toHaveProperty('outcome', 'unknown');
  expect(classifyDatabaseError(new AggregateError([...Array(5).fill({}), { code: 'ECONNREFUSED' }]))).toBeUndefined();
});
it('accesores, proxies, ciclos y datos hostiles no ejecutan código', () => {
  const get = jest.fn(() => { throw new Error('CANARIO_GET'); });
  const proxy = new Proxy({}, { get, getPrototypeOf: get, getOwnPropertyDescriptor: get });
  const e = new QueryFailedError('INSERT CANARIO_SQL', [], new Error());
  Object.defineProperty(e, 'driverError', { get, configurable: true });
  expect(() => classifyDatabaseError(e)).not.toThrow();
  expect(classifyDatabaseError(e)).toHaveProperty('category', 'unknown');
  Object.defineProperty(e, 'driverError', { value: proxy });
  expect(classifyDatabaseError(e)).toHaveProperty('category', 'unknown');
  expect(classifyDatabaseError(proxy)).toBeUndefined();
  expect(classifyDatabaseError(Object.create(proxy))).toBeUndefined();
  const cycle: { driverError?: unknown } = {}; cycle.driverError = cycle;
  expect(classifyDatabaseError(cycle)).toHaveProperty('category', 'unknown');
  expect(classifyDatabaseError(Object.assign(new Error(), { code: { toString: get } }))).toBeUndefined();
  expect(get).not.toHaveBeenCalled();
});
it.each([null, undefined, 'CANARIO_MSG', {}, new Error('CANARIO_MSG')])('no reconoce error ajeno %#', e => expect(classifyDatabaseError(e)).toBeUndefined());
it('la forma BD sin SQLSTATE nunca usa coincidencia de mensaje de conexión', () => {
  expect(classifyDatabaseError({ query: '', parameters: [], message: 'Connection terminated' })).toHaveProperty('category', 'unknown');
});
it('contexto congelado y autenticado por identidad', () => {
  const input = { operation: 'insert', table: 't', valuesOrigin: 'request', atomic: true } as const;
  const context = createOperationContext(input);
  expect(Object.isFrozen(context)).toBe(true); expect(isOperationContext(context)).toBe(true);
  expect(isOperationContext(input)).toBe(false); expect(isOperationContext(JSON.parse(JSON.stringify(context)))).toBe(false);
});
it.each([{ operation: 'CANARIO_OP' }, { operation: 'insert', table: 'CANARIO_TABLE' }, { operation: 'insert', table: 't\n' }, { operation: 'insert', valuesOrigin: 'CANARIO_ORIGIN' }, { operation: 'insert', atomic: 'CANARIO_ATOMIC' }, null])('contexto inválido %#', input => {
  expect(() => createOperationContext(input as OperationContext)).toThrow('Contexto de operación inválido.');
});
