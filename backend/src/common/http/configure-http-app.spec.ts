import { ExecutionContext, UnsupportedMediaTypeException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JsonBody, JsonBodyGuard } from './content-type';
import { OriginGuard } from './origin.guard';
class Routes {
  @JsonBody() json() { return true; }
  empty() { return true; }
}
it('solo exige JSON con metadata explícita de ruta', () => {
  const guard = new JsonBodyGuard(new Reflector());
  const context = (handler: () => boolean) => ({ getHandler: () => handler, getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ is: () => false }) }) }) as unknown as ExecutionContext;
  expect(guard.canActivate(context(Routes.prototype.empty))).toBe(true);
  expect(() => guard.canActivate(context(Routes.prototype.json))).toThrow(UnsupportedMediaTypeException);
});

import type { INestApplication } from '@nestjs/common';
import { configureHttpApp } from './configure-http-app';
import { setupHttpLogging } from '../../logging/setup-http-logging';
import { securityHeaders } from './security-headers';
jest.mock('../../logging/setup-http-logging', () => ({ setupHttpLogging: jest.fn().mockResolvedValue(undefined) }));
it('prefijo, seguridad, logging antes del parser y validación global', async () => {
  const disable = jest.fn();
  const setNotFoundHandler = jest.fn();
  const adapter = { getInstance: () => ({ disable }), setNotFoundHandler };
  const app = { setGlobalPrefix: jest.fn(), getHttpAdapter: () => adapter,
    use: jest.fn(), useGlobalPipes: jest.fn(), useGlobalGuards: jest.fn(), get: () => new Reflector() };
  await configureHttpApp(app as unknown as INestApplication);
  expect(app.setGlobalPrefix).toHaveBeenCalledWith('api/v1');
  // Nest entrega un proxy que ya contiene AllExceptionsFilter. No sustituirlo
  // ni registrar el catch-all antes de que Nest haya registrado las rutas.
  expect(setNotFoundHandler).not.toHaveBeenCalled();
  const proxy = jest.fn();
  app.getHttpAdapter().setNotFoundHandler(proxy, 'api/v1', []);
  expect(setNotFoundHandler).toHaveBeenCalledWith(proxy);
  expect(disable).toHaveBeenCalledWith('x-powered-by');
  expect(app.use).toHaveBeenNthCalledWith(1, securityHeaders);
  expect(jest.mocked(setupHttpLogging).mock.invocationCallOrder[0]).toBeLessThan(app.use.mock.invocationCallOrder[2]);
  expect(app.useGlobalPipes).toHaveBeenCalledTimes(1);
  expect(app.useGlobalGuards).toHaveBeenCalledTimes(1);
  expect(app.useGlobalGuards).toHaveBeenCalledWith(expect.any(OriginGuard), expect.any(JsonBodyGuard));
});

import { Controller, Get, Post } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import { AllExceptionsFilter } from '../errors/all-exceptions.filter';
import { IdsModule } from '../ids/ids.module';
import { AppConfigService } from '../../config/app-config.service';

@Controller('auth')
class AuthRoutes {
  @Post('prueba') @JsonBody() prueba() { return { ok: true }; }
}
@Controller('health')
class HealthRoute { @Get() health() { return { ok: true }; } }

describe('no-store antes del parser en HTTP real', () => {
  let app: INestApplication;
  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }), IdsModule],
      controllers: [AuthRoutes, HealthRoute],
      providers: [{ provide: AppConfigService, useValue: { env: 'test', allowedOrigins: [] } },
        { provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    await configureHttpApp(app); await app.init();
  });
  afterEach(async () => { await app?.close(); });
  it.each(['/api/v1/auth', '/api/v1/auth/desconocida'])('incluye 404 en %s', async path => {
    const response = await request(app.getHttpServer()).get(path).expect(404);
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('incluye éxito, 413 del parser y 415 del guard', async () => {
    const ok = await request(app.getHttpServer()).post('/api/v1/auth/prueba').send({}).expect(201);
    const large = await request(app.getHttpServer()).post('/api/v1/auth/prueba').send({ dato: 'x'.repeat(101 * 1024) }).expect(413);
    const media = await request(app.getHttpServer()).post('/api/v1/auth/prueba').type('text').send('dato').expect(415);
    for (const response of [ok, large, media]) expect(response.headers['cache-control']).toBe('no-store');
  });
  it('no afecta health ni prefijos parecidos', async () => {
    for (const path of ['/api/v1/health', '/api/v1/authenticacion']) {
      const response = await request(app.getHttpServer()).get(path);
      expect(response.headers['cache-control']).toBeUndefined();
    }
  });
});
