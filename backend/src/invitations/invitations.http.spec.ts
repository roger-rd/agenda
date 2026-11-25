import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { Writable } from 'node:stream';
import request from 'supertest';
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
import { InvitationsController } from './invitations.controller';
import { InvitationsService, INSERT_INVITATION_COMPANIES_SQL, INSERT_INVITATION_SQL } from './invitations.service';
import { hashInvitationToken, InvitationTokens } from './invitation-token';
import { FakeDb } from './testing/fake-db';

const sessionToken = generateSessionToken(() => Buffer.alloc(32, 7));
const cookie = `agenda_session=${sessionToken}`;
const csrf = deriveCsrfToken(sessionToken);
const origin = 'https://permitido.test';
const uuid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = uuid(0xa0); const OTHER_ORG = uuid(0xb0); const MEMBERSHIP = uuid(0xc0);
const now = new Date('2026-01-01T00:00:00.000Z');
const session = { user: { id: uuid(0xd0), email: 'ana@example.test', name: 'Ana' }, organization: { id: ORG, name: 'Equipo' },
  membership: { id: MEMBERSHIP, role: 'community_manager' }, sessionId: 'sesión-privada', createdAt: now, lastSeenAt: now,
  expiresAt: new Date(now.getTime() + 3_600_000), renewed: false };
const valid = { email: 'Nuevo@Example.com', role: 'worker', companyIds: [uuid(1), uuid(2)] };
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

describe('invitaciones HTTP con servicio y logging reales, sin PostgreSQL', () => {
  let app: INestApplication;
  let output: string;
  let db: FakeDb;
  let tick: number;
  const authenticate = jest.fn();
  beforeEach(async () => {
    output = ''; tick = 0; db = new FakeDb();
    db.companies.set(ORG, new Set([uuid(1), uuid(2), uuid(3)])); db.companies.set(OTHER_ORG, new Set([uuid(9)]));
    authenticate.mockReset().mockResolvedValue(session);
    let next = 0x1000; let tokens = 0;
    const ids = { next: () => uuid(next++) };
    const tokenSource: InvitationTokens = { next: () => Buffer.alloc(32, ++tokens + 40).toString('base64url') };
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const module = await Test.createTestingModule({
      imports: [IdsModule, LoggerModule.forRoot({ pinoHttp: createLoggerOptions({ logLevel: 'info' }, stream, ids), useExisting: true })],
      controllers: [InvitationsController],
      providers: [InvitationsService, SessionAuthGuard, RoleGuard,
        { provide: Clock, useValue: { now: () => new Date(now.getTime() + 1000 * tick) } }, { provide: TransactionRunner, useValue: db.runner },
        { provide: InvitationTokens, useValue: tokenSource }, { provide: SessionService, useValue: { authenticate } },
        { provide: ConstraintRegistry, useValue: registerSchemaConstraints(new ConstraintRegistry()) },
        { provide: AppConfigService, useValue: { env: 'test', logLevel: 'info', allowedOrigins: [origin] } },
        { provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).overrideProvider(IdGenerator).useValue(ids).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    await configureHttpApp(app); await app.init(); output = '';
  });
  afterEach(async () => { await app?.close(); });

  const base = '/api/v1/invitations';
  const http = () => request(app.getHttpServer());
  const write = (method: 'post', path: string) => http()[method](path).set('Origin', origin).set('Cookie', cookie).set('X-CSRF-Token', csrf);
  const create = (body: object = valid) => write('post', base).send(body);
  const renew = (id: string, body: object = {}) => write('post', `${base}/${id}/renew`).send(body);
  const revoke = (id: string) => write('post', `${base}/${id}/revoke`);
  const list = (query = '') => http().get(`${base}${query}`).set('Cookie', cookie);
  const issued: string[] = [];
  const remember = (response: request.Response) => { if (typeof response.body?.token === 'string') issued.push(response.body.token, response.body.link); return response; };

  function secure(response: request.Response) {
    expect(response.headers['cache-control']).toBe('no-store');
    expect(output).toContain('Solicitud finalizada.');
    for (const secret of [cookie, sessionToken, csrf, session.sessionId, ...issued]) {
      expect(output).not.toContain(secret);
    }
  }
  function error(response: request.Response, status: number, code: string, field?: string) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: { code, message: expect.any(String), requestId: response.headers['x-request-id'], ...(field ? { field } : {}) } });
    expect(JSON.stringify(response.body)).not.toMatch(/"token"|tokenHash|token_hash|#/);
    secure(response);
  }
  const untouched = () => { expect(db.runs).toBe(0); expect(db.statements).toEqual([]); };

  describe('crear', () => {
    it('201 con id, estado, token y enlace una sola vez; el hash guardado corresponde al token', async () => {
      const response = remember(await create());
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ id: expect.any(String), email: 'nuevo@example.com', role: 'worker', companyIds: [uuid(1), uuid(2)], status: 'open',
        createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(), revokedAt: null, acceptedAt: null,
        token: expect.stringMatching(TOKEN_FORMAT), link: `/invitacion#${response.body.token}` });
      expect(db.invitations.get(response.body.id)!.tokenHash.equals(hashInvitationToken(response.body.token))).toBe(true);
      expect(response.headers.location).toBeUndefined();
      secure(response);
    });
    it.each([1, 7, 30])('vigencia %i días', async days => {
      const response = remember(await create({ ...valid, validityDays: days }));
      expect(response.status).toBe(201);
      expect(response.body.expiresAt).toBe(new Date(now.getTime() + days * 86_400_000).toISOString());
    });
    it.each([
      ['email inválido', { email: 'x' }, 'email'], ['rol community_manager', { role: 'community_manager' }, 'role'], ['rol ausente', { role: undefined }, 'role'],
      ['sin empresas', { companyIds: [] }, 'companyIds'], ['empresas duplicadas', { companyIds: [uuid(1), uuid(1)] }, 'companyIds'],
      ['51 empresas', { companyIds: Array.from({ length: 51 }, (_, i) => uuid(i + 1)) }, 'companyIds'], ['vigencia 14', { validityDays: 14 }, 'validityDays'],
      ['vigencia null', { validityDays: null }, 'validityDays'],
    ])('400 %s, sin tocar la base', async (_n, extra, field) => {
      error(await create({ ...valid, ...extra }), 400, 'invalid_input', field); untouched();
    });
    it.each(['organizationId', 'status', 'token', 'tokenHash', 'expiresAt', 'createdByMembershipId', 'id'])('400 por el campo desconocido %s', async key => {
      error(await create({ ...valid, [key]: 'ajeno' }), 400, 'invalid_input'); untouched();
    });
    it('400 con query string', async () => { error(await write('post', `${base}?organizationId=${OTHER_ORG}`).send(valid), 400, 'invalid_input'); untouched(); });
    it('una empresa de otra organización: 400 companyIds, sin invitación', async () => {
      error(await create({ ...valid, companyIds: [uuid(9)] }), 400, 'invalid_input', 'companyIds'); expect(db.invitations.size).toBe(0);
    });
    it('409 con conflictos distinguibles: miembro activo, desactivado y pendiente', async () => {
      db.members.push({ organizationId: ORG, email: 'activo@example.com', active: true }, { organizationId: ORG, email: 'baja@example.com', active: false });
      error(await create({ ...valid, email: 'activo@example.com' }), 409, 'member_already_active', 'email');
      error(await create({ ...valid, email: 'baja@example.com' }), 409, 'member_deactivated', 'email');
      expect((await create()).status).toBe(201);
      error(await create(), 409, 'invitation_pending_exists', 'email');
    });
    it('un fallo de base con el token en su mensaje no lo filtra a la respuesta ni al log por campos saneados', async () => {
      db.failOn = sql => (sql === INSERT_INVITATION_COMPANIES_SQL ? { severity: 'ERROR', code: '08006', detail: 'detalle', parameters: ['x'] } : null);
      error(await create(), 503, 'outcome_unknown');
      expect(db.statements.filter(s => s.sql === INSERT_INVITATION_SQL)).toHaveLength(1);
      expect(db.outcomes).toEqual(['rollback']);
    });
  });

  describe('listar', () => {
    it('200 sin token ni hash ni enlace; solo la organización de la sesión', async () => {
      const a = remember(await create({ ...valid, email: 'a@example.com' })); tick = 5;
      remember(await create({ ...valid, email: 'b@example.com' }));
      db.invitations.set(uuid(0x500), { id: uuid(0x500), organizationId: OTHER_ORG, email: 'x@example.com', role: 'client', tokenHash: Buffer.alloc(32), createdByMembershipId: uuid(1),
        createdAtUs: '2026-01-01T00:00:00.000000Z', expiresAt: new Date(now.getTime() + 86_400_000), revokedAt: null, acceptedAt: null, companyIds: [uuid(9)] });
      const response = await list();
      expect(response.status).toBe(200);
      expect(response.body.items.map((i: { email: string }) => i.email)).toEqual(['b@example.com', 'a@example.com']);
      expect(response.body.items.map((i: { id: string }) => i.id)).toContain(a.body.id);
      expect(response.body.nextCursor).toBeNull();
      expect(response.text).not.toMatch(/token|hash|link|#/i);
      for (const secret of issued) expect(response.text).not.toContain(secret);
      secure(response);
    });
    it('pagina por HTTP con cursor de seis decimales sin omitir ni repetir, y filtra por estado', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) { tick = i; ids.unshift(remember(await create({ ...valid, email: `u${i}@example.com` })).body.id); }
      const seen: string[] = []; let cursor: string | undefined; let pages = 0;
      do {
        const page = await list(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        expect(page.status).toBe(200); seen.push(...page.body.items.map((i: { id: string }) => i.id)); cursor = page.body.nextCursor ?? undefined; pages++;
      } while (cursor && pages < 10);
      expect(seen).toEqual(ids); expect(pages).toBe(3);
      await revoke(ids[0]);
      expect((await list('?status=revoked')).body.items.map((i: { id: string }) => i.id)).toEqual([ids[0]]);
      expect((await list('?status=open')).body.items).toHaveLength(4);
    });
    it.each(['?status=pendiente', '?limit=0', '?limit=101', '?cursor=basura', `?organizationId=${OTHER_ORG}`, '?token=x'])('400 con %s', async query => {
      error(await list(query), 400, 'invalid_input', query.startsWith('?status') ? 'status' : query.startsWith('?limit') ? 'limit' : query.startsWith('?cursor') ? 'cursor' : undefined);
      expect(db.runs).toBe(0);
    });
  });

  describe('revocar', () => {
    it('200 y es idempotente: la segunda llamada devuelve lo mismo sin escribir', async () => {
      const made = remember(await create()); tick = 3;
      const first = await revoke(made.body.id);
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ id: made.body.id, status: 'revoked', revokedAt: new Date(now.getTime() + 3000).toISOString() });
      secure(first); tick = 9;
      const writesBefore = db.statements.filter(s => /^UPDATE/.test(s.sql)).length;
      const second = await revoke(made.body.id);
      expect(second.status).toBe(200); expect(second.body).toEqual(first.body);
      expect(db.statements.filter(s => /^UPDATE/.test(s.sql))).toHaveLength(writesBefore);
    });
    it('409 si ya fue aceptada', async () => {
      const made = remember(await create()); db.invitations.get(made.body.id)!.acceptedAt = new Date(now.getTime() + 1);
      error(await revoke(made.body.id), 409, 'invitation_accepted');
    });
    it('404 idéntico para ajena, inexistente y mal formada', async () => {
      db.invitations.set(uuid(0x500), { id: uuid(0x500), organizationId: OTHER_ORG, email: 'x@example.com', role: 'client', tokenHash: Buffer.alloc(32), createdByMembershipId: uuid(1),
        createdAtUs: '2026-01-01T00:00:00.000000Z', expiresAt: new Date(now.getTime() + 86_400_000), revokedAt: null, acceptedAt: null, companyIds: [uuid(9)] });
      const bodies = [];
      for (const id of [uuid(0x500), uuid(0x501), 'no-es-uuid']) {
        const response = await revoke(id); error(response, 404, 'not_found'); bodies.push({ ...response.body.error, requestId: undefined });
      }
      expect(bodies[0]).toEqual(bodies[1]); expect(bodies[1]).toEqual(bodies[2]);
      expect(db.invitations.get(uuid(0x500))!.revokedAt).toBeNull();
    });
    it('400 con query string', async () => { error(await write('post', `${base}/${uuid(1)}/revoke?x=1`), 400, 'invalid_input'); untouched(); });
  });

  describe('renovar', () => {
    it('200 con nuevo id, token y enlace; la anterior queda revocada y el reemplazo abierto', async () => {
      const old = remember(await create()); tick = 2;
      const response = remember(await renew(old.body.id));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ email: 'nuevo@example.com', role: 'worker', companyIds: [uuid(1), uuid(2)], status: 'open',
        expiresAt: new Date(now.getTime() + 2000 + 7 * 86_400_000).toISOString() });
      expect(response.body.id).not.toBe(old.body.id); expect(response.body.token).not.toBe(old.body.token);
      expect(response.body.token).toMatch(TOKEN_FORMAT); expect(response.body.link).toBe(`/invitacion#${response.body.token}`);
      expect(db.invitations.get(old.body.id)!.revokedAt).toEqual(new Date(now.getTime() + 2000));
      expect(db.invitations.get(response.body.id)!.revokedAt).toBeNull();
      secure(response);
    });
    it('admite validityDays 1, 7 o 30 y usa 7 con el cuerpo vacío', async () => {
      const first = remember(await create());
      const thirty = remember(await renew(first.body.id, { validityDays: 30 }));
      expect(thirty.body.expiresAt).toBe(new Date(now.getTime() + 30 * 86_400_000).toISOString());
      expect(remember(await renew(thirty.body.id, {})).body.expiresAt).toBe(new Date(now.getTime() + 7 * 86_400_000).toISOString());
    });
    it.each([[{ validityDays: 14 }], [{ validityDays: null }], [{ validityDays: '7' }], [{ extra: 1 }], [{ email: 'otro@example.com' }], [{ companyIds: [uuid(1)] }], [{ organizationId: OTHER_ORG }]])('400 con el cuerpo %p', async body => {
      const old = remember(await create()); const before = db.statements.length;
      error(await renew(old.body.id, body), 400, 'invalid_input', 'validityDays' in body ? 'validityDays' : undefined);
      expect(db.statements.slice(before)).toEqual([]);
    });
    it('409 si está aceptada o revocada; renueva una vencida', async () => {
      const accepted = remember(await create({ ...valid, email: 'acc@example.com' })); db.invitations.get(accepted.body.id)!.acceptedAt = new Date(now.getTime() + 1);
      error(await renew(accepted.body.id), 409, 'invitation_accepted');
      const revoked = remember(await create({ ...valid, email: 'rev@example.com' })); await revoke(revoked.body.id);
      error(await renew(revoked.body.id), 409, 'invitation_revoked');
      const expired = remember(await create({ ...valid, email: 'exp@example.com', validityDays: 1 })); tick = 2 * 86_400;
      expect((await renew(expired.body.id)).status).toBe(200);
    });
    it('dos renovaciones simultáneas del mismo id: un 200 y un 409, y un único reemplazo', async () => {
      const old = remember(await create());
      const [a, b] = await Promise.all([renew(old.body.id), renew(old.body.id)]);
      remember(a); remember(b);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      error(loser, 409, 'invitation_revoked');
      expect(db.invitations.size).toBe(2);
      expect([...db.invitations.values()].filter(i => i.revokedAt === null)).toHaveLength(1);
    });
    it('si falla la creación del reemplazo, la anterior queda intacta y la respuesta no lleva token', async () => {
      const old = remember(await create());
      db.failOn = sql => (sql === INSERT_INVITATION_COMPANIES_SQL ? { severity: 'ERROR', code: '08006' } : null);
      const response = await renew(old.body.id);
      error(response, 503, 'outcome_unknown');
      expect(db.invitations.get(old.body.id)!.revokedAt).toBeNull(); expect(db.invitations.size).toBe(1);
      expect(db.outcomes.at(-1)).toBe('rollback');
    });
    it('404 idéntico para ajena, inexistente y mal formada; 400 con query string', async () => {
      for (const id of [uuid(0x501), 'x']) error(await renew(id), 404, 'not_found');
      error(await write('post', `${base}/${uuid(1)}/renew?x=1`).send({}), 400, 'invalid_input');
    });
  });

  describe('controles de acceso, en el orden existente', () => {
    const routes: [string, string, 'get' | 'post'][] = [['crear', base, 'post'], ['listar', base, 'get'], ['revocar', `${base}/${uuid(1)}/revoke`, 'post'], ['renovar', `${base}/${uuid(1)}/renew`, 'post']];
    const call = (method: 'get' | 'post', path: string, headers: Record<string, string> = {}) => {
      const req = http()[method](path);
      for (const [name, value] of Object.entries(headers)) req.set(name, value);
      return method === 'post' ? req.send(path === base ? valid : {}) : req;
    };
    const full = { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf };
    it.each(routes)('%s sin cookie: 401', async (_n, path, method) => {
      const { Cookie, ...headers } = full; void Cookie;
      error(await call(method, path, headers), 401, 'unauthenticated'); expect(authenticate).not.toHaveBeenCalled(); untouched();
    });
    it.each(routes.filter(r => r[2] === 'post'))('%s sin CSRF o con CSRF incorrecto: 403 sin autenticar', async (_n, path, method) => {
      for (const value of [undefined, 'incorrecto']) {
        const headers: Record<string, string> = { Origin: origin, Cookie: cookie }; if (value) headers['X-CSRF-Token'] = value;
        error(await call(method, path, headers), 403, 'forbidden');
      }
      expect(authenticate).not.toHaveBeenCalled(); untouched();
    });
    it.each(routes.filter(r => r[2] === 'post'))('%s con Origin ajeno: 403 antes de autenticar', async (_n, path, method) => {
      for (const value of ['null', 'https://ajeno.test']) error(await call(method, path, { ...full, Origin: value }), 403, 'forbidden');
      expect(authenticate).not.toHaveBeenCalled(); untouched();
    });
    it.each(routes)('%s con cookie inválida: 401 y borra la cookie', async (_n, path, method) => {
      const response = await call(method, path, { ...full, Cookie: 'agenda_session=inválida' });
      error(response, 401, 'unauthenticated'); expect(response.headers['set-cookie']).toEqual([serializeClearedSessionCookie(sessionCookieConfig('test'))]);
      expect(authenticate).not.toHaveBeenCalled();
    });
    it.each(routes)('%s con sesión vencida: 401', async (_n, path, method) => {
      authenticate.mockResolvedValue(null);
      error(await call(method, path, full), 401, 'unauthenticated'); untouched();
    });
    it.each(routes)('%s: solo community_manager, también la lista; worker, client, rol desconocido o sin organización reciben 403', async (_n, path, method) => {
      for (const change of [{ membership: { id: 'm', role: 'worker' } }, { membership: { id: 'm', role: 'client' } }, { membership: { id: 'm', role: 'admin' } }, { organization: null }, { membership: null }]) {
        authenticate.mockResolvedValue({ ...session, ...change, renewed: true });
        const response = await call(method, path, full);
        error(response, 403, 'forbidden');
        expect(response.headers['set-cookie']).toEqual([`${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`]);
      }
      untouched();
    });
    it.each([['crear', base], ['renovar', `${base}/${uuid(1)}/renew`]])('%s sin Content-Type JSON: 415 antes de autenticar', async (_n, path) => {
      error(await http().post(path).set('Origin', origin).set('Cookie', cookie).set('X-CSRF-Token', csrf).type('text').send('texto'), 415, 'unsupported_media_type');
      expect(authenticate).not.toHaveBeenCalled(); untouched();
    });
    it('413 para más de 100 KB antes de autenticar', async () => {
      error(await create({ ...valid, email: 'a'.repeat(110_000) }), 413, 'payload_too_large'); expect(authenticate).not.toHaveBeenCalled();
    });
    it('Cache-Control: no-store también en rutas inexistentes bajo el prefijo y en métodos no admitidos', async () => {
      for (const response of [await http().get(`${base}/${uuid(1)}/otra`), await http().delete(base), await http().get(`${base}/x/y/z`)]) {
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
    });
  });

  describe('el token y el enlace nunca se registran', () => {
    it('ni en éxito ni en ningún error, con el logger real', async () => {
      const a = remember(await create()); remember(await renew(a.body.id));
      remember(await create({ ...valid, email: 'otro@example.com' })); await revoke(uuid(0x777)); await list();
      db.failOn = sql => (sql === INSERT_INVITATION_SQL ? { severity: 'ERROR', code: '23514', constraint: 'CK_invitations_times', detail: 'x' } : null);
      await create({ ...valid, email: 'fallo@example.com' });
      db.failOn = null;
      expect(issued.length).toBeGreaterThanOrEqual(6);
      expect(output).toContain('Solicitud finalizada.');
      for (const secret of issued) expect(output).not.toContain(secret);
      expect(output).not.toMatch(/\/invitacion#/);
      for (const row of db.invitations.values()) { expect(output).not.toContain(row.tokenHash.toString('hex')); expect(output).not.toContain(row.tokenHash.toString('base64url')); }
    });
    it('un error inesperado durante la renovación responde 500 genérico, sin detalle ni token', async () => {
      const made = remember(await create());
      db.failOn = sql => (sql === INSERT_INVITATION_SQL ? new Error('fallo sin relación') : null);
      const response = await renew(made.body.id);
      error(response, 500, 'internal_error');
      expect(JSON.stringify(response.body)).not.toContain(made.body.token);
    });
  });
});
