import 'reflect-metadata';
import { Controller, Get, INestApplication, Req } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Logger, LoggerModule } from 'nestjs-pino';
import { QueryFailedError } from 'typeorm';
import { DatabaseError } from 'pg';
import { Writable } from 'node:stream';
import type { Request } from 'express';
import request from 'supertest';
import { IdsModule } from '../common/ids/ids.module';
import { AllExceptionsFilter } from '../common/errors/all-exceptions.filter';
import { AppConfigService } from '../config/app-config.service';
import { createLoggerOptions } from './logger-options';
import { setupHttpLogging } from './setup-http-logging';
import { registerSecret, resetSecretsForTests } from './secret-registry';
const password = 'fake-password-for-unit-tests-0001';
function dbError() {
  const pg = new DatabaseError('CANARIO_MSG_PG', 42, 'error');
  Object.assign(pg, { code: '23505', severity: 'ERROR', detail: 'CANARIO_DETAIL', where: 'CANARIO_WHERE', hint: 'CANARIO_HINT', internalQuery: 'CANARIO_INTERNAL_SQL' });
  return new QueryFailedError('CANARIO_SQL', ['CANARIO_PARAM'], pg);
}
@Controller()
class LoggingController {
  constructor(private readonly logger: Logger) {}
  @Get('database') database() { throw dbError(); }
  @Get('aggregate') aggregate() {
    throw new AggregateError([dbError(), new Error(`https://user:${password}@example.test/path`)], 'Fallo agregado.');
  }
  @Get('cause') cause() { throw new Error('Fallo con causa.', { cause: dbError() }); }
  @Get('direct') direct(@Req() req: Request) {
    req.log.error({ payload: dbError(), lista: [dbError(), { password }], nested: { deep: { error: dbError(), context: 'CANARIO_TRACE\n    at private' } } });
    req.log.error({ err: dbError() });
    req.log.error(dbError());
    req.log.error({ req: { headers: { authorization: 'CANARIO_AUTH' }, body: 'CANARIO_BODY', secret: 'CANARIO_SECRET' }, res: { body: 'CANARIO_RESPONSE' } });
    return { ok: true };
  }
  @Get('reserved') reserved(@Req() req: Request) {
    for (const key of ['detail', 'hint', 'where', 'query', 'parameters', 'internalQuery', 'driverError']) {
      req.log.info({ event: 'reserved-fields', key, requestId: 'reserved-request',
        nested: { deep: { [key]: { value: 'CANARIO_OBJECT' }, queryId: 'q1' } },
        list: [{ [key]: ['CANARIO_ARRAY'], name: 'legítimo' }, [{ [key]: 'CANARIO_NESTED_ARRAY' }]],
      });
    }
    return { ok: true };
  }
  @Get('nest') nest() {
    this.logger.error(dbError());
    this.logger.error('Fallo controlado.', 'CANARIO_STACK\n    at file.ts:1:2');
    this.logger.error('Fallo controlado.', 'CANARIO_STACK\n    at file.ts:1:2', 'Contexto');
    this.logger.warn({ e: dbError() });
    return { ok: true };
  }
}
type Entry = { level?: number; sqlState?: string; event?: string; req?: { id?: string; method?: string; url?: string; remoteAddress?: string }; msg?: string; context?: string; err?: { sqlState?: string; stack?: string; cause?: { sqlState?: string }; errors?: { sqlState?: string }[] } };
describe('Logging seguro con Nest, pino-http y filtro real', () => {
  let app: INestApplication;
  let output = '';
  const entries = (): Entry[] => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Entry);
  beforeAll(async () => {
    registerSecret(password);
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const module = await Test.createTestingModule({
      imports: [IdsModule, LoggerModule.forRoot({ pinoHttp: createLoggerOptions({ logLevel: 'info' }, stream), useExisting: true })],
      controllers: [LoggingController], providers: [{ provide: AppConfigService, useValue: { logLevel: 'info' } }, { provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await setupHttpLogging(app);
    await app.init();
  });
  beforeEach(() => { output = ''; });
  afterAll(async () => { await app?.close(); resetSecretsForTests(); });
  function noLeaks(response: request.Response) {
    expect(output).not.toContain('CANARIO_');
    expect(output).not.toContain(password);
    expect(JSON.stringify(response.body)).not.toMatch(/CANARIO_|fake-password/);
    expect(entries().length).toBeGreaterThan(0);
    const completion = entries().find(entry => entry.msg === 'Solicitud finalizada.');
    expect(completion?.req?.remoteAddress).toEqual(expect.any(String));
    expect(Object.keys(completion?.req ?? {}).sort()).toEqual(['id', 'method', 'remoteAddress', 'url']);
  }
  it('excepción database responde 409 sin err ni stack', async () => {
    const response = await request(app.getHttpServer()).get('/database').expect(409);
    expect(response.body.error.code).toBe('conflict');
    noLeaks(response);
    const records = entries();
    const failures = records.filter(entry => entry.sqlState !== undefined);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ level: 40, sqlState: '23505', event: 'unique_violation' });
    for (const record of records) {
      expect(record).not.toHaveProperty('err');
      expect(record).not.toHaveProperty('stack');
    }
    expect(JSON.stringify(response.body)).not.toMatch(/constraint|table|sql|query|parameters/i);
  });
  it.each(['aggregate', 'cause'])('excepción %s tiene un único err y conserva marcos', async path => {
    const response = await request(app.getHttpServer()).get(`/${path}`).expect(500);
    noLeaks(response);
    const errors = entries().filter(entry => entry.err);
    expect(errors).toHaveLength(1);
    const err = errors[0].err!;
    expect(err.stack).toMatch(/^\s+at\s/);
    expect(err.stack).not.toContain('CANARIO_');
    const sqlState = path === 'database' ? err.sqlState : path === 'cause' ? err.cause?.sqlState : err.errors?.[0].sqlState;
    expect(sqlState).toBe('23505');
  });
  it('registros directos y req/res falsos no filtran datos', async () => {
    const response = await request(app.getHttpServer()).get('/direct').expect(200);
    noLeaks(response);
    expect(entries().filter(entry => entry.err)).toHaveLength(2);
    for (const entry of entries().filter(entry => entry.err)) expect(entry.msg).toBe('Error de base de datos 23505 (violación de integridad).');
  });
  it('contratos de nestjs-pino saneados', async () => {
    const response = await request(app.getHttpServer()).get('/nest').expect(200);
    noLeaks(response);
    expect(entries().some(entry => entry.context === '[CONTEXTO_OMITIDO]')).toBe(true);
    expect(entries().some(entry => entry.context === 'Contexto')).toBe(true);
    expect(entries().find(entry => entry.err?.sqlState)?.msg).toBe('Error de base de datos 23505 (violación de integridad).');
  });
  it('claves reservadas anidadas en objetos y arrays no filtran y preservan campos legítimos', async () => {
    const response = await request(app.getHttpServer()).get('/reserved').expect(200);
    noLeaks(response);
    const records = entries().filter(entry => 'event' in entry && entry.event === 'reserved-fields');
    expect(records).toHaveLength(7);
    for (const record of records) {
      expect(record).toHaveProperty('requestId', 'reserved-request');
      const key = (record as unknown as { key: string }).key;
      if (key === 'driverError') {
        expect(record).toHaveProperty('nested.deep.database', true);
        expect(record).toHaveProperty('list.0.database', true);
      } else {
        expect(record).toHaveProperty(`nested.deep.${key}`, '[REDACTED]');
        expect(record).toHaveProperty('nested.deep.queryId', 'q1');
        expect(record).toHaveProperty(`list.0.${key}`, '[REDACTED]');
        expect(record).toHaveProperty('list.0.name', 'legítimo');
        expect(record).toHaveProperty(`list.1.0.${key}`, '[REDACTED]');
      }
    }
  });

});
