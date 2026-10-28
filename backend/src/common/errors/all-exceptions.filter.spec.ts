import { QueryFailedError, TypeORMError, EntityNotFoundError, OptimisticLockVersionMismatchError } from 'typeorm';
import { DatabaseError } from 'pg';
import { ConstraintRegistry } from '../../database/errors/constraint-registry';
import { createOperationContext } from '../../database/errors/database-failure';
import { wrapDatabaseError } from '../../database/errors/database-operation-error';
const databaseRegistry = new ConstraintRegistry();
databaseRegistry.register({ kind: 'unique', name: 'uq_title', code: 'title_conflict', field: 'title', message: 'Título duplicado.' });
databaseRegistry.register({ kind: 'foreign_key', name: 'fk_parent', childTable: 'internal_child', parentTable: 'internal_parent', field: 'parentId' });
const databaseRoutes: [string, number, string][] = [
  ['23505', 409, 'conflict'], ['unique', 409, 'title_conflict'], ['23503', 400, 'invalid_input'],
  ['fk_child_insert', 400, 'invalid_input'], ['fk_child_update', 400, 'invalid_input'], ['fk_parent_delete', 409, 'conflict'], ['fk_parent_update', 409, 'conflict'],
  ['fk_update', 409, 'conflict'], ['fk_delete', 409, 'conflict'], ['23502', 500, 'internal_error'], ['23514', 500, 'internal_error'], ['22P02', 400, 'invalid_input'],
  ...['40001', '40P01', '55P03', '57014', '57P01', 'pool', 'system', 'wrapped', 'atomic'].map(k => [k, 503, 'outcome_unknown'] as [string, number, string]),
  ['42501', 500, 'internal_error'], ['42P01', 500, 'internal_error'], ['missing', 404, 'not_found'], ['optimistic', 409, 'conflict'], ['orm', 500, 'internal_error'],
];
function routeDatabaseError(kind: string): unknown {
  if (kind === 'pool') return new Error('timeout exceeded when trying to connect');
  if (kind === 'system') return Object.assign(new Error('CANARIO_MSG'), { code: 'ECONNREFUSED' });
  if (kind === 'missing') return new EntityNotFoundError('CANARIO_ENTITY', { id: 'CANARIO_ID' });
  if (kind === 'optimistic') return new OptimisticLockVersionMismatchError('CANARIO_ENTITY', 1, 2);
  if (kind === 'orm') return new TypeORMError('CANARIO_WHERE');
  const fk = kind.startsWith('fk_');
  const code = kind === 'unique' ? '23505' : fk ? '23503' : ['wrapped', 'atomic'].includes(kind) ? '40001' : kind;
  const operation = kind.endsWith('update') ? 'update' : kind.endsWith('delete') ? 'delete' : 'insert';
  const error = new QueryFailedError(`${operation.toUpperCase()} CANARIO_SQL`, ['CANARIO_PARAM'], Object.assign(new DatabaseError('CANARIO_MSG', 1, 'error'),
    { code, severity: 'ERROR', constraint: kind === 'unique' ? 'uq_title' : fk ? 'fk_parent' : undefined, table: 'internal_child', column: 'internal_title' }));
  if (kind === 'wrapped' || kind === 'atomic') return wrapDatabaseError(error, createOperationContext({ operation, atomic: kind === 'atomic' }));
  if (kind.startsWith('fk_child_') || kind.startsWith('fk_parent_')) return wrapDatabaseError(error, createOperationContext({ operation, table: kind.startsWith('fk_child_') ? 'internal_child' : 'internal_parent' }));
  return error;
}
import 'reflect-metadata';
import { ArgumentsHost, Controller, Get, HttpException, INestApplication, Param, Post, Req, Res } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import request from 'supertest';
import { Writable } from 'node:stream';
import { LoggerModule, PinoLogger } from 'nestjs-pino';
import { APP_FILTER } from '@nestjs/core';

import { IdsModule } from '../ids/ids.module';
import { isUuidV7, Uuid7Generator } from '../ids/uuid7-generator';
import { createLoggerOptions } from '../../logging/logger-options';
import { setupHttpLogging } from '../../logging/setup-http-logging';
import { AppConfigService } from '../../config/app-config.service';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError, UnauthenticatedError } from './domain-error';
import { mappedError } from './error-codes';

@Controller()
class ErrorsController {
  @Get('database/:kind') databaseGet(@Param('kind') kind: string) { throw routeDatabaseError(kind); }
  @Post('database/:kind') databasePost(@Param('kind') kind: string) { throw routeDatabaseError(kind); }
  @Get('domain/:kind') domain(@Param('kind') kind: string) {
    const errors = { invalid: new InvalidInputError('Entrada incorrecta.', 'title'), missing: new NotFoundError(), forbidden: new ForbiddenError(), conflict: new ConflictError(), unauthenticated: new UnauthenticatedError() };
    throw errors[kind as keyof typeof errors];
  }
  @Get('http/:status') http(@Param('status') status: string) { throw new HttpException('secret /Users/private', Number(status)); }
  @Get('middleware/:status') middleware(@Param('status') status: string) { throw { statusCode: Number(status), expose: true, message: 'secret' }; }
  @Get('crash') crash() { throw new Error('fallo db password=hunter2 at /Users/x/app.ts:10'); }
  @Get('string') string() { throw 'texto'; }
  @Get('object') object() { throw { secret: 'x' }; }
  @Get('promise') promise() { return Promise.reject(new TypeError('secreto')); }
  @Post('body') body() { return {}; }
  @Get('log/:value') log(@Req() req: Request, @Res() res: Response) {
    req.log.info({ password: 'secret-password', payload: { token: 'secret-token' } }, 'Registro de prueba.');
    res.setHeader('set-cookie', 'secret-set-cookie');
    res.json({});
  }
}

type Log = { level: number; req?: { id: string; url: string }; err?: { stack?: string; message?: string }; requestId?: string; status?: number };
const originalEnv = { ...process.env };
beforeAll(() => {
  process.env = { NODE_ENV: 'test', DATABASE_NAME: 'agenda_test', DATABASE_USER: 'agenda_test_app',
    DATABASE_PASSWORD: 'fake-password-for-unit-tests-0001' };
});
afterAll(() => { process.env = originalEnv; });

describe('Filtro HTTP y logs', () => {
  let app: INestApplication;
  let output: string;
  const logs = (): Log[] => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Log);
  beforeAll(async () => {
    const { AppConfigModule } = await import('../../config/app-config.module');
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const module = await Test.createTestingModule({
      imports: [AppConfigModule, IdsModule, LoggerModule.forRoot({ pinoHttp: createLoggerOptions({ logLevel: 'info' }, stream), useExisting: true })],
      controllers: [ErrorsController], providers: [{ provide: ConstraintRegistry, useValue: databaseRegistry }, { provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).overrideProvider(AppConfigService).useValue({ logLevel: 'info' }).compile();
    app = module.createNestApplication({ logger: false });
    await setupHttpLogging(app);
    await app.init();
  });
  beforeEach(() => { output = ''; });
  afterAll(async () => { await app?.close(); });

  function verify(response: request.Response, code: string, field?: string) {
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(Object.keys(response.body)).toEqual(['error']);
    expect(Object.keys(response.body.error).sort()).toEqual((field ? ['code', 'message', 'field', 'requestId'] : ['code', 'message', 'requestId']).sort());
    expect(response.body.error.code).toBe(code);
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
    if (field) expect(response.body.error.field).toBe(field);
  }
  it.each([['invalid', 400, 'invalid_input', 'title'], ['missing', 404, 'not_found', undefined], ['forbidden', 403, 'forbidden', undefined], ['conflict', 409, 'conflict', undefined], ['unauthenticated', 401, 'unauthenticated', undefined]] as const)('DomainError %s', async (kind, status, code, field) => {
    const response = await request(app.getHttpServer()).get(`/domain/${kind}`).expect(status);
    verify(response, code, field);
    if (field) expect(response.body.error.message).toBe('Entrada incorrecta.');
  });
  it.each([400, 401, 403, 404, 405, 409, 413, 415, 418, 422, 429, 500, 501, 503])('HttpException %s', async status => {
    const mapped = mappedError(status);
    const response = await request(app.getHttpServer()).get(`/http/${status}`).expect(mapped.status);
    verify(response, mapped.code);
    expect(response.body.error.message).toBe(mapped.message);
    expect(JSON.stringify(response.body)).not.toMatch(/secret|Users/);
  });
  it.each([400, 413, 418])('middleware expuesto %s', async status => {
    const response = await request(app.getHttpServer()).get(`/middleware/${status}`).expect(status);
    verify(response, mappedError(status).code);
  });
  it('404 no refleja ruta ni query', async () => {
    const response = await request(app.getHttpServer()).get('/inexistente?token=secret-query').expect(404);
    verify(response, 'not_found');
    expect(response.body.error.message).toBe('Recurso no encontrado.');
    expect(output).not.toContain('secret-query');
  });
  it.each([['{bad', 400, 'invalid_input'], [JSON.stringify({ text: 'x'.repeat(110000) }), 413, 'payload_too_large']] as const)('parser responde según tamaño y sintaxis', async (body, status, code) => {
    const response = await request(app.getHttpServer()).post('/body').set('Content-Type', 'application/json').send(body).expect(status);
    verify(response, code);
    expect(isUuidV7(response.headers['x-request-id'])).toBe(true);
    expect(logs().every(log => log.req?.id === response.headers['x-request-id'])).toBe(true);
  });
  it.each(['crash', 'string', 'object', 'promise'])('error inesperado %s siempre es genérico', async path => {
    const response = await request(app.getHttpServer()).get(`/${path}`).expect(500);
    expect(response.body).toEqual({ error: { code: 'internal_error', message: 'Error interno del servidor.', requestId: response.headers['x-request-id'] } });
    expect(JSON.stringify(response.body)).not.toMatch(/hunter2|password|\/Users|stack|texto|secret/);
  });
  it('registra exactamente una excepción con stack y finalización sin err', async () => {
    const response = await request(app.getHttpServer()).get('/crash').set('X-Request-Id', 'test-request-123').expect(500);
    const entries = logs();
    expect(entries.filter(log => log.err)).toHaveLength(1);
    expect(entries.find(log => log.err)?.err?.message).toContain('fallo db');
    expect(entries.find(log => log.err)?.err?.stack).toContain('at ');
    expect(entries.find(log => log.err)?.err?.stack).not.toContain('Error: fallo db');
    expect(entries.find(log => log.err)?.level).toBe(50);
    expect(entries).toHaveLength(2);
    expect(entries[1]).not.toHaveProperty('err');
    expect(JSON.stringify(entries[1])).not.toContain('stack');
    expect(entries.every(log => log.req?.id === 'test-request-123')).toBe(true);
    verify(response, 'internal_error');
    expect(response.headers['x-request-id']).toBe('test-request-123');
  });
  it('4xx genera warn sin stack', async () => {
    await request(app.getHttpServer()).get('/http/400').expect(400);
    expect(logs().filter(log => log.level === 40)).toHaveLength(1);
    expect(output).not.toContain('stack');
  });
  it.each(['x'.repeat(65), 'with spaces'])('reemplaza id HTTP inválido %s', async id => {
    const response = await request(app.getHttpServer()).get('/missing').set('X-Request-Id', id).expect(404);
    expect(isUuidV7(response.headers['x-request-id'])).toBe(true);
    verify(response, 'not_found');
  });
  it('no filtra cabeceras, query, tokens en rutas ni claves sensibles', async () => {
    await request(app.getHttpServer()).get(`/log/${'T'.repeat(24)}?token=secret-query`).set('Authorization', 'secret-auth').set('Cookie', 'secret-cookie').set('X-Api-Key', 'secret-key').set('X-Csrf-Token', 'secret-csrf').expect(200);
    expect(output).not.toContain('secret-');
    expect(output).not.toContain('T'.repeat(24));
    expect(logs().every(log => log.req?.url === '/log/[REDACTED]')).toBe(true);
    expect(logs().every(log => log.req?.id === logs()[0].req?.id)).toBe(true);
    output = '';
    const uuid = new Uuid7Generator().next();
    await request(app.getHttpServer()).get(`/log/${uuid}`).expect(200);
    expect(logs()[0].req?.url).toBe(`/log/${uuid}`);
  });
  it.each(databaseRoutes.flatMap(row => ['get', 'post'].map(method => [...row, method] as const)))('BD HTTP %s %s %s %s', async (kind, status, code, method) => {
    const response = await (method === 'get' ? request(app.getHttpServer()).get(`/database/${kind}`) : request(app.getHttpServer()).post(`/database/${kind}`)).expect(status);
    const repeatable = method === 'get' || kind === 'atomic';
    verify(response, status === 503 && repeatable ? 'service_unavailable' : code, kind === 'unique' ? 'title' : kind === 'fk_child_insert' || kind === 'fk_child_update' ? 'parentId' : undefined);
    expect(JSON.stringify(response.body)).not.toMatch(/CANARIO_|internal_child|internal_parent|internal_title|uq_title|fk_parent/);
    expect(output).not.toContain('CANARIO_');
    const events = logs().filter(log => log.status === status);
    expect(events).toHaveLength(1);
    if (status === 500) expect(events[0].err?.stack).toContain('at ');
    else expect(events[0]).not.toHaveProperty('err');
    if (status === 503) {
      expect(response.headers['retry-after']).toBe(repeatable ? ['40001', '40P01', '55P03', 'wrapped', 'atomic'].includes(kind) ? '1' : kind === '57014' ? '2' : '5' : undefined);
      expect(response.headers['cache-control']).toBe(repeatable ? undefined : 'no-store');
    }
  });
  it('headersSent termina sin escribir y no duplica la excepción', () => {
    const logger = { error: jest.fn() };
    const filter = new AllExceptionsFilter({ logger } as unknown as PinoLogger, new Uuid7Generator());
    const response = { headersSent: true, end: jest.fn(), json: jest.fn() };
    const host = { switchToHttp: () => ({ getRequest: () => ({ id: 'valid-request', headers: {} }), getResponse: () => response }) } as ArgumentsHost;
    const error = new Error('error');
    filter.catch(error, host);
    filter.catch(error, host);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(response.json).not.toHaveBeenCalled();
    expect(response.end).toHaveBeenCalledTimes(2);
  });
});
