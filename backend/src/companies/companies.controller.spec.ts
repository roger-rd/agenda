import 'reflect-metadata';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { Writable } from 'node:stream';
import request from 'supertest';
import { SessionService } from '../auth/session.service';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { AllExceptionsFilter } from '../common/errors/all-exceptions.filter';
import { configureHttpApp } from '../common/http/configure-http-app';
import { serializeClearedSessionCookie, sessionCookieConfig } from '../common/http/cookies';
import { IdGenerator } from '../common/ids/id-generator';
import { AppConfigService } from '../config/app-config.service';
import { generateSessionToken } from '../identity/session-token';
import { createLoggerOptions } from '../logging/logger-options';
import { CompaniesController } from './companies.controller';
import { CompaniesService, LIST_ACCESSIBLE_COMPANIES_SQL, LIST_COMPANIES_SQL } from './companies.service';
import { encodeCursor } from './companies-cursor';

@Controller('health')
class HealthController { @Get() health() { return { ok: true }; } }
const token = generateSessionToken(() => Buffer.alloc(32, 7));
const cookie = `agenda_session=${token}`;
const cleared = serializeClearedSessionCookie(sessionCookieConfig('test'));
const origin = 'https://permitido.test';
const id = '01900000-0000-7000-8000-000000000001';
const cursor = encodeCursor({ nameKey: 'empresa privada', id });
const now = new Date('2026-01-01T00:00:00Z');
const session = { user: { id: 'usuario-privado', email: 'ana@example.test', name: 'Ana' },
  organization: { id: 'organización-de-sesión', name: 'Equipo' }, membership: { id: 'membresía-de-sesión', role: 'community_manager' },
  sessionId: 'sesión-canario-privada', createdAt: now, lastSeenAt: now, expiresAt: now, renewed: true };
const row = { id, name: 'Empresa', color: '#112233', name_key: 'empresa privada', organization_id: 'privada', version: 9, created_at: now };
const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('empresas HTTP con servicio y logging reales, sin PostgreSQL', () => {
  let app: INestApplication;
  let output: string;
  const authenticate = jest.fn();
  const query = jest.fn();
  const appConfig = { env: 'test', logLevel: 'info', allowedOrigins: [origin] };
  beforeEach(async () => {
    output = ''; appConfig.allowedOrigins = [origin];
    authenticate.mockReset().mockResolvedValue(session);
    query.mockReset().mockResolvedValue([row]);
    let sequence = 0;
    const ids = { next: () => `petición-${++sequence}` };
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const module = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: createLoggerOptions({ logLevel: 'info' }, stream, ids), useExisting: true })],
      controllers: [CompaniesController, HealthController],
      providers: [CompaniesService, SessionAuthGuard,
        { provide: 'CompanyRepository', useValue: { query } },
        { provide: SessionService, useValue: { authenticate } }, { provide: IdGenerator, useValue: ids },
        { provide: AppConfigService, useValue: appConfig }, { provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    await configureHttpApp(app); await app.init(); output = '';
  });
  afterEach(async () => { await app?.close(); });
  const get = () => request(app.getHttpServer()).get('/api/v1/companies').set('Cookie', cookie);
  function secure(response: request.Response) {
    expect(response.headers['cache-control']).toBe('no-store');
    expect(output).toContain('Solicitud finalizada.');
    for (const secret of [cookie, token, cursor, session.sessionId, session.user.id, session.membership.id, session.organization.id]) {
      expect(output).not.toContain(secret);
    }
  }
  function error(response: request.Response, status: number, code: string, field?: string) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: { code, message: expect.any(String),
      requestId: response.headers['x-request-id'], ...(field ? { field } : {}) } });
    secure(response);
  }
  it.each(['community_manager', 'worker', 'client'])('%s usa solo el alcance de sesión y proyecta campos públicos', async role => {
    authenticate.mockResolvedValue({ ...session, membership: { ...session.membership, role } });
    const response = await get().set('Origin', origin).set('X-Organization-Id', 'organización-ajena').set('X-Role', 'admin');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [{ id, name: row.name, color: row.color, version: row.version }], nextCursor: null });
    expect(query).toHaveBeenCalledWith(role === 'community_manager' ? LIST_COMPANIES_SQL : LIST_ACCESSIBLE_COMPANIES_SQL,
      [session.organization.id, null, null, 21, ...(role === 'community_manager' ? [] : [session.membership.id])]);
    expect(authenticate).toHaveBeenCalledWith(token); secure(response);
  });
  it('sin accesos responde 200 vacío', async () => {
    authenticate.mockResolvedValue({ ...session, membership: { ...session.membership, role: 'worker' } });
    query.mockResolvedValue([]);
    const response = await get().expect(200);
    expect(response.body).toEqual({ items: [], nextCursor: null }); secure(response);
  });
  it.each([{ organization: null }, { membership: null }, { organization: null, membership: null },
    { membership: { id: 'm', role: 'admin' } }])('deniega alcance %p sin consultar', async change => {
    authenticate.mockResolvedValue({ ...session, ...change });
    const response = await get(); error(response, 403, 'forbidden');
    expect(response.body.error.message).toBe('Acceso denegado.'); expect(query).not.toHaveBeenCalled();
  });
  it.each([undefined, 'agenda_session=inválida', `${cookie}; ${cookie}`])('401 con cookie %p', async value => {
    const req = request(app.getHttpServer()).get('/api/v1/companies');
    if (value) req.set('Cookie', value);
    const response = await req; error(response, 401, 'unauthenticated');
    expect(response.headers['set-cookie']).toEqual(value ? [cleared] : undefined);
    expect(authenticate).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
  });
  it.each(['vencida', 'revocada', 'membresía baja'])('borra la cookie de sesión %s', async () => {
    authenticate.mockResolvedValue(null);
    const response = await get(); error(response, 401, 'unauthenticated');
    expect(response.headers['set-cookie']).toEqual([cleared]);
    expect(authenticate).toHaveBeenCalledWith(token); expect(query).not.toHaveBeenCalled();
  });
  it.each([['null', undefined], ['https://ajeno.test', undefined], [undefined, 'same-site']])('Origin %p y sitio %p preceden a authenticate', async (value, site) => {
    const req = get();
    if (value) req.set('Origin', value);
    if (site) req.set('Sec-Fetch-Site', site);
    const response = await req; error(response, 403, 'forbidden');
    expect(authenticate).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
  });
  it('respeta la lista controlable de orígenes permitidos', async () => {
    appConfig.allowedOrigins = [];
    error(await get().set('Origin', origin), 403, 'forbidden');
    expect(authenticate).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
  });
  it.each(['organizationId', 'role', 'companyId'])('rechaza suplantación por query %s sin field', async field => {
    error(await get().query({ [field]: 'ajeno' }), 400, 'invalid_input'); expect(query).not.toHaveBeenCalled();
  });
  it.each(['0', '101', 'abc', ['2', '3']])('rechaza limit %p', async limit => {
    error(await get().query({ limit }), 400, 'invalid_input', 'limit'); expect(query).not.toHaveBeenCalled();
  });
  it.each(['!', 'a'.repeat(513), 'e31', cursor + '=', raw({ n: 'ab', i: id, extra: true }),
    raw({ n: 'ab', i: id.replace('-7000-', '-4000-') }), raw({ n: 'Ab', i: id })])('rechaza cursor %p', async value => {
    error(await get().query({ cursor: value }), 400, 'invalid_input', 'cursor'); expect(query).not.toHaveBeenCalled();
  });
  it('el cursor válido llega al servicio sin aparecer en logs', async () => {
    const response = await get().query({ cursor, limit: 2 }).expect(200);
    expect(query).toHaveBeenCalledWith(LIST_COMPANIES_SQL, [session.organization.id, 'empresa privada', id, 3]); secure(response);
  });
  it('el filtro global traduce un error falso de BD a 503 con Retry-After', async () => {
    query.mockRejectedValue({ severity: 'ERROR', code: '08006', table: 'companies', detail: `${cookie} ${cursor}` });
    const response = await get(); error(response, 503, 'service_unavailable');
    expect(response.headers['retry-after']).toBe('5');
  });
  it('404 bajo companies conserva no-store', async () => {
    error(await request(app.getHttpServer()).get('/api/v1/companies/desconocida'), 404, 'not_found');
    expect(authenticate).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
  });
  it('health y prefijos parecidos no reciben no-store', async () => {
    for (const path of ['/api/v1/health', '/api/v1/companiesx', '/api/v1/authenticacion']) {
      const response = await request(app.getHttpServer()).get(path);
      expect(response.status).toBe(path.endsWith('health') ? 200 : 404);
      expect(response.headers['cache-control']).toBeUndefined();
    }
  });
});
