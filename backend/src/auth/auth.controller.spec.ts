import 'reflect-metadata';
import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { Writable } from 'node:stream';
import request from 'supertest';
import { AllExceptionsFilter } from '../common/errors/all-exceptions.filter';
import { OutcomeUnknownError, ServiceUnavailableError, UnauthenticatedError } from '../common/errors/domain-error';
import { Clock } from '../common/clock/clock';
import { JsonBody, JsonBodyGuard } from '../common/http/content-type';
import { configureHttpApp } from '../common/http/configure-http-app';
import { serializeClearedSessionCookie, serializeSessionCookie, sessionCookieConfig } from '../common/http/cookies';
import { OriginGuard } from '../common/http/origin.guard';
import { IdGenerator } from '../common/ids/id-generator';
import { AppConfigService } from '../config/app-config.service';
import { deriveCsrfToken, generateSessionToken } from '../identity/session-token';
import { createLoggerOptions } from '../logging/logger-options';
import { AuthController } from './auth.controller';
import { AuthenticationService } from './authentication.service';
import { SessionService } from './session.service';
import { SessionAuthGuard } from './session-auth.guard';

@Controller('health')
class HealthController { @Get() health() { return { ok: true }; } }
@Controller('auth')
class RegistrationTestController {
  @Post('register') @JsonBody() register() { return { ok: true }; }
}
const token = generateSessionToken(() => Buffer.alloc(32, 7));
const csrfToken = deriveCsrfToken(token);
const origin = 'https://permitido.test';
const password = '  clave-canario-http-privada  ';
const input = { email: 'ana@example.test', password };
const config = sessionCookieConfig('test');
const cookie = `agenda_session=${token}`;
const cleared = serializeClearedSessionCookie(config);
const now = new Date('2026-01-01T00:00:00Z');
const identity = { user: { id: 'u1', email: input.email, name: 'Ana' }, organization: { id: 'o1', name: 'Equipo' }, membership: { id: 'm1', role: 'community_manager' } };
const expiresAt = new Date(now.getTime() + 3600500);
const session = { ...identity, sessionId: 's1', createdAt: now, lastSeenAt: now, expiresAt, renewed: false };

describe('HTTP de autenticación con logging real y servicios falsos', () => {
  let app: INestApplication;
  let output: string;
  const login = jest.fn();
  const authenticate = jest.fn();
  const revoke = jest.fn();
  const appConfig = { env: 'test', logLevel: 'info', allowedOrigins: [origin] };
  beforeEach(async () => {
    output = '';
    appConfig.env = 'test'; appConfig.allowedOrigins = [origin];
    login.mockReset().mockResolvedValue({ ...identity, token, csrfToken, expiresAt, maxAgeSeconds: 3600 });
    authenticate.mockReset().mockResolvedValue(session);
    revoke.mockReset().mockResolvedValue(true);
    let sequence = 0;
    const ids = { next: () => `peticion-${++sequence}` };
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const module = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: createLoggerOptions({ logLevel: 'info' }, stream, ids), useExisting: true })],
      controllers: [AuthController, HealthController, RegistrationTestController],
      providers: [SessionAuthGuard,
        { provide: AuthenticationService, useValue: { login } }, { provide: SessionService, useValue: { authenticate, revoke } },
        { provide: Clock, useValue: { now: () => now } }, { provide: IdGenerator, useValue: ids },
        { provide: AppConfigService, useValue: appConfig }, { provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    await configureHttpApp(app); await app.init(); output = '';
  });
  afterEach(async () => { jest.restoreAllMocks(); await app?.close(); });
  const post = (body: object = input) => request(app.getHttpServer()).post('/api/v1/auth/login').send(body);
  function secure(response: request.Response) {
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.text).not.toContain(token);
    expect(response.text).not.toContain(password);
    expect(response.text).not.toContain(origin);
    expect(response.text).not.toContain('tokenHash');
    if (response.status >= 400) expect(response.text).not.toContain(csrfToken);
    expect(JSON.stringify(response.headers['set-cookie'] ?? [])).not.toContain(csrfToken);
    expect(output).toContain('Solicitud finalizada.');
    for (const secret of [token, csrfToken, password, origin]) expect(output).not.toContain(secret);
  }
  function error(response: request.Response, status: number, code: string, field?: string) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: { code, message: expect.any(String), requestId: response.headers['x-request-id'], ...(field ? { field } : {}) } });
    secure(response);
  }
  function untouched() {
    expect(login).not.toHaveBeenCalled(); expect(authenticate).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
  }
  const origins: [string | undefined, string | undefined, boolean][] = [
    [origin, 'cross-site', true], ['https://otro.test', undefined, false], ['null', undefined, false],
    ['', undefined, false], [`${origin}/ruta`, undefined, false], [`${origin}/`, undefined, false],
    ['ftp://permitido.test', undefined, false], [`${origin}, https://otro.test`, undefined, false],
    [undefined, 'same-origin', true], [undefined, 'none', true], [undefined, undefined, true],
    [undefined, 'same-site', false], [undefined, 'cross-site', false], [undefined, 'foo', false],
  ];
  describe.each(['login', 'session', 'logout'] as const)('Origin en %s', route => {
    it.each(origins)('origen %p y sitio %p: permitido %p', async (value, site, allowed) => {
      let req = request(app.getHttpServer())[route === 'session' ? 'get' : 'post'](`/api/v1/auth/${route}`)
        .set('Cookie', cookie).set('X-CSRF-Token', csrfToken);
      if (value !== undefined) req = req.set('Origin', value);
      if (site !== undefined) req = req.set('Sec-Fetch-Site', site);
      if (route === 'login') req = req.send(input);
      const response = await req;
      if (!allowed) {
        error(response, 403, 'forbidden'); expect(response.body.error.message).toBe('Acceso denegado.');
        expect(response.headers['set-cookie']).toBeUndefined(); untouched();
        if (value?.includes('://')) expect(output).not.toContain(value);
      } else { expect(response.status).toBe(route === 'logout' ? 204 : 200); secure(response); }
    });
  });
  it('Origin precede al guard JSON y a la validación', async () => {
    const jsonGuard = jest.spyOn(JsonBodyGuard.prototype, 'canActivate');
    for (const make of [() => request(app.getHttpServer()).post('/api/v1/auth/login').type('text').send('texto'), () => post({})]) {
      const response = await make().set('Origin', 'null');
      error(response, 403, 'forbidden'); expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(jsonGuard).not.toHaveBeenCalled();
    untouched();
  });
  it('el parser devuelve 413 antes de rechazar Origin', async () => {
    const originGuard = jest.spyOn(OriginGuard.prototype, 'canActivate');
    const response = await post({ dato: 'x'.repeat(101 * 1024) }).set('Origin', 'https://otro.test');
    error(response, 413, 'payload_too_large');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(originGuard).not.toHaveBeenCalled();
    untouched();
  });
  it.each(['login', 'session', 'logout'] as const)('ejecuta OriginGuard una sola vez en %s', async route => {
    const originGuard = jest.spyOn(OriginGuard.prototype, 'canActivate');
    let req = request(app.getHttpServer())[route === 'session' ? 'get' : 'post'](`/api/v1/auth/${route}`)
      .set('Origin', origin).set('Cookie', cookie).set('X-CSRF-Token', csrfToken);
    if (route === 'login') req = req.send(input);
    await req.expect(route === 'logout' ? 204 : 200);
    expect(originGuard).toHaveBeenCalledTimes(1);
  });
  it('registro y health sin marca permiten Origin ajeno', async () => {
    const registration = await request(app.getHttpServer()).post('/api/v1/auth/register')
      .set('Origin', 'https://otro.test').send({}).expect(201);
    expect(registration.body).toEqual({ ok: true });
    const health = await request(app.getHttpServer()).get('/api/v1/health')
      .set('Origin', 'https://otro.test').expect(200);
    expect(health.body).toEqual({ ok: true });
    untouched();
  });
  it('login devuelve claves públicas exactas y cookies separadas', async () => {
    const response = await post().set('Origin', origin);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ...identity, csrfToken, expiresAt: expiresAt.toISOString() });
    expect(response.headers['set-cookie']).toEqual([serializeSessionCookie(config, token, 3600)]);
    expect(login).toHaveBeenCalledWith({ ...input, presentedSessionToken: undefined });
    secure(response);
  });
  it.each([undefined, 'agenda_session=incorrecta', `${cookie}; ${cookie}`, cookie])('login solo presenta cookie válida: %p', async value => {
    const req = post(); if (value) req.set('Cookie', value);
    secure(await req.expect(200));
    expect(login).toHaveBeenCalledWith({ ...input, presentedSessionToken: value === cookie ? token : undefined });
  });
  it('login fallido conserva la cookie anterior', async () => {
    login.mockRejectedValue(new UnauthenticatedError('Credenciales inválidas.'));
    const response = await post().set('Cookie', cookie);
    error(response, 401, 'unauthenticated'); expect(response.headers['set-cookie']).toBeUndefined();
    expect(authenticate).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
  });
  it.each(['email', 'password'] as const)('valida ausencia, tipo y longitud de %s', async field => {
    const missing: Record<string, unknown> = { ...input }; delete missing[field];
    for (const body of [missing, { ...input, [field]: 42 }, { ...input, [field]: 'x'.repeat(field === 'email' ? 255 : 1025) }]) {
      const response = await post(body); error(response, 400, 'invalid_input', field);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    untouched();
  });
  it('413 y 415 reales conservan no-store sin efectos', async () => {
    const large = await post({ ...input, password: password.repeat(5000) });
    error(large, 413, 'payload_too_large'); expect(large.headers['set-cookie']).toBeUndefined();
    const media = await request(app.getHttpServer()).post('/api/v1/auth/login').type('text').send(password);
    error(media, 415, 'unsupported_media_type'); expect(media.headers['set-cookie']).toBeUndefined(); untouched();
  });
  it.each([[new ServiceUnavailableError(undefined, 1), 'service_unavailable', '1'],
    [new ServiceUnavailableError(), 'service_unavailable', undefined], [new OutcomeUnknownError(), 'outcome_unknown', undefined]])('propaga 503 seguro %p', async (failure, code, retry) => {
    login.mockRejectedValue(failure);
    const response = await post().set('Cookie', cookie); error(response, 503, code as string);
    expect(response.headers['retry-after']).toBe(retry); expect(response.headers['set-cookie']).toBeUndefined();
  });
  it.each([undefined, 'agenda_session=incorrecta', `${cookie}; ${cookie}`])('session sin cookie utilizable %p', async value => {
    const req = request(app.getHttpServer()).get('/api/v1/auth/session'); if (value) req.set('Cookie', value);
    const response = await req; error(response, 401, 'unauthenticated');
    expect(response.headers['set-cookie']).toEqual(value ? [cleared] : undefined); untouched();
  });
  it.each(['vencida', 'revocada', 'membresía baja'])('borra sesión %s', async () => {
    authenticate.mockResolvedValue(null);
    const response = await request(app.getHttpServer()).get('/api/v1/auth/session').set('Cookie', cookie);
    error(response, 401, 'unauthenticated'); expect(response.headers['set-cookie']).toEqual([cleared]);
    expect(authenticate).toHaveBeenCalledWith(token);
  });
  it.each([false, true])('session válida, renovación %p', async renewed => {
    authenticate.mockResolvedValue({ ...session, renewed });
    const response = await request(app.getHttpServer()).get('/api/v1/auth/session').set('Cookie', cookie).expect(200);
    expect(response.body).toEqual({ ...identity, csrfToken, expiresAt: expiresAt.toISOString() });
    expect(response.headers['set-cookie']).toEqual(renewed ? [serializeSessionCookie(config, token, 3600)] : undefined); secure(response);
  });
  it.each([-1000, 999999999999])('limita Max-Age al renovar: %p', async delta => {
    authenticate.mockResolvedValue({ ...session, renewed: true, expiresAt: new Date(now.getTime() + delta) });
    const response = await request(app.getHttpServer()).get('/api/v1/auth/session').set('Cookie', cookie).expect(200);
    expect(response.headers['set-cookie']).toEqual([serializeSessionCookie(config, token, delta < 0 ? 1 : 2678400)]); secure(response);
  });
  it.each(['post', 'put', 'delete'] as const)('%s session no está registrado', async method => {
    error(await request(app.getHttpServer())[method]('/api/v1/auth/session'), 404, 'not_found'); untouched();
  });
  it.each([undefined, 'agenda_session=incorrecta', `${cookie}; ${cookie}`])('logout sin cookie utilizable %p', async value => {
    const req = request(app.getHttpServer()).post('/api/v1/auth/logout'); if (value) req.set('Cookie', value);
    const response = await req.expect(204); expect(response.headers['set-cookie']).toEqual([cleared]); secure(response); untouched();
  });
  it.each([true, false])('logout idempotente, revoke devuelve %p', async result => {
    revoke.mockResolvedValue(result);
    const response = await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', csrfToken).expect(204);
    expect(revoke).toHaveBeenCalledTimes(1); expect(revoke).toHaveBeenCalledWith(token);
    expect(authenticate).not.toHaveBeenCalled(); expect(login).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toEqual([cleared]); expect(response.text).toBe(''); secure(response);
  });
  it.each([undefined, token, 'malformado', `${csrfToken}, ${csrfToken}`])('logout rechaza CSRF %p antes de revoke', async value => {
    const req = request(app.getHttpServer()).post('/api/v1/auth/logout').set('Cookie', cookie); if (value) req.set('X-CSRF-Token', value);
    const response = await req; error(response, 403, 'forbidden'); expect(response.headers['set-cookie']).toBeUndefined(); untouched();
  });
  it('rechaza cabeceras CSRF duplicadas', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/logout')
      .set('Cookie', cookie).set({ 'X-CSRF-Token': [csrfToken, csrfToken] });
    error(response, 403, 'forbidden'); expect(response.headers['set-cookie']).toBeUndefined(); untouched();
  });
  it('producción usa cookie __Host segura', async () => {
    appConfig.env = 'production';
    const response = await post().expect(200);
    expect(response.headers['set-cookie']).toEqual([serializeSessionCookie(sessionCookieConfig('production'), token, 3600)]); secure(response);
  });
  it.each(['/api/v1/auth', '/api/v1/auth/desconocida'])('404 mantiene no-store en %s', async path => {
    const response = await request(app.getHttpServer()).get(path); error(response, 404, 'not_found'); untouched();
  });
  it('health no recibe no-store', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(response.headers['cache-control']).toBeUndefined();
  });
});
