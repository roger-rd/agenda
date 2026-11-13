import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { PasswordHasher } from '../../../src/identity/password-hasher';
import type { RegistrationResult } from '../../../src/registration/registration.service';
import { DeleteGate, httpMarkers } from './markers';

type Context = {
  app: INestApplication; observer: DataSource; gate: DeleteGate; saved: RegistrationResult[];
  id: string; ready: boolean; counts: () => Promise<number[]>;
  credentials: { name: string; password: string };
};

export function registerHttpTest(context: () => Context): void {
  test('HTTP real: contrato, persistencia y conflictos atómicos', async () => {
    const { app, observer, gate, saved, id, ready, counts, credentials } = context();
    expect(ready).toBe(true);
    const attempts = httpMarkers(id);
    const post = async (marker: typeof attempts.success) => {
      gate.assertArmed();
      try {
        return await request(app.getHttpServer()).post('/api/v1/auth/register')
          .set('Content-Type', 'application/json').send({ ...credentials, ...marker });
      } catch { throw new Error('HTTP register: solicitud fallida (detalles sensibles omitidos)'); }
    };
    gate.arm(); // Preflight complete, all markers reserved, immediately before first POST.
    const response = await post(attempts.success);
    const result = response.body as RegistrationResult;
    if (response.status === 201) saved.push(result); // Before any assertion, including headers/body.
    expect(response.status).toBe(201);
    // Assert only booleans for response contents: a broken endpoint might expose secrets.
    expect(response.text.includes(credentials.password)).toBe(false);
    expect(response.text.includes('$argon2')).toBe(false);
    expect(response.headers['cache-control'] === 'no-store').toBe(true);
    expect(typeof response.headers['x-request-id'] === 'string' && response.headers['x-request-id'].length > 0).toBe(true);
    expect(response.headers.location === undefined).toBe(true);
    const keys = (value: object, expected: string[]) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.sort());
    expect(keys(result, ['user', 'organization', 'membership'])).toBe(true);
    expect(keys(result.user, ['id', 'email', 'name'])).toBe(true);
    expect(keys(result.organization, ['id', 'name'])).toBe(true);
    expect(keys(result.membership, ['id', 'role'])).toBe(true);
    expect(result.user.email === attempts.success.email && result.user.name === credentials.name).toBe(true);
    expect(result.organization.name === attempts.success.organizationName).toBe(true);
    expect(result.membership.role === 'community_manager').toBe(true);
    const uuid7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const row of [result.user, result.organization, result.membership]) expect(uuid7.test(row.id)).toBe(true);
    const unchanged = async () => expect((await counts()).slice(0, 3)).toEqual([1, 1, 1]);
    await unchanged();
    const joined: { role: string; deactivated_at: unknown; uv: number; ov: number; mv: number; dates: boolean; password_hash: string }[] = await observer.query(`SELECT m.role, m.deactivated_at, u.version AS uv, o.version AS ov, m.version AS mv,
      u.created_at = u.updated_at AND u.created_at = o.created_at AND o.created_at = o.updated_at AND o.created_at = m.created_at AND m.created_at = m.updated_at AND u.password_changed_at = u.created_at AS dates,
      u.password_hash FROM public.users u JOIN public.organization_memberships m ON m.user_id = u.id
      JOIN public.organizations o ON o.id = m.organization_id WHERE u.id = $1 AND o.id = $2 AND m.id = $3`,
    [result.user.id, result.organization.id, result.membership.id]);
    expect(joined.length).toBe(1);
    const stored = joined[0];
    expect(stored.role === 'community_manager' && stored.deactivated_at === null).toBe(true);
    expect(stored.uv === 1 && stored.ov === 1 && stored.mv === 1 && stored.dates === true).toBe(true);
    const hash = stored.password_hash;
    expect(typeof hash === 'string' && hash.startsWith('$argon2id$') && hash.length >= 40 && hash.length <= 512).toBe(true);
    const verify = async (password: string) => {
      try { return await app.get(PasswordHasher).verify(hash, password); }
      catch { throw new Error('Verificación de contraseña fallida (detalles sensibles omitidos)'); }
    };
    expect(await verify(credentials.password)).toBe(true);
    expect(await verify(`${credentials.password}-different`)).toBe(false);
    const rejectedAbsent = async () => {
      const organizations: unknown[] = await observer.query('SELECT id FROM public.organizations WHERE name = $1', [attempts.emailConflict.organizationName]);
      const users: unknown[] = await observer.query('SELECT id FROM public.users WHERE email = $1', [attempts.organizationConflict.email]);
      expect(organizations.length).toBe(0); expect(users.length).toBe(0);
    };
    for (const [marker, field] of [[attempts.emailConflict, 'email'], [attempts.organizationConflict, 'organizationName']] as const) {
      const conflict = await post(marker);
      expect(conflict.status).toBe(409);
      expect(conflict.body?.error?.code === 'conflict').toBe(true);
      expect(conflict.body?.error?.field === field).toBe(true);
      await unchanged(); await rejectedAbsent();
    }
    await unchanged(); await rejectedAbsent();
  });
}
