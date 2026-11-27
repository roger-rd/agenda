/**
 * Acceptance phase (connected). Writes, by actor:
 *  - application, over HTTP: users, organizations and memberships (register cmA/cmB and the competing registrations), user_sessions
 *    (login and acceptance), companies (POST), invitations and invitation_companies (create, revoke, renew), and the acceptances
 *    themselves (users, organization_memberships, company_accesses, invitations.accepted_*, user_sessions).
 *  - observer: SELECT and the cleanup DELETE statements only. Nothing is seeded or modified by hand.
 *  - locker: holds row and SHARE table locks inside a transaction it always rolls back. It writes nothing.
 * No DDL, no role or database settings. Every request is checked to carry no secret in its body or headers.
 */
import request from 'supertest';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { INSERT_SESSION_SQL } from '../../../src/auth/session-issue';
import { AppConfigService } from '../../../src/config/app-config.service';
import { PasswordHasher } from '../../../src/identity/password-hasher';
import { deriveCsrfToken, hashSessionToken } from '../../../src/identity/session-token';
import { INSERT_ACCESSES_SQL, INSERT_USER_SQL, LOCK_INVITATION_BY_TOKEN_SQL } from '../../../src/invitations/invitation-acceptance-sql';
import { SELECT_INVITATION_FOR_UPDATE_SQL } from '../../../src/invitations/invitations.service';
import type { RegistrationResult } from '../../../src/registration/registration.service';
import { DeleteGate } from './markers';
import { ControlledClock, DAY } from './auth-controls';
import { formatAuthFailure } from './auth-failure';
import { acceptanceInvitee, acceptanceLocks, acceptanceSQL as SQL, type acceptanceMarkers } from './acceptance-fixture';
import { invitationsSQL, LOCK_WAIT, type InvitationsSaved } from './invitations-fixture';
import type { LogCapture } from './invitations-log-capture';
import { holding, startsLike, waitForWaiters, type WaitIo } from './lock-support';

type Context = {
  app: INestApplication; source: DataSource; observer: DataSource; locker: DataSource; clock: ControlledClock; gate: DeleteGate;
  saved: RegistrationResult[]; seeded: InvitationsSaved; reservations: ReturnType<typeof acceptanceMarkers>; id: string; zone: string;
  appPids: () => Promise<number[]>; logs: LogCapture; ready: boolean;
};
type Actor = 'cmA' | 'cmB';
type Invitation = { id: string; token: string };
type UserRow = { id: string; email: string; name: string; password_hash: string };
type SessionRow = { id: string; token_hash_hex: string; active_organization_id: string | null; created_at: Date; last_seen_at: Date; expires_at: Date; revoked_at: Date | null };
type InvitationRow = { id: string; organization_id: string; email: string; role: string; created_at: Date; expires_at: Date; revoked_at: Date | null; accepted_at: Date | null; accepted_by_user_id: string | null };

const ORIGIN = 'https://app.agenda.test';
const PASSWORD = 'B2b-acceptance-long-passphrase-2026!';
const COOKIE = /^agenda_session=([A-Za-z0-9_-]{43}); Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800$/;
const invitationHash = (token: string) => createHash('sha256').update('agenda-invitation-token-v1').update(Buffer.from([0])).update(Buffer.from(token, 'base64url')).digest('hex');
const acceptLock = startsLike(LOCK_INVITATION_BY_TOKEN_SQL);
const manageLock = startsLike(SELECT_INVITATION_FOR_UPDATE_SQL);
const acceptUserInsert = startsLike(INSERT_USER_SQL);
const registerUserInsert = /^INSERT INTO ("public"\.)?"users"/;
const accessInsert = startsLike(INSERT_ACCESSES_SQL);
const sessionInsert = startsLike(INSERT_SESSION_SQL);

export function registerAcceptanceTest(context: () => Context): void {
  test('acceptance real: aceptación completa, uso único, carreras, colisiones, rollback, vencimiento y estados accepted', async () => {
    let step = 'preparación';
    try {
      const { app, source, observer, locker, clock, gate, saved, seeded, reservations, id, zone, appPids, logs, ready } = context();
      expect(ready).toBe(true);
      await app.listen(0, '127.0.0.1');
      const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      const hasher = app.get(PasswordHasher);
      const sessionTokens: string[] = [];
      const invitationTokens: string[] = [];
      const secrets = () => [PASSWORD, ...sessionTokens.flatMap(t => [t, deriveCsrfToken(t), hashSessionToken(t).toString('hex')]),
        ...invitationTokens.flatMap(t => [t, invitationHash(t)])];
      /** no-store and request id always; secrets never in body or headers; a cookie only where `cookie` says so; token/link only for an issuer. */
      const secure = (r: request.Response, allow: { cookie?: boolean; issuer?: boolean } = {}) => {
        expect(r.headers['cache-control'] === 'no-store').toBe(true);
        expect(typeof r.headers['x-request-id'] === 'string' && r.headers['x-request-id'].length > 0).toBe(true);
        if (!allow.cookie) expect(r.headers['set-cookie'] === undefined).toBe(true);
        const body = { ...r.body }; delete body.csrfToken;
        if (allow.issuer && (r.status === 200 || r.status === 201)) { delete body.token; delete body.link; }
        const headers = { ...r.headers }; delete headers['set-cookie'];
        const output = JSON.stringify({ body, headers });
        expect(secrets().some(secret => output.includes(secret))).toBe(false);
      };
      const run = async (make: () => request.Test) => { gate.assertArmed(); return make().timeout(15000); };
      /** The session token of a 200 login or 201 acceptance, read from the exact cookie and registered as a secret. */
      const cookieToken = (r: request.Response): string => {
        const cookies: unknown = r.headers['set-cookie'];
        expect(Array.isArray(cookies) && cookies.length === 1 && COOKIE.test(cookies[0])).toBe(true);
        const token = COOKIE.exec((cookies as string[])[0])![1];
        sessionTokens.push(token);
        return token;
      };

      /* ---- siembra: solo por la API ---- */
      step = 'registro de las dos organizaciones';
      console.info('[b2b] acceptance reservas', { organizations: [reservations.cmA.organizationName, reservations.cmB.organizationName, ...reservations.competitors], invitees: reservations.invitees.length });
      gate.arm();
      const orgs = {} as Record<'A' | 'B', string>;
      const sessions = {} as Record<Actor, { token: string; csrf: string }>;
      for (const [actor, org] of [['cmA', 'A'], ['cmB', 'B']] as const) {
        const r = await run(() => request(base).post('/api/v1/auth/register').send({ ...reservations[actor], name: 'Acceptance Tester', password: PASSWORD }));
        if (r.status === 201) saved.push(r.body as RegistrationResult);
        secure(r); expect(r.status === 201).toBe(true);
        orgs[org] = (r.body as RegistrationResult).organization.id;
      }
      const login = async (email: string) => {
        const r = await run(() => request(base).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email, password: PASSWORD }));
        expect(r.status === 200).toBe(true);
        const token = cookieToken(r); secure(r, { cookie: true });
        return { token, csrf: deriveCsrfToken(token) };
      };
      step = 'logins de los community managers';
      sessions.cmA = await login(reservations.cmA.email);
      sessions.cmB = await login(reservations.cmB.email);
      const as = (actor: Actor) => (req: request.Test) => req.set('Origin', ORIGIN).set('Cookie', `agenda_session=${sessions[actor].token}`).set('X-CSRF-Token', sessions[actor].csrf);
      step = 'empresas de A y B';
      const company = async (actor: Actor, name: string): Promise<string> => {
        const r = await run(() => as(actor)(request(base).post('/api/v1/companies')).send({ name, color: '#aabbcc' }));
        secure(r); expect(r.status === 201).toBe(true); seeded.companies.push(r.body.id); return r.body.id as string;
      };
      const A = [await company('cmA', 'Alfa Uno'), await company('cmA', 'Alfa Dos'), await company('cmA', 'Alfa Tres'), await company('cmA', 'Alfa Cuatro')];
      const B = [await company('cmB', 'Beta Uno')];

      /* ---- zonas y conexiones ---- */
      step = 'zona horaria de las conexiones (aplicación, observador y locker)';
      expect(['info', 'debug', 'trace'].includes(app.get(AppConfigService).logLevel)).toBe(true);
      const pool = await Promise.all(Array.from({ length: 8 }, () => source.query(invitationsSQL.poolTimeZone) as Promise<{ pid: number; tz: string }[]>));
      const poolPids = pool.map(r => r[0].pid);
      const lockerPid = ((await locker.query(invitationsSQL.backendPid)) as { pid: number }[])[0].pid;
      const observerPid = ((await observer.query(invitationsSQL.backendPid)) as { pid: number }[])[0].pid;
      expect(new Set(poolPids).size === 8 && pool.every(r => r[0].tz === zone)).toBe(true);
      const ownApp = await appPids();
      expect(poolPids.every(pid => ownApp.includes(pid)) && !poolPids.includes(lockerPid) && !poolPids.includes(observerPid)).toBe(true);
      expect(((await locker.query(invitationsSQL.sessionTimeZone)) as { tz: string }[])[0].tz === zone).toBe(true);
      await observer.query(invitationsSQL.observerZone);
      expect(((await observer.query(invitationsSQL.sessionTimeZone)) as { tz: string }[])[0].tz !== zone).toBe(true);
      const io: WaitIo = { query: (sql, params) => observer.query(sql, params as unknown[]), appPids };

      /* ---- ayudantes de API y observador ---- */
      const t0 = () => clock.now().getTime();
      const invite = async (actor: Actor, n: number, role: 'worker' | 'client', companyIds: string[], validityDays = 7): Promise<Invitation> => {
        const r = await run(() => as(actor)(request(base).post('/api/v1/invitations')).send({ email: acceptanceInvitee(id, n), role, companyIds, validityDays }));
        expect(r.status === 201 && /^[A-Za-z0-9_-]{43}$/.test(r.body.token)).toBe(true);
        invitationTokens.push(r.body.token); seeded.invitations.push(r.body.id); secure(r, { issuer: true });
        return { id: r.body.id as string, token: r.body.token as string };
      };
      const revoke = async (actor: Actor, invitation: string) => { const r = await run(() => as(actor)(request(base).post(`/api/v1/invitations/${invitation}/revoke`))); secure(r); return r; };
      const renew = async (actor: Actor, invitation: string) => {
        const r = await run(() => as(actor)(request(base).post(`/api/v1/invitations/${invitation}/renew`)).send({}));
        if (r.status === 200) { invitationTokens.push(r.body.token); seeded.invitations.push(r.body.id); }
        secure(r, { issuer: true });
        return r;
      };
      const accepted = new Map<string, string>(); // email -> cookie token of the acceptance
      const accept = async (token: string, name = 'Persona Invitada', cookie?: string) => {
        const r = await run(() => {
          const req = request(base).post('/api/v1/invitations/accept').set('Origin', ORIGIN);
          if (cookie !== undefined) req.set('Cookie', cookie);
          return req.send({ token, name, password: PASSWORD });
        });
        if (r.status === 201) {
          const session = cookieToken(r);
          accepted.set(r.body.user.email, session);
          seeded.users.push(r.body.user.id); seeded.memberships.push(r.body.membership.id);
        }
        secure(r, { cookie: r.status === 201 });
        return r;
      };
      const inspect = async (token: string) => {
        const r = await run(() => request(base).post('/api/v1/invitations/inspect').set('Origin', ORIGIN).send({ token }));
        secure(r); return r;
      };
      const register = async (email: string, organizationName: string) => {
        const r = await run(() => request(base).post('/api/v1/auth/register').send({ email, name: 'Registro Competidor', organizationName, password: PASSWORD }));
        if (r.status === 201) saved.push(r.body as RegistrationResult);
        secure(r); return r;
      };
      const userRows = async (email: string) => await observer.query(SQL.userByEmail, [email]) as UserRow[];
      const memberships = async (userId: string) => await observer.query(SQL.membershipsOfUser, [userId]) as { id: string; organization_id: string; role: string; deactivated_at: Date | null }[];
      const accesses = async (membershipId: string) => await observer.query(SQL.accessesOfMembership, [membershipId]) as { company_id: string; organization_id: string; membership_role: string }[];
      const sessionsOf = async (userId: string) => await observer.query(SQL.sessionsOfUser, [userId]) as SessionRow[];
      const invitationRow = async (invitation: string) => ((await observer.query(SQL.invitationById, [invitation])) as InvitationRow[])[0];
      const snapshot = async () => ({ sessions: ((await observer.query(SQL.sessionCount)) as { n: number }[])[0].n,
        accessesA: ((await observer.query(SQL.accessCountByOrg, [orgs.A])) as { n: number }[])[0].n,
        accessesB: ((await observer.query(SQL.accessCountByOrg, [orgs.B])) as { n: number }[])[0].n });
      const isOpen = async (invitation: string) => { const row = await invitationRow(invitation); return row.accepted_at === null && row.accepted_by_user_id === null && row.revoked_at === null; };

      /** Everything an acceptance must leave: user, password, membership, exact accesses, the mark, and one session for the cookie. */
      const assertAccepted = async (options: { invitation: string; email: string; org: string; role: string; companies: string[]; name: string; cookie: string; sessions?: number }) => {
        const users = await userRows(options.email);
        expect(users.length === 1 && users[0].name === options.name).toBe(true);
        expect(users[0].password_hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$') && users[0].password_hash.indexOf(PASSWORD) === -1).toBe(true);
        expect(await hasher.verify(users[0].password_hash, PASSWORD)).toBe(true);
        const own = await memberships(users[0].id);
        expect(own.length === 1 && own[0].organization_id === options.org && own[0].role === options.role && own[0].deactivated_at === null).toBe(true);
        const rows = await accesses(own[0].id);
        expect(rows.map(a => a.company_id).join() === [...options.companies].sort().join() && rows.every(a => a.organization_id === options.org && a.membership_role === options.role)).toBe(true);
        const invitation = await invitationRow(options.invitation);
        expect(invitation.accepted_at !== null && invitation.accepted_at.getTime() === t0() && invitation.accepted_by_user_id === users[0].id && invitation.revoked_at === null).toBe(true);
        const session = await sessionsOf(users[0].id);
        const mine = session.filter(s => s.token_hash_hex === hashSessionToken(options.cookie).toString('hex'));
        expect(session.length === (options.sessions ?? 1) && mine.length === 1).toBe(true);
        expect(mine[0].active_organization_id === options.org && mine[0].created_at.getTime() === t0() && mine[0].last_seen_at.getTime() === t0()
          && mine[0].expires_at.getTime() === t0() + 7 * DAY && mine[0].revoked_at === null).toBe(true);
        return users[0];
      };
      /** A failed or losing acceptance leaves nothing: no user, no new session or access, and the invitation untouched. */
      const assertNothing = async (email: string, invitation: string, before: { sessions: number; accessesA: number; accessesB: number }) => {
        expect((await userRows(email)).length === 0).toBe(true);
        const row = await invitationRow(invitation);
        expect(row.accepted_at === null && row.accepted_by_user_id === null).toBe(true);
        const after = await snapshot();
        expect(after.sessions === before.sessions && after.accessesA === before.accessesA && after.accessesB === before.accessesB).toBe(true);
      };

      /* ---- 1 y 2. aceptación completa, contraseña, sesión y cookie ---- */
      step = 'aceptación completa de worker y client';
      const worker = await invite('cmA', 0, 'worker', [A[0], A[1]]);
      const client = await invite('cmA', 1, 'client', [A[2]]);
      expect((await inspect(worker.token)).body.status === 'open').toBe(true);
      const w = await accept(worker.token, 'Trabajadora Real');
      expect(w.status === 201 && w.body.user.email === acceptanceInvitee(id, 0) && w.body.membership.role === 'worker' && w.body.organization.id === orgs.A).toBe(true);
      const wCookie = accepted.get(acceptanceInvitee(id, 0))!;
      expect(w.body.csrfToken === deriveCsrfToken(wCookie) && w.body.token === undefined).toBe(true);
      const wUser = await assertAccepted({ invitation: worker.id, email: acceptanceInvitee(id, 0), org: orgs.A, role: 'worker', companies: [A[0], A[1]], name: 'Trabajadora Real', cookie: wCookie });
      const c = await accept(client.token, 'Cliente Real');
      expect(c.status === 201 && c.body.membership.role === 'client').toBe(true);
      const cCookie = accepted.get(acceptanceInvitee(id, 1))!;
      await assertAccepted({ invitation: client.id, email: acceptanceInvitee(id, 1), org: orgs.A, role: 'client', companies: [A[2]], name: 'Cliente Real', cookie: cCookie });

      /* ---- 3. acceso posterior solo a las empresas asignadas ---- */
      step = 'acceso posterior solo a las empresas asignadas';
      const asCookie = (token: string, req: request.Test) => req.set('Origin', ORIGIN).set('Cookie', `agenda_session=${token}`).set('X-CSRF-Token', deriveCsrfToken(token));
      for (const [cookie, role, assigned] of [[wCookie, 'worker', [A[0], A[1]]], [cCookie, 'client', [A[2]]]] as const) {
        const me = await run(() => asCookie(cookie, request(base).get('/api/v1/auth/session')));
        secure(me); expect(me.status === 200 && me.body.membership.role === role && me.body.organization.id === orgs.A).toBe(true);
        const list = await run(() => asCookie(cookie, request(base).get('/api/v1/companies?limit=100')));
        secure(list);
        expect(list.status === 200 && (list.body.items as { id: string }[]).map(i => i.id).sort().join() === [...assigned].sort().join()).toBe(true);
        const forbidden = [
          () => asCookie(cookie, request(base).post('/api/v1/companies')).send({ name: 'No Permitida', color: '#000000' }),
          () => asCookie(cookie, request(base).patch(`/api/v1/companies/${assigned[0]}`)).send({ version: 1, name: 'No Permitida' }),
          () => asCookie(cookie, request(base).get('/api/v1/invitations')),
        ];
        for (const make of forbidden) { const r = await run(make); secure(r); expect(r.status === 403).toBe(true); }
      }
      const spare = await invite('cmA', 13, 'worker', [A[3]]);
      const blocked = await accept(spare.token, 'Otra Persona', `agenda_session=${wCookie}`);
      expect(blocked.status === 409 && blocked.body.error?.code === 'session_active').toBe(true);
      expect(await isOpen(spare.id) && (await userRows(acceptanceInvitee(id, 13))).length === 0).toBe(true);
      step = 'login posterior genera otra sesión';
      const second = await login(acceptanceInvitee(id, 0));
      expect(second.token !== wCookie).toBe(true);
      const both = await sessionsOf(wUser.id);
      const fromAcceptance = both.filter(s => s.token_hash_hex === hashSessionToken(wCookie).toString('hex'));
      const fromLogin = both.filter(s => s.token_hash_hex === hashSessionToken(second.token).toString('hex'));
      expect(both.length === 2 && fromAcceptance.length === 1 && fromLogin.length === 1 && fromAcceptance[0].id !== fromLogin[0].id).toBe(true);
      expect(both.every(s => s.revoked_at === null && s.active_organization_id === orgs.A)).toBe(true);

      /* ---- 5. cuenta existente ---- */
      step = 'cuenta existente: nada cambia';
      const elsewhere = await invite('cmB', 0, 'client', [B[0]]);
      const before5 = await snapshot(); const hashBefore = (await userRows(acceptanceInvitee(id, 0)))[0].password_hash;
      const existing = await accept(elsewhere.token, 'Intento Ajeno');
      expect(existing.status === 409 && existing.body.error?.code === 'account_exists').toBe(true);
      const unchanged = (await userRows(acceptanceInvitee(id, 0)))[0];
      expect(unchanged.password_hash === hashBefore && unchanged.name === 'Trabajadora Real' && (await memberships(wUser.id)).length === 1).toBe(true);
      expect(await isOpen(elsewhere.id) && JSON.stringify(await snapshot()) === JSON.stringify(before5)).toBe(true);

      /* ---- 4. estados accepted pendientes de I1 ---- */
      step = 'filtro accepted y conflictos de gestión';
      const acceptedList = await run(() => as('cmA')(request(base).get('/api/v1/invitations?status=accepted&limit=100')));
      secure(acceptedList);
      expect(acceptedList.status === 200 && (acceptedList.body.items as { id: string }[]).map(i => i.id).sort().join() === [worker.id, client.id].sort().join()).toBe(true);
      expect((acceptedList.body.items as { acceptedAt: string | null; status: string }[]).every(i => i.status === 'accepted' && i.acceptedAt !== null)).toBe(true);
      for (const response of [await revoke('cmA', worker.id), await renew('cmA', worker.id)]) {
        expect(response.status === 409 && response.body.error?.code === 'invitation_accepted').toBe(true);
      }
      expect((await inspect(worker.token)).body.status === 'unavailable').toBe(true);
      const reused = await accept(worker.token, 'Reutilizar');
      expect(reused.status === 404 && reused.body.error?.code === 'invitation_unavailable').toBe(true);
      const again = await run(() => as('cmA')(request(base).post('/api/v1/invitations')).send({ email: acceptanceInvitee(id, 0), role: 'worker', companyIds: [A[0]] }));
      secure(again); expect(again.status === 409 && again.body.error?.code === 'member_already_active').toBe(true);

      /* ---- 6. dos aceptaciones del mismo token ---- */
      step = 'dos aceptaciones simultáneas del mismo token';
      const same = await invite('cmA', 2, 'worker', [A[0]]);
      const sameEmail = acceptanceInvitee(id, 2);
      const rowRace = (target: Invitation, org: string, first: { make: () => Promise<request.Response>; pattern: RegExp }, other: { make: () => Promise<request.Response>; pattern: RegExp }) =>
        holding(locker, [{ sql: acceptanceLocks.row, values: [target.id, org] }], async ({ pid, release, track }) => {
          const a = track(first.make()); await waitForWaiters(io, { blocker: pid, patterns: [first.pattern] });
          const b = track(other.make()); await waitForWaiters(io, { blocker: pid, patterns: [first.pattern, other.pattern] });
          await release();
          return Promise.all([a, b]);
        });
      const [s1, s2] = await rowRace(same, orgs.A, { make: () => accept(same.token, 'Primera Persona'), pattern: acceptLock }, { make: () => accept(same.token, 'Segunda Persona'), pattern: acceptLock });
      expect([s1.status, s2.status].sort().join() === '201,404').toBe(true);
      const winner = s1.status === 201 ? s1 : s2, loser = s1.status === 201 ? s2 : s1;
      expect(loser.body.error?.code === 'invitation_unavailable' && (await userRows(sameEmail)).length === 1).toBe(true);
      await assertAccepted({ invitation: same.id, email: sameEmail, org: orgs.A, role: 'worker', companies: [A[0]], name: winner.body.user.name, cookie: accepted.get(sameEmail)! });

      /* ---- 7. aceptar frente a revocar, en los dos órdenes ---- */
      for (const [order, n] of [['aceptar primero', 4], ['revocar primero', 3]] as const) {
        step = `aceptar frente a revocar (${order})`;
        const target = await invite('cmA', n, 'client', [A[1]]);
        const email = acceptanceInvitee(id, n);
        const before = await snapshot();
        const accepting = { make: () => accept(target.token, 'Carrera Revocar'), pattern: acceptLock };
        const revoking = { make: () => revoke('cmA', target.id), pattern: manageLock };
        const [first, other] = await rowRace(target, orgs.A, order === 'aceptar primero' ? accepting : revoking, order === 'aceptar primero' ? revoking : accepting);
        const [acceptance, revocation] = order === 'aceptar primero' ? [first, other] : [other, first];
        if (acceptance.status === 201) {
          expect(revocation.status === 409 && revocation.body.error?.code === 'invitation_accepted').toBe(true);
          await assertAccepted({ invitation: target.id, email, org: orgs.A, role: 'client', companies: [A[1]], name: 'Carrera Revocar', cookie: accepted.get(email)! });
        } else {
          expect(acceptance.status === 404 && acceptance.body.error?.code === 'invitation_unavailable' && revocation.status === 200).toBe(true);
          await assertNothing(email, target.id, before);
          expect((await invitationRow(target.id)).revoked_at !== null).toBe(true);
        }
        console.info(`[b2b] acceptance ${order} (revocar): aceptar=${acceptance.status} revocar=${revocation.status}`);
      }

      /* ---- 8. aceptar frente a renovar, en los dos órdenes ---- */
      for (const [order, n] of [['aceptar primero', 6], ['renovar primero', 5]] as const) {
        step = `aceptar frente a renovar (${order})`;
        const target = await invite('cmA', n, 'worker', [A[2]]);
        const email = acceptanceInvitee(id, n);
        const before = await snapshot();
        const accepting = { make: () => accept(target.token, 'Carrera Renovar'), pattern: acceptLock };
        const renewing = { make: () => renew('cmA', target.id), pattern: manageLock };
        const [first, other] = await rowRace(target, orgs.A, order === 'aceptar primero' ? accepting : renewing, order === 'aceptar primero' ? renewing : accepting);
        const [acceptance, renewal] = order === 'aceptar primero' ? [first, other] : [other, first];
        const rows = await observer.query(SQL.invitationsByEmail, [orgs.A, email]) as InvitationRow[];
        if (acceptance.status === 201) {
          expect(renewal.status === 409 && renewal.body.error?.code === 'invitation_accepted' && rows.length === 1).toBe(true);
          await assertAccepted({ invitation: target.id, email, org: orgs.A, role: 'worker', companies: [A[2]], name: 'Carrera Renovar', cookie: accepted.get(email)! });
        } else {
          expect(acceptance.status === 404 && renewal.status === 200 && rows.length === 2).toBe(true);
          await assertNothing(email, target.id, before);
          expect(rows.find(r => r.id === target.id)!.revoked_at !== null && await isOpen(renewal.body.id)).toBe(true);
          const fresh = await accept(renewal.body.token, 'Carrera Renovar');
          expect(fresh.status === 201).toBe(true);
          await assertAccepted({ invitation: renewal.body.id, email, org: orgs.A, role: 'worker', companies: [A[2]], name: 'Carrera Renovar', cookie: accepted.get(email)! });
        }
        console.info(`[b2b] acceptance ${order} (renovar): aceptar=${acceptance.status} renovar=${renewal.status}`);
      }

      /* ---- 9. colisión: aceptar frente a registrar el mismo correo ---- */
      for (const [round, n] of [[0, 7], [1, 8]] as const) {
        step = `colisión de correo con un registro (ronda ${round + 1})`;
        const target = await invite('cmA', n, 'worker', [A[3]]);
        const email = acceptanceInvitee(id, n), organizationName = reservations.competitors[round];
        const before = await snapshot();
        const [acceptance, registration] = await holding(locker, [{ sql: acceptanceLocks.users }], async ({ pid, release, track }) => {
          const a = track(accept(target.token, 'Contra Registro')), b = track(register(email, organizationName));
          await waitForWaiters(io, { blocker: pid, patterns: [acceptUserInsert, registerUserInsert] });
          await release();
          return Promise.all([a, b]);
        });
        const users = await userRows(email);
        expect(users.length === 1).toBe(true);
        const organization = await observer.query(SQL.organizationByName, [organizationName]) as { id: string }[];
        if (acceptance.status === 201) {
          expect(registration.status === 409 && registration.body.error?.field === 'email' && organization.length === 0).toBe(true);
          await assertAccepted({ invitation: target.id, email, org: orgs.A, role: 'worker', companies: [A[3]], name: 'Contra Registro', cookie: accepted.get(email)! });
        } else {
          expect(acceptance.status === 409 && acceptance.body.error?.code === 'account_exists' && registration.status === 201 && organization.length === 1).toBe(true);
          const own = await memberships(users[0].id);
          expect(own.length === 1 && own[0].organization_id === organization[0].id && own[0].role === 'community_manager').toBe(true);
          expect((await sessionsOf(users[0].id)).length === 0 && await isOpen(target.id)).toBe(true);
          const after = await snapshot();
          expect(after.sessions === before.sessions && after.accessesA === before.accessesA).toBe(true);
        }
        console.info(`[b2b] acceptance colisión con registro ronda ${round + 1}: aceptar=${acceptance.status} registrar=${registration.status}`);
      }

      /* ---- 10. colisión entre dos aceptaciones de organizaciones distintas ---- */
      step = 'colisión de correo entre dos aceptaciones';
      const inA = await invite('cmA', 9, 'worker', [A[0], A[2]]);
      const inB = await invite('cmB', 9, 'client', [B[0]]);
      const clash = acceptanceInvitee(id, 9);
      const before10 = await snapshot();
      const [fromA, fromB] = await holding(locker, [{ sql: acceptanceLocks.users }], async ({ pid, release, track }) => {
        const a = track(accept(inA.token, 'Doble Alta')), b = track(accept(inB.token, 'Doble Alta'));
        await waitForWaiters(io, { blocker: pid, patterns: [acceptUserInsert, acceptUserInsert] });
        await release();
        return Promise.all([a, b]);
      });
      expect([fromA.status, fromB.status].sort().join() === '201,409').toBe(true);
      const won = fromA.status === 201 ? { invitation: inA, org: orgs.A, role: 'worker', companies: [A[0], A[2]], other: inB } : { invitation: inB, org: orgs.B, role: 'client', companies: [B[0]], other: inA };
      const lost = fromA.status === 201 ? fromB : fromA;
      expect(lost.body.error?.code === 'account_exists').toBe(true);
      await assertAccepted({ invitation: won.invitation.id, email: clash, org: won.org, role: won.role, companies: won.companies, name: 'Doble Alta', cookie: accepted.get(clash)! });
      const after10 = await snapshot();
      expect(await isOpen(won.other.id) && after10.sessions === before10.sessions + 1
        && after10.accessesA === before10.accessesA + (won.org === orgs.A ? 2 : 0) && after10.accessesB === before10.accessesB + (won.org === orgs.B ? 1 : 0)).toBe(true);

      /* ---- 11 y 12. rollback real por lock_timeout ---- */
      for (const [label, lockSql, pattern, n, name] of [
        ['rollback en los accesos', acceptanceLocks.accesses, accessInsert, 10, 'Rollback Accesos'],
        ['rollback en la sesión (tras la marca de uso)', acceptanceLocks.sessions, sessionInsert, 11, 'Rollback Sesion'],
      ] as const) {
        step = label;
        const target = await invite('cmA', n, 'worker', [A[0], A[1]]);
        const email = acceptanceInvitee(id, n);
        const before = await snapshot();
        const started = Date.now();
        // The lock is NOT released: the request reaches the named statement (proven by the waiter) and fails by the application lock_timeout.
        const failed = await holding(locker, [{ sql: lockSql }], async ({ pid, track }) => {
          const pending = track(accept(target.token, name));
          await waitForWaiters(io, { blocker: pid, patterns: [pattern] });
          return pending;
        });
        const elapsed = Date.now() - started;
        expect(failed.status === 503 && failed.body.error?.code === 'service_unavailable' && failed.headers['retry-after'] === '1').toBe(true);
        expect(elapsed >= LOCK_WAIT.timeoutMinMs && elapsed <= LOCK_WAIT.timeoutMaxMs).toBe(true);
        await assertNothing(email, target.id, before);
        expect(await isOpen(target.id)).toBe(true);
        const retried = await accept(target.token, name);
        expect(retried.status === 201).toBe(true);
        await assertAccepted({ invitation: target.id, email, org: orgs.A, role: 'worker', companies: [A[0], A[1]], name, cookie: accepted.get(email)! });
      }

      /* ---- 13. vencimiento comprobado tras adquirir el bloqueo (al final: el reloj solo avanza) ---- */
      step = 'vencimiento tras adquirir el bloqueo';
      const short = await invite('cmA', 12, 'client', [A[3]], 1);
      const shortEmail = acceptanceInvitee(id, 12);
      expect((await inspect(short.token)).body.status === 'open').toBe(true);
      const before13 = await snapshot();
      const expired = await holding(locker, [{ sql: acceptanceLocks.row, values: [short.id, orgs.A] }], async ({ pid, release, track }) => {
        const pending = track(accept(short.token, 'Llega Tarde'));
        await waitForWaiters(io, { blocker: pid, patterns: [acceptLock] }); // already past the early read, waiting at the lock
        clock.advance(2 * DAY);
        await release();
        return pending;
      });
      expect(expired.status === 409 && expired.body.error?.code === 'invitation_expired').toBe(true);
      await assertNothing(shortEmail, short.id, before13);
      expect((await inspect(short.token)).body.status === 'expired').toBe(true);
      const expiredList = await run(() => as('cmA')(request(base).get('/api/v1/invitations?status=expired&limit=100')));
      // Two days later the manager's session is renewed by the guard, which re-issues its cookie: only here is a cookie expected.
      secure(expiredList, { cookie: true }); expect(expiredList.status === 200 && (expiredList.body.items as { id: string }[]).some(i => i.id === short.id)).toBe(true);

      /* ---- 14. logs ---- */
      step = 'logs sin secretos';
      const log = logs.text();
      expect(logs.overflowed()).toBe(false);
      expect(log.length > 0 && log.includes('Solicitud finalizada.')).toBe(true);
      expect(sessionTokens.length >= 11 && invitationTokens.length >= 16).toBe(true); // minimum for any valid combination of race winners
      expect(secrets().some(secret => log.includes(secret))).toBe(false);
      expect(log.includes('/invitacion#') || log.includes('$argon2')).toBe(false);
    } catch (error) { throw new Error(formatAuthFailure(step, error, 'acceptance')); }
  }, 600000);
}
