import 'reflect-metadata';
import { ArgumentsHost, Controller, Get, HttpException, INestApplication, Param, Post, Req, Res } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import request from 'supertest';
import { Writable } from 'node:stream';
import { LoggerModule, PinoLogger } from 'nestjs-pino';
import { APP_FILTER } from '@nestjs/core';
import { AppConfigModule } from '../../config/app-config.module';
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

type Log = { level: number; req?: { id: string; url: string }; err?: { stack?: string }; requestId?: string; status?: number };
describe('Filtro HTTP y logs', () => {
  let app: INestApplication;
  let output: string;
  const logs = (): Log[] => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Log);
  beforeAll(async () => {
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const module = await Test.createTestingModule({
      imports: [AppConfigModule, IdsModule, LoggerModule.forRoot({ pinoHttp: createLoggerOptions({ logLevel: 'info' }, stream), useExisting: true })],
      controllers: [ErrorsController], providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
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
    expect(entries.find(log => log.err)?.err?.stack).toContain('Error: fallo db');
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
