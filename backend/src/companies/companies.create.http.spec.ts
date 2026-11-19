import 'reflect-metadata';
import { Clock } from '../common/clock/clock';
import { INestApplication } from '@nestjs/common';
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
import { IdsModule } from '../common/ids/ids.module';
import { IdGenerator } from '../common/ids/id-generator';
import { AppConfigService } from '../config/app-config.service';
import { deriveCsrfToken, generateSessionToken } from '../identity/session-token';
import { createLoggerOptions } from '../logging/logger-options';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { QueryFailedError, type EntityManager } from 'typeorm';
import { TransactionRunner } from '../registration/transaction-runner';
import { RoleGuard } from '../auth/role.guard';
import { ConstraintRegistry } from '../database/errors/constraint-registry';
import { registerSchemaConstraints } from '../database/errors/register-schema-constraints';

const token = generateSessionToken(() => Buffer.alloc(32, 7));
const cookie = `agenda_session=${token}`;
const csrf = deriveCsrfToken(token);
const origin = 'https://permitido.test';
const id = '01900000-0000-7000-8000-000000000001';
const now = new Date('2026-01-01T00:00:00Z');
const session = { user: { id: 'usuario', email: 'ana@example.test', name: 'Ana' },
  organization: { id: 'organización-de-sesión', name: 'Equipo' }, membership: { id: 'membresía', role: 'community_manager' },
  sessionId: 'sesión-privada', createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + 3600000), renewed: false };
const valid = { name: '  ÁRBOL   Ñandú Москва ', color: '#AaBBcc' };

describe('crear empresa HTTP con servicio y logging reales, sin PostgreSQL', () => {
  let app: INestApplication;
  let output: string;
  let create: jest.SpyInstance;
  const authenticate = jest.fn();
  const insert = jest.fn();
  const run = jest.fn(async work => work({ insert } as unknown as EntityManager));
  beforeEach(async () => {
    output = ''; authenticate.mockReset().mockResolvedValue(session);
    insert.mockReset().mockResolvedValue({}); run.mockClear();
    const ids = { next: () => id };
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const module = await Test.createTestingModule({
      imports: [IdsModule, LoggerModule.forRoot({ pinoHttp: createLoggerOptions({ logLevel: 'info' }, stream, ids), useExisting: true })],
      controllers: [CompaniesController],
      providers: [CompaniesService, SessionAuthGuard, RoleGuard,
        { provide: Clock, useValue: { now: () => now } }, { provide: TransactionRunner, useValue: { run } },
        { provide: 'CompanyRepository', useValue: {} }, { provide: SessionService, useValue: { authenticate } },
        { provide: ConstraintRegistry, useValue: registerSchemaConstraints(new ConstraintRegistry()) },
        { provide: AppConfigService, useValue: { env: 'test', logLevel: 'info', allowedOrigins: [origin] } },
        { provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).overrideProvider(IdGenerator).useValue(ids).compile();
    create = jest.spyOn(module.get(CompaniesService), 'create');
    app = module.createNestApplication({ logger: false, bodyParser: false });
    await configureHttpApp(app); await app.init(); output = '';
  });
  afterEach(async () => { await app?.close(); });
  const post = () => request(app.getHttpServer()).post('/api/v1/companies').set('Origin', origin);
  const authorized = () => post().set('Cookie', cookie).set('X-CSRF-Token', csrf);
  function secure(response: request.Response) {
    expect(response.headers['cache-control']).toBe('no-store');
    expect(output).toContain('Solicitud finalizada.');
    for (const secret of [cookie, token, csrf, session.sessionId]) {
      expect(output).not.toContain(secret); expect(JSON.stringify(response.body)).not.toContain(secret);
    }
  }
  function error(response: request.Response, status: number, code: string, field?: string) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: { code, message: expect.any(String),
      requestId: response.headers['x-request-id'], ...(field ? { field } : {}) } });
    secure(response);
  }
  function untouched() { expect(run).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled(); }
  function once() { expect(run).toHaveBeenCalledTimes(1); expect(insert).toHaveBeenCalledTimes(1); }
  it('201 proyecta exactamente los valores propios normalizados', async () => {
    const response = await authorized().send(valid);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id, name: 'ÁRBOL Ñandú Москва', color: '#aabbcc', version: 1 });
    expect(response.headers.location).toBeUndefined();
    expect(insert).toHaveBeenCalledWith(expect.any(Function), { id, organizationId: session.organization.id,
      name: 'ÁRBOL Ñandú Москва', nameKey: 'arbol nandu москва', color: '#aabbcc', version: 1, createdAt: now, updatedAt: now });
    once(); secure(response);
  });
  it.each([undefined, 1, 'a', 'a'.repeat(81), 'ab\u0000', '\ud800'])('nombre inválido %p', async name => {
    error(await authorized().send({ ...valid, name }), 400, 'invalid_input', 'name'); untouched();
  });
  it.each([undefined, '#fff', '#GGGGGG', 'aabbcc', '#aabbcc ', '#aabbcc\n', 1])('color inválido %p', async color => {
    error(await authorized().send({ ...valid, color }), 400, 'invalid_input', 'color'); untouched();
  });
  it.each([{}, { name: '', color: '' }])('cuerpo vacío o ambos inválidos %p', async body => {
    error(await authorized().send(body), 400, 'invalid_input', 'name'); untouched();
  });
  it.each(['organizationId', 'id', 'version', 'nameKey', 'role', 'companyId'])('propiedad desconocida %s', async key => {
    error(await authorized().send({ ...valid, [key]: 'ajeno' }), 400, 'invalid_input'); untouched();
  });
  it.each([{ membership: { id: 'm', role: 'worker' } }, { membership: { id: 'm', role: 'client' } },
    { membership: { id: 'm', role: 'admin' } }, { organization: null }, { membership: null }, { organization: null, membership: null }])('deniega %p antes de validar y crear, aunque autenticar renueve la sesión', async change => {
    for (const body of [valid, {}]) {
      authenticate.mockClear().mockResolvedValue({ ...session, ...change, renewed: true });
      const response = await authorized().send(body);
      error(response, 403, 'forbidden');
      // La autenticación puede renovar la sesión aunque el servicio de empresas no se invoque.
      expect(response.headers['set-cookie']).toEqual([`${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`]);
      expect(authenticate).toHaveBeenCalledTimes(1); expect(create).not.toHaveBeenCalled(); untouched();
    }
  });
  it.each(['null', 'https://ajeno.test', undefined])('Origin rechazado %p', async value => {
    const req = authorized();
    if (value) req.set('Origin', value); else req.unset('Origin').set('Sec-Fetch-Site', 'same-site');
    const response = await req.send(valid); error(response, 403, 'forbidden');
    expect(authenticate).not.toHaveBeenCalled(); expect(response.headers['set-cookie']).toBeUndefined(); untouched();
  });
  it.each([undefined, 'incorrecto', `${csrf}, ${csrf}`])('CSRF rechazado %p', async value => {
    const req = post().set('Cookie', cookie);
    if (value !== undefined) req.set('X-CSRF-Token', value);
    const response = await req.send(valid); error(response, 403, 'forbidden');
    expect(authenticate).not.toHaveBeenCalled(); expect(response.headers['set-cookie']).toBeUndefined(); untouched();
  });
  it.each(['agenda_session=inválida', `${cookie}; ${cookie}`])('cookie inválida %p', async value => {
    error(await authorized().set('Cookie', value).send(valid), 401, 'unauthenticated');
    expect(authenticate).not.toHaveBeenCalled(); untouched();
  });
  it('sesión vencida borra cookie', async () => {
    authenticate.mockResolvedValue(null);
    const response = await authorized().send(valid); error(response, 401, 'unauthenticated');
    expect(response.headers['set-cookie']).toEqual([serializeClearedSessionCookie(sessionCookieConfig('test'))]);
    expect(authenticate).toHaveBeenCalledTimes(1); untouched();
  });
  it('415 precede a autenticación', async () => {
    error(await post().type('text').send('texto'), 415, 'unsupported_media_type');
    expect(authenticate).not.toHaveBeenCalled(); untouched();
  });
  it('413 para más de 100 KB', async () => {
    error(await authorized().send({ name: 'a'.repeat(110000), color: '#112233' }), 413, 'payload_too_large');
    expect(authenticate).not.toHaveBeenCalled(); untouched();
  });
  it.each([
    ['23505', 'UQ_companies_org_name_key', 409, 'conflict', 'name', undefined],
    ['23505', 'UQ_other', 409, 'conflict', undefined, undefined],
    ['23514', 'CK_companies_name', 400, 'invalid_input', 'name', undefined],
    ['23514', 'CK_companies_color', 400, 'invalid_input', 'color', undefined],
    ['55P03', undefined, 503, 'service_unavailable', undefined, '1'],
    ['57014', undefined, 503, 'service_unavailable', undefined, '2'],
    ['08006', undefined, 503, 'outcome_unknown', undefined, undefined],
  ] as const)('traduce %s / %s sin reintento', async (code, constraint, status, mapped, field, retryAfter) => {
    insert.mockRejectedValue({ severity: 'ERROR', code, constraint, table: 'companies', detail: `${cookie} ${csrf}` });
    const response = await authorized().send(valid); error(response, status, mapped, field); once();
    expect(response.headers['retry-after']).toBe(retryAfter);
    if (constraint === 'UQ_companies_org_name_key') expect(response.body.error.message).toBe('El nombre de empresa ya está registrado.');
    if (constraint === 'UQ_other') expect(response.body.error.message).not.toBe('El nombre de empresa ya está registrado.');
  });
  it('error inesperado se oculta sin reintentar', async () => {
    const failure = new Error('fallo inesperado de prueba');
    insert.mockRejectedValue(failure);
    const response = await authorized().send(valid);
    error(response, 500, 'internal_error'); once();
    expect(JSON.stringify(response.body)).not.toContain(failure.message);
    expect(response.body).not.toHaveProperty('stack');
    expect(response.body.error).not.toHaveProperty('stack');
  });
  it.each(['Error', 'QueryFailedError'] as const)('error inesperado de la dependencia con cookie y CSRF reales: el logger no los registra (%s)', async kind => {
    const body = { name: 'Canario-Empresa-7Q', color: '#7a3bc9' };
    const query = 'INSERT INTO "companies" ("name", "color") VALUES ($1, $2) /* Canario-Consulta-7Q */';
    const detail = `${body.name} ${body.color}`;
    const driverError = Object.assign(new Error('fallo inesperado de prueba'), {
      code: '42P01', detail, hint: detail, where: detail,
    });
    const failure = kind === 'Error' ? new Error('fallo inesperado de prueba')
      : new QueryFailedError(query, [body.name, body.color], driverError);
    expect(token).toHaveLength(43);
    insert.mockRejectedValue(failure);
    const response = await authorized().send(body);
    error(response, 500, 'internal_error'); once();
    expect(insert).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining(body));
    for (const marker of [failure.message, query, 'Canario-Consulta-7Q', body.name, body.color, detail, '42P01']) {
      expect(JSON.stringify(response.body)).not.toContain(marker);
    }
    for (const marker of [query, 'Canario-Consulta-7Q', body.name, body.color, detail]) expect(output).not.toContain(marker);
    // El servicio traduce el fallo SQL; el filtro lo registra como error de base de datos.
    expect(output).toContain(kind === 'Error' ? 'Error de solicitud.' : 'Error interno de base de datos.');
  });

  // El logger sanea palabras clave y secretos registrados, y las rutas
  // query/parameters/driverError/detail/hint/where; no reconoce nombres de cookie,
  // valores CSRF ni texto arbitrario en message. La aplicación usa mensajes fijos:
  // no interpola cabeceras ni tokens, por lo que esta fuga no es alcanzable desde
  // este flujo. Si el saneador cubre estos casos, la prueba B fallará y deberá actualizarse.
  it.each([
    { label: 'cookie y CSRF deliberados en message se conservan', message: `${cookie} ${csrf}`, leaked: true },
    { label: 'token=VALOR en message se redacta', message: 'token=Canario-Secreto-7Q', leaked: false },
  ])('LIMITACIÓN CONOCIDA: $label', async ({ message, leaked }) => {
    insert.mockRejectedValue(new Error(message));
    const response = await authorized().send(valid);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: 'internal_error', message: expect.any(String),
      requestId: response.headers['x-request-id'] } });
    expect(response.headers['cache-control']).toBe('no-store');
    for (const secret of [message, cookie, token, csrf, session.sessionId, 'Canario-Secreto-7Q']) {
      expect(JSON.stringify(response.body)).not.toContain(secret);
    }
    expect(output).toContain('Error de solicitud.');
    expect(output).toContain('Solicitud finalizada.');
    expect(output).not.toContain(session.sessionId);
    if (leaked) {
      expect(output).toContain(message);
      expect(output).toContain(token);
      expect(output).toContain(csrf);
    } else {
      secure(response);
      expect(output).not.toContain('Canario-Secreto-7Q');
      expect(output).toContain('token=[REDACTED]');
    }
    once();
  });
});
