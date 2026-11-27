/**
 * Members phase (connected). Writes, by actor:
 *  - application, over HTTP: users, organizations and memberships (register cmA/cmB), user_sessions (login and acceptance), companies,
 *    invitations and invitation_companies, the acceptances (users, memberships, accesses, marks, sessions) and the access replacements (PUT).
 *  - observer: SELECT, the cleanup DELETEs and exactly ONE manual UPDATE: DEACTIVATE_MEMBER_SQL, on a member created by this run.
 *  - locker: holds row and SHARE table locks inside a transaction it always rolls back. It writes nothing.
 * No DDL, no role or database settings. Real members only: nothing else is seeded or modified by hand.
 */
import request from 'supertest';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { AppConfigService } from '../../../src/config/app-config.service';
import { deriveCsrfToken, hashSessionToken } from '../../../src/identity/session-token';
import { BUMP_MEMBER_VERSION_SQL, DELETE_ACCESSES_SQL, LOCK_MEMBER_SQL } from '../../../src/members/member-sql';
import type { RegistrationResult } from '../../../src/registration/registration.service';
import { DeleteGate } from './markers';
import { ControlledClock } from './auth-controls';
import { formatAuthFailure } from './auth-failure';
import { invitationsSQL, LOCK_WAIT, type InvitationsSaved } from './invitations-fixture';
import type { LogCapture } from './invitations-log-capture';
import { holding, startsLike, waitForWaiters, type WaitIo } from './lock-support';
import { DEACTIVATE_MEMBER_SQL, membersInvitee, membersLocks, membersSQL as SQL, type membersMarkers } from './members-fixture';

type Context = {
  app: INestApplication; source: DataSource; observer: DataSource; locker: DataSource; clock: ControlledClock; gate: DeleteGate;
  saved: RegistrationResult[]; seeded: InvitationsSaved; reservations: ReturnType<typeof membersMarkers>; id: string; zone: string;
  appPids: () => Promise<number[]>; logs: LogCapture; ready: boolean;
};
type Actor = 'cmA' | 'cmB';
type Member = { id: string; cookie: string; name: string; email: string };
type MembershipRow = { id: string; organization_id: string; user_id: string; role: string; version: number; deactivated_at: string | null; created_at: string; updated_at: string };
type AccessRow = { company_id: string; organization_id: string; membership_role: string; created_at: string };
type Snapshot = { membership: MembershipRow; accesses: AccessRow[] };

const ORIGIN = 'https://app.agenda.test';
const PASSWORD = 'B2b-members-long-passphrase-2026!';
const COOKIE = /^agenda_session=([A-Za-z0-9_-]{43}); Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800$/;
const invitationHash = (token: string) => createHash('sha256').update('agenda-invitation-token-v1').update(Buffer.from([0])).update(Buffer.from(token, 'base64url')).digest('hex');
const lockMember = startsLike(LOCK_MEMBER_SQL);
const bumpVersion = startsLike(BUMP_MEMBER_VERSION_SQL);
const deleteAccesses = startsLike(DELETE_ACCESSES_SQL);
const ascending = (ids: readonly string[]) => [...ids].sort().join();

export function registerMembersTest(context: () => Context): void {
  test('members real: accesos, concurrencia, rollback, aislamiento y miembro desactivado', async () => {
    let step = 'preparación';
    try {
      const { app, source, observer, locker, clock, gate, saved, seeded, reservations, id, zone, appPids, logs, ready } = context();
      expect(ready).toBe(true);
      await app.listen(0, '127.0.0.1');
      const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      const sessionTokens: string[] = [];
      const invitationTokens: string[] = [];
      const people: string[] = [];
      const secrets = () => [PASSWORD, ...sessionTokens.flatMap(t => [t, deriveCsrfToken(t), hashSessionToken(t).toString('hex')]),
        ...invitationTokens.flatMap(t => [t, invitationHash(t)])];
      const secure = (r: request.Response, allow: { cookie?: boolean; issuer?: boolean } = {}) => {
        expect(r.headers['cache-control'] === 'no-store').toBe(true);
        expect(typeof r.headers['x-request-id'] === 'string' && r.headers['x-request-id'].length > 0).toBe(true);
        if (!allow.cookie) expect(r.headers['set-cookie'] === undefined).toBe(true);
        const body = { ...r.body }; delete body.csrfToken;
        if (allow.issuer && (r.status === 200 || r.status === 201)) { delete body.token; delete body.link; }
        const headers = { ...r.headers }; delete headers['set-cookie'];
        expect(secrets().some(secret => JSON.stringify({ body, headers }).includes(secret))).toBe(false);
      };
      const run = async (make: () => request.Test) => { gate.assertArmed(); return make().timeout(15000); };
      const cookieToken = (r: request.Response): string => {
        const cookies: unknown = r.headers['set-cookie'];
        expect(Array.isArray(cookies) && cookies.length === 1 && COOKIE.test(cookies[0])).toBe(true);
        const token = COOKIE.exec((cookies as string[])[0])![1];
        sessionTokens.push(token);
        return token;
      };
      const asCookie = (token: string, req: request.Test) => req.set('Origin', ORIGIN).set('Cookie', `agenda_session=${token}`).set('X-CSRF-Token', deriveCsrfToken(token));

      /* ---- siembra real ---- */
      step = 'registro y logins de los community managers';
      console.info('[b2b] members reservas', { organizations: [reservations.cmA.organizationName, reservations.cmB.organizationName], invitees: reservations.invitees.length });
      gate.arm();
      const orgs = {} as Record<'A' | 'B', string>;
      const managers = {} as Record<Actor, { token: string; membership: string }>;
      for (const [actor, org, name] of [['cmA', 'A', 'Canario Gestora Alfa'], ['cmB', 'B', 'Canario Gestora Beta']] as const) {
        const registered = await run(() => request(base).post('/api/v1/auth/register').send({ ...reservations[actor], name, password: PASSWORD }));
        if (registered.status === 201) saved.push(registered.body as RegistrationResult);
        secure(registered); expect(registered.status === 201).toBe(true);
        const result = registered.body as RegistrationResult;
        orgs[org] = result.organization.id;
        people.push(name, reservations[actor].email);
        const login = await run(() => request(base).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: reservations[actor].email, password: PASSWORD }));
        expect(login.status === 200).toBe(true);
        managers[actor] = { token: cookieToken(login), membership: result.membership.id };
        secure(login, { cookie: true });
      }
      const as = (actor: Actor, req: request.Test) => asCookie(managers[actor].token, req);
      step = 'empresas';
      const company = async (actor: Actor, name: string): Promise<string> => {
        const r = await run(() => as(actor, request(base).post('/api/v1/companies')).send({ name, color: '#aabbcc' }));
        secure(r); expect(r.status === 201).toBe(true); seeded.companies.push(r.body.id); return r.body.id as string;
      };
      const A = [await company('cmA', 'Alfa Uno'), await company('cmA', 'Alfa Dos'), await company('cmA', 'Alfa Tres'), await company('cmA', 'Alfa Cuatro')];
      const B = [await company('cmB', 'Beta Uno')];
      step = 'miembros por invitación y aceptación reales';
      const member = async (actor: Actor, n: number, role: 'worker' | 'client', companyIds: string[], name: string): Promise<Member> => {
        const email = membersInvitee(id, n);
        const invited = await run(() => as(actor, request(base).post('/api/v1/invitations')).send({ email, role, companyIds }));
        expect(invited.status === 201).toBe(true);
        invitationTokens.push(invited.body.token); seeded.invitations.push(invited.body.id); secure(invited, { issuer: true });
        const accepted = await run(() => request(base).post('/api/v1/invitations/accept').set('Origin', ORIGIN).send({ token: invited.body.token, name, password: PASSWORD }));
        expect(accepted.status === 201).toBe(true);
        const cookie = cookieToken(accepted);
        secure(accepted, { cookie: true });
        seeded.users.push(accepted.body.user.id); seeded.memberships.push(accepted.body.membership.id);
        people.push(name, email);
        return { id: accepted.body.membership.id as string, cookie, name, email };
      };
      const worker = await member('cmA', 0, 'worker', [A[0], A[1]], 'Canario Miembro Trabajador');
      const client = await member('cmA', 1, 'client', [A[2]], 'Canario Miembro Cliente');
      const outsider = await member('cmB', 2, 'worker', [B[0]], 'Canario Miembro Ajeno');

      /* ---- zona y conexiones ---- */
      step = 'zona horaria de las conexiones';
      expect(['info', 'debug', 'trace'].includes(app.get(AppConfigService).logLevel)).toBe(true);
      const pool = await Promise.all(Array.from({ length: 8 }, () => source.query(invitationsSQL.poolTimeZone) as Promise<{ pid: number; tz: string }[]>));
      const poolPids = pool.map(r => r[0].pid);
      const lockerPid = ((await locker.query(invitationsSQL.backendPid)) as { pid: number }[])[0].pid;
      const observerPid = ((await observer.query(invitationsSQL.backendPid)) as { pid: number }[])[0].pid;
      expect(new Set(poolPids).size === 8 && pool.every(r => r[0].tz === zone)).toBe(true);
      const ownApp = await appPids();
      expect(poolPids.every(pid => ownApp.includes(pid)) && !poolPids.includes(lockerPid) && !poolPids.includes(observerPid)).toBe(true);
      expect(((await observer.query(invitationsSQL.sessionTimeZone)) as { tz: string }[])[0].tz === zone).toBe(true);
      const io: WaitIo = { query: (sql, params) => observer.query(sql, params as unknown[]), appPids };

      /* ---- ayudantes ---- */
      const list = async (actor: Actor, query = '') => { const r = await run(() => as(actor, request(base).get(`/api/v1/members${query}`))); secure(r); return r; };
      const put = async (actor: Actor, target: string, version: number, companyIds: string[]) => {
        const r = await run(() => as(actor, request(base).put(`/api/v1/members/${target}/accesses`)).send({ version, companyIds }));
        secure(r); return r;
      };
      const snapshot = async (target: string): Promise<Snapshot> => ({
        membership: ((await observer.query(SQL.membership, [target])) as MembershipRow[])[0],
        accesses: (await observer.query(SQL.accesses, [target])) as AccessRow[],
      });
      const same = (a: Snapshot, b: Snapshot) => JSON.stringify(a) === JSON.stringify(b);
      const companiesOf = (s: Snapshot) => ascending(s.accesses.map(a => a.company_id));
      const visible = async (who: Member) => {
        const r = await run(() => asCookie(who.cookie, request(base).get('/api/v1/companies?limit=100')));
        secure(r); expect(r.status === 200).toBe(true);
        return ascending((r.body.items as { id: string }[]).map(i => i.id));
      };
      const advance = () => clock.advance(1000);
      const atClock = (text: string) => Date.parse(text.replace(' ', 'T').replace(/\+00$/, 'Z')) === clock.now().getTime();

      /* ---- 1. listado ---- */
      step = 'listado de miembros';
      const all = await list('cmA');
      const items = all.body.items as { id: string; role: string; status: string; version: number; companyAccess: string; companyIds: string[] }[];
      expect(all.status === 200 && ascending(items.map(i => i.id)) === ascending([worker.id, client.id, managers.cmA.membership])).toBe(true);
      expect(items.map(i => i.id).join() === [...items.map(i => i.id)].sort().join()).toBe(true);
      const byId = new Map(items.map(i => [i.id, i]));
      expect(byId.get(worker.id)!.companyIds.join() === ascending([A[0], A[1]]) && byId.get(worker.id)!.companyAccess === 'assigned' && byId.get(worker.id)!.version === 1).toBe(true);
      expect(byId.get(client.id)!.companyIds.join() === A[2] && byId.get(client.id)!.status === 'active').toBe(true);
      expect(byId.get(managers.cmA.membership)!.companyAccess === 'all' && byId.get(managers.cmA.membership)!.companyIds.length === 0).toBe(true);
      expect(ascending(((await list('cmA', '?role=worker')).body.items as { id: string }[]).map(i => i.id)) === worker.id).toBe(true);
      expect(((await list('cmA', '?status=deactivated')).body.items as unknown[]).length === 0).toBe(true);
      for (const limit of [1, 2]) {
        const seen: string[] = []; let cursor: string | undefined; let pages = 0;
        do {
          const page = await list('cmA', `?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
          expect(page.status === 200).toBe(true);
          seen.push(...(page.body.items as { id: string }[]).map(i => i.id)); cursor = page.body.nextCursor ?? undefined; pages++;
        } while (cursor && pages < 5);
        expect(seen.join() === items.map(i => i.id).join()).toBe(true);
      }

      /* ---- 2. cambio efectivo ---- */
      step = 'cambio efectivo: solo diferencias y una subida';
      advance();
      const before2 = await snapshot(worker.id);
      const changed = await put('cmA', worker.id, 1, [A[2], A[1]]);
      expect(changed.status === 200 && changed.body.version === 2 && changed.body.companyIds.join() === ascending([A[1], A[2]])).toBe(true);
      const after2 = await snapshot(worker.id);
      expect(companiesOf(after2) === ascending([A[1], A[2]]) && after2.membership.version === 2 && atClock(after2.membership.updated_at)).toBe(true);
      expect(after2.membership.created_at === before2.membership.created_at && after2.membership.deactivated_at === null).toBe(true);
      expect(after2.accesses.find(a => a.company_id === A[1])!.created_at === before2.accesses.find(a => a.company_id === A[1])!.created_at).toBe(true);
      expect(atClock(after2.accesses.find(a => a.company_id === A[2])!.created_at)).toBe(true);

      /* ---- 3 y 4. conjunto idéntico y versión desactualizada ---- */
      step = 'conjunto idéntico: sin cambiar versión ni fecha';
      advance();
      const identical = await put('cmA', worker.id, 2, [A[2], A[1]]);
      expect(identical.status === 200 && identical.body.version === 2).toBe(true);
      expect(same(await snapshot(worker.id), after2)).toBe(true);
      step = 'versión desactualizada con el mismo conjunto';
      const stale = await put('cmA', worker.id, 1, [A[1], A[2]]);
      expect(stale.status === 409 && stale.body.error?.code === 'version_conflict').toBe(true);
      expect(same(await snapshot(worker.id), after2)).toBe(true);

      /* ---- 5. retirada vista desde la sesión del miembro ---- */
      step = 'retirada de accesos vista en la siguiente petición del miembro';
      expect(await visible(worker) === ascending([A[1], A[2]])).toBe(true);
      advance();
      expect((await put('cmA', worker.id, 2, [A[1]])).status === 200).toBe(true);
      expect(await visible(worker) === A[1]).toBe(true);
      advance();
      const emptied = await put('cmA', worker.id, 3, []);
      expect(emptied.status === 200 && emptied.body.version === 4 && emptied.body.companyIds.length === 0).toBe(true);
      expect(await visible(worker) === '').toBe(true);
      const stillIn = await run(() => asCookie(worker.cookie, request(base).get('/api/v1/auth/session')));
      secure(stillIn); expect(stillIn.status === 200 && stillIn.body.membership.role === 'worker').toBe(true);
      const emptySnapshot = await snapshot(worker.id);
      expect(emptySnapshot.accesses.length === 0 && emptySnapshot.membership.version === 4 && emptySnapshot.membership.deactivated_at === null).toBe(true);

      /* ---- 6. dos cambios efectivos con la misma versión ---- */
      step = 'dos cambios efectivos simultáneos con la misma versión';
      advance();
      expect((await put('cmA', worker.id, 4, [A[0]])).status === 200).toBe(true);
      const base6 = await snapshot(worker.id);
      expect(base6.membership.version === 5).toBe(true);
      advance();
      const [first, second] = await holding(locker, [{ sql: membersLocks.row, values: [worker.id, orgs.A] }], async ({ pid, release, track }) => {
        const a = track(put('cmA', worker.id, 5, [A[1]]));
        await waitForWaiters(io, { blocker: pid, patterns: [lockMember] });
        const b = track(put('cmA', worker.id, 5, [A[2]]));
        await waitForWaiters(io, { blocker: pid, patterns: [lockMember, lockMember] });
        await release();
        return Promise.all([a, b]);
      });
      expect([first.status, second.status].sort().join() === '200,409').toBe(true);
      const winner = first.status === 200 ? first : second, loser = first.status === 200 ? second : first;
      expect(loser.body.error?.code === 'version_conflict' && winner.body.version === 6).toBe(true);
      const after6 = await snapshot(worker.id);
      expect(after6.membership.version === 6 && companiesOf(after6) === winner.body.companyIds.join() && after6.accesses.length === 1).toBe(true);
      console.info(`[b2b] members concurrencia: primera=${first.status} segunda=${second.status}`);

      /* ---- 7. rollback en el último paso: bloqueado en el UPDATE de versión ---- */
      step = 'rollback en la subida de versión, después de borrar e insertar accesos';
      advance();
      const base7 = await snapshot(client.id);
      expect(base7.membership.version === 1 && companiesOf(base7) === A[2]).toBe(true);
      const started7 = Date.now();
      // SHARE lets SELECT ... FOR UPDATE and the access writes through and stops only the version UPDATE. The lock is NOT released.
      const failed7 = await holding(locker, [{ sql: membersLocks.memberships }], async ({ pid, track }) => {
        const pending = track(put('cmA', client.id, 1, [A[0], A[1]]));
        await waitForWaiters(io, { blocker: pid, patterns: [bumpVersion] });
        return pending;
      });
      const elapsed7 = Date.now() - started7;
      expect(failed7.status === 503 && failed7.body.error?.code === 'service_unavailable' && failed7.headers['retry-after'] === '1').toBe(true);
      expect(elapsed7 >= LOCK_WAIT.timeoutMinMs && elapsed7 <= LOCK_WAIT.timeoutMaxMs).toBe(true);
      expect(same(await snapshot(client.id), base7)).toBe(true);
      step = 'reintento manual tras el rollback del último paso';
      const retried7 = await put('cmA', client.id, 1, [A[0], A[1]]);
      expect(retried7.status === 200 && retried7.body.version === 2).toBe(true);
      const after7 = await snapshot(client.id);
      expect(after7.membership.version === 2 && companiesOf(after7) === ascending([A[0], A[1]]) && atClock(after7.membership.updated_at)).toBe(true);

      /* ---- 8. rollback en la primera escritura ---- */
      step = 'rollback en la primera escritura de accesos';
      advance();
      const base8 = await snapshot(client.id);
      const started8 = Date.now();
      const failed8 = await holding(locker, [{ sql: membersLocks.accesses }], async ({ pid, track }) => {
        const pending = track(put('cmA', client.id, 2, [A[3]]));
        await waitForWaiters(io, { blocker: pid, patterns: [deleteAccesses] });
        return pending;
      });
      const elapsed8 = Date.now() - started8;
      expect(failed8.status === 503 && failed8.body.error?.code === 'service_unavailable').toBe(true);
      expect(elapsed8 >= LOCK_WAIT.timeoutMinMs && elapsed8 <= LOCK_WAIT.timeoutMaxMs).toBe(true);
      expect(same(await snapshot(client.id), base8)).toBe(true);
      const retried8 = await put('cmA', client.id, 2, [A[3]]);
      expect(retried8.status === 200 && retried8.body.version === 3 && companiesOf(await snapshot(client.id)) === A[3]).toBe(true);

      /* ---- 9. aislamiento entre organizaciones ---- */
      step = 'aislamiento entre organizaciones';
      const listB = await list('cmB', '?status=all');
      expect(ascending((listB.body.items as { id: string }[]).map(i => i.id)) === ascending([outsider.id, managers.cmB.membership])).toBe(true);
      expect(!((await list('cmA', '?status=all')).body.items as { id: string }[]).some(i => i.id === outsider.id || i.id === managers.cmB.membership)).toBe(true);
      const snapshotA = await snapshot(worker.id), snapshotB = await snapshot(outsider.id);
      const missing = await put('cmA', '01900000-0000-7000-8000-00000000ffff', 1, []);
      for (const attempt of [await put('cmB', worker.id, snapshotA.membership.version, []), await put('cmA', outsider.id, snapshotB.membership.version, [])]) {
        expect(attempt.status === 404 && attempt.body.error?.code === missing.body.error?.code && attempt.body.error?.message === missing.body.error?.message && missing.status === 404).toBe(true);
      }
      const foreignCompany = await put('cmA', worker.id, snapshotA.membership.version, [B[0]]);
      expect(foreignCompany.status === 400 && foreignCompany.body.error?.field === 'companyIds').toBe(true);
      expect(same(await snapshot(worker.id), snapshotA) && same(await snapshot(outsider.id), snapshotB)).toBe(true);

      /* ---- 10. roles ---- */
      step = 'roles: solo community manager';
      for (const who of [worker, client]) {
        for (const make of [() => asCookie(who.cookie, request(base).get('/api/v1/members')),
          () => asCookie(who.cookie, request(base).put(`/api/v1/members/${client.id}/accesses`)).send({ version: 1, companyIds: [] })]) {
          const r = await run(make); secure(r); expect(r.status === 403).toBe(true);
        }
      }
      const managerTarget = await put('cmA', managers.cmA.membership, 1, [A[0]]);
      expect(managerTarget.status === 409 && managerTarget.body.error?.code === 'member_not_assignable').toBe(true);

      /* ---- 11. miembro desactivado: la única modificación manual del observador ---- */
      step = 'desactivación simulada por el observador (una sola fila)';
      advance();
      const beforeOff = await snapshot(client.id);
      // Only a membership this run created, in its own organization.
      expect(seeded.memberships.includes(client.id) && beforeOff.membership.organization_id === orgs.A && beforeOff.membership.deactivated_at === null).toBe(true);
      expect(await visible(client) === A[3]).toBe(true);
      gate.assertArmed();
      const [updated, affected] = await observer.query(DEACTIVATE_MEMBER_SQL, [client.id, clock.now(), orgs.A]) as [{ id: string }[], number];
      expect(affected === 1 && updated.length === 1 && updated[0].id === client.id).toBe(true);
      const off = await snapshot(client.id);
      expect(off.membership.version === beforeOff.membership.version && off.membership.deactivated_at !== null && atClock(off.membership.deactivated_at) && off.membership.updated_at === off.membership.deactivated_at).toBe(true);
      expect(JSON.stringify(off.accesses) === JSON.stringify(beforeOff.accesses)).toBe(true);
      step = 'miembro desactivado: listado, cambios y sesión';
      const active = (await list('cmA')).body.items as { id: string }[];
      expect(!active.some(i => i.id === client.id)).toBe(true);
      const deactivated = (await list('cmA', '?status=deactivated')).body.items as { id: string; status: string }[];
      expect(deactivated.length === 1 && deactivated[0].id === client.id && deactivated[0].status === 'deactivated').toBe(true);
      const refused = await put('cmA', client.id, off.membership.version, [A[0]]);
      expect(refused.status === 409 && refused.body.error?.code === 'member_deactivated').toBe(true);
      const refusedStale = await put('cmA', client.id, off.membership.version - 1, [A[0]]);
      expect(refusedStale.status === 409 && refusedStale.body.error?.code === 'version_conflict').toBe(true);
      expect(same(await snapshot(client.id), off)).toBe(true);
      const lockedOut = await run(() => asCookie(client.cookie, request(base).get('/api/v1/companies')));
      secure(lockedOut, { cookie: true }); expect(lockedOut.status === 401).toBe(true);
      expect(await visible(worker) === companiesOf(await snapshot(worker.id))).toBe(true);

      /* ---- 12. logs ---- */
      step = 'logs sin secretos ni datos de las personas';
      const log = logs.text();
      expect(logs.overflowed()).toBe(false);
      expect(log.length > 0 && log.includes('Solicitud finalizada.')).toBe(true);
      expect(sessionTokens.length === 5 && invitationTokens.length === 3 && people.length === 10).toBe(true);
      expect(secrets().some(secret => log.includes(secret))).toBe(false);
      expect(people.some(value => log.includes(value))).toBe(false);
      expect(log.includes('$argon2') || log.includes('/invitacion#')).toBe(false);
    } catch (error) { throw new Error(formatAuthFailure(step, error, 'members')); }
  }, 600000);
}
