import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { Writable } from 'node:stream';
import request from 'supertest';
import { QueryFailedError } from 'typeorm';
import { AuthController } from '../auth/auth.controller';
import { AuthenticationService, SESSION_TOKEN_FACTORY } from '../auth/authentication.service';
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
import { LimitedPasswordHasher } from '../identity/limited-password-hasher';
import { Argon2idPasswordHasher, PasswordHasher } from '../identity/password-hasher';
import { deriveCsrfToken, generateSessionToken, hashSessionToken } from '../identity/session-token';
import { createLoggerOptions } from '../logging/logger-options';
import { TransactionRunner } from '../registration/transaction-runner';
import { InvitationAcceptanceController, publicAcceptance, publicInspection } from './invitation-acceptance.controller';
import { ACCEPTANCE_OUTCOME_UNKNOWN_MESSAGE } from './invitation-acceptance-errors';
import { INSERT_ACCESSES_SQL, INSERT_USER_SQL, LOCK_INVITATION_BY_TOKEN_SQL } from './invitation-acceptance-sql';
import { InvitationAcceptanceService } from './invitation-acceptance.service';
import type { CreateInvitationDto } from './create-invitation.dto';
import { hashInvitationToken, type InvitationTokens } from './invitation-token';
import { InvitationsService } from './invitations.service';
import type { InvitationsScope } from './invitations-scope';
import { NoSessionCookieGuard } from './no-session-cookie.guard';
import { FakeDb } from './testing/fake-db';

const uuid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = uuid(0xa0);
const scope: InvitationsScope = { organizationId: ORG, membershipId: uuid(0xc0), role: 'community_manager' };
const NOW = new Date('2026-11-25T12:00:00.000Z');
const DAY = 86_400_000;
const PASSWORD = 'Canario-contraseña-larga-7Q-2026';
const ORIGIN = 'https://permitido.test';
const BASE = '/api/v1/invitations';
const unknownToken = Buffer.alloc(32, 222).toString('base64url');

describe('invitaciones públicas (inspección y aceptación) con servicio, guarda y logger reales, sin PostgreSQL', () => {
  let app: INestApplication;
  let output: string;
  let db: FakeDb;
  let now: Date;
  let hash: jest.Mock;
  let env: 'test' | 'production';
  const authenticate = jest.fn();
  const revoke = jest.fn();
  const sessionTokens: string[] = [];
  const invitationTokens: string[] = [];
  let accept: jest.SpyInstance;
  let inspect: jest.SpyInstance;
  let hasherOverride: PasswordHasher | null;
  let invitations: InvitationsService;

  async function start() {
    output = ''; db = new FakeDb(); now = NOW; sessionTokens.length = 0; invitationTokens.length = 0;
    db.companies.set(ORG, new Set([uuid(1), uuid(2)])); db.organizations.set(ORG, 'Equipo Norte');
    db.companyNames.set(uuid(1), 'Zeta').set(uuid(2), 'Alfa');
    authenticate.mockReset(); revoke.mockReset().mockResolvedValue(true);
    let next = 0x1000; let invitationCount = 0;
    const ids = { next: () => uuid(next++) };
    const clock: Clock = { now: () => new Date(now) };
    const tokenSource: InvitationTokens = { next: () => { const t = Buffer.alloc(32, ++invitationCount + 10).toString('base64url'); invitationTokens.push(t); return t; } };
    invitations = new InvitationsService(db.runner, ids, clock, tokenSource);
    hash = jest.fn(async () => `$argon2id$v=19$m=19456,t=2,p=1$canario${'x'.repeat(40)}`);
    const hasher = hasherOverride ?? new LimitedPasswordHasher({ hash, verify: jest.fn(), needsRehash: jest.fn() } as unknown as PasswordHasher);
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const module = await Test.createTestingModule({
      imports: [IdsModule, LoggerModule.forRoot({ pinoHttp: createLoggerOptions({ logLevel: 'info' }, stream, ids), useExisting: true })],
      controllers: [InvitationAcceptanceController, AuthController],
      providers: [InvitationAcceptanceService, NoSessionCookieGuard, SessionAuthGuard,
        { provide: PasswordHasher, useValue: hasher }, { provide: TransactionRunner, useValue: db.runner }, { provide: Clock, useValue: clock },
        { provide: SESSION_TOKEN_FACTORY, useValue: () => { const t = generateSessionToken(); sessionTokens.push(t); return t; } },
        { provide: AuthenticationService, useValue: { login: jest.fn() } }, { provide: SessionService, useValue: { authenticate, revoke } },
        { provide: ConstraintRegistry, useValue: registerSchemaConstraints(new ConstraintRegistry()) },
        { provide: AppConfigService, useValue: { env, logLevel: 'info', allowedOrigins: [ORIGIN] } },
        { provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).overrideProvider(IdGenerator).useValue(ids).compile();
    accept = jest.spyOn(module.get(InvitationAcceptanceService), 'accept');
    inspect = jest.spyOn(module.get(InvitationAcceptanceService), 'inspect');
    app = module.createNestApplication({ logger: false, bodyParser: false });
    await configureHttpApp(app); await app.init(); output = '';
  }
  beforeEach(async () => { env = 'test'; hasherOverride = null; await start(); });
  afterEach(async () => { await app?.close(); jest.restoreAllMocks(); });

  const invite = (extra: Partial<CreateInvitationDto> = {}) =>
    invitations.create(scope, { email: 'Nuevo@Example.com', role: 'client', companyIds: [uuid(1), uuid(2)], validityDays: 7, ...extra });
  const post = (path: string, body: object | string) => request(app.getHttpServer()).post(`${BASE}/${path}`).set('Origin', ORIGIN).send(body);
  const acceptCall = (token: string, extra: Record<string, unknown> = {}) => post('accept', { token, name: 'Nuevo Usuario', password: PASSWORD, ...extra });
  const secrets = () => [PASSWORD, ...invitationTokens, ...invitationTokens.flatMap(t => [hashInvitationToken(t).toString('hex'), hashInvitationToken(t).toString('base64url')]),
    ...sessionTokens, ...sessionTokens.flatMap(t => [deriveCsrfToken(t), hashSessionToken(t).toString('hex'), hashSessionToken(t).toString('base64url')]),
    `agenda_session=${sessionTokens[0] ?? 'sin-sesión'}`, '$argon2id'];

  function secureHeaders(response: request.Response) {
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
  }
  /** Every error: the exact public shape, no cookie, and none of the secrets in the body or the log. */
  function error(response: request.Response, status: number, code: string, field?: string) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: { code, message: expect.any(String), requestId: response.headers['x-request-id'], ...(field ? { field } : {}) } });
    secureHeaders(response);
    expect(response.headers['set-cookie']).toBeUndefined();
    for (const secret of secrets()) expect(response.text).not.toContain(secret);
    expect(output).toContain('Solicitud finalizada.');
    for (const secret of secrets()) expect(output).not.toContain(secret);
  }
  const noWrites = () => expect(db.users.size + db.memberships.size + db.sessions.size + db.accesses.length).toBe(0);

  describe('inspección', () => {
    it('200 abierta con la proyección explícita; sin cookie', async () => {
      const made = await invite();
      const response = await post('inspect', { token: made.token });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'open', organization: { name: 'Equipo Norte' }, role: 'client', email: 'nuevo@example.com',
        companies: [{ name: 'Alfa' }, { name: 'Zeta' }], expiresAt: new Date(NOW.getTime() + 7 * DAY).toISOString() });
      secureHeaders(response); expect(response.headers['set-cookie']).toBeUndefined();
      for (const secret of secrets()) expect(response.text).not.toContain(secret);
    });
    it('desconocida, mal formada, revocada y aceptada responden exactamente igual; vencida es expired', async () => {
      const revoked = await invite({ email: 'a@example.com' }); await invitations.revoke(scope, revoked.id);
      const used = await invite({ email: 'b@example.com' }); await acceptCall(used.token).expect(201);
      for (const token of [unknownToken, 'mal-formado', '', revoked.token, used.token]) {
        const response = await post('inspect', { token });
        expect(response.status).toBe(200); expect(response.body).toEqual({ status: 'unavailable' }); secureHeaders(response);
      }
      const expiring = await invite({ email: 'c@example.com', validityDays: 1 }); now = new Date(NOW.getTime() + 2 * DAY);
      expect((await post('inspect', { token: expiring.token })).body).toEqual({ status: 'expired' });
    });
    it('una cookie de sesión no estorba a la inspección: la guarda es solo de aceptación', async () => {
      const made = await invite();
      const response = await post('inspect', { token: made.token }).set('Cookie', `agenda_session=${generateSessionToken()}`);
      expect(response.status).toBe(200); expect(response.body.status).toBe('open'); expect(response.headers['set-cookie']).toBeUndefined();
    });
    it.each([[{}], [{ token: 5 }], [{ token: null }], [{ token: 'a'.repeat(129) }], [{ token: 'x', extra: 1 }], [{ token: 'x', email: 'a@b.co' }]])('400 con %p sin llamar al servicio', async body => {
      error(await post('inspect', body), 400, 'invalid_input', 'token' in body && Object.keys(body).length === 1 ? 'token' : Object.keys(body).length === 0 ? 'token' : undefined);
      expect(inspect).not.toHaveBeenCalled();
    });
    it('415 sin JSON, 403 con Origin ajeno, 400 con query y 413 por tamaño; ninguno llega al servicio', async () => {
      error(await request(app.getHttpServer()).post(`${BASE}/inspect`).set('Origin', ORIGIN).type('text').send('x'), 415, 'unsupported_media_type');
      error(await post('inspect', { token: 'x' }).set('Origin', 'https://ajeno.test'), 403, 'forbidden');
      error(await request(app.getHttpServer()).post(`${BASE}/inspect?token=x`).set('Origin', ORIGIN).send({ token: 'x' }), 400, 'invalid_input');
      error(await post('inspect', { token: 'a'.repeat(120_000) }), 413, 'payload_too_large');
      expect(inspect).not.toHaveBeenCalled();
    });
    it('un fallo de base de datos es 503 reintentable', async () => {
      const made = await invite(); db.failOn = () => ({ severity: 'ERROR', code: '08006' });
      const response = await post('inspect', { token: made.token });
      error(response, 503, 'service_unavailable'); expect(response.headers['retry-after']).toBe('1');
    });
  });

  describe('aceptación: camino feliz', () => {
    it('201 con los campos públicos y el CSRF; el token de sesión solo en la cookie', async () => {
      const made = await invite();
      const response = await acceptCall(made.token);
      expect(response.status).toBe(201);
      const user = [...db.users.values()][0], membership = [...db.memberships.values()][0];
      expect(response.body).toEqual({ user: { id: user.id, email: 'nuevo@example.com', name: 'Nuevo Usuario' }, organization: { id: ORG, name: 'Equipo Norte' },
        membership: { id: membership.id, role: 'client' }, csrfToken: deriveCsrfToken(sessionTokens[0]), expiresAt: new Date(NOW.getTime() + 7 * DAY).toISOString() });
      expect(response.headers['set-cookie']).toEqual([`agenda_session=${sessionTokens[0]}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`]);
      expect(response.text).not.toContain(sessionTokens[0]); expect(response.text).not.toContain(made.token);
      expect(response.headers.location).toBeUndefined(); secureHeaders(response);
      expect([...db.sessions.values()][0].tokenHash.equals(hashSessionToken(sessionTokens[0]))).toBe(true);
    });
    it('en producción la cookie es __Host- y Secure, y una cookie con el nombre de desarrollo no estorba', async () => {
      await app.close(); env = 'production'; await start();
      const made = await invite();
      const response = await acceptCall(made.token).set('Cookie', 'agenda_session=resto-de-desarrollo');
      expect(response.status).toBe(201);
      expect(response.headers['set-cookie']).toEqual([`__Host-agenda_session=${sessionTokens[0]}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`]);
      const other = await invite({ email: 'otro@example.com' });
      error(await acceptCall(other.token).set('Cookie', `__Host-agenda_session=${sessionTokens[0]}`), 409, 'session_active');
    });
    it('la cookie se emite solo después del commit: mientras la transacción no confirma no llega respuesta', async () => {
      const made = await invite();
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      const original = db.runner.run.bind(db.runner); let calls = 0;
      (db.runner as { run: unknown }).run = (work: (m: never) => Promise<unknown>) => {
        calls++;
        return calls !== 2 ? original(work as never) : original(async manager => { const result = await work(manager as never); await gate; return result; });
      };
      let settled = false;
      const pending = acceptCall(made.token).then(r => { settled = true; return r; });
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(settled).toBe(false); expect(db.outcomes).not.toContain('commit-unknown');
      release();
      const response = await pending;
      expect(response.status).toBe(201); expect(response.headers['set-cookie']).toHaveLength(1);
    });
    it('el token de sesión no viaja en el cuerpo aunque el resultado del servicio lo llevase como propiedad enumerable', async () => {
      const made = await invite();
      accept.mockResolvedValueOnce({ sessionToken: generateSessionToken(() => Buffer.alloc(32, 55)), maxAgeSeconds: 60,
        body: { user: { id: 'u', email: 'e@x.co', name: 'N', passwordHash: 'secreto' }, organization: { id: 'o', name: 'O', nameKey: 'k' },
          membership: { id: 'm', role: 'client', sessionToken: 'x' }, csrfToken: 'c', expiresAt: 'z', sessionToken: 'filtrado', tokenHash: 'h' } });
      const response = await acceptCall(made.token);
      expect(response.body).toEqual({ user: { id: 'u', email: 'e@x.co', name: 'N' }, organization: { id: 'o', name: 'O' }, membership: { id: 'm', role: 'client' }, csrfToken: 'c', expiresAt: 'z' });
      expect(response.text).not.toMatch(/filtrado|secreto|tokenHash|nameKey|sessionToken/);
    });
    it('las proyecciones solo copian los campos listados', () => {
      expect(Object.keys(publicAcceptance({ user: { id: '1', email: 'a', name: 'b' }, organization: { id: '2', name: 'c' }, membership: { id: '3', role: 'worker' }, csrfToken: 'd', expiresAt: 'e', extra: 'x' } as never))).toEqual(['user', 'organization', 'membership', 'csrfToken', 'expiresAt']);
      expect(publicInspection({ status: 'expired', secret: 'x' } as never)).toEqual({ status: 'expired' });
      expect(publicInspection({ status: 'open', organization: { name: 'o', id: 'x' }, role: 'client', email: 'e', expiresAt: 'z', companies: [{ name: 'n', id: 'x' }], accountExists: true } as never))
        .toEqual({ status: 'open', organization: { name: 'o' }, role: 'client', email: 'e', expiresAt: 'z', companies: [{ name: 'n' }] });
    });
    it('no revoca ni toca sesiones previas de la persona', async () => {
      const made = await invite();
      db.sessions.set(uuid(0x900), { id: uuid(0x900), tokenHash: Buffer.alloc(32, 1), userId: uuid(0x901), activeOrganizationId: ORG, createdAt: NOW, lastSeenAt: NOW, expiresAt: new Date(NOW.getTime() + DAY) });
      await acceptCall(made.token).expect(201);
      expect(db.sessions.size).toBe(2); expect(revoke).not.toHaveBeenCalled();
    });
  });

  describe('guarda de cookie previa, solo para aceptar', () => {
    const valid = () => `agenda_session=${generateSessionToken(() => Buffer.alloc(32, 3))}`;
    it.each([['válida', 'valid'], ['inválida', 'agenda_session=nada'], ['vacía', 'agenda_session='], ['sin valor', 'agenda_session'], ['duplicada', 'dup'], ['entre otras', 'mix']])(
      'cookie %s: 409 session_active antes del pipe, del hash y del servicio, sin Set-Cookie', async (_label, kind) => {
        const made = await invite(); const runs = db.runs;
        const header = kind === 'valid' ? valid() : kind === 'dup' ? `${valid()}; ${valid()}` : kind === 'mix' ? `a=1; ${valid()}; b=2` : kind;
        const response = await request(app.getHttpServer()).post(`${BASE}/accept`).set('Origin', ORIGIN).set('Cookie', header)
          .send({ token: made.token, name: 5, password: [], email: 'x', extra: true }); // un cuerpo inválido: el pipe no llega a verlo
        error(response, 409, 'session_active');
        expect(accept).not.toHaveBeenCalled(); expect(hash).not.toHaveBeenCalled(); expect(db.runs).toBe(runs); noWrites();
        expect(authenticate).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
      });
    it('otras cookies no cuentan', async () => {
      const made = await invite();
      expect((await acceptCall(made.token).set('Cookie', 'preferencia=1; otra=2')).status).toBe(201);
    });
    it('Origin y Content-Type se comprueban antes que la guarda', async () => {
      const made = await invite(); const cookie = valid();
      error(await acceptCall(made.token).set('Origin', 'https://ajeno.test').set('Cookie', cookie), 403, 'forbidden');
      error(await request(app.getHttpServer()).post(`${BASE}/accept`).set('Origin', ORIGIN).set('Cookie', cookie).type('text').send('x'), 415, 'unsupported_media_type');
      expect(accept).not.toHaveBeenCalled();
    });
    it('recuperación con sesión vencida: GET /auth/session borra la cookie (401) y la aceptación sigue', async () => {
      const made = await invite(); const cookie = valid();
      error(await acceptCall(made.token).set('Cookie', cookie), 409, 'session_active');
      authenticate.mockResolvedValue(null);
      const session = await request(app.getHttpServer()).get('/api/v1/auth/session').set('Origin', ORIGIN).set('Cookie', cookie);
      expect(session.status).toBe(401); expect(session.headers['set-cookie']).toEqual([serializeClearedSessionCookie(sessionCookieConfig('test'))]);
      expect((await acceptCall(made.token)).status).toBe(201); // el navegador ya no envía cookie
    });
    it('recuperación con sesión vigente: GET /auth/session da el CSRF, logout la borra y la aceptación sigue', async () => {
      const made = await invite(); const token = generateSessionToken(() => Buffer.alloc(32, 4)); const cookie = `agenda_session=${token}`;
      error(await acceptCall(made.token).set('Cookie', cookie), 409, 'session_active');
      authenticate.mockResolvedValue({ user: { id: 'u', email: 'a@b.co', name: 'A' }, organization: null, membership: null, sessionId: 's', createdAt: NOW, lastSeenAt: NOW, expiresAt: new Date(NOW.getTime() + DAY), renewed: false });
      const session = await request(app.getHttpServer()).get('/api/v1/auth/session').set('Origin', ORIGIN).set('Cookie', cookie);
      expect(session.status).toBe(200);
      const logout = await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Origin', ORIGIN).set('Cookie', cookie).set('X-CSRF-Token', session.body.csrfToken);
      expect(logout.status).toBe(204); expect(logout.headers['set-cookie']).toEqual([serializeClearedSessionCookie(sessionCookieConfig('test'))]);
      expect(revoke).toHaveBeenCalledWith(token);
      expect((await acceptCall(made.token)).status).toBe(201);
    });
    it('recuperación con cookie inutilizable: logout la borra sin CSRF', async () => {
      const made = await invite();
      error(await acceptCall(made.token).set('Cookie', 'agenda_session=nada'), 409, 'session_active');
      const logout = await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Origin', ORIGIN).set('Cookie', 'agenda_session=nada');
      expect(logout.status).toBe(204); expect(logout.headers['set-cookie']).toEqual([serializeClearedSessionCookie(sessionCookieConfig('test'))]);
    });
  });

  describe('errores de aceptación: sin cookie, sin token y sin escrituras', () => {
    it.each([['token ausente', { token: undefined }, 'token'], ['token de otro tipo', { token: 5 }, 'token'], ['nombre ausente', { name: undefined }, 'name'],
      ['contraseña de otro tipo', { password: 5 }, 'password'], ['nombre largo', { name: 'a'.repeat(201) }, 'name'], ['contraseña corta', { password: 'corta' }, 'password'], ['nombre vacío', { name: '   ' }, 'name']])(
      '400 %s', async (_label, extra, field) => {
        const made = await invite();
        error(await acceptCall(made.token, extra), 400, 'invalid_input', field); noWrites(); expect(hash).not.toHaveBeenCalled();
      });
    it.each(['email', 'role', 'organizationId', 'companyIds', 'csrfToken', 'accountExists'])('400 por la propiedad desconocida %s', async key => {
      const made = await invite();
      error(await acceptCall(made.token, { [key]: 'x' }), 400, 'invalid_input'); expect(accept).not.toHaveBeenCalled(); noWrites();
    });
    it('415, 403, query y 413 sin llegar al servicio', async () => {
      error(await request(app.getHttpServer()).post(`${BASE}/accept`).set('Origin', ORIGIN).type('text').send('x'), 415, 'unsupported_media_type');
      error(await post('accept', {}).set('Origin', 'https://ajeno.test'), 403, 'forbidden');
      error(await request(app.getHttpServer()).post(`${BASE}/accept?token=x`).set('Origin', ORIGIN).send({ token: 'x', name: 'a', password: PASSWORD }), 400, 'invalid_input');
      error(await post('accept', { token: 'a'.repeat(120_000) }), 413, 'payload_too_large');
      expect(accept).not.toHaveBeenCalled();
    });
    it('404 uniforme: desconocida, mal formada, revocada y usada con el mismo cuerpo', async () => {
      const revoked = await invite({ email: 'a@example.com' }); await invitations.revoke(scope, revoked.id);
      const used = await invite({ email: 'b@example.com' }); await acceptCall(used.token).expect(201);
      const bodies = [];
      for (const token of [unknownToken, 'mal-formado', revoked.token, used.token]) {
        const response = await acceptCall(token); error(response, 404, 'invitation_unavailable');
        bodies.push({ ...response.body.error, requestId: undefined });
      }
      for (const body of bodies) expect(body).toEqual(bodies[0]);
      expect(db.users.size).toBe(1);
    });
    it('409 vencida y 409 cuenta existente, sin escribir y con la contraseña intacta', async () => {
      const expiring = await invite({ validityDays: 1 }); now = new Date(NOW.getTime() + 2 * DAY);
      error(await acceptCall(expiring.token), 409, 'invitation_expired'); now = NOW;
      const existing = await invite({ email: 'existente@example.com' });
      db.users.set(uuid(0x700), { id: uuid(0x700), email: 'existente@example.com', name: 'X', passwordHash: '$argon2id$original', createdAt: NOW });
      error(await acceptCall(existing.token), 409, 'account_exists');
      expect(db.users.get(uuid(0x700))!.passwordHash).toBe('$argon2id$original'); expect(db.memberships.size + db.sessions.size).toBe(0);
    });
    it('503 controlados: reloj anterior a la creación, bloqueo agotado y hasher saturado', async () => {
      const made = await invite();
      db.before.set(LOCK_INVITATION_BY_TOKEN_SQL, () => { now = new Date(NOW.getTime() - 5000); });
      error(await acceptCall(made.token), 503, 'service_unavailable'); now = NOW; noWrites();
      db.failOn = sql => (sql === INSERT_ACCESSES_SQL ? { severity: 'ERROR', code: '55P03' } : null);
      const locked = await acceptCall(made.token); error(locked, 503, 'service_unavailable'); expect(locked.headers['retry-after']).toBe('1'); noWrites();
      db.failOn = null;
      await app.close();
      let free!: () => void;
      hasherOverride = new LimitedPasswordHasher({ hash: () => new Promise<string>(resolve => { free = () => resolve('$argon2id$x'); }), verify: jest.fn(), needsRehash: jest.fn() } as unknown as PasswordHasher, 1, 0);
      await start();
      const one = await invite({ email: 'uno@example.com' }); const two = await invite({ email: 'dos@example.com' });
      const pending = acceptCall(one.token).then(r => r);
      await new Promise(resolve => setTimeout(resolve, 50));
      error(await acceptCall(two.token), 503, 'service_unavailable'); noWrites();
      free(); expect((await pending).status).toBe(201);
    });
    it.each([[true], [false]])('outcome_unknown (aplicado=%s): 503 con el mensaje de recuperación, sin cookie, sin token y sin reintento', async applied => {
      const made = await invite();
      const original = db.runner.run.bind(db.runner); let calls = 0;
      (db.runner as { run: unknown }).run = (work: never) => { calls++; if (calls === 2) db.commitFailure = { error: { severity: 'ERROR', code: '08006', message: `${PASSWORD} secreto-driver` }, applied }; return original(work).finally(() => { db.commitFailure = null; }); };
      const response = await acceptCall(made.token);
      error(response, 503, 'outcome_unknown');
      expect(response.body.error.message).toBe(ACCEPTANCE_OUTCOME_UNKNOWN_MESSAGE);
      expect(response.text).not.toContain('secreto-driver');
      expect(calls).toBe(2); expect(db.users.size).toBe(applied ? 1 : 0);
    });
    it('colisión de correo en la inserción: 409 account_exists con rollback', async () => {
      const made = await invite();
      db.before.set(INSERT_USER_SQL, () => db.users.set(uuid(0x701), { id: uuid(0x701), email: 'nuevo@example.com', name: 'Otro', passwordHash: '$argon2id$ganador', createdAt: NOW }));
      error(await acceptCall(made.token), 409, 'account_exists');
      expect(db.users.size).toBe(1); expect(db.memberships.size + db.sessions.size + db.accesses.length).toBe(0);
    });
    it('error de base de datos con parámetros sensibles: ni la respuesta ni el log los muestran', async () => {
      const made = await invite();
      db.failOn = (sql, params) => {
        if (sql !== INSERT_USER_SQL) return null;
        const driver = Object.assign(new Error('duplicate'), { code: '23514', severity: 'ERROR', constraint: 'CK_users_email', detail: `Failing row ${params.join(' ')}`, parameters: params });
        return new QueryFailedError(sql, params, driver);
      };
      const response = await acceptCall(made.token);
      error(response, 400, 'invalid_input', 'email');
    });
    it('error inesperado: 500 genérico sin cookie', async () => {
      const made = await invite();
      db.failOn = sql => (sql === INSERT_USER_SQL ? new Error('fallo sin relación') : null);
      error(await acceptCall(made.token), 500, 'internal_error'); noWrites();
    });
  });

  describe('con Argon2id real', () => {
    it('la contraseña y su hash no aparecen en el log ni en la respuesta', async () => {
      await app.close(); hasherOverride = new LimitedPasswordHasher(new Argon2idPasswordHasher()); await start();
      const made = await invite();
      const response = await acceptCall(made.token);
      expect(response.status).toBe(201);
      const stored = [...db.users.values()][0].passwordHash;
      expect(stored.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
      expect(await new Argon2idPasswordHasher().verify(stored, PASSWORD)).toBe(true);
      for (const secret of [PASSWORD, stored, made.token, sessionTokens[0], deriveCsrfToken(sessionTokens[0])]) expect(output).not.toContain(secret);
      expect(response.text).not.toContain(stored);
      expect(output).toContain('Solicitud finalizada.');
    });
  });
});
