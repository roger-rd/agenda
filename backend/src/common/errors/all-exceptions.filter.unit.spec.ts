import 'reflect-metadata';
import { ArgumentsHost, HttpException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError, UnauthenticatedError } from './domain-error';
import { Uuid7Generator, isUuidV7 } from '../ids/uuid7-generator';

function invoke(error: unknown) {
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  const response = { headersSent: false, setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
  const host = { switchToHttp: () => ({ getRequest: () => ({ headers: {} }), getResponse: () => response }) } as ArgumentsHost;
  new AllExceptionsFilter({ logger } as unknown as PinoLogger, new Uuid7Generator()).catch(error, host);
  return { logger, response, body: response.json.mock.calls[0][0] as { error: { code: string; message: string; requestId: string; field?: string } } };
}

describe('Contrato del filtro sin sockets', () => {
  it.each([
    [new InvalidInputError('Entrada incorrecta.', 'title'), 400, 'invalid_input'],
    [new NotFoundError(), 404, 'not_found'], [new ForbiddenError(), 403, 'forbidden'],
    [new ConflictError(), 409, 'conflict'], [new UnauthenticatedError(), 401, 'unauthenticated'],
  ] as const)('respeta DomainError %s', (error, status, code) => {
    const { response, body } = invoke(error);
    expect(response.status).toHaveBeenCalledWith(status);
    expect(body.error.code).toBe(code);
    expect(body.error.message).toBe(error.message);
    expect(body.error.field).toBe(error.field);
  });
  it.each([
    [400, 'invalid_input'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'],
    [405, 'method_not_allowed'], [409, 'conflict'], [413, 'payload_too_large'], [415, 'unsupported_media_type'],
    [418, 'request_error'], [422, 'invalid_input'], [429, 'rate_limited'], [503, 'service_unavailable'],
  ] as const)('mapea HTTP %i', (status, code) => {
    const { response, body, logger } = invoke(new HttpException('secreto /Users/x', status));
    expect(response.status).toHaveBeenCalledWith(status);
    expect(body.error.code).toBe(code);
    expect(JSON.stringify(body)).not.toMatch(/secreto|Users/);
    expect(isUuidV7(body.error.requestId)).toBe(true);
    expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', body.error.requestId);
    if (status < 500) {
      expect(logger.error).not.toHaveBeenCalled();
      const log = status === 404 ? logger.info : logger.warn;
      expect(log.mock.calls[0][0]).not.toHaveProperty('err');
    }
  });
  it.each([new Error('password=hunter2 /Users/x'), new TypeError('secret'), 'texto', { secret: 'x' }, null, undefined, new HttpException('secret', 502), { status: 403, expose: false }])('protege errores inesperados %p', error => {
    const { response, body, logger } = invoke(error);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(body).toEqual({ error: { code: 'internal_error', message: 'Error interno del servidor.', requestId: expect.any(String) } });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
  it.each([{ status: 400, expose: true }, { statusCode: 413, expose: true }])('acepta middleware expuesto %p', error => {
    const { response } = invoke(error);
    expect(response.status).toHaveBeenCalledWith('status' in error ? error.status : error.statusCode);
  });
});

import { QueryFailedError, TypeORMError, EntityNotFoundError, OptimisticLockVersionMismatchError } from 'typeorm';
import { DatabaseError } from 'pg';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { createLoggerOptions } from '../../logging/logger-options';
import { ConstraintRegistry } from '../../database/errors/constraint-registry';
import { createOperationContext, OperationContext } from '../../database/errors/database-failure';
import { wrapDatabaseError } from '../../database/errors/database-operation-error';
import { ServiceUnavailableError, OutcomeUnknownError } from './domain-error';
function pgFailure(code: string, verb = 'INSERT', constraint?: string) {
  return new QueryFailedError(`${verb} CANARIO_SQL`, ['CANARIO_PARAM'], Object.assign(new DatabaseError('CANARIO_MSG', 1, 'error'),
    { code, severity: 'ERROR', constraint, table: 'internal_child', column: 'internal_title', detail: 'CANARIO_DETAIL' }));
}
const dbCases: [string, () => unknown, number, string][] = [
  ['unique', () => pgFailure('23505'), 409, 'conflict'],
  ['unique registrado', () => pgFailure('23505', 'INSERT', 'uq_title'), 409, 'title_conflict'],
  ['FK insert', () => pgFailure('23503'), 400, 'invalid_input'],
  ['FK delete', () => pgFailure('23503', 'DELETE'), 409, 'conflict'],
  ['FK update', () => pgFailure('23503', 'UPDATE'), 409, 'conflict'],
  ['not_null', () => pgFailure('23502'), 500, 'internal_error'], ['check', () => pgFailure('23514'), 500, 'internal_error'],
  ['data', () => pgFailure('22P02'), 400, 'invalid_input'],
  ...['40001', '40P01', '55P03', '57014', '57P01'].map(code => [code, () => pgFailure(code), 503, 'outcome_unknown'] as [string, () => unknown, number, string]),
  ['pool', () => new Error('timeout exceeded when trying to connect'), 503, 'outcome_unknown'],
  ['system', () => Object.assign(new Error('CANARIO_MSG'), { code: 'ECONNREFUSED' }), 503, 'outcome_unknown'],
  ['permission', () => pgFailure('42501'), 500, 'internal_error'], ['programming', () => pgFailure('42P01'), 500, 'internal_error'],
  ['not_found', () => new EntityNotFoundError('CANARIO_ENTITY', { id: 'CANARIO_ID' }), 404, 'not_found'],
  ['optimistic', () => new OptimisticLockVersionMismatchError('CANARIO_ENTITY', 1, 2), 409, 'conflict'],
  ['ORM where', () => new TypeORMError('CANARIO_WHERE'), 500, 'internal_error'],
];
function exerciseDatabase(error: unknown, method: unknown = 'POST', registry?: ConstraintRegistry) {
  let output = '';
  const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const logger = pino(createLoggerOptions({ logLevel: 'info' }, stream), stream);
  const response = { headersSent: false, setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn(), end: jest.fn() };
  const req = { headers: {}, method, id: 'request-safe' };
  const host = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => response }) } as ArgumentsHost;
  const filter = new AllExceptionsFilter({ logger } as unknown as PinoLogger, new Uuid7Generator(), registry);
  filter.catch(error, host); filter.catch(error, host);
  const records = output.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  expect(records).toHaveLength(1); expect(output).not.toContain('CANARIO_');
  const body = response.json.mock.calls[0][0] as { error: { code: string; message: string; requestId: string; field?: string } };
  expect(Object.keys(body)).toEqual(['error']); expect(Object.keys(body.error).sort()).toEqual((body.error.field ? ['code', 'message', 'requestId', 'field'] : ['code', 'message', 'requestId']).sort());
  expect(JSON.stringify(body)).not.toMatch(/CANARIO_|internal_child|internal_title|uq_title|fk_parent|INSERT|UPDATE|DELETE/);
  return { response, body, record: records[0], output };
}
function registered() {
  const r = new ConstraintRegistry();
  r.register({ kind: 'unique', name: 'uq_title', code: 'title_conflict', field: 'title', message: 'Título duplicado.' });
  r.register({ kind: 'foreign_key', name: 'fk_parent', childTable: 'internal_child', parentTable: 'internal_parent', field: 'parentId', tenantBoundary: true });
  return r;
}
it.each(dbCases.flatMap(row => ['GET', 'POST'].map(method => [...row, method] as const)))('filtro BD %s %s %s %s método %s', (_label, create, status, code, method) => {
  const { response, body, record, output } = exerciseDatabase(create(), method, registered());
  expect(response.status).toHaveBeenCalledWith(status); expect(body.error.code).toBe(status === 503 && method === 'GET' ? 'service_unavailable' : code);
  expect(record).toMatchObject({ requestId: 'request-safe', status, method, category: expect.any(String), outcome: expect.any(String), event: expect.any(String) });
  if (status === 500) { expect(record).toHaveProperty('err.stack', expect.stringContaining('at ')); expect(record.level).toBe(50); }
  else { expect(record).not.toHaveProperty('err'); expect(output).not.toContain('stack'); }
  if (status === 503) {
    expect(response.setHeader).toHaveBeenCalledWith(method === 'GET' ? 'Retry-After' : 'Cache-Control', method === 'GET' ? ['40001', '40P01', '55P03'].includes(_label) ? '1' : _label === '57014' ? '2' : '5' : 'no-store');
    expect(response.setHeader.mock.calls.some(call => call[0] === (method === 'GET' ? 'Cache-Control' : 'Retry-After'))).toBe(false);
  }
});
it.each([
  [{ operation: 'insert' }, 'INSERT', 400, 'reference_violation'],
  [{ operation: 'update', table: 'internal_child' }, 'UPDATE', 400, 'reference_violation'],
  [{ operation: 'delete' }, 'DELETE', 409, 'in_use'],
  [{ operation: 'update', table: 'internal_parent' }, 'UPDATE', 409, 'in_use'],
  [{ operation: 'insert' }, 'DELETE', 409, 'fk_context_mismatch'],
] as const)('FK con contexto %#', (context, verb, status, event) => {
  const e = wrapDatabaseError(pgFailure('23503', verb, 'fk_parent'), createOperationContext(context));
  const { response, record } = exerciseDatabase(e, 'POST', registered());
  expect(response.status).toHaveBeenCalledWith(status); expect(record.event).toBe(event);
  if (event === 'reference_violation') expect(record.tenantBoundary).toBe(true);
});
it.each([undefined, false, true])('envoltorio transitorio atomic %s', atomic => {
  const context = createOperationContext({ operation: 'insert', valuesOrigin: 'request', atomic });
  const { response, body, record } = exerciseDatabase(wrapDatabaseError(pgFailure('40001'), context));
  expect(body.error.code).toBe(atomic ? 'service_unavailable' : 'outcome_unknown');
  expect(record).toMatchObject({ operation: 'insert', valuesOrigin: 'request' });
  expect(response.setHeader).toHaveBeenCalledWith(atomic ? 'Retry-After' : 'Cache-Control', atomic ? '1' : 'no-store');
});
it('registry opcional y método inválido conservador', () => {
  const { body } = exerciseDatabase(pgFailure('23505', 'INSERT', 'uq_title'));
  expect(body.error.code).toBe('conflict');
  for (const method of [undefined, 'get', 'GET\n', 123]) expect(exerciseDatabase(pgFailure('40001'), method).body.error.code).toBe('outcome_unknown');
});
it('nuevos DomainError y validación de Retry-After', () => {
  expect(exerciseDatabase(new ServiceUnavailableError(undefined, 3)).response.setHeader).toHaveBeenCalledWith('Retry-After', '3');
  expect(exerciseDatabase(new OutcomeUnknownError()).response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  for (const value of [0, 61, 1.5, NaN]) expect(() => new ServiceUnavailableError(undefined, value)).toThrow('Intervalo de reintento inválido.');
});
it('valoresOrigin request transforma gap en 400 sin traza', () => {
  for (const operation of ['insert', 'update'] as OperationContext['operation'][]) {
    const { body, record } = exerciseDatabase(wrapDatabaseError(pgFailure('23502'), createOperationContext({ operation, valuesOrigin: 'request' })));
    expect(body.error.code).toBe('invalid_input'); expect(record).not.toHaveProperty('err');
  }
});

describe('Propiedades HTTP heredadas sin ejecutar accesores', () => {
  it.each([[413, 'payload_too_large'], [400, 'invalid_input']] as const)('acepta datos del prototipo para %i', (status, code) => {
    const prototype = Object.assign(Object.create(Error.prototype) as object, { expose: true, status, statusCode: status });
    const error: unknown = Object.create(prototype);
    const result = invoke(error);
    expect(result.response.status).toHaveBeenCalledWith(status);
    expect(result.body.error.code).toBe(code);
  });
  it('acepta statusCode heredado cuando status está ausente', () => {
    const result = invoke(Object.create({ expose: true, statusCode: 413 }));
    expect(result.response.status).toHaveBeenCalledWith(413);
    expect(result.body.error.code).toBe('payload_too_large');
  });
  it.each(['expose', 'status', 'statusCode'])('rechaza accesor propio o heredado de %s sin invocarlo', key => {
    for (const inherited of [false, true]) {
      const get = jest.fn(() => { throw new Error('CANARIO_ACCESSOR'); });
      const base = key === 'expose' ? { expose: true, status: 413 } : { expose: true, [key]: 413 };
      const holder = Object.defineProperty(Object.create(base) as object, key, { get });
      const error: unknown = inherited ? Object.create(holder) : holder;
      const result = invoke(error);
      expect(result.response.status).toHaveBeenCalledWith(500);
      expect(result.body.error.code).toBe('internal_error');
      expect(get).not.toHaveBeenCalled();
    }
  });
  it('rechaza Proxy propio y en el prototipo sin lanzar ni ejecutar trampas', () => {
    const trap = jest.fn(() => { throw new Error('CANARIO_PROXY'); });
    const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    for (const error of [proxy, Object.create(proxy) as unknown]) {
      const result = invoke(error);
      expect(result.response.status).toHaveBeenCalledWith(500);
      expect(result.body.error.code).toBe('internal_error');
    }
    expect(trap).not.toHaveBeenCalled();
  });
});
