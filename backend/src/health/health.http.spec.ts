import 'reflect-metadata';
import { Body, Controller, Get, INestApplication, Param, Post, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { Writable } from 'node:stream';
import type { Server } from 'node:http';
import request from 'supertest';
import { IsString } from 'class-validator';
import { HealthModule } from './health.module';
import { configureHttpApp } from '../common/http/configure-http-app';
import { JsonBody } from '../common/http/content-type';
import { PaginationQueryDto } from '../common/http/pagination.dto';
import { AllExceptionsFilter } from '../common/errors/all-exceptions.filter';
import { IdsModule } from '../common/ids/ids.module';
import { AppConfigService } from '../config/app-config.service';
import { createLoggerOptions } from '../logging/logger-options';
import { ConstraintRegistry } from '../database/errors/constraint-registry';
import { registerSchemaConstraints } from '../database/errors/register-schema-constraints';
class BodyDto { @IsString() title!: string; }
@Controller('test')
class TestController {
  @Post('body') @JsonBody() body(@Body() body: BodyDto) { return body; }
  @Get('page') page(@Query() query: PaginationQueryDto) { return query; }
  @Get('database/:constraint') database(@Param('constraint') constraint: string) {
    throw { code: '23505', severity: 'ERROR', constraint, table: 'users', column: 'email' };
  }
}
describe('Fundamentos HTTP (pg trap de Jest activa)', () => {
  let app: INestApplication;
  let server: Server;
  beforeEach(async () => {
    const stream = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const module = await Test.createTestingModule({
      imports: [HealthModule, IdsModule, LoggerModule.forRoot({ pinoHttp: createLoggerOptions({ logLevel: 'info' }, stream), useExisting: true })],
      controllers: [TestController],
      providers: [{ provide: AppConfigService, useValue: { logLevel: 'info' } },
        { provide: ConstraintRegistry, useFactory: () => registerSchemaConstraints(new ConstraintRegistry()) },
        { provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await configureHttpApp(app);
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer() as Server;
  });
  afterEach(async () => { await app?.close(); });
  function security(res: request.Response) {
    expect(res.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
    expect(res.headers).not.toHaveProperty('x-powered-by');
    expect(res.headers).not.toHaveProperty('strict-transport-security');
  }
  function error(res: request.Response, code: string, field?: string) {
    security(res);
    expect(res.headers['content-type']).toMatch(/^application\/json\b/);
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(Object.keys(res.body.error).sort()).toEqual((field ? ['code', 'message', 'requestId', 'field'] : ['code', 'message', 'requestId']).sort());
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/CANARIO|stack|BodyDto|SyntaxError|UQ_|uq_/);
    if (field) expect(res.body.error.field).toBe(field);
  }
  it('health aislado de DatabaseModule y cabeceras', async () => {
    const res = await request(server).get('/api/v1/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' }); security(res);
    expect(res.headers['x-request-id']).toBeTruthy();
  });
  it.each(['/health', '/missing', '/api/v1/missing'])('404 %s', async path => {
    error(await request(server).get(path).expect(404), 'not_found');
  });
  it('POST health sin Content-Type sigue siendo 404', async () => {
    error(await request(server).post('/api/v1/health').expect(404), 'not_found');
  });
  it.each([
    ['application/json', '{"CANARIO":', 400, 'invalid_input'],
    ['application/json', JSON.stringify({ title: 'CANARIO'.repeat(16000) }), 413, 'payload_too_large'],
    ['text/plain', 'CANARIO', 415, 'unsupported_media_type'],
    ['application/x-www-form-urlencoded', 'title=CANARIO', 415, 'unsupported_media_type'],
  ] as const)('parser y tipo %#', async (type, body, status, code) => {
    error(await request(server).post('/api/v1/test/body').set('Content-Type', type).send(body).expect(status), code);
  });
  it('ruta JSON exige Content-Type', async () => {
    error(await request(server).post('/api/v1/test/body').expect(415), 'unsupported_media_type');
  });
  it.each([{ title: 7 }, { title: 'ok', CANARIO: 'CANARIO' }])('DTO rechaza sin publicar claves ni contenido', async body => {
    error(await request(server).post('/api/v1/test/body').send(body).expect(400), 'invalid_input', 'CANARIO' in body ? undefined : 'title');
  });
  it('DTO válido y request id del logging', async () => {
    const res = await request(server).post('/api/v1/test/body').set('X-Request-Id', 'http-test-123').send({ title: 'ok' }).expect(201);
    expect(res.body).toEqual({ title: 'ok' }); expect(res.headers['x-request-id']).toBe('http-test-123'); security(res);
  });
  it.each(['', '?limit=10'])('paginación transforma y aplica default %s', async query => {
    const res = await request(server).get(`/api/v1/test/page${query}`).expect(200);
    expect(res.body.limit).toBe(query ? 10 : 20);
  });
  it.each(['limit=5&limit=6', 'limit=0', 'limit=101', 'limit=1.5', 'limit=no', 'cursor=a&cursor=b', `cursor=${'a'.repeat(513)}`])('paginación inválida %s', async query => {
    error(await request(server).get(`/api/v1/test/page?${query}`).expect(400), 'invalid_input', query.startsWith('limit') ? 'limit' : 'cursor');
  });
  it.each(['UQ_users_email', 'uq_users_email', 'UQ_unknown'])('extracción, clasificación, registro y filtro %s', async constraint => {
    const res = await request(server).get(`/api/v1/test/database/${constraint}`).expect(409);
    const known = constraint === 'UQ_users_email';
    error(res, 'conflict', known ? 'email' : undefined);
    expect(res.body.error.message).toBe(known ? 'El email ya está registrado.' : 'Conflicto con el estado del recurso.');
  });
});
