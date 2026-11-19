import { STALE } from '../database/errors/database-http';
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
import { CompaniesService, UPDATE_COMPANY_SQL, SELECT_COMPANY_SQL } from './companies.service';
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
const valid = { version: 1, name: '  ÁRBOL   Ñandú Москва ', color: '#AaBBcc' };

describe('editar empresa HTTP con servicio y logging reales, sin PostgreSQL', () => {
  let app: INestApplication;
  let output: string;
  let update: jest.SpyInstance;
  const authenticate = jest.fn();
  type Row = { id: string; organizationId: string; name: string; nameKey: string; color: string; version: number };
  let rows: Row[];
  let between: (() => void) | undefined;
  const project = ({ id, name, color, version }: Row) => ({ id, name, color, version });
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    const [target, organizationId, name, nameKey, color, , version] = params;
    if (sql === SELECT_COMPANY_SQL) {
      between?.(); between = undefined;
      return rows.filter(row => row.id === target && row.organizationId === organizationId).map(project);
    }
    if (sql !== UPDATE_COMPANY_SQL) throw new Error('Consulta inesperada.');
    const row = rows.find(row => row.id === target && row.organizationId === organizationId && row.version === version);
    if (!row || (row.name === (name ?? row.name) && row.color === (color ?? row.color))) return [[], 0];
    if (rows.some(other => other.id !== row.id && other.organizationId === organizationId && other.nameKey === (nameKey ?? row.nameKey))) {
      throw { severity: 'ERROR', code: '23505', constraint: 'UQ_companies_org_name_key' };
    }
    row.name = (name ?? row.name) as string; row.nameKey = (nameKey ?? row.nameKey) as string;
    row.color = (color ?? row.color) as string; row.version++;
    return [[project(row)], 1];
  });
  const run = jest.fn(async work => work({ query } as unknown as EntityManager));
  beforeEach(async () => {
    output = ''; authenticate.mockReset().mockResolvedValue(session);
    query.mockClear(); run.mockClear(); between = undefined;
    rows = [{ id, organizationId: session.organization.id, name: 'Empresa original', nameKey: 'empresa original', color: '#112233', version: 1 }];
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
    update = jest.spyOn(module.get(CompaniesService), 'update');
    app = module.createNestApplication({ logger: false, bodyParser: false });
    await configureHttpApp(app); await app.init(); output = '';
  });
  afterEach(async () => { await app?.close(); });
  const post = () => request(app.getHttpServer()).patch(`/api/v1/companies/${id}`).set('Origin', origin);
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
    for (const name of [valid.name, 'ÁRBOL Ñandú Москва', 'Canario-Empresa-7Q']) {
      expect(output).not.toContain(name); expect(JSON.stringify(response.body)).not.toContain(name);
    }
  }
  function untouched() { expect(run).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled(); }
  function once() { expect(run).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(1); }
  it.each([
    [{ version: 1, name: valid.name }, 'ÁRBOL Ñandú Москва', '#112233', 'arbol nandu москва', null],
    [{ version: 1, color: valid.color }, 'Empresa original', '#aabbcc', null, '#aabbcc'],
    [valid, 'ÁRBOL Ñandú Москва', '#aabbcc', 'arbol nandu москва', '#aabbcc'],
  ])('edición parcial %p conserva lo omitido', async (body, name, color, key, colorParam) => {
    const response = await authorized().send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id, name, color, version: 2 });
    expect(response.headers.location).toBeUndefined();
    expect(query).toHaveBeenCalledWith(UPDATE_COMPANY_SQL, [id, session.organization.id,
      key === null ? null : name, key, colorParam, now, 1]);
    once(); secure(response); expect(rows[0].version).toBe(2);
  });
  it.each([undefined, null, 0, -1, 1.5, '1', 2147483648])('versión inválida %p', async version => {
    error(await authorized().send({ ...valid, version }), 400, 'invalid_input', 'version'); untouched();
  });
  it.each(['name', 'color', 'version'])('null explícito en %s', async field => {
    error(await authorized().send({ ...valid, [field]: null }), 400, 'invalid_input', field); untouched();
  });
  it.each(['a', 'a'.repeat(81), 'ab\u0000', '\ud800'])('nombre inválido tras normalizar %p', async name => {
    error(await authorized().send({ version: 1, name }), 400, 'invalid_input', 'name'); untouched();
  });
  it.each(['#fff', '#GGGGGG', 'aabbcc', '#aabbcc ', '#aabbcc\n'])('color inválido tras normalizar %p', async color => {
    error(await authorized().send({ version: 1, color }), 400, 'invalid_input', 'color'); untouched();
  });
  it('requiere algún cambio', async () => {
    error(await authorized().send({ version: 1 }), 400, 'invalid_input'); untouched();
  });
  it.each(['organizationId', 'id', 'nameKey', 'role', 'companyId'])('rechaza propiedad desconocida %s', async key => {
    error(await authorized().send({ ...valid, [key]: 'ajeno' }), 400, 'invalid_input'); untouched();
    error(await authorized().query({ [key]: 'ajeno' }).send(valid), 400, 'invalid_input'); untouched();
  });
  it('duplicado no modifica la fila ni diagnostica', async () => {
    rows.push({ ...rows[0], id: '01900000-0000-7000-8000-000000000002', name: 'Otra', nameKey: 'otra' });
    const before = structuredClone(rows);
    const response = await authorized().send({ version: 1, name: 'ÓTRA' });
    error(response, 409, 'conflict', 'name');
    expect(response.body.error.message).toBe('El nombre de empresa ya está registrado.');
    expect(rows).toEqual(before); once();
  });
  it('permite cambiar capitalización y acentos de la misma clave', async () => {
    const response = await authorized().send({ version: 1, name: 'ÉMPRESA ORIGINAL' });
    expect(response.status).toBe(200); expect(response.body.version).toBe(2);
    expect(rows[0].nameKey).toBe('empresa original'); once(); secure(response);
  });
  it('empresa ajena e inexistente son indistinguibles', async () => {
    rows[0].organizationId = 'otra-organización';
    const before = structuredClone(rows);
    const foreign = await authorized().send(valid);
    error(foreign, 404, 'not_found'); expect(rows).toEqual(before);
    rows = [];
    const absent = await authorized().send(valid);
    error(absent, 404, 'not_found'); expect(absent.body).toEqual(foreign.body);
    expect(query.mock.calls).toEqual([
      [UPDATE_COMPANY_SQL, [id, session.organization.id, 'ÁRBOL Ñandú Москва', 'arbol nandu москва', '#aabbcc', now, 1]],
      [SELECT_COMPANY_SQL, [id, session.organization.id]],
      [UPDATE_COMPANY_SQL, [id, session.organization.id, 'ÁRBOL Ñandú Москва', 'arbol nandu москва', '#aabbcc', now, 1]],
      [SELECT_COMPANY_SQL, [id, session.organization.id]],
    ]);
  });
  it.each(['01900000-0000-7000-8000-00000000000A', 'texto', '01900000-0000-0000-8000-000000000001'])('id no canónico %s', async target => {
    const patch = () => request(app.getHttpServer()).patch(`/api/v1/companies/${target}`).set('Origin', origin).set('Cookie', cookie).set('X-CSRF-Token', csrf);
    error(await patch().send(valid), 404, 'not_found'); untouched();
    error(await patch().send({ version: null }), 400, 'invalid_input', 'version'); untouched();
    error(await patch().send({ version: 1 }), 400, 'invalid_input'); untouched();
  });
  it('versión desactualizada prevalece incluso si los valores coinciden', async () => {
    rows[0].version = 2;
    const response = await authorized().send({ version: 1, name: rows[0].name });
    error(response, 409, 'conflict'); expect(response.body.error.message).toBe(STALE);
    expect(run).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(2);
  });
  it('dos ediciones secuenciales con la misma versión solo escriben una vez', async () => {
    expect((await authorized().send(valid)).status).toBe(200);
    error(await authorized().send(valid), 409, 'conflict');
    expect(rows[0].version).toBe(2); expect(run).toHaveBeenCalledTimes(2); expect(query).toHaveBeenCalledTimes(3);
  });
  it.each([{ version: 1, name: '  Empresa   original  ' }, { version: 1, color: '#112233' }])('sin cambios %p no incrementa versión', async body => {
    const response = await authorized().send(body);
    expect(response.status).toBe(200); expect(response.body).toEqual(project(rows[0]));
    expect(rows[0].version).toBe(1); expect(run).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2); secure(response);
  });
  it.each(['desactualizada', 'sin cambios', 'imposible', 'eliminada'])('carrera entre UPDATE y SELECT: %s', async kind => {
    if (kind === 'desactualizada') rows[0].version = 2;
    between = () => {
      if (kind === 'eliminada') { rows = []; return; }
      rows[0].name = 'Cambio concurrente';
      if (kind !== 'imposible') rows[0].version++;
    };
    const response = await authorized().send({ version: 1, name: 'Empresa original' });
    error(response, kind === 'eliminada' ? 404 : 409, kind === 'eliminada' ? 'not_found' : 'conflict');
    if (kind !== 'eliminada') expect(response.body.error.message).toBe(STALE);
    expect(run).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(2);
  });
  it.each([{ membership: { id: 'm', role: 'worker' } }, { membership: { id: 'm', role: 'client' } },
    { membership: { id: 'm', role: 'admin' } }, { organization: null }, { membership: null }, { organization: null, membership: null }])('deniega %p antes de validar y editar, aunque autenticar renueve la sesión', async change => {
    for (const body of [valid, {}]) {
      authenticate.mockClear().mockResolvedValue({ ...session, ...change, renewed: true });
      const response = await authorized().send(body);
      error(response, 403, 'forbidden');
      // La autenticación puede renovar la sesión aunque el servicio de empresas no se invoque.
      expect(response.headers['set-cookie']).toEqual([`${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`]);
      expect(authenticate).toHaveBeenCalledTimes(1); expect(update).not.toHaveBeenCalled(); untouched();
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
    query.mockRejectedValueOnce({ severity: 'ERROR', code, constraint, table: 'companies', detail: `${cookie} ${csrf}` });
    const response = await authorized().send(valid); error(response, status, mapped, field); once();
    expect(response.headers['retry-after']).toBe(retryAfter);
    if (constraint === 'UQ_companies_org_name_key') expect(response.body.error.message).toBe('El nombre de empresa ya está registrado.');
    if (constraint === 'UQ_other') expect(response.body.error.message).not.toBe('El nombre de empresa ya está registrado.');
  });
  it('conexión perdida durante la confirmación conserva resultado incierto sin reintentar', async () => {
    run.mockImplementationOnce(async work => {
      await work({ query } as unknown as EntityManager);
      throw { severity: 'ERROR', code: '08006' };
    });
    const response = await authorized().send(valid);
    error(response, 503, 'outcome_unknown'); once();
    expect(response.headers['retry-after']).toBeUndefined();
    expect(rows[0].version).toBe(2);
  });
  it('error inesperado se oculta sin reintentar', async () => {
    const failure = new Error('fallo inesperado de prueba');
    query.mockRejectedValueOnce(failure);
    const response = await authorized().send(valid);
    error(response, 500, 'internal_error'); once();
    expect(JSON.stringify(response.body)).not.toContain(failure.message);
    expect(response.body).not.toHaveProperty('stack');
    expect(response.body.error).not.toHaveProperty('stack');
  });
  it.each(['Error', 'QueryFailedError'] as const)('error inesperado de la dependencia con cookie y CSRF reales: el logger no los registra (%s)', async kind => {
    const body = { version: 1, name: 'Canario-Empresa-7Q', color: '#7a3bc9' };
    const sql = 'UPDATE "companies" SET "name" = $1, "color" = $2 /* Canario-Consulta-7Q */';
    const detail = `${body.name} ${body.color}`;
    const driverError = Object.assign(new Error('fallo inesperado de prueba'), {
      code: '42P01', detail, hint: detail, where: detail,
    });
    const failure = kind === 'Error' ? new Error('fallo inesperado de prueba')
      : new QueryFailedError(sql, [body.name, body.color], driverError);
    expect(token).toHaveLength(43);
    query.mockRejectedValueOnce(failure);
    const response = await authorized().send(body);
    error(response, 500, 'internal_error'); once();
    expect(query).toHaveBeenCalledWith(UPDATE_COMPANY_SQL, [id, session.organization.id, body.name, 'canario-empresa-7q', body.color, now, 1]);
    for (const marker of [failure.message, sql, 'Canario-Consulta-7Q', body.name, body.color, detail, '42P01']) {
      expect(JSON.stringify(response.body)).not.toContain(marker);
    }
    for (const marker of [sql, 'Canario-Consulta-7Q', body.name, body.color, detail]) expect(output).not.toContain(marker);
    // El servicio traduce el fallo SQL; el filtro lo registra como error de base de datos.
    expect(output).toContain(kind === 'Error' ? 'Error de solicitud.' : 'Error interno de base de datos.');
  });

});
