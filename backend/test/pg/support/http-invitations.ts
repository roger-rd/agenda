/**
 * Invitations phase (connected). Writes, by actor:
 *  - application, over HTTP: users, organizations and memberships (register cmA/cmB), user_sessions (login), companies (POST),
 *    invitations and invitation_companies (create, renew, revoke).
 *  - observer: INSERT of users and memberships wA, mA (active member) and dA (deactivated member); UPDATE of created_at only, on invitations the
 *    application created in this run, to exact microsecond values (the application clock has millisecond resolution); DELETE (cleanup).
 *  - locker: a second connection that only HOLDS locks inside a transaction it always rolls back (row lock, SHARE lock on
 *    invitation_companies) and one INSERT per cross-organization attempt that must fail, also rolled back.
 * It never writes accepted_at or accepted_by_user_id (acceptances are out of scope). No DDL, no role or database settings.
 */
import request from 'supertest';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { AppConfigService } from '../../../src/config/app-config.service';
import { IdGenerator } from '../../../src/common/ids/id-generator';
import { classifyDatabaseError } from '../../../src/database/errors/database-failure';
import { DatabaseOperationError } from '../../../src/database/errors/database-operation-error';
import { PasswordHasher } from '../../../src/identity/password-hasher';
import { deriveCsrfToken } from '../../../src/identity/session-token';
import { decodeInvitationsCursor } from '../../../src/invitations/invitations-cursor';
import type { RegistrationResult } from '../../../src/registration/registration.service';
import { DeleteGate } from './markers';
import { ControlledClock } from './auth-controls';
import { formatAuthFailure } from './auth-failure';
import type { LogCapture } from './invitations-logging';
import {
  canSetCreatedAt, cutInsideTie, evaluateWaiters, expectedPaginationOrder, inviteeEmail, invitationsSQL as SQL,
  LOCK_WAIT, lostByMillisecondBound, microsOf, PAGINATION_LIMITS, PAGINATION_ROWS, PAGINATION_TIE_KEYS,
  type DatedRow, type InvitationActor, type InvitationsSaved, type invitationsMarkers,
} from './invitations-fixture';

type Context = {
  app: INestApplication; source: DataSource; observer: DataSource; locker: DataSource; clock: ControlledClock; gate: DeleteGate;
  saved: RegistrationResult[]; seeded: InvitationsSaved; reservations: ReturnType<typeof invitationsMarkers>; id: string; zone: string;
  appPids: () => Promise<number[]>; logs: LogCapture; ready: boolean;
};
type Issued = { id: string; token: string; link: string };
const ORIGIN = 'https://app.agenda.test';
const DOMAIN = 'agenda-invitation-token-v1';
const uuid7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const failure = (error: unknown) => error instanceof DatabaseOperationError ? error.failure : classifyDatabaseError(error);
const storedHash = (token: string) => createHash('sha256').update(DOMAIN).update(Buffer.from([0])).update(Buffer.from(token, 'base64url')).digest('hex');

export function registerInvitationsTest(context: () => Context): void {
  test('invitations real: zonas, concurrencia, rollback, paginación con microsegundos y aislamiento', async () => {
    let step = 'preparación';
    try {
      const { app, source, observer, locker, clock, gate, saved, seeded, reservations, id, zone, appPids, logs, ready } = context();
      expect(ready).toBe(true);
      const password = 'B2b-invitations-long-passphrase-2026!';
      const users = {} as Record<InvitationActor, string>;
      const sessions = {} as Record<'cmA' | 'cmB' | 'wA', { token: string; csrf: string }>;
      const orgs = {} as Record<'A' | 'B', string>;
      const issued: Issued[] = [];
      await app.listen(0, '127.0.0.1');
      const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      const secrets = () => [password, ...Object.values(sessions).flatMap(s => [s.token, s.csrf]), ...issued.flatMap(i => [i.token, i.link, storedHash(i.token)])];
      /** Only a successful create or renew may carry a token and a link (the one it issues); everything else must carry none of the issued secrets. */
      const secure = (r: request.Response, issuer = false) => {
        expect(r.headers['cache-control'] === 'no-store').toBe(true);
        expect(typeof r.headers['x-request-id'] === 'string' && r.headers['x-request-id'].length > 0).toBe(true);
        const body = { ...r.body }; delete body.csrfToken;
        if (issuer && (r.status === 200 || r.status === 201)) { delete body.token; delete body.link; }
        const headers = { ...r.headers }; delete headers['set-cookie'];
        const output = JSON.stringify({ body, headers });
        expect(secrets().some(secret => output.includes(secret))).toBe(false);
      };
      const owners = new Map<string, 'cmA' | 'cmB'>();
      const remember = (r: request.Response, actor: 'cmA' | 'cmB') => {
        if ((r.status === 201 || r.status === 200) && typeof r.body?.token === 'string') {
          expect(uuid7.test(r.body.id) && r.body.link === `/invitacion#${r.body.token}` && /^[A-Za-z0-9_-]{43}$/.test(r.body.token)).toBe(true);
          issued.push({ id: r.body.id, token: r.body.token, link: r.body.link }); seeded.invitations.push(r.body.id); owners.set(r.body.id, actor);
        }
      };
      const send = async (make: () => request.Test, issuer?: 'cmA' | 'cmB') => {
        gate.assertArmed(); const r = await make().timeout(15000); secure(r, issuer !== undefined);
        if (issuer) remember(r, issuer);
        return r;
      };
      const as = (actor: 'cmA' | 'cmB' | 'wA') => (req: request.Test, csrf = true) => {
        req.set('Origin', ORIGIN).set('Cookie', `agenda_session=${sessions[actor].token}`);
        return csrf ? req.set('X-CSRF-Token', sessions[actor].csrf) : req;
      };
      const create = (actor: 'cmA' | 'cmB', body: object) => send(() => as(actor)(request(base).post('/api/v1/invitations')).send(body), actor);
      const renew = (actor: 'cmA' | 'cmB', invitation: string, body: object = {}) => send(() => as(actor)(request(base).post(`/api/v1/invitations/${invitation}/renew`)).send(body), actor);
      const revoke = (actor: 'cmA' | 'cmB', invitation: string) => send(() => as(actor)(request(base).post(`/api/v1/invitations/${invitation}/revoke`)));
      const list = (actor: 'cmA' | 'cmB' | 'wA', query = '') => send(() => as(actor)(request(base).get(`/api/v1/invitations${query}`), false));
      const rowsOf = async (org: string, email: string): Promise<(DatedRow & { id: string; email: string; created_at: Date })[]> => observer.query(SQL.invitationsByEmail, [org, email]);
      const openOf = <T extends DatedRow>(rows: T[]): T[] => rows.filter(r => r.revoked_at === null && r.accepted_at === null);
      const companiesCount = async (invitation: string): Promise<number> => (await observer.query(SQL.invitationCompaniesCount, [invitation]))[0].n as number;
      const sameError = (a: request.Response, b: request.Response) => a.status === b.status && a.body.error?.code === b.body.error?.code && a.body.error?.message === b.body.error?.message;

      /* ---- siembra ---- */
      step = 'registro de las dos organizaciones';
      console.info('[b2b] invitations reservas', reservations.reserved);
      gate.arm();
      for (const [actor, org] of [['cmA', 'A'], ['cmB', 'B']] as const) {
        gate.assertArmed();
        const r = await request(base).post('/api/v1/auth/register').send({ ...reservations.byActor[actor], name: 'Invitations Tester', password }).timeout(15000);
        if (r.status === 201) saved.push(r.body as RegistrationResult);
        secure(r); expect(r.status === 201 && r.headers['set-cookie'] === undefined).toBe(true);
        users[actor] = (r.body as RegistrationResult).user.id; orgs[org] = (r.body as RegistrationResult).organization.id;
      }
      step = 'siembra de worker, miembro activo y miembro desactivado';
      const hash = await app.get(PasswordHasher).hash(password), now = clock.now();
      expect(hash.startsWith('$argon2id$')).toBe(true);
      for (const [actor, deactivated] of [['wA', false], ['mA', false], ['dA', true]] as const) {
        users[actor] = app.get(IdGenerator).next(); seeded.users.push(users[actor]);
        const membership = app.get(IdGenerator).next(); seeded.memberships.push(membership);
        gate.assertArmed();
        await observer.query('INSERT INTO public.users (id,email,name,password_hash,password_changed_at,version,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,1,$5,$5)',
          [users[actor], reservations.byActor[actor].email, 'Invitations Tester', hash, now]);
        await observer.query('INSERT INTO public.organization_memberships (id,organization_id,user_id,role,deactivated_at,version,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,1,$6,$6)',
          [membership, orgs.A, users[actor], 'worker', deactivated ? now : null, now]);
      }
      step = 'logins';
      for (const actor of ['cmA', 'cmB', 'wA'] as const) {
        const r = await send(() => request(base).post('/api/v1/auth/login').send({ email: reservations.byActor[actor].email, password }));
        expect(r.status === 200).toBe(true);
        const cookies: unknown = r.headers['set-cookie'];
        expect(Array.isArray(cookies) && cookies.length === 1 && /^agenda_session=[A-Za-z0-9_-]{43};/.test(cookies[0])).toBe(true);
        const token = (cookies as string[])[0].split(';')[0].slice('agenda_session='.length);
        sessions[actor] = { token, csrf: deriveCsrfToken(token) };
      }
      step = 'empresas de A y B';
      const company = async (actor: 'cmA' | 'cmB', name: string): Promise<string> => {
        const r = await send(() => as(actor)(request(base).post('/api/v1/companies')).send({ name, color: '#aabbcc' }));
        expect(r.status === 201 && uuid7.test(r.body.id)).toBe(true); seeded.companies.push(r.body.id); return r.body.id as string;
      };
      const A = [await company('cmA', 'Alfa Uno'), await company('cmA', 'Alfa Dos'), await company('cmA', 'Alfa Tres')];
      const B = [await company('cmB', 'Beta Uno'), await company('cmB', 'Beta Dos')];

      /* ---- zona horaria de las conexiones de la aplicación ---- */
      step = 'zona horaria de las conexiones (aplicación, observador y locker)';
      expect(['info', 'debug', 'trace'].includes(app.get(AppConfigService).logLevel)).toBe(true);
      const pool = await Promise.all(Array.from({ length: 8 }, () => source.query(SQL.poolTimeZone) as Promise<{ pid: number; tz: string }[]>));
      const poolPids = pool.map(r => r[0].pid);
      const lockerPid = ((await locker.query(SQL.backendPid)) as { pid: number }[])[0].pid;
      const observerPid = ((await observer.query(SQL.backendPid)) as { pid: number }[])[0].pid;
      expect(new Set(poolPids).size === 8 && pool.every(r => r[0].tz === zone)).toBe(true);
      const ownApp = await appPids();
      expect(poolPids.every(pid => ownApp.includes(pid)) && !poolPids.includes(lockerPid) && !poolPids.includes(observerPid)).toBe(true);
      expect(((await observer.query(SQL.sessionTimeZone)) as { tz: string }[])[0].tz === zone).toBe(true);
      expect(((await locker.query(SQL.sessionTimeZone)) as { tz: string }[])[0].tz === zone).toBe(true);
      await observer.query(SQL.observerZone);
      const observerZone = ((await observer.query(SQL.sessionTimeZone)) as { tz: string }[])[0].tz;
      expect(observerZone === 'Asia/Tokyo' && observerZone !== zone).toBe(true);
      console.info(`[b2b] invitations zonas: PostgreSQL(aplicación)=${zone} observador=${observerZone} Node=${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

      /* ---- esperas por pids concretos ---- */
      const waitForWaiters = async (expected: number, blocker: number, deadlineMs: number): Promise<void> => {
        const deadline = Date.now() + deadlineMs; let last = 'sin lectura';
        for (;;) {
          const own = await appPids();
          const rows = own.length ? await observer.query(SQL.appBlocking, [own]) as { pid: number; wait_event_type: string | null; wait_event: string | null; blockers: number[] }[] : [];
          const verdict = evaluateWaiters(rows, { locker: blocker, own, expected });
          if (verdict.state === 'ready') return;
          if (verdict.state === 'invalid') throw new Error(`[b2b] espera inválida: ${verdict.reason}`);
          last = verdict.reason;
          if (Date.now() >= deadline) throw new Error(`[b2b] las esperas no se observaron a tiempo: ${last}`);
          await sleep(LOCK_WAIT.pollMs);
        }
      };
      type Hold = { pid: number; release: () => Promise<void>; track: <T>(promise: Promise<T>) => Promise<T> };
      /** Holds locks in the locker's own transaction. Always rolled back; its own idle and lock waits are bounded. */
      const holding = async <T>(statements: { sql: string; values?: unknown[] }[], body: (hold: Hold) => Promise<T>): Promise<T> => {
        const runner = locker.createQueryRunner(); const pending: Promise<unknown>[] = [];
        const release = async () => { if (runner.isTransactionActive) await runner.rollbackTransaction(); };
        try {
          await runner.connect(); await runner.startTransaction();
          await runner.query(SQL.lockerLockTimeout); await runner.query(SQL.lockerIdleTimeout);
          const pid = ((await runner.query(SQL.backendPid)) as { pid: number }[])[0].pid;
          for (const s of statements) await runner.query(s.sql, s.values);
          return await body({ pid, release, track: promise => { pending.push(promise); return promise; } });
        } finally {
          try { await release(); } finally { try { await runner.release(); } finally { await Promise.allSettled(pending); } }
        }
      };
      /** Brief concurrency hold: both requests must be observed waiting on the locker well inside lock_timeout, then the lock is released. */
      const briefRace = async (target: string, org: string, first: () => Promise<request.Response>, second: () => Promise<request.Response>) =>
        holding([{ sql: SQL.lockRow, values: [target, org] }], async ({ pid, release, track }) => {
          const a = track(first()); await waitForWaiters(1, pid, LOCK_WAIT.briefObserveMs);
          const b = track(second()); await waitForWaiters(2, pid, LOCK_WAIT.briefObserveMs);
          await release();
          return Promise.all([a, b]);
        });

      /* ---- 1. dos creaciones simultáneas del mismo correo ---- */
      step = 'dos creaciones simultáneas del mismo correo';
      for (let round = 0; round < 5; round++) {
        const email = inviteeEmail(id, round), body = { email, role: 'worker', companyIds: [A[0], A[1]] };
        const [x, y] = await Promise.all([create('cmA', body), create('cmA', body)]);
        expect([x.status, y.status].sort().join() === '201,409').toBe(true);
        const winner = x.status === 201 ? x : y, loser = x.status === 201 ? y : x;
        expect(loser.body.error?.code === 'invitation_pending_exists' && loser.body.error?.field === 'email').toBe(true);
        const rows = await rowsOf(orgs.A, email);
        expect(rows.length === 1 && openOf(rows).length === 1 && rows[0].id === winner.body.id).toBe(true);
        expect(await companiesCount(winner.body.id) === 2).toBe(true);
      }

      /* ---- 2. dos renovaciones de la misma invitación ---- */
      step = 'dos renovaciones simultáneas (bloqueo de fila)';
      const toRenew = await create('cmA', { email: inviteeEmail(id, 10), role: 'client', companyIds: [A[1], A[2]] });
      expect(toRenew.status === 201).toBe(true);
      const [r1, r2] = await briefRace(toRenew.body.id, orgs.A, () => renew('cmA', toRenew.body.id), () => renew('cmA', toRenew.body.id));
      expect([r1.status, r2.status].sort().join() === '200,409').toBe(true);
      const won = r1.status === 200 ? r1 : r2, beaten = r1.status === 200 ? r2 : r1;
      expect(beaten.body.error?.code === 'invitation_revoked').toBe(true);
      const renewRows = await rowsOf(orgs.A, inviteeEmail(id, 10));
      expect(renewRows.length === 2 && openOf(renewRows).length === 1 && openOf(renewRows)[0].id === won.body.id).toBe(true);
      expect(renewRows.find(r => r.id === toRenew.body.id)!.revoked_at !== null).toBe(true);
      expect((await observer.query(SQL.invitationCompaniesOf, [won.body.id]) as { company_id: string }[]).map(c => c.company_id).join() === [A[1], A[2]].sort().join()).toBe(true);

      /* ---- 3. renovar frente a revocar, en los dos órdenes ---- */
      for (const order of ['renovar primero', 'revocar primero'] as const) {
        step = `renovar frente a revocar (${order})`;
        const email = inviteeEmail(id, order === 'renovar primero' ? 11 : 12);
        const made = await create('cmA', { email, role: 'worker', companyIds: [A[0]] });
        expect(made.status === 201).toBe(true);
        const doRenew = () => renew('cmA', made.body.id), doRevoke = () => revoke('cmA', made.body.id);
        const [first, second] = await briefRace(made.body.id, orgs.A, order === 'renovar primero' ? doRenew : doRevoke, order === 'renovar primero' ? doRevoke : doRenew);
        const [renewed, revoked] = order === 'renovar primero' ? [first, second] : [second, first];
        const rows = await rowsOf(orgs.A, email);
        const old = rows.find(r => r.id === made.body.id)!;
        expect(old.revoked_at !== null && revoked.status === 200 && revoked.body.revokedAt === old.revoked_at.toISOString()).toBe(true);
        if (renewed.status === 200) {
          expect(rows.length === 2 && openOf(rows).length === 1 && openOf(rows)[0].id === renewed.body.id).toBe(true);
        } else {
          expect(renewed.status === 409 && renewed.body.error?.code === 'invitation_revoked' && rows.length === 1 && openOf(rows).length === 0).toBe(true);
        }
        console.info(`[b2b] invitations ${order}: renovación=${renewed.status} revocación=${revoked.status}`);
      }

      /* ---- 4. rollback real por lock_timeout (distinto de los bloqueos breves) ---- */
      step = 'rollback real de renovar tras revocar la anterior';
      const stay = await create('cmA', { email: inviteeEmail(id, 13), role: 'worker', companyIds: [A[0], A[1]] });
      expect(stay.status === 201).toBe(true);
      const before = await rowsOf(orgs.A, inviteeEmail(id, 13));
      const t0 = Date.now();
      const timedOut = await holding([{ sql: SQL.lockCompanies }], async ({ pid, track }) => {
        const pending = track(renew('cmA', stay.body.id));
        // The request revokes the previous row and inserts the replacement, then waits on invitation_companies; the lock is NOT released.
        await waitForWaiters(1, pid, LOCK_WAIT.briefObserveMs);
        return pending;
      });
      const elapsed = Date.now() - t0;
      expect(timedOut.status === 503 && timedOut.body.error?.code === 'service_unavailable' && timedOut.headers['retry-after'] === '1').toBe(true);
      expect(elapsed >= LOCK_WAIT.timeoutMinMs && elapsed <= LOCK_WAIT.timeoutMaxMs).toBe(true);
      const after = await rowsOf(orgs.A, inviteeEmail(id, 13));
      expect(after.length === before.length && after[0].id === stay.body.id && after[0].revoked_at === null).toBe(true);
      expect(await companiesCount(stay.body.id) === 2).toBe(true);
      step = 'rollback real de crear con las empresas bloqueadas';
      const lockedEmail = inviteeEmail(id, 14);
      const createTimedOut = await holding([{ sql: SQL.lockCompanies }], async ({ pid, track }) => {
        const pending = track(create('cmA', { email: lockedEmail, role: 'client', companyIds: [A[0]] }));
        await waitForWaiters(1, pid, LOCK_WAIT.briefObserveMs);
        return pending;
      });
      expect(createTimedOut.status === 503 && createTimedOut.body.error?.code === 'service_unavailable').toBe(true);
      expect((await rowsOf(orgs.A, lockedEmail)).length === 0).toBe(true);
      expect((await create('cmA', { email: lockedEmail, role: 'client', companyIds: [A[0]] })).status === 201).toBe(true);
      expect((await renew('cmA', stay.body.id)).status === 200).toBe(true);

      /* ---- 5. paginación con microsegundos y empates (organización B) ---- */
      step = 'paginación: siembra de microsegundos';
      const keyById = new Map<string, { key: string; at: string }>();
      for (const [index, fixture] of PAGINATION_ROWS.entries()) {
        const made = await create('cmB', { email: inviteeEmail(id, 20 + index), role: 'client', companyIds: [B[index % 2]] });
        expect(made.status === 201).toBe(true);
        const row = (await observer.query(SQL.invitationById, [made.body.id]) as (DatedRow & { organization_id: string })[])[0];
        expect(row.organization_id === orgs.B && canSetCreatedAt(row, fixture.at)).toBe(true); // respeta CK_invitations_times
        gate.assertArmed();
        await observer.query(SQL.setCreatedAt, [made.body.id, orgs.B, fixture.at]);
        keyById.set(made.body.id, { key: fixture.key, at: fixture.at });
      }
      const stored = await observer.query(SQL.createdAtText, [orgs.B]) as { id: string; created_at_us: string }[];
      expect(stored.length === PAGINATION_ROWS.length && stored.every(r => keyById.get(r.id)!.at === r.created_at_us)).toBe(true);
      const dated = [...keyById].map(([rowId, v]) => ({ id: rowId, at: v.at }));
      const expectedOrder = expectedPaginationOrder(dated);
      expect(stored.map(r => r.id).join() === expectedOrder.join()).toBe(true); // PostgreSQL y el cálculo exacto coinciden, empates por id descendente
      step = 'paginación: los datos ejercitan microsegundos y empates';
      const sameMillisecond = PAGINATION_ROWS.filter(r => r.at.startsWith('2026-03-01T10:00:00.123'));
      expect(sameMillisecond.length >= 6 && new Set(sameMillisecond.map(r => r.at)).size >= 4).toBe(true);
      const tieIds = [...keyById].filter(([, v]) => (PAGINATION_TIE_KEYS as readonly string[]).includes(v.key)).map(([rowId]) => rowId);
      expect(tieIds.length === 3 && new Set(tieIds.map(rowId => keyById.get(rowId)!.at)).size === 1).toBe(true);
      const ordered = expectedOrder.map(rowId => ({ id: rowId, at: keyById.get(rowId)!.at }));
      expect(cutInsideTie(ordered, 2) && cutInsideTie(ordered, 3)).toBe(true);
      const top = ordered[0];
      const skipped = (await observer.query(SQL.millisecondLoss, [orgs.B, top.at, top.id]) as { id: string }[]).map(r => r.id);
      const expectedLoss = lostByMillisecondBound(dated, top);
      expect(skipped.join() === expectedLoss.join() && skipped.length >= 4).toBe(true); // un cursor en milisegundos habría perdido esas filas
      step = 'paginación: recorrido completo por límites';
      for (const limit of PAGINATION_LIMITS) {
        const seen: string[] = []; let cursor: string | undefined; let pages = 0;
        do {
          const page = await list('cmB', `?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
          expect(page.status === 200 && Array.isArray(page.body.items) && page.body.items.length <= limit).toBe(true);
          for (const item of page.body.items as { id: string; createdAt: string; status: string; companyIds: string[] }[]) {
            // The API shows milliseconds (the driver's Date); the driver may truncate or round the sub-millisecond part, never more than 1 ms.
            const apiMs = Date.parse(item.createdAt), exactMs = Date.parse(`${keyById.get(item.id)!.at.slice(0, 23)}Z`);
            expect((apiMs === exactMs || apiMs === exactMs + 1) && item.status === 'open').toBe(true);
            seen.push(item.id);
          }
          cursor = page.body.nextCursor ?? undefined; pages++;
          if (cursor) {
            const last = page.body.items.at(-1) as { id: string };
            const decoded = decodeInvitationsCursor(cursor);
            expect(decoded.id === last.id && decoded.createdAt === keyById.get(last.id)!.at && /\.\d{6}Z$/.test(decoded.createdAt)).toBe(true);
          }
        } while (cursor && pages <= PAGINATION_ROWS.length);
        expect(seen.join() === expectedOrder.join() && pages === Math.ceil(PAGINATION_ROWS.length / limit)).toBe(true);
      }
      expect(microsOf(top.at) > microsOf(ordered.at(-1)!.at)).toBe(true);

      /* ---- 7. aislamiento entre organizaciones ---- */
      step = 'aislamiento entre organizaciones';
      const idsA = (await list('cmA', '?limit=100')).body.items.map((i: { id: string }) => i.id) as string[];
      const idsB = (await list('cmB', '?limit=100')).body.items.map((i: { id: string }) => i.id) as string[];
      const ownedBy = (actor: 'cmA' | 'cmB') => [...owners].filter(([, owner]) => owner === actor).map(([invitation]) => invitation).sort();
      expect(idsA.length > 0 && [...idsA].sort().join() === ownedBy('cmA').join()).toBe(true);
      expect(idsB.length >= PAGINATION_ROWS.length && [...idsB].sort().join() === ownedBy('cmB').join()).toBe(true);
      expect(!idsA.some(x => idsB.includes(x))).toBe(true);
      const missing = await revoke('cmA', '01900000-0000-7000-8000-00000000ffff');
      for (const attempt of [await revoke('cmB', toRenew.body.id), await renew('cmB', stay.body.id)]) {
        expect(attempt.status === 404 && sameError(attempt, missing)).toBe(true);
      }
      expect(((await create('cmB', { email: inviteeEmail(id, 30), role: 'worker', companyIds: [A[0]] })).body.error?.field) === 'companyIds').toBe(true);
      const both = [await create('cmA', { email: inviteeEmail(id, 31), role: 'worker', companyIds: [A[0]] }), await create('cmB', { email: inviteeEmail(id, 31), role: 'worker', companyIds: [B[0]] })];
      expect(both.every(r => r.status === 201)).toBe(true);
      expect((await rowsOf(orgs.A, inviteeEmail(id, 31))).length === 1 && (await rowsOf(orgs.B, inviteeEmail(id, 31))).length === 1).toBe(true);
      step = 'miembros activos y desactivados';
      for (const [actor, code] of [['mA', 'member_already_active'], ['dA', 'member_deactivated']] as const) {
        const r = await create('cmA', { email: reservations.byActor[actor].email, role: 'worker', companyIds: [A[0]] });
        expect(r.status === 409 && r.body.error?.code === code && r.body.error?.field === 'email').toBe(true);
        expect((await rowsOf(orgs.A, reservations.byActor[actor].email)).length === 0).toBe(true);
      }
      const memberships = await observer.query('SELECT user_id, deactivated_at FROM public.organization_memberships WHERE user_id = ANY($1::uuid[]) ORDER BY user_id', [[users.mA, users.dA]]) as { user_id: string; deactivated_at: Date | null }[];
      expect(memberships.find(m => m.user_id === users.mA)!.deactivated_at === null && memberships.find(m => m.user_id === users.dA)!.deactivated_at !== null).toBe(true);
      step = 'claves foráneas compuestas: referencias cruzadas rechazadas';
      const foreign = won.body.id as string; // an open invitation of A with its two companies
      const beforeCross = await companiesCount(foreign);
      const cross = async (invitation: string, companyId: string, organization: string) => {
        const runner = locker.createQueryRunner();
        try {
          await runner.connect(); await runner.startTransaction(); await runner.query(SQL.lockerIdleTimeout);
          try { await runner.query(SQL.crossCompany, [invitation, companyId, organization]); return { sqlState: 'ninguno', constraint: 'ninguna' }; }
          catch (error) { const f = failure(error); return { sqlState: f?.sqlState, constraint: f?.constraint }; }
        } finally { try { if (runner.isTransactionActive) await runner.rollbackTransaction(); } finally { await runner.release(); } }
      };
      const viaCompany = await cross(foreign, B[0], orgs.A), viaInvitation = await cross(foreign, B[0], orgs.B);
      expect(viaCompany.sqlState === '23503' && viaCompany.constraint === 'FK_invitation_companies_company').toBe(true);
      expect(viaInvitation.sqlState === '23503' && viaInvitation.constraint === 'FK_invitation_companies_invitation').toBe(true);
      expect(beforeCross === 2 && await companiesCount(foreign) === beforeCross).toBe(true);

      /* ---- 8. hash almacenado y token ---- */
      step = 'hash almacenado correcto y token ausente de la base';
      expect(issued.length >= 20).toBe(true);
      for (const item of issued) {
        const row = (await observer.query(SQL.tokenHash, [item.id]) as { hex: string; bytes: number }[])[0];
        expect(row.bytes === 32 && row.hex === storedHash(item.token)).toBe(true);
        expect(row.hex !== createHash('sha256').update(Buffer.from(item.token, 'base64url')).digest('hex')).toBe(true); // no es el hash de sesión
      }
      const texts = (await observer.query(SQL.rowText, [issued.map(i => i.id)]) as { text: string }[]).map(r => r.text).join('\n');
      expect(issued.some(i => texts.includes(i.token) || texts.includes(Buffer.from(i.token, 'base64url').toString('hex'))) === false).toBe(true);
      const renewedOld = issued.find(i => i.id === toRenew.body.id);
      const openHolders = async (token: string) => (await observer.query(SQL.tokenHashHolders, [storedHash(token)]) as { id: string }[]).map(r => r.id);
      expect(renewedOld === undefined || (await openHolders(renewedOld.token)).length === 0).toBe(true);
      expect((await openHolders(won.body.token)).join() === won.body.id).toBe(true);

      /* ---- 9. respuestas no autorizadas ---- */
      step = 'respuestas no autorizadas sin token';
      const anyA = won.body.id as string; // open before and after the unauthorized attempts
      const snapshot = JSON.stringify(await observer.query(SQL.invitationById, [anyA]));
      const calls: [string, (csrf: boolean) => request.Test][] = [
        ['crear', () => request(base).post('/api/v1/invitations').send({ email: inviteeEmail(id, 40), role: 'worker', companyIds: [A[0]] })],
        ['listar', () => request(base).get('/api/v1/invitations')],
        ['revocar', () => request(base).post(`/api/v1/invitations/${anyA}/revoke`)],
        ['renovar', () => request(base).post(`/api/v1/invitations/${anyA}/renew`).send({})],
      ];
      for (const [name, make] of calls) {
        gate.assertArmed();
        const anonymous = await make(false).set('Origin', ORIGIN).timeout(15000); secure(anonymous);
        expect(anonymous.status === 401).toBe(true);
        if (name !== 'listar') {
          const badCsrf = await make(false).set('Origin', ORIGIN).set('Cookie', `agenda_session=${sessions.cmA.token}`).set('X-CSRF-Token', 'incorrecto').timeout(15000); secure(badCsrf);
          expect(badCsrf.status === 403).toBe(true);
        }
        const worker = await as('wA')(make(true), name !== 'listar').timeout(15000); secure(worker);
        expect(worker.status === 403).toBe(true);
      }
      expect(JSON.stringify(await observer.query(SQL.invitationById, [anyA])) === snapshot).toBe(true);
      expect((await rowsOf(orgs.A, inviteeEmail(id, 40))).length === 0).toBe(true);

      /* ---- 9b. logs ---- */
      step = 'logs sin token, enlace ni hash';
      const log = logs.text();
      expect(logs.overflowed()).toBe(false);
      expect(log.includes('Solicitud finalizada.')).toBe(true);
      expect(secrets().some(secret => log.includes(secret))).toBe(false);
      expect(log.includes('/invitacion#')).toBe(false);
    } catch (error) { throw new Error(formatAuthFailure(step, error, 'invitations')); }
  }, 600000);
}
