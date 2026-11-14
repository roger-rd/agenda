import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthenticationService, ROTATE_SESSION_SQL, SESSION_TOKEN_FACTORY } from '../../../src/auth/authentication.service';
import { TOUCH_SESSION_SQL } from '../../../src/auth/session.service';
import { PasswordHasher } from '../../../src/identity/password-hasher';
import { deriveCsrfToken, hashSessionToken } from '../../../src/identity/session-token';
import { IdGenerator } from '../../../src/common/ids/id-generator';
import { User } from '../../../src/persistence/entities/user.entity';
import { UserSession } from '../../../src/persistence/entities/user-session.entity';
import { DataSourceTransactionRunner } from '../../../src/registration/transaction-runner';
import type { RegistrationResult } from '../../../src/registration/registration.service';
import { authMarkers, DeleteGate } from './markers';
import { ControlledClock, DAY, expiry, renewalDays } from './auth-controls';

import { formatAuthFailure } from './auth-failure';

type Context = { app: INestApplication; observer: DataSource; source: DataSource; clock: ControlledClock;
  gate: DeleteGate; saved: RegistrationResult[]; id: string; ready: boolean };
type Row = { id: string; user_id: string; token_hash: Buffer; active_organization_id: string;
  created_at: Date; last_seen_at: Date; expires_at: Date; revoked_at: Date | null };
const password = 'B2b-auth-only-long-passphrase-2026!';
const keys = (value: object, expected: string[]) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
export function registerAuthTest(context: () => Context): void {
  test('auth real: sesiones, límite absoluto, rollback, concurrencia y membresía', async () => {
    let step = 'preparación';
    try {
      const { app, observer, source, clock, gate, saved, id, ready } = context();
      expect(ready).toBe(true);
      const markers = authMarkers(id), tokens: string[] = [];
      await app.listen(0, '127.0.0.1');
      const port = (app.getHttpServer().address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;
      const rows = async (): Promise<Row[]> => observer.query('SELECT * FROM public.user_sessions ORDER BY id');
      let expectedCount = 0;
      const count = async () => expect((await rows()).length).toBe(expectedCount);
      const secure = (r: request.Response) => {
        expect(r.headers['cache-control'] === 'no-store').toBe(true);
        const headers = { ...r.headers }; delete headers['set-cookie'];
        for (const secret of [password, ...tokens, ...tokens.map(deriveCsrfToken), ...tokens.map(t => hashSessionToken(t).toString('hex')), ...tokens.map(t => hashSessionToken(t).toString('base64'))]) {
          expect(JSON.stringify(headers).includes(secret)).toBe(false);
          const body = { ...r.body }; if (r.status === 200) delete body.csrfToken;
          expect(JSON.stringify(body).includes(secret)).toBe(false);
        }
        expect(r.text.includes('$argon2') || r.text.includes('token_hash') || r.text.includes('tokenHash')).toBe(false);
        const cookies = JSON.stringify(r.headers['set-cookie'] ?? []);
        expect(cookies.includes(password) || tokens.some(t => cookies.includes(deriveCsrfToken(t)))).toBe(false);
      };
      const send = async (make: () => request.Test) => {
        gate.assertArmed();
        const r = await make(); secure(r); return r;
      };
      const cookie = (token: string) => `agenda_session=${token}`;
      const setCookie = (r: request.Response, token: string, age: number) =>
        expect(JSON.stringify(r.headers['set-cookie']) === JSON.stringify([`${cookie(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}`])).toBe(true);
      const clear = (r: request.Response) => expect(JSON.stringify(r.headers['set-cookie']) === JSON.stringify([
        'agenda_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      ])).toBe(true);
      const register = async (marker: typeof markers.a) => {
        const r = await request(base).post('/api/v1/auth/register').send({ ...marker, name: 'Auth Tester', password });
        if (r.status === 201) saved.push(r.body as RegistrationResult);
        secure(r); expect(r.status).toBe(201); return r.body as RegistrationResult;
      };
      await count(); gate.arm();
      step = 'registro A';
      const a = await register(markers.a);
      step = 'registro B';
      await count(); const b = await register(markers.b);
      const login = async (email = markers.a.email, presented?: string, origin?: string, secret = password, status = 200) => {
        await count();
        const before = JSON.stringify(await rows());
        const r = await send(() => {
          const req = request(base).post('/api/v1/auth/login').send({ email, password: secret });
          if (presented) req.set('Cookie', cookie(presented));
          if (origin !== undefined) req.set('Origin', origin);
          return req;
        });
        expect(r.status).toBe(status);
        if (status !== 200) {
          expect(r.headers['set-cookie'] === undefined).toBe(true);
          if (status === 401) expect(r.body?.error?.message === 'Credenciales inválidas.').toBe(true);
          await count(); expect(JSON.stringify(await rows()) === before).toBe(true); return '';
        }
        const header: unknown = r.headers['set-cookie'];
        expect(Array.isArray(header) && header.length === 1 && /^agenda_session=[A-Za-z0-9_-]{43};/.test(header[0])).toBe(true);
        const token = (header as string[])[0].slice('agenda_session='.length).split(';')[0];
        tokens.push(token); secure(r);
        expect(keys(r.body, ['user', 'organization', 'membership', 'csrfToken', 'expiresAt'])).toBe(true);
        expect(keys(r.body.user, ['id', 'email', 'name']) && keys(r.body.organization, ['id', 'name']) && keys(r.body.membership, ['id', 'role'])).toBe(true);
        expect(r.body.csrfToken === deriveCsrfToken(token)).toBe(true);
        expect(r.body.expiresAt === new Date(clock.now().getTime() + 7 * DAY).toISOString()).toBe(true);
        setCookie(r, token, 604800); expectedCount++; await count(); return token;
      };
      const row = async (token: string) => {
        const found = (await rows()).filter(r => r.token_hash.equals(hashSessionToken(token)));
        expect(found.length).toBe(1); return found[0];
      };
      const session = async (token: string, status = 200) => {
        await count();
        const r = await send(() => request(base).get('/api/v1/auth/session').set('Cookie', cookie(token)));
        expect(r.status).toBe(status);
        if (status === 401) clear(r);
        else {
          expect(keys(r.body, ['user', 'organization', 'membership', 'csrfToken', 'expiresAt'])).toBe(true);
          expect(r.body.csrfToken === deriveCsrfToken(token)).toBe(true);
        }
        await count(); return r;
      };
      step = 'login T0';
      const t0 = clock.now().getTime(), s1 = await login();
      const initial = await row(s1);
      expect((await rows()).filter(r => r.user_id === a.user.id).length).toBe(1);
      expect(initial.token_hash.length === 32 && initial.token_hash.equals(hashSessionToken(s1))).toBe(true);
      expect(initial.active_organization_id === a.organization.id && initial.revoked_at === null).toBe(true);
      expect(+initial.created_at === t0 && +initial.last_seen_at === t0 && +initial.expires_at === t0 + 7 * DAY).toBe(true);
      expect(Object.values(initial).filter(v => typeof v === 'string').some(v => v.includes(s1))).toBe(false);
      step = 'sesión sin renovación';
      expect((await session(s1)).headers['set-cookie'] === undefined).toBe(true);
      step = 'renovación +6min';
      clock.advance(6 * 60000);
      // Observe the real driver result; retain the original implementation and parameters.
      const repository = source.getRepository(UserSession), originalQuery = repository.query.bind(repository);
      let touched = false;
      const spy = jest.spyOn(repository, 'query').mockImplementation(async (sql, parameters) => {
        const result: unknown = await originalQuery(sql, parameters);
        if (sql === TOUCH_SESSION_SQL) {
          expect(Array.isArray(result) && Array.isArray(result[0]) && result[1] === 1).toBe(true);
          expect(Array.isArray(parameters) && parameters[1] === 2592000 && parameters[2] === 604800).toBe(true); touched = true;
        }
        return result;
      });
      try { setCookie(await session(s1), s1, 604800); expect(touched).toBe(true); } finally { spy.mockRestore(); }
      expect(+(await row(s1)).last_seen_at === +clock.now() && +(await row(s1)).expires_at === +clock.now() + 7 * DAY).toBe(true);
      for (const day of renewalDays) {
        step = `tope día ${day}`;
        clock.set(t0 + day * DAY);
        const r = await session(s1), stored = await row(s1), expires = expiry(t0, +clock.now());
        expect(+stored.last_seen_at === +clock.now() && +stored.expires_at === expires).toBe(true);
        setCookie(r, s1, Math.floor((expires - +clock.now()) / 1000));
      }
      expect(+(await row(s1)).expires_at === t0 + 30 * DAY).toBe(true);
      step = 'límite día 30';
      for (const delta of [0, 1000]) {
        clock.set(t0 + 30 * DAY + delta); await session(s1, 401); expect((await row(s1)).revoked_at === null).toBe(true);
      }
      step = 'login con cookie vencida';
      const expiredSnapshot = JSON.stringify(await row(s1));
      const s2 = await login(markers.a.email, s1), sb2 = await login(markers.b.email);
      expect(JSON.stringify(await row(s1)) === expiredSnapshot).toBe(true);
      const logout = async (csrf?: string, status = 204) => {
        await count(); const r = await send(() => {
          const req = request(base).post('/api/v1/auth/logout').set('Cookie', cookie(s2));
          if (csrf !== undefined) req.set('X-CSRF-Token', csrf); return req;
        });
        expect(r.status).toBe(status);
        if (status === 204) clear(r); else expect(r.headers['set-cookie'] === undefined).toBe(true);
        await count();
      };
      step = 'logout CSRF';
      for (const csrf of [undefined, 'incorrecto']) { await logout(csrf, 403); expect((await row(s2)).revoked_at === null).toBe(true); }
      await logout(deriveCsrfToken(s2)); expect(+(await row(s2)).revoked_at! === +clock.now()).toBe(true);
      await session(s2, 401); const revoked = JSON.stringify(await row(s2));
      await logout(deriveCsrfToken(s2)); expect(JSON.stringify(await row(s2)) === revoked).toBe(true);
      step = 'rotación';
      const s3 = await login(), s4 = await login(markers.a.email, s3);
      expect(+(await row(s3)).revoked_at! === +clock.now()).toBe(true);
      step = 'cookie revocada/ajena';
      for (const token of [s2, sb2]) {
        const before = await rows(); await login(markers.a.email, token);
        const after = await rows(); expect(before.every(r => JSON.stringify(after.find(x => x.id === r.id)) === JSON.stringify(r))).toBe(true);
      }
      step = 'rollback real';
      await count(); const beforeRollback = JSON.stringify(await rows());
      let rotated = false;
      const synthetic = new Error('auth synthetic insert failure');
      class FailingRunner extends DataSourceTransactionRunner {
        override run<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
          return super.run(manager => work(new Proxy(manager, { get(target, property) {
            if (property === 'query') return async (sql: string, parameters?: unknown[]) => {
              const result: unknown = await target.query(sql, parameters);
              if (sql === ROTATE_SESSION_SQL) {
                expect(Array.isArray(result) && Array.isArray(result[0]) && result[1] === 1).toBe(true); rotated = true;
              }
              return result;
            };
            if (property === 'insert') return async (...args: Parameters<EntityManager['insert']>) => {
              if (args[0] === UserSession) { expect(rotated).toBe(true); throw synthetic; }
              return target.insert(...args);
            };
            const value: unknown = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
          } })));
        }
      }
      const failing = new AuthenticationService(app.get(PasswordHasher), clock, app.get(IdGenerator), new FailingRunner(source), source.getRepository(User), app.get(SESSION_TOKEN_FACTORY));
      let caught: unknown;
      try { await failing.login({ email: markers.a.email, password, presentedSessionToken: s4 }); } catch (error) { caught = error; }
      expect(caught === synthetic && rotated).toBe(true);
      expect((await row(s4)).revoked_at === null && JSON.stringify(await rows()) === beforeRollback).toBe(true); await count();
      step = 'concurrencia';
      const s5 = await login(), beforeConcurrent = await rows(); await count();
      const concurrent = await Promise.all([0, 1].map(() => send(() => request(base).post('/api/v1/auth/login')
        .set('Cookie', cookie(s5)).send({ email: markers.a.email, password }))));
      for (const r of concurrent) {
        expect(r.status).toBe(200);
        const header: unknown = r.headers['set-cookie'];
        expect(Array.isArray(header) && header.length === 1 && /^agenda_session=[A-Za-z0-9_-]{43};/.test(header[0])).toBe(true);
        const token = (header as string[])[0].slice('agenda_session='.length).split(';')[0];
        tokens.push(token); secure(r); setCookie(r, token, 604800);
        expect(r.body.csrfToken === deriveCsrfToken(token)).toBe(true);
      }
      expectedCount += 2; await count();
      const afterConcurrent = await rows(), added = afterConcurrent.filter(r => !beforeConcurrent.some(x => x.id === r.id));
      expect(added.length === 2 && !added[0].token_hash.equals(added[1].token_hash)).toBe(true);
      expect(+(await row(s5)).revoked_at! === +clock.now()).toBe(true);
      expect(beforeConcurrent.filter(r => !r.token_hash.equals(hashSessionToken(s5))).every(r =>
        JSON.stringify(afterConcurrent.find(x => x.id === r.id)) === JSON.stringify(r))).toBe(true);
      step = 'membresía worker';
      const sb3 = await login(markers.b.email);
      const membershipA = async () => observer.query('SELECT * FROM public.organization_memberships WHERE id = $1', [a.membership.id]);
      const unchangedA = JSON.stringify(await membershipA());
      for (const assignment of ["role = 'worker'", 'deactivated_at = GREATEST(now(), created_at)']) {
        step = assignment.startsWith('role') ? 'membresía worker' : 'membresía baja';
        await count();
        const result: unknown = await observer.query(`UPDATE public.organization_memberships SET ${assignment} WHERE id = $1 RETURNING id`, [b.membership.id]);
        expect(Array.isArray(result) && Array.isArray(result[0]) && result[0].length === 1 && result[1] === 1 && result[0][0].id === b.membership.id).toBe(true);
        expect(JSON.stringify(await membershipA()) === unchangedA).toBe(true);
        const r = await session(sb3, assignment.startsWith('role') ? 200 : 401);
        if (assignment.startsWith('role')) expect(r.body.membership.role === 'worker').toBe(true);
      }
      await login(markers.b.email, undefined, undefined, password, 401);
      step = 'negativos';
      await login(markers.a.email, undefined, undefined, `${password}-incorrect`, 401);
      await login(markers.unknown.email, undefined, undefined, password, 401);
      step = 'origen';
      await login(markers.a.email, undefined, 'null', password, 403);
      await login(markers.a.email, undefined, 'https://app.agenda.test');
      await login(markers.a.email, undefined, 'https://otro.test', password, 403);
    } catch (error) { throw new Error(formatAuthFailure(step, error)); }
  }, 180000);
}
