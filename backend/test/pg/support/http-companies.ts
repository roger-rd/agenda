/**
 * Escrituras: el observador INSERTa users, organization_memberships, companies y
 * company_accesses. La aplicación INSERTa users, organizations y memberships al
 * registrar, y user_sessions al login. Puede UPDATEar user_sessions al revocar una
 * cookie previa o renovar tras cinco minutos; aquí no se envían cookies al login
 * ni se esperan cinco minutos, y el escenario final comprueba que no ocurrió.
 * SELECT de verificación; DELETE de un acceso y de limpieza. Sin DDL.
 */
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { IdGenerator } from '../../../src/common/ids/id-generator';
import { PasswordHasher } from '../../../src/identity/password-hasher';
import { decodeCursor, encodeCursor } from '../../../src/companies/companies-cursor';
import type { RegistrationResult } from '../../../src/registration/registration.service';
import { DeleteGate } from './markers';
import { actors, companiesFixture, companiesMarkers, type Actor, type Org, type CompaniesSaved } from './companies-fixture';
import { formatAuthFailure } from './auth-failure';

type Context = { app: INestApplication; observer: DataSource; gate: DeleteGate; saved: RegistrationResult[];
  seeded: CompaniesSaved; reservations: ReturnType<typeof companiesMarkers>; ready: boolean };
type Item = { id: string; name: string; color: string; version: number };
type Page = { items: Item[]; nextCursor: string | null };
type Ordered = { id: string; name_key: string };
const keys = (value: object, expected: string[]) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
const sameSet = (actual: string[], expected: string[]) => actual.length === expected.length && new Set(actual).size === actual.length && actual.every(id => expected.includes(id));

export function registerCompaniesTest(context: () => Context): void {
  test('companies real: aislamiento, paginación, cursores y retirada de acceso', async () => {
    let step = 'preparación';
    try {
      const { app, observer, gate, saved, seeded, reservations, ready } = context();
      expect(ready).toBe(true);
      const fixture = companiesFixture(), password = 'B2b-companies-only-long-passphrase-2026!';
      const users = {} as Record<Actor, string>, orgs = {} as Record<Org, string>;
      const memberships = new Map<string, string>(), companyIds = new Map<string, string>();
      const cookies = {} as Record<Actor, string>;
      await app.listen(0, '127.0.0.1');
      const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      const secure = (r: request.Response) => {
        expect(r.headers['cache-control'] === 'no-store').toBe(true);
        expect(typeof r.headers['x-request-id'] === 'string' && r.headers['x-request-id'].length > 0).toBe(true);
        expect(r.text.includes(password) || r.text.includes('$argon2') || r.text.includes('password_hash')).toBe(false);
      };
      const send = async (make: () => request.Test) => { gate.assertArmed(); const r = await make(); secure(r); return r; };
      const reserve = (list: string[]) => { const id = app.get(IdGenerator).next(); list.push(id); return id; };
      step = 'registro organizaciones';
      gate.arm(); // Preflight complete and exact markers already reserved, immediately before first write.
      for (const [actor, org] of [['cmA', 'A'], ['cmB', 'B']] as const) {
        // Save the 201 IDs before assertions, including response security checks.
        gate.assertArmed();
        const r = await request(base).post('/api/v1/auth/register').send({ ...reservations.byActor[actor], name: 'Companies Tester', password });
        if (r.status === 201) saved.push(r.body as RegistrationResult);
        secure(r); expect(r.status === 201).toBe(true);
        const result = r.body as RegistrationResult;
        users[actor] = result.user.id; orgs[org] = result.organization.id; memberships.set(`${actor}-${org}`, result.membership.id);
      }
      step = 'siembra usuarios y membresías';
      const hash = await app.get(PasswordHasher).hash(password), now = new Date();
      expect(hash.startsWith('$argon2id$')).toBe(true);
      for (const actor of actors.filter(a => a !== 'cmA' && a !== 'cmB')) {
        users[actor] = reserve(seeded.users);
        await observer.query('INSERT INTO public.users (id,email,name,password_hash,password_changed_at,version,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,1,$5,$5)',
          [users[actor], reservations.byActor[actor].email, 'Companies Tester', hash, now]);
      }
      for (const m of fixture.memberships.filter(m => m.role !== 'community_manager')) {
        const id = reserve(seeded.memberships); memberships.set(`${m.actor}-${m.org}`, id);
        await observer.query('INSERT INTO public.organization_memberships (id,organization_id,user_id,role,deactivated_at,version,created_at,updated_at) VALUES ($1,$2,$3,$4,NULL,1,$5,$5)',
          [id, orgs[m.org], users[m.actor], m.role, now]);
      }
      step = 'siembra empresas y accesos';
      for (const c of fixture.companies) {
        const id = reserve(seeded.companies); companyIds.set(c.key, id);
        await observer.query('INSERT INTO public.companies (id,organization_id,name,name_key,color,version,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,1,$6,$6)',
          [id, orgs[c.org], c.name, c.nameKey, c.color, now]);
      }
      for (const a of fixture.accesses) {
        await observer.query('INSERT INTO public.company_accesses (membership_id,company_id,organization_id,membership_role,created_at) VALUES ($1,$2,$3,$4,$5)',
          [memberships.get(`${a.actor}-${a.org}`), companyIds.get(a.company), orgs[a.org], a.role, now]);
      }
      step = 'login sin cookie previa';
      for (const actor of actors) {
        const r = await send(() => request(base).post('/api/v1/auth/login').send({ email: reservations.byActor[actor].email, password }));
        expect(r.status === 200).toBe(true);
        const headers: unknown = r.headers['set-cookie'];
        expect(Array.isArray(headers) && headers.length === 1 && /^agenda_session=[A-Za-z0-9_-]{43};/.test(headers[0])).toBe(true);
        cookies[actor] = (headers as string[])[0].split(';')[0];
        expect(r.body.user?.id === users[actor]).toBe(true);
        if (actor === 'multi') expect(r.body.organization === null && r.body.membership === null).toBe(true);
      }
      const get = async (actor?: Actor, limit?: number, cursor?: string, origin?: string, status = 200): Promise<Page> => {
        const r = await send(() => {
          const req = request(base).get('/api/v1/companies');
          if (actor) req.set('Cookie', cookies[actor]);
          if (limit !== undefined) req.query({ limit });
          if (cursor !== undefined) req.query({ cursor });
          if (origin !== undefined) req.set('Origin', origin);
          return req;
        });
        expect(r.status === status).toBe(true);
        expect(r.headers['set-cookie'] === undefined).toBe(true);
        if (status !== 200) {
          expect(r.body?.error?.code === (status === 401 ? 'unauthenticated' : 'forbidden')).toBe(true);
          return { items: [], nextCursor: null };
        }
        const page = r.body as Page;
        expect(keys(page, ['items', 'nextCursor']) && Array.isArray(page.items)).toBe(true);
        expect(page.nextCursor === null || typeof page.nextCursor === 'string').toBe(true);
        for (const item of page.items) {
          expect(keys(item, ['id', 'name', 'color', 'version'])).toBe(true);
          expect(Number.isInteger(item.version) && item.version === 1).toBe(true);
          const seed = fixture.companies.find(c => companyIds.get(c.key) === item.id);
          expect(!!seed && item.name === seed.name && item.color === seed.color).toBe(true);
        }
        return page;
      };
      const expected = (actor: Actor, org: Org) => fixture.expected(actor, org).map(key => companyIds.get(key)!);
      step = 'aislamiento exacto de todos los roles';
      const scopes = fixture.memberships.filter(m => m.actor !== 'multi');
      for (const m of scopes) {
        const page = await get(m.actor, 100);
        expect(sameSet(page.items.map(c => c.id), expected(m.actor, m.org)) && page.nextCursor === null).toBe(true);
      }
      await get('multi', 100, undefined, undefined, 403);
      await get(undefined, 100, undefined, undefined, 401);
      await get('cmA', 100, undefined, 'null', 403);
      expect(sameSet((await get('cmA', 100)).items.map(c => c.id), expected('cmA', 'A'))).toBe(true);
      // Independent observer queries: no imported application SQL, no JS collation assumptions.
      const reference = async (actor: Actor, org: Org, cursor?: string): Promise<Ordered[]> => {
        const manager = actor === 'cmA' || actor === 'cmB';
        const params: unknown[] = [orgs[org]];
        let sql = 'SELECT c.id, c.name_key FROM public.companies c';
        if (!manager) sql += ' JOIN public.company_accesses a ON a.company_id = c.id AND a.organization_id = c.organization_id';
        sql += ' WHERE c.organization_id = $1';
        if (cursor !== undefined) {
          const { nameKey, id } = decodeCursor(cursor); params.push(nameKey, id);
          sql += ' AND (c.name_key, c.id) > ($2::text, $3::uuid)';
        }
        if (!manager) { params.push(memberships.get(`${actor}-${org}`)); sql += ` AND a.membership_id = $${params.length}::uuid`; }
        return observer.query(sql + ' ORDER BY c.name_key, c.id', params);
      };
      step = 'paginación según collation del observador';
      for (const m of scopes) {
        const ordered = await reference(m.actor, m.org);
        expect(sameSet(ordered.map(c => c.id), expected(m.actor, m.org))).toBe(true);
        for (const limit of [1, 2, 3, undefined]) {
          const collected: string[] = [], cursors = new Set<string>();
          let cursor: string | undefined;
          for (let n = 0; ; n++) {
            expect(n <= ordered.length).toBe(true);
            const page = await get(m.actor, limit, cursor);
            expect(page.items.length <= (limit ?? 20)).toBe(true);
            collected.push(...page.items.map(c => c.id));
            if (page.nextCursor === null) break;
            expect(page.items.length > 0 && !cursors.has(page.nextCursor)).toBe(true);
            cursors.add(page.nextCursor); cursor = page.nextCursor;
          }
          expect(JSON.stringify(collected) === JSON.stringify(ordered.map(c => c.id)) && new Set(collected).size === collected.length).toBe(true);
        }
        const last = ordered.at(-1);
        if (last) {
          const page = await get(m.actor, 100, encodeCursor({ nameKey: last.name_key, id: last.id }));
          expect(page.items.length === 0 && page.nextCursor === null).toBe(true);
        }
      }
      step = 'cursores ajenos entre organizaciones y membresías';
      for (const [from, to, org] of [['cmA', 'cmB', 'B'], ['wA1', 'cA1', 'A']] as const) {
        const cursor = (await get(from, 2)).nextCursor;
        expect(typeof cursor === 'string').toBe(true);
        const page = await get(to, 100, cursor!);
        const ordered = await reference(to, org, cursor!);
        expect(JSON.stringify(page.items.map(c => c.id)) === JSON.stringify(ordered.map(c => c.id)) && page.nextCursor === null).toBe(true);
        expect(page.items.every(c => expected(to, org).includes(c.id))).toBe(true);
      }
      step = 'retirada de acceso entre peticiones';
      const before = await get('wA1', 100), removed = companyIds.get('A0')!;
      expect(sameSet(before.items.map(c => c.id), expected('wA1', 'A')) && before.items.some(c => c.id === removed)).toBe(true);
      const result: unknown = await observer.query('DELETE FROM public.company_accesses WHERE membership_id = $1 AND company_id = $2 RETURNING membership_id',
        [memberships.get('wA1-A'), removed]);
      expect(Array.isArray(result) && Array.isArray(result[0]) && result[0].length === 1 && result[1] === 1 && result[0][0].membership_id === memberships.get('wA1-A')).toBe(true);
      const after = await get('wA1', 100);
      expect(sameSet(after.items.map(c => c.id), expected('wA1', 'A').filter(id => id !== removed)) && after.nextCursor === null).toBe(true);
      expect(sameSet((await get('cmA', 100)).items.map(c => c.id), expected('cmA', 'A'))).toBe(true);
      step = 'sesiones sin revocación ni renovación';
      const sessions: { user_id: string; unchanged: boolean }[] = await observer.query('SELECT user_id, revoked_at IS NULL AND last_seen_at = created_at AS unchanged FROM public.user_sessions WHERE user_id = ANY($1::uuid[])', [Object.values(users)]);
      expect(sessions.length === actors.length && sessions.every(s => s.unchanged) && sameSet(sessions.map(s => s.user_id), Object.values(users))).toBe(true);
    } catch (error) { throw new Error(formatAuthFailure(step, error, 'companies')); }
  }, 240000);
}
