/**
 * Escrituras: INSERT de la aplicación en users, organizations, organization_memberships
 * (registro), companies (POST) y user_sessions (login). INSERT del observador en users
 * y organization_memberships (wA/cA). UPDATE de la aplicación en companies (PATCH) y
 * user_sessions (renovación por SessionAuthGuard en GET /companies, PATCH de wA
 * rechazado por rol y cadena de días). Login sin cookie previa: ninguna revocación.
 * SELECT de verificación; DELETE de limpieza en user_sessions, company_accesses,
 * companies, organization_memberships, users y organizations. Sin DDL.
 */
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { IdGenerator } from '../../../src/common/ids/id-generator';
import { PasswordHasher } from '../../../src/identity/password-hasher';
import { deriveCsrfToken } from '../../../src/identity/session-token';
import { CompaniesService } from '../../../src/companies/companies.service';
import { normalizeCompanyName } from '../../../src/companies/company-input';
import type { RegistrationResult } from '../../../src/registration/registration.service';
import { DeleteGate } from './markers';
import { ControlledClock, DAY } from './auth-controls';
import { formatAuthFailure } from './auth-failure';
import type { CompaniesSaved } from './companies-fixture';
import { companiesWriteMarkers, writeActors, type WriteActor, duplicateNames, collisionNames, alphabetNames,
  ligatureNames, raceRounds, identicalRace, firstPartWriteLimit, companiesWriteTimeline, sameCompanyError } from './companies-write-fixture';

type Context = { app: INestApplication; observer: DataSource; clock: ControlledClock; gate: DeleteGate;
  saved: RegistrationResult[]; seeded: CompaniesSaved; reservations: ReturnType<typeof companiesWriteMarkers>; ready: boolean };
type Item = { id: string; name: string; color: string; version: number };
type Row = Item & { organization_id: string; name_key: string; created_at: Date; updated_at: Date };
type Session = { user_id: string; created_at: Date; last_seen_at: Date; expires_at: Date; revoked_at: Date | null };
const uuid7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const publicRow = ({ id, name, color, version }: Row): Item => ({ id, name, color, version });

export function registerCompaniesWriteTest(context: () => Context): void {
  test('companies-write real: creación, edición, concurrencia y renovación', async () => {
    let step = 'preparación';
    try {
      const { app, observer, clock, gate, saved, seeded, reservations, ready } = context();
      expect(ready).toBe(true);
      const password = 'B2b-companies-write-long-passphrase-2026!';
      const users = {} as Record<WriteActor, string>, tokens = {} as Record<WriteActor, string>;
      const orgs = {} as Record<'A' | 'B', string>;
      await app.listen(0, '127.0.0.1');
      const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      const secure = (r: request.Response) => {
        expect(r.headers['cache-control'] === 'no-store').toBe(true);
        expect(typeof r.headers['x-request-id'] === 'string' && r.headers['x-request-id'].length > 0).toBe(true);
        const body = { ...r.body }; delete body.csrfToken;
        const headers = { ...r.headers }; delete headers['set-cookie'];
        const output = JSON.stringify({ body, headers });
        expect([password, ...Object.values(tokens), ...Object.values(tokens).map(deriveCsrfToken), '$argon2', 'password_hash', 'token_hash']
          .some(secret => output.includes(secret))).toBe(false);
      };
      const send = async (make: () => request.Test) => { gate.assertArmed(); const r = await make().timeout(15000); secure(r); return r; };
      const reserve = (list: string[]) => { const id = app.get(IdGenerator).next(); list.push(id); return id; };
      step = 'registro organizaciones';
      // Exact reservations are retained and logged before arming or writing.
      console.info('[b2b] companies-write reservas', reservations.reserved);
      gate.arm();
      for (const [actor, org] of [['cmA', 'A'], ['cmB', 'B']] as const) {
        gate.assertArmed();
        const r = await request(base).post('/api/v1/auth/register').send({ ...reservations.byActor[actor], name: 'Write Tester', password }).timeout(15000);
        if (r.status === 201) saved.push(r.body as RegistrationResult);
        secure(r); expect(r.status === 201 && r.headers['set-cookie'] === undefined).toBe(true);
        const result = r.body as RegistrationResult;
        users[actor] = result.user.id; orgs[org] = result.organization.id;
      }
      step = 'siembra worker y client';
      const hash = await app.get(PasswordHasher).hash(password), now = clock.now();
      expect(hash.startsWith('$argon2id$')).toBe(true);
      for (const [actor, role] of [['wA', 'worker'], ['cA', 'client']] as const) {
        users[actor] = reserve(seeded.users);
        const membership = reserve(seeded.memberships);
        gate.assertArmed();
        await observer.query('INSERT INTO public.users (id,email,name,password_hash,password_changed_at,version,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,1,$5,$5)',
          [users[actor], reservations.byActor[actor].email, 'Write Tester', hash, now]);
        await observer.query('INSERT INTO public.organization_memberships (id,organization_id,user_id,role,deactivated_at,version,created_at,updated_at) VALUES ($1,$2,$3,$4,NULL,1,$5,$5)',
          [membership, orgs.A, users[actor], role, now]);
      }
      step = 'cuatro logins T0';
      const t0 = clock.now().getTime();
      for (const actor of writeActors) {
        const r = await send(() => request(base).post('/api/v1/auth/login').send({ email: reservations.byActor[actor].email, password }));
        expect(r.status === 200).toBe(true);
        const cookies: unknown = r.headers['set-cookie'];
        expect(Array.isArray(cookies) && cookies.length === 1 && /^agenda_session=[A-Za-z0-9_-]{43};/.test(cookies[0])).toBe(true);
        tokens[actor] = (cookies as string[])[0].split(';')[0].slice('agenda_session='.length);
        secure(r); expect(r.body.user?.id === users[actor]).toBe(true);
      }
      const sessions = async (): Promise<Session[]> => observer.query('SELECT user_id, created_at, last_seen_at, expires_at, revoked_at FROM public.user_sessions WHERE user_id = ANY($1::uuid[]) ORDER BY user_id', [Object.values(users)]);
      const initialSessions = await sessions();
      expect(initialSessions.length === 4 && writeActors.every(actor => initialSessions.filter(s => s.user_id === users[actor]).length === 1)).toBe(true);
      expect(initialSessions.every(s => +s.created_at === t0 && +s.last_seen_at === t0 && +s.expires_at === t0 + 7 * DAY && s.revoked_at === null)).toBe(true);
      const row = async (id: string): Promise<Row> => {
        const rows: Row[] = await observer.query('SELECT * FROM public.companies WHERE id = $1', [id]);
        expect(rows.length).toBe(1); return rows[0];
      };
      const allCompanies = async (): Promise<Row[]> => observer.query('SELECT * FROM public.companies ORDER BY id');
      const count = async () => (await allCompanies()).length;
      let writes = 0, firstPart = true;
      const write = async (actor: WriteActor, body: object, id?: string, options: { origin?: string; badCsrf?: boolean } = {}) => {
        if (firstPart) { clock.advance(1000); writes++; expect(writes <= firstPartWriteLimit).toBe(true); }
        // Factories are lazy: no request starts until after clock advancement and gate checks.
        gate.assertArmed();
        const make = () => {
          const req = id === undefined ? request(base).post('/api/v1/companies') : request(base).patch(`/api/v1/companies/${id}`);
          req.set('Cookie', `agenda_session=${tokens[actor]}`).set('X-CSRF-Token', options.badCsrf ? 'incorrecto' : deriveCsrfToken(tokens[actor]));
          if (options.origin !== undefined) req.set('Origin', options.origin);
          return req.send(body);
        };
        const r = await make().timeout(15000);
        if (r.status === 201) seeded.companies.push((r.body as Item).id);
        secure(r);
        if (firstPart) expect(r.headers['set-cookie'] === undefined).toBe(true);
        return r;
      };
      const contract = (r: request.Response, expected: Item, status: number) => {
        expect(r.status === status && equal(Object.keys(r.body).sort(), ['color', 'id', 'name', 'version'])).toBe(true);
        expect(equal(r.body, expected) || (r.body.id === expected.id && r.body.name === expected.name && r.body.color === expected.color && r.body.version === expected.version)).toBe(true);
      };
      const conflict = (r: request.Response, name = false) => {
        expect(r.status === 409 && r.body.error?.code === 'conflict').toBe(true);
        expect(name ? r.body.error.field === 'name' : !Object.hasOwn(r.body.error, 'field')).toBe(true);
        expect(r.body.error.message === (name ? 'El nombre de empresa ya está registrado.' : 'Los datos cambiaron mientras los editabas. Actualiza e inténtalo de nuevo.')).toBe(true);
      };
      const create = async (name: string, color = '#AABBCC', actor: WriteActor = 'cmA') => {
        const r = await write(actor, { name, color });
        expect(r.status === 201 && uuid7.test(r.body.id)).toBe(true);
        const c = await row(r.body.id), normalized = normalizeCompanyName(name)!;
        contract(r, { id: c.id, name: normalized.name, color: color.toLowerCase(), version: 1 }, 201);
        expect(c.organization_id === orgs[actor === 'cmB' ? 'B' : 'A'] && c.name === normalized.name && c.name_key === normalized.nameKey && c.color === color.toLowerCase() && c.version === 1).toBe(true);
        expect(c.created_at.getTime() === clock.now().getTime() && c.updated_at.getTime() === clock.now().getTime()).toBe(true);
        return c;
      };
      step = 'crear nombres y duplicados';
      const cafe = await create(duplicateNames[0]);
      const editable = await create(alphabetNames[0]);
      for (const name of alphabetNames.slice(1)) await create(name);
      for (const name of duplicateNames) {
        const before = await count(); conflict(await write('cmA', { name, color: '#abcdef' }), true); expect(await count()).toBe(before);
      }
      await create(ligatureNames[0]);
      const beforeLigature = await count();
      conflict(await write('cmA', { name: ligatureNames[1], color: '#abcdef' }), true); expect(await count()).toBe(beforeLigature);
      const companyB = await create('Café Central', '#AABBCC', 'cmB');
      step = 'rechazos creación';
      for (const negative of [
        { actor: 'cmA' as const, body: { name: 'a', color: '#abcdef' }, status: 400 },
        { actor: 'cmA' as const, body: { name: 'Valido', color: '#xyz' }, status: 400 },
        { actor: 'cmA' as const, options: { origin: 'null' }, status: 403 },
        { actor: 'cmA' as const, options: { badCsrf: true }, status: 403 },
        { actor: 'wA' as const, status: 403 }, { actor: 'cA' as const, status: 403 },
      ]) {
        const before = await allCompanies();
        const r = await write(negative.actor, negative.body ?? { name: 'Valido', color: '#abcdef' }, undefined, negative.options);
        expect(r.status === negative.status).toBe(true);
        expect(await count()).toBe(before.length); expect(equal(await allCompanies(), before)).toBe(true);
      }
      step = 'creaciones simultáneas';
      const beforeCollision = await count();
      const collisions = await Promise.all(collisionNames.map(name => write('cmA', { name, color: '#abcdef' })));
      expect(collisions.filter(r => r.status === 201).length).toBe(1);
      const losers = collisions.filter(r => r.status !== 201); expect(losers.length).toBe(4); losers.forEach(r => conflict(r, true));
      const collisionRows: Row[] = await observer.query('SELECT * FROM public.companies WHERE organization_id = $1 AND name_key = $2', [orgs.A, 'zeta norte']);
      expect(collisionRows.length === 1 && await count() === beforeCollision + 1).toBe(true);
      step = 'ediciones parciales';
      let current = editable;
      for (const change of [{ name: 'Nuevo Nombre' }, { color: '#112233' }, { name: 'Otro Nombre', color: '#445566' }]) {
        const previous = current;
        const r = await write('cmA', { version: previous.version, ...change }, current.id);
        current = await row(current.id);
        contract(r, { ...publicRow(previous), ...change, version: previous.version + 1 }, 200);
        expect(equal(publicRow(current), r.body) && current.name_key === normalizeCompanyName(current.name)?.nameKey).toBe(true);
        expect(+current.created_at === +previous.created_at && +current.updated_at === +clock.now()).toBe(true);
      }
      // Use a color containing letters so uppercase normalization is actually exercised.
      const noOpCompany = await create('Sin Cambios', '#aabbcc');
      step = 'sin cambios';
      const unchanged = await write('cmA', { version: 1, name: '  Sin   Cambios  ', color: '#AABBCC' }, noOpCompany.id);
      contract(unchanged, publicRow(noOpCompany), 200); expect(equal(await row(noOpCompany.id), noOpCompany)).toBe(true);
      step = 'versiones desactualizadas';
      for (const change of [{ name: 'Distinto' }, { name: current.name, color: current.color }]) {
        conflict(await write('cmA', { version: current.version - 1, ...change }, current.id));
        expect(equal(await row(current.id), current)).toBe(true);
      }
      step = 'conflicto nombre y misma clave';
      conflict(await write('cmA', { version: current.version, name: 'cafe central' }, current.id), true);
      expect(equal(await row(current.id), current)).toBe(true);
      const renamed = await write('cmA', { version: cafe.version, name: 'CAFÉ CENTRAL' }, cafe.id);
      contract(renamed, { ...publicRow(cafe), name: 'CAFÉ CENTRAL', version: 2 }, 200);
      const cafeAfter = await row(cafe.id);
      expect(cafeAfter.name_key === cafe.name_key && cafeAfter.version === 2 && cafeAfter.name === 'CAFÉ CENTRAL' && cafeAfter.color === cafe.color && +cafeAfter.created_at === +cafe.created_at && +cafeAfter.updated_at === +clock.now()).toBe(true);
      step = 'aislamiento indistinguible';
      const errors: request.Response[] = [];
      for (const id of [companyB.id, app.get(IdGenerator).next(), 'no-es-uuid']) {
        const r = await write('cmA', { version: 1, name: 'Ajeno' }, id);
        expect(r.status === 404 && r.body.error?.code === 'not_found').toBe(true); errors.push(r);
        expect(equal(await row(companyB.id), companyB)).toBe(true);
      }
      expect(errors.every(r => sameCompanyError(r, errors[0]))).toBe(true);
      expect(errors.every(r => typeof r.body.error.requestId === 'string' && r.body.error.requestId === r.headers['x-request-id'])).toBe(true);
      expect(new Set(errors.map(r => r.body.error.requestId)).size).toBe(3);
      expect((await write('cmB', { version: current.version, name: 'Ajeno' }, current.id)).status === 404).toBe(true);
      expect(equal(await row(current.id), current)).toBe(true);
      step = 'rechazos edición';
      for (const negative of [{ actor: 'wA' as const }, { actor: 'cA' as const },
        { actor: 'cmA' as const, options: { origin: 'null' } }, { actor: 'cmA' as const, options: { badCsrf: true } }]) {
        expect((await write(negative.actor, { version: current.version, name: 'Prohibido' }, current.id, negative.options)).status === 403).toBe(true);
        expect(equal(await row(current.id), current)).toBe(true);
      }
      step = 'cinco rondas concurrentes';
      for (const round of raceRounds) {
        const initial = await create(round.initial.name, round.initial.color);
        const results = await Promise.all(round.changes.map(change => write('cmA', change, initial.id)));
        expect(results.filter(r => r.status === 200).length === 1 && results.filter(r => r.status === 409).length === 1).toBe(true);
        const winner = results.findIndex(r => r.status === 200); conflict(results[1 - winner]);
        const final = await row(initial.id), expected = { ...publicRow(initial), ...round.changes[winner], version: 2 };
        contract(results[winner], expected, 200);
        expect(equal(publicRow(final), expected) && final.name_key === normalizeCompanyName(expected.name)?.nameKey && +final.created_at === +initial.created_at && +final.updated_at === +clock.now()).toBe(true);
      }
      step = 'dos ediciones idénticas';
      const initial = await create(identicalRace.initial.name, identicalRace.initial.color);
      const twins = await Promise.all([0, 1].map(() => write('cmA', identicalRace.change, initial.id)));
      expect(twins.filter(r => r.status === 200).length === 1 && twins.filter(r => r.status === 409).length === 1).toBe(true);
      conflict(twins.find(r => r.status === 409)!);
      const twinFinal = await row(initial.id);
      contract(twins.find(r => r.status === 200)!, { ...publicRow(initial), ...identicalRace.change, version: 2 }, 200);
      expect(twinFinal.version === 2 && twinFinal.name === identicalRace.change.name && twinFinal.color === initial.color).toBe(true);
      expect(+clock.now() - t0 === writes * 1000 && writes * 1000 < 240000).toBe(true);
      expect(equal(await sessions(), initialSessions)).toBe(true);
      firstPart = false;
      const companiesBeforeRenewal = await allCompanies();
      const timeline = companiesWriteTimeline(t0);
      const renewed = async (actor: WriteActor, r: request.Response, expires: number) => {
        const cookies: unknown = r.headers['set-cookie'], age = Math.floor((expires - +clock.now()) / 1000);
        expect(Array.isArray(cookies) && cookies.length === 1).toBe(true);
        expect(equal(cookies, [`agenda_session=${tokens[actor]}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}`])).toBe(true);
        const found = (await sessions()).filter(s => s.user_id === users[actor]);
        expect(found.length === 1 && +found[0].created_at === t0 && +found[0].last_seen_at === +clock.now() && +found[0].expires_at === expires && found[0].revoked_at === null).toBe(true);
      };
      const get = async () => {
        const r = await send(() => request(base).get('/api/v1/companies').set('Cookie', `agenda_session=${tokens.cmA}`));
        expect(r.status === 200).toBe(true); return r;
      };
      step = 'renovación worker rechazado';
      clock.set(timeline[0].now);
      const spy = jest.spyOn(app.get(CompaniesService), 'update');
      try {
        const r = await write('wA', { version: current.version, name: 'Prohibido' }, current.id);
        expect(r.status === 403).toBe(true); expect(spy).not.toHaveBeenCalled();
        await renewed('wA', r, timeline[0].expires);
        expect(timeline[0].maxAge === 604800 && equal(await row(current.id), current)).toBe(true);
      } finally { spy.mockRestore(); }
      const workerAfterRenewal = (await sessions()).find(s => s.user_id === users.wA)!;
      step = 'renovación manager e inmediata';
      await renewed('cmA', await get(), timeline[0].expires);
      const afterRenewal = await sessions();
      expect((await get()).headers['set-cookie'] === undefined).toBe(true);
      expect(equal(await sessions(), afterRenewal)).toBe(true);
      step = 'cadena de renovaciones';
      for (const point of timeline.slice(1)) {
        clock.set(point.now); await renewed('cmA', await get(), point.expires);
      }
      expect(timeline.at(-1)!.expires === t0 + 30 * DAY && timeline.at(-1)!.maxAge === 86400).toBe(true);
      step = 'sesiones finales sin revocación';
      const finalSessions = await sessions();
      expect(finalSessions.length === 4 && finalSessions.every(s => s.revoked_at === null)).toBe(true);
      expect(equal(finalSessions.find(s => s.user_id === users.wA), workerAfterRenewal)).toBe(true);
      for (const actor of ['cmB', 'cA'] as const) expect(equal(finalSessions.find(s => s.user_id === users[actor]), initialSessions.find(s => s.user_id === users[actor]))).toBe(true);
      expect(equal(await allCompanies(), companiesBeforeRenewal)).toBe(true);
    } catch (error) { throw new Error(formatAuthFailure(step, error, 'companies-write')); }
  }, 240000);
}
