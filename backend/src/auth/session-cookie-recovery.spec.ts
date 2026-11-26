import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../common/errors/all-exceptions.filter';
import { Clock } from '../common/clock/clock';
import { configureHttpApp } from '../common/http/configure-http-app';
import { serializeClearedSessionCookie, sessionCookieConfig } from '../common/http/cookies';
import { IdsModule } from '../common/ids/ids.module';
import { AppConfigService } from '../config/app-config.service';
import { deriveCsrfToken, generateSessionToken } from '../identity/session-token';
import { LoggerModule } from 'nestjs-pino';
import { createLoggerOptions } from '../logging/logger-options';
import { AuthController } from './auth.controller';
import { AuthenticationService } from './authentication.service';
import { SessionService } from './session.service';
import { SessionAuthGuard } from './session-auth.guard';

/**
 * Documents, against the real controller and guard, how a person recovers from a session cookie they cannot use. It changes nothing:
 * logout is not extended. This is the recovery the acceptance of an invitation relies on when it answers 409 session_active.
 */
const token = generateSessionToken(() => Buffer.alloc(32, 7));
const csrf = deriveCsrfToken(token);
const origin = 'https://permitido.test';
const cleared = serializeClearedSessionCookie(sessionCookieConfig('test'));
const NOW = new Date('2026-01-01T00:00:00Z');
const session = { user: { id: 'u', email: 'a@example.test', name: 'Ana' }, organization: { id: 'o', name: 'Equipo' }, membership: { id: 'm', role: 'worker' },
  sessionId: 's', createdAt: NOW, lastSeenAt: NOW, expiresAt: new Date(NOW.getTime() + 3_600_000), renewed: false };

describe('recuperación de una cookie de sesión inutilizable', () => {
  let app: INestApplication;
  const authenticate = jest.fn();
  const revoke = jest.fn();
  beforeEach(async () => {
    authenticate.mockReset(); revoke.mockReset().mockResolvedValue(false);
    const module = await Test.createTestingModule({
      imports: [IdsModule, LoggerModule.forRoot({ pinoHttp: createLoggerOptions({ logLevel: 'silent' }), useExisting: true })],
      controllers: [AuthController],
      providers: [SessionAuthGuard, { provide: AuthenticationService, useValue: { login: jest.fn() } }, { provide: SessionService, useValue: { authenticate, revoke } },
        { provide: Clock, useValue: { now: () => NOW } }, { provide: AppConfigService, useValue: { env: 'test', logLevel: 'silent', allowedOrigins: [origin] } },
        { provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    await configureHttpApp(app); await app.init();
  });
  afterEach(async () => { await app?.close(); });
  const logout = (cookie?: string, csrfToken?: string) => {
    const req = request(app.getHttpServer()).post('/api/v1/auth/logout').set('Origin', origin);
    if (cookie) req.set('Cookie', cookie);
    if (csrfToken) req.set('X-CSRF-Token', csrfToken);
    return req;
  };
  const getSession = (cookie: string) => request(app.getHttpServer()).get('/api/v1/auth/session').set('Origin', origin).set('Cookie', cookie);

  it.each([['inválida', 'agenda_session=incorrecta'], ['duplicada', `agenda_session=${token}; agenda_session=${token}`], ['con valor vacío', 'agenda_session='], ['ausente', '']])(
    'cookie %s: el logout la limpia sin CSRF y sin tocar la base', async (_label, cookie) => {
      const response = await logout(cookie || undefined);
      expect(response.status).toBe(204);
      expect(response.headers['set-cookie']).toEqual([cleared]);
      expect(revoke).not.toHaveBeenCalled(); expect(authenticate).not.toHaveBeenCalled();
    });
  it('cookie bien formada con sesión vencida y sin CSRF: el logout la rechaza (403) y NO la limpia; GET /auth/session sí la limpia (401)', async () => {
    authenticate.mockResolvedValue(null);
    const cookie = `agenda_session=${token}`;
    const refused = await logout(cookie);
    expect(refused.status).toBe(403); expect(refused.headers['set-cookie']).toBeUndefined(); expect(revoke).not.toHaveBeenCalled();
    const recovered = await getSession(cookie);
    expect(recovered.status).toBe(401); expect(recovered.headers['set-cookie']).toEqual([cleared]);
    expect(recovered.headers['cache-control']).toBe('no-store');
  });
  it('cookie bien formada con sesión vigente y sin CSRF: GET /auth/session devuelve el CSRF derivado y con él el logout funciona', async () => {
    authenticate.mockResolvedValue(session);
    const cookie = `agenda_session=${token}`;
    const current = await getSession(cookie);
    expect(current.status).toBe(200); expect(current.body.csrfToken).toBe(csrf);
    revoke.mockResolvedValue(true);
    const done = await logout(cookie, current.body.csrfToken);
    expect(done.status).toBe(204); expect(done.headers['set-cookie']).toEqual([cleared]); expect(revoke).toHaveBeenCalledWith(token);
  });
  it('con CSRF correcto el logout también limpia una cookie de sesión ya vencida (revocar devuelve false, igualmente 204)', async () => {
    const done = await logout(`agenda_session=${token}`, csrf);
    expect(done.status).toBe(204); expect(done.headers['set-cookie']).toEqual([cleared]);
  });
});
