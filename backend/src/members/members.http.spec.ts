import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { Writable } from 'node:stream';
import request from 'supertest';
import { QueryFailedError } from 'typeorm';
import { RoleGuard } from '../auth/role.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { SessionService } from '../auth/session.service';
import { Clock } from '../common/clock/clock';
import { AllExceptionsFilter } from '../common/errors/all-exceptions.filter';
import { configureHttpApp } from '../common/http/configure-http-app';
import { serializeClearedSessionCookie, sessionCookieConfig } from '../common/http/cookies';
import { IdGenerator } from '../common/ids/id-generator';
import { IdsModule } from '../common/ids/ids.module';
import { AppConfigService } from '../config/app-config.service';
import { ConstraintRegistry } from '../database/errors/constraint-registry';
import { registerSchemaConstraints } from '../database/errors/register-schema-constraints';
import { deriveCsrfToken, generateSessionToken } from '../identity/session-token';
import { createLoggerOptions } from '../logging/logger-options';
import { TransactionRunner } from '../registration/transaction-runner';
import { BUMP_MEMBER_VERSION_SQL, INSERT_ACCESSES_SQL, LOCK_MEMBER_SQL } from './member-sql';
import { MembersController, publicAccessUpdate, publicMember } from './members.controller';
import { MembersService } from './members.service';
import { FakeMembersDb, type FakeMembership } from './testing/fake-db';

const sessionToken = generateSessionToken(() => Buffer.alloc(32, 7));
const cookie = `agenda_session=${sessionToken}`;
const csrf = deriveCsrfToken(sessionToken);
const ORIGIN = 'https://permitido.test';
const uuid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = uuid(0xa0); const OTHER_ORG = uuid(0xb0);
const NOW = new Date('2026-11-26T12:00:00.000Z'); const CREATED = new Date('2026-11-01T00:00:00.000Z');
const C = [uuid(11), uuid(12), uuid(13)]; const FOREIGN = uuid(99);
const WORKER = uuid(1), CLIENT = uuid(2), GONE = uuid(3), ALIEN = uuid(4), MANAGER = uuid(0xc0);
const session = { user: { id: uuid(0xd0), email: 'gestora@example.test', name: 'Gestora' }, organization: { id: ORG, name: 'Equipo' },
  membership: { id: MANAGER, role: 'community_manager' }, sessionId: 'sesión-privada', createdAt: NOW, lastSeenAt: NOW, expiresAt: new Date(NOW.getTime() + 3_600_000), renewed: false };
const SENSITIVE = ['Canario-Nombre-Trabajador', 'canario-worker@example.com', 'Canario-Nombre-Cliente', 'canario-client@example.com', 'Canario-Nombre-Ajeno', 'canario-alien@example.com'];
const BASE = '/api/v1/members';

describe('miembros HTTP con servicio y logging reales, sin PostgreSQL', () => {
  let app: INestApplication;
  let output: string;
  let db: FakeMembersDb;
  let update: jest.SpyInstance;
  let list: jest.SpyInstance;
  const authenticate = jest.fn();
  beforeEach(async () => {
    output = ''; db = new FakeMembersDb();
    db.companies.set(ORG, new Set(C)); db.companies.set(OTHER_ORG, new Set([FOREIGN]));
    const add = (id: string, extra: Partial<FakeMembership>) => db.memberships.set(id, { id, organizationId: ORG, name: 'N', email: 'n@example.com', role: 'worker', version: 3,
      deactivatedAt: null, createdAt: CREATED, updatedAt: CREATED, ...extra });
    add(WORKER, { name: SENSITIVE[0], email: SENSITIVE[1] }); add(CLIENT, { name: SENSITIVE[2], email: SENSITIVE[3], role: 'client' });
    add(MANAGER, { name: 'Gestora', email: 'gestora@example.test', role: 'community_manager', version: 1 });
    add(GONE, { deactivatedAt: CREATED }); add(ALIEN, { organizationId: OTHER_ORG, name: SENSITIVE[4], email: SENSITIVE[5] });
    db.accesses.push({ membershipId: WORKER, companyId: C[0], organizationId: ORG, role: 'worker', createdAt: CREATED }, { membershipId: WORKER, companyId: C[1], organizationId: ORG, role: 'worker', createdAt: CREATED },
      { membershipId: ALIEN, companyId: FOREIGN, organizationId: OTHER_ORG, role: 'worker', createdAt: CREATED });
    authenticate.mockReset().mockResolvedValue(session);
    let next = 0; const ids = { next: () => `peticion-${++next}` };
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const module = await Test.createTestingModule({
      imports: [IdsModule, LoggerModule.forRoot({ pinoHttp: createLoggerOptions({ logLevel: 'info' }, stream, ids), useExisting: true })],
      controllers: [MembersController],
      providers: [MembersService, SessionAuthGuard, RoleGuard, { provide: Clock, useValue: { now: () => NOW } }, { provide: TransactionRunner, useValue: db.runner },
        { provide: SessionService, useValue: { authenticate } }, { provide: ConstraintRegistry, useValue: registerSchemaConstraints(new ConstraintRegistry()) },
        { provide: AppConfigService, useValue: { env: 'test', logLevel: 'info', allowedOrigins: [ORIGIN] } }, { provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).overrideProvider(IdGenerator).useValue(ids).compile();
    update = jest.spyOn(module.get(MembersService), 'updateAccesses');
    list = jest.spyOn(module.get(MembersService), 'list');
    app = module.createNestApplication({ logger: false, bodyParser: false });
    await configureHttpApp(app); await app.init(); output = '';
  });
  afterEach(async () => { await app?.close(); jest.restoreAllMocks(); });

  const http = () => request(app.getHttpServer());
  const get = (query = '') => http().get(`${BASE}${query}`).set('Cookie', cookie);
  const put = (id: string, body: object) => http().put(`${BASE}/${id}/accesses`).set('Origin', ORIGIN).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(body);
  const change = (version: number, companyIds: string[]) => ({ version, companyIds });
  const writes = () => db.statements.filter(s => /^(INSERT|UPDATE|DELETE)/.test(s.sql));

  function secure(response: request.Response) {
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(output).toContain('Solicitud finalizada.');
    for (const secret of [cookie, sessionToken, csrf, session.sessionId, ...SENSITIVE]) expect(output).not.toContain(secret);
    for (const secret of [cookie, sessionToken, csrf, session.sessionId]) expect(response.text).not.toContain(secret);
    expect(response.text).not.toMatch(/organizationId|organization_id|updatedAt|updated_at|deactivatedAt|deactivated_at|passwordHash|password_hash|userId|user_id/);
  }
  function error(response: request.Response, status: number, code: string, field?: string) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: { code, message: expect.any(String), requestId: response.headers['x-request-id'], ...(field ? { field } : {}) } });
    for (const secret of SENSITIVE) expect(response.text).not.toContain(secret);
    secure(response);
  }

  describe('listar', () => {
    it('200 con la proyección explícita, solo activos de la organización de la sesión, ordenados por id', async () => {
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.body.items.map((i: { id: string }) => i.id)).toEqual([WORKER, CLIENT, MANAGER]);
      expect(response.body.items[0]).toEqual({ id: WORKER, user: { name: SENSITIVE[0], email: SENSITIVE[1] }, role: 'worker', status: 'active', version: 3,
        companyAccess: 'assigned', companyIds: [C[0], C[1]], createdAt: CREATED.toISOString() });
      expect(response.body.items[2]).toMatchObject({ companyAccess: 'all', companyIds: [] });
      expect(Object.keys(response.body)).toEqual(['items', 'nextCursor']);
      expect(response.text).not.toContain(SENSITIVE[4]); expect(response.text).not.toContain(FOREIGN);
      secure(response);
    });
    it('filtros y paginación por HTTP', async () => {
      expect((await get('?status=deactivated')).body.items.map((i: { id: string }) => i.id)).toEqual([GONE]);
      expect((await get('?status=all')).body.items).toHaveLength(4);
      expect((await get('?role=client')).body.items.map((i: { id: string }) => i.id)).toEqual([CLIENT]);
      const first = await get('?limit=2'); expect(first.body.items).toHaveLength(2);
      const second = await get(`?limit=2&cursor=${first.body.nextCursor}`);
      expect([...first.body.items, ...second.body.items].map((i: { id: string }) => i.id)).toEqual([WORKER, CLIENT, MANAGER]);
      expect(second.body.nextCursor).toBeNull();
    });
    it('aislamiento: la organización sale de la sesión', async () => {
      authenticate.mockResolvedValue({ ...session, organization: { id: OTHER_ORG, name: 'Otro' } });
      const response = await get();
      expect(response.body.items.map((i: { id: string }) => i.id)).toEqual([ALIEN]);
      expect(response.text).not.toContain(SENSITIVE[0]); expect(response.text).not.toContain(C[0]);
    });
    it.each([['?status=inactive', 'status'], ['?role=admin', 'role'], ['?limit=0', 'limit'], ['?limit=101', 'limit'], ['?cursor=basura', 'cursor'], [`?organizationId=${OTHER_ORG}`, undefined], ['?extra=1', undefined]])(
      '400 con %s', async (query, field) => { error(await get(query), 400, 'invalid_input', field); expect(db.runs).toBe(0); });
  });

  describe('cambiar accesos', () => {
    it('200 con la respuesta explícita y una sola subida de versión', async () => {
      const response = await put(WORKER, change(3, [C[2], C[1]]));
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ id: WORKER, role: 'worker', version: 4, companyIds: [C[1], C[2]] });
      expect(db.accessesOf(WORKER)).toEqual([C[1], C[2]]);
      secure(response);
    });
    it('el mismo conjunto en otro orden: 200 sin ninguna escritura ni cambio de versión', async () => {
      const response = await put(WORKER, change(3, [C[1], C[0]]));
      expect(response.status).toBe(200); expect(response.body).toEqual({ id: WORKER, role: 'worker', version: 3, companyIds: [C[0], C[1]] });
      expect(writes()).toEqual([]); expect(db.memberships.get(WORKER)!.updatedAt).toEqual(CREATED);
      secure(response);
    });
    it('[] retira todos los accesos y el miembro sigue activo', async () => {
      const response = await put(WORKER, change(3, []));
      expect(response.status).toBe(200); expect(response.body).toEqual({ id: WORKER, role: 'worker', version: 4, companyIds: [] });
      expect(db.accessesOf(WORKER)).toEqual([]);
      const listed = (await get()).body.items.find((i: { id: string }) => i.id === WORKER);
      expect(listed).toMatchObject({ status: 'active', companyAccess: 'assigned', companyIds: [], version: 4 });
    });
    it('versión desactualizada: 409 aunque el conjunto coincida', async () => {
      error(await put(WORKER, change(2, [C[0], C[1]])), 409, 'version_conflict'); expect(writes()).toEqual([]);
      error(await put(WORKER, change(4, [C[2]])), 409, 'version_conflict');
    });
    it('409 distinguibles: community manager y desactivado', async () => {
      error(await put(MANAGER, change(1, [C[0]])), 409, 'member_not_assignable');
      error(await put(GONE, change(3, [C[0]])), 409, 'member_deactivated');
      expect(writes()).toEqual([]);
    });
    it('miembro ajeno, inexistente y mal formado: el mismo 404', async () => {
      const bodies = [];
      for (const id of [ALIEN, uuid(0x999), 'no-es-uuid', ALIEN.toUpperCase()]) {
        const response = await put(id, change(3, [C[0]])); error(response, 404, 'not_found'); bodies.push({ ...response.body.error, requestId: undefined });
      }
      for (const body of bodies) expect(body).toEqual(bodies[0]);
      expect(db.accessesOf(ALIEN)).toEqual([FOREIGN]);
    });
    it('empresa ajena o inexistente: el mismo 400 sin cambios', async () => {
      const foreign = await put(WORKER, change(3, [FOREIGN])); error(foreign, 400, 'invalid_input', 'companyIds');
      const missing = await put(WORKER, change(3, [uuid(0x888)])); error(missing, 400, 'invalid_input', 'companyIds');
      expect(foreign.body.error.message).toBe(missing.body.error.message);
      expect(writes()).toEqual([]); expect(db.accessesOf(WORKER)).toEqual([C[0], C[1]]);
    });
    it.each([[{}, 'version'], [{ version: 3 }, 'companyIds'], [{ companyIds: [] }, 'version'], [{ version: 0, companyIds: [] }, 'version'], [{ version: '3', companyIds: [] }, 'version'],
      [{ version: 3, companyIds: 'x' }, 'companyIds'], [{ version: 3, companyIds: [5] }, 'companyIds'], [{ version: 3, companyIds: [C[0], C[0]] }, 'companyIds'],
      [{ version: 3, companyIds: Array.from({ length: 51 }, (_, i) => uuid(i + 100)) }, 'companyIds'], [{ version: 3, companyIds: ['no-es-uuid'] }, 'companyIds']])(
      '400 con el cuerpo %p', async (body, field) => { error(await put(WORKER, body), 400, 'invalid_input', field); expect(db.runs).toBe(0); });
    it.each(['organizationId', 'role', 'membershipId', 'userId', 'deactivatedAt', 'updatedAt'])('400 por el campo desconocido %s', async key => {
      error(await put(WORKER, { ...change(3, []), [key]: 'x' }), 400, 'invalid_input'); expect(update).not.toHaveBeenCalled(); expect(db.runs).toBe(0);
    });
    it('400 con query string, 415 sin JSON y 413 por tamaño', async () => {
      error(await http().put(`${BASE}/${WORKER}/accesses?x=1`).set('Origin', ORIGIN).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(change(3, [])), 400, 'invalid_input');
      error(await http().put(`${BASE}/${WORKER}/accesses`).set('Origin', ORIGIN).set('Cookie', cookie).set('X-CSRF-Token', csrf).type('text').send('x'), 415, 'unsupported_media_type');
      error(await put(WORKER, { version: 3, companyIds: ['a'.repeat(120_000)] }), 413, 'payload_too_large');
      expect(db.runs).toBe(0);
    });
    it('las proyecciones solo copian los campos del contrato', () => {
      expect(Object.keys(publicMember({ id: '1', user: { name: 'n', email: 'e', id: 'x' } as never, role: 'worker', status: 'active', version: 1, companyAccess: 'assigned', companyIds: [], createdAt: 'z', organizationId: 'x' } as never)))
        .toEqual(['id', 'user', 'role', 'status', 'version', 'companyAccess', 'companyIds', 'createdAt']);
      expect(publicAccessUpdate({ id: '1', role: 'client', version: 2, companyIds: ['a'], updatedAt: 'x' } as never)).toEqual({ id: '1', role: 'client', version: 2, companyIds: ['a'] });
    });
  });

  describe('controles de acceso, en el orden existente', () => {
    const routes: [string, 'get' | 'put', string][] = [['listar', 'get', BASE], ['cambiar', 'put', `${BASE}/${WORKER}/accesses`]];
    const call = (method: 'get' | 'put', path: string, headers: Record<string, string>) => {
      const req = http()[method](path);
      for (const [name, value] of Object.entries(headers)) req.set(name, value);
      return method === 'put' ? req.send(change(3, [])) : req;
    };
    const full = { Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': csrf };
    const untouched = () => { expect(db.runs).toBe(0); expect(update).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); };
    it.each(routes)('%s sin cookie: 401', async (_n, method, path) => {
      error(await call(method, path, { Origin: ORIGIN, 'X-CSRF-Token': csrf }), 401, 'unauthenticated'); expect(authenticate).not.toHaveBeenCalled(); untouched();
    });
    it('cambiar sin CSRF o con CSRF incorrecto: 403 antes de autenticar', async () => {
      for (const headers of [{ Origin: ORIGIN, Cookie: cookie }, { Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': 'incorrecto' }, { Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': `${csrf}, ${csrf}` }]) {
        error(await call('put', routes[1][2], headers as Record<string, string>), 403, 'forbidden');
      }
      expect(authenticate).not.toHaveBeenCalled(); untouched();
    });
    it.each(routes)('%s con Origin ajeno: 403 antes de autenticar', async (_n, method, path) => {
      for (const origin of ['null', 'https://ajeno.test']) error(await call(method, path, { ...full, Origin: origin }), 403, 'forbidden');
      expect(authenticate).not.toHaveBeenCalled(); untouched();
    });
    it.each(routes)('%s con cookie inválida o sesión vencida: 401', async (_n, method, path) => {
      const invalid = await call(method, path, { ...full, Cookie: 'agenda_session=nada' });
      error(invalid, 401, 'unauthenticated'); expect(invalid.headers['set-cookie']).toEqual([serializeClearedSessionCookie(sessionCookieConfig('test'))]);
      authenticate.mockResolvedValue(null);
      error(await call(method, path, full), 401, 'unauthenticated'); untouched();
    });
    it.each(routes)('%s: solo community manager; worker, client, rol desconocido o sin organización reciben 403', async (_n, method, path) => {
      for (const change_ of [{ membership: { id: 'm', role: 'worker' } }, { membership: { id: 'm', role: 'client' } }, { membership: { id: 'm', role: 'admin' } }, { organization: null }, { membership: null }]) {
        authenticate.mockResolvedValue({ ...session, ...change_ });
        error(await call(method, path, full), 403, 'forbidden');
      }
      untouched();
    });
  });

  describe('errores de base y no-store', () => {
    it('bloqueo agotado: 503 con Retry-After; commit incierto: outcome_unknown sin reintento', async () => {
      db.failOn = sql => (sql === LOCK_MEMBER_SQL ? { severity: 'ERROR', code: '55P03' } : null);
      const locked = await put(WORKER, change(3, [])); error(locked, 503, 'service_unavailable'); expect(locked.headers['retry-after']).toBe('1');
      db.failOn = null; const runs = db.runs;
      db.commitFailure = { error: { severity: 'ERROR', code: '08006', message: SENSITIVE[1] }, applied: true };
      error(await put(WORKER, change(3, [])), 503, 'outcome_unknown');
      expect(db.runs).toBe(runs + 1);
    });
    it('un fallo de base con parámetros: rollback, sin datos en respuesta ni log', async () => {
      db.failOn = (sql, params) => (sql === INSERT_ACCESSES_SQL
        ? new QueryFailedError(sql, params, Object.assign(new Error('x'), { code: '23514', severity: 'ERROR', detail: SENSITIVE.join(' '), parameters: params })) : null);
      error(await put(WORKER, change(3, [C[2]])), 400, 'invalid_input');
      expect(db.accessesOf(WORKER)).toEqual([C[0], C[1]]); expect(db.memberships.get(WORKER)!.version).toBe(3);
    });
    it('error inesperado: 500 genérico', async () => {
      db.failOn = sql => (sql === BUMP_MEMBER_VERSION_SQL ? new Error('fallo sin relación') : null);
      error(await put(WORKER, change(3, [])), 500, 'internal_error');
      expect(db.accessesOf(WORKER)).toEqual([C[0], C[1]]);
    });
    it('Cache-Control: no-store también en rutas inexistentes y métodos no admitidos bajo el prefijo', async () => {
      for (const response of [await http().get(`${BASE}/${WORKER}`), await http().delete(BASE), await http().post(BASE), await http().patch(`${BASE}/${WORKER}/accesses`), await http().get(`${BASE}/x/y/z`)]) {
        expect(response.status).toBeGreaterThanOrEqual(400); expect(response.headers['cache-control']).toBe('no-store');
      }
    });
  });
});
