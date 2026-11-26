import { DomainError, OutcomeUnknownError, ServiceUnavailableError } from '../common/errors/domain-error';
import { Clock } from '../common/clock/clock';
import { IdGenerator } from '../common/ids/id-generator';
import { ConstraintRegistry } from '../database/errors/constraint-registry';
import { mapDatabaseFailure } from '../database/errors/database-http';
import { DatabaseOperationError } from '../database/errors/database-operation-error';
import { LimitedPasswordHasher } from '../identity/limited-password-hasher';
import { PasswordHasher } from '../identity/password-hasher';
import { deriveCsrfToken, generateSessionToken, hashSessionToken } from '../identity/session-token';
import { INSERT_SESSION_SQL } from '../auth/session-issue';
import { SESSION_POLICY } from '../auth/session-policy';
import { InvitationConflictError } from './invitation-errors';
import { ACCEPTANCE_OUTCOME_UNKNOWN_MESSAGE, InvitationAcceptanceError } from './invitation-acceptance-errors';
import { ACCEPTANCE_COMPANIES_SQL, INSERT_ACCESSES_SQL, INSERT_MEMBERSHIP_SQL, INSERT_USER_SQL, INSPECT_INVITATION_SQL, LOCK_INVITATION_BY_TOKEN_SQL,
  MARK_ACCEPTED_SQL, USER_EXISTS_BY_EMAIL_SQL } from './invitation-acceptance-sql';
import { InvitationAcceptanceService, translateAcceptanceError } from './invitation-acceptance.service';
import { InvitationsService } from './invitations.service';
import type { InvitationsScope } from './invitations-scope';
import type { InvitationTokens } from './invitation-token';
import type { CreateInvitationDto } from './create-invitation.dto';
import { FakeDb } from './testing/fake-db';

const uuid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = uuid(0xa0); const MEMBERSHIP = uuid(0xc0);
const scope: InvitationsScope = { organizationId: ORG, membershipId: MEMBERSHIP, role: 'community_manager' };
const NOW = new Date('2026-11-25T12:00:00.000Z');
const DAY = 86_400_000;
const PASSWORD = 'una-contraseña-larga-válida-2026';
const COMPANIES = [uuid(1), uuid(2), uuid(3)];

function setup() {
  const db = new FakeDb();
  db.companies.set(ORG, new Set(COMPANIES)); db.organizations.set(ORG, 'Equipo Norte');
  db.companyNames.set(uuid(1), 'Zeta').set(uuid(2), 'Alfa').set(uuid(3), 'Beta');
  let now = NOW; let id = 0x100; let invitationTokens = 0; let sessionTokens = 0;
  const events: string[] = [];
  const clock: Clock = { now: () => { events.push('clock'); return new Date(now); } };
  const ids: IdGenerator = { next: () => uuid(id++) };
  const tokens: InvitationTokens = { next: () => Buffer.alloc(32, ++invitationTokens).toString('base64url') };
  const sessionToken = () => generateSessionToken(() => Buffer.alloc(32, ++sessionTokens + 100));
  const hasher = { hash: jest.fn(async (p: unknown) => { events.push('hash'); return `$argon2id$v=19$fake$${String(p).length}`; }), verify: jest.fn(), needsRehash: jest.fn() } as unknown as PasswordHasher;
  const invitations = new InvitationsService(db.runner, ids, clock, tokens);
  const service = new InvitationAcceptanceService(hasher, db.runner, ids, clock, sessionToken);
  db.onStatement = sql => {
    const name = ({ [INSPECT_INVITATION_SQL]: 'inspect', [LOCK_INVITATION_BY_TOKEN_SQL]: 'lock' } as Record<string, string>)[sql];
    if (name) events.push(name);
  };
  const invite = async (extra: Partial<CreateInvitationDto> = {}) =>
    invitations.create(scope, { email: 'Nuevo@Example.com', role: 'client', companyIds: [uuid(1), uuid(2)], validityDays: 7, ...extra });
  const accept = (token: string, extra: Record<string, unknown> = {}) => service.accept({ token, name: 'Nuevo Usuario', password: PASSWORD, ...extra });
  return { db, service, invitations, invite, accept, hasher, events, setNow: (value: Date) => { now = value; }, sessionTokenAt: (n: number) => generateSessionToken(() => Buffer.alloc(32, n + 100)) };
}
const rejection = async (promise: Promise<unknown>) => promise.then(() => { throw new Error('debía rechazar'); }, (error: unknown) => error);
const snapshot = (db: FakeDb) => JSON.stringify({
  users: [...db.users.values()], memberships: [...db.memberships.values()], accesses: db.accesses, sessions: [...db.sessions.values()],
  invitations: [...db.invitations.values()].map(i => ({ id: i.id, acceptedAt: i.acceptedAt, acceptedBy: i.acceptedByUserId ?? null, revokedAt: i.revokedAt })),
});
const empty = (db: FakeDb) => db.users.size + db.memberships.size + db.accesses.length + db.sessions.size === 0;
/** Resolves when the statement has been issued the given number of times. */
const issued = (db: FakeDb, sql: string, times = 1) => new Promise<void>(resolve => {
  const previous = db.onStatement;
  const seen = () => db.statements.filter(s => s.sql === sql).length;
  if (seen() >= times) { resolve(); return; }
  db.onStatement = (statement, params) => { previous?.(statement, params); if (statement === sql && seen() >= times) resolve(); };
});

describe('inspección por token', () => {
  it('abierta: organización, rol, empresas por nombre, correo y vencimiento; sin escribir nada', async () => {
    const { db, service, invite } = setup();
    const made = await invite();
    const before = db.statements.length; const snap = snapshot(db);
    const view = await service.inspect({ token: made.token });
    expect(view).toEqual({ status: 'open', organization: { name: 'Equipo Norte' }, role: 'client', email: 'nuevo@example.com',
      companies: [{ name: 'Alfa' }, { name: 'Zeta' }], expiresAt: new Date(NOW.getTime() + 7 * DAY).toISOString() });
    expect(db.statements.slice(before).map(s => s.sql)).toEqual([INSPECT_INVITATION_SQL]);
    expect(snapshot(db)).toBe(snap);
  });
  it('un token no canónico no llega a la base y es unavailable', async () => {
    const { db, service } = setup();
    for (const token of ['x', undefined, 5, '', `${'A'.repeat(43)} `]) expect(await service.inspect({ token })).toEqual({ status: 'unavailable' });
    expect(db.runs).toBe(0);
  });
  it('desconocida, revocada y aceptada son unavailable; vencida es expired', async () => {
    const { db, service, invitations, invite, accept, setNow } = setup();
    expect(await service.inspect({ token: Buffer.alloc(32, 9).toString('base64url') })).toEqual({ status: 'unavailable' });
    const revoked = await invite({ email: 'a@example.com' }); await invitations.revoke(scope, revoked.id);
    expect(await service.inspect({ token: revoked.token })).toEqual({ status: 'unavailable' });
    const used = await invite({ email: 'b@example.com' }); await accept(used.token);
    expect(await service.inspect({ token: used.token })).toEqual({ status: 'unavailable' });
    const expiring = await invite({ email: 'c@example.com', validityDays: 1 });
    setNow(new Date(NOW.getTime() + 2 * DAY));
    expect(await service.inspect({ token: expiring.token })).toEqual({ status: 'expired' });
    expect(db.users.size).toBe(1);
  });
  it('un fallo de base de datos es un 503 reintentable, nunca un resultado desconocido', async () => {
    const { db, service, invite } = setup();
    const made = await invite();
    for (const code of ['08006', '55P03', 'ECONNRESET']) {
      db.failOn = sql => (sql === INSPECT_INVITATION_SQL ? { severity: 'ERROR', code, message: 'secreto del driver' } : null);
      const error = await rejection(service.inspect({ token: made.token }));
      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect(JSON.stringify(error)).not.toContain('secreto');
    }
  });
});

describe('aceptación con cuenta nueva: camino feliz', () => {
  it('crea usuario, membresía, accesos, marca de uso y sesión en una sola transacción', async () => {
    const { db, accept, invite, sessionTokenAt } = setup();
    const made = await invite();
    const result = await accept(made.token);
    const user = [...db.users.values()][0], membership = [...db.memberships.values()][0], session = [...db.sessions.values()][0];
    expect(db.users.size === 1 && db.memberships.size === 1 && db.sessions.size === 1 && db.accesses.length === 2).toBe(true);
    expect(user).toMatchObject({ email: 'nuevo@example.com', name: 'Nuevo Usuario', createdAt: NOW });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/); expect(user.passwordHash).not.toContain(PASSWORD);
    expect(membership).toMatchObject({ organizationId: ORG, userId: user.id, role: 'client', deactivatedAt: null, createdAt: NOW });
    expect(db.accesses.map(a => [a.membershipId, a.companyId, a.organizationId, a.role]).sort()).toEqual(
      [uuid(1), uuid(2)].map(c => [membership.id, c, ORG, 'client']).sort());
    const invitation = db.invitations.get(made.id)!;
    expect(invitation.acceptedAt).toEqual(NOW); expect(invitation.acceptedByUserId).toBe(user.id);
    const token = sessionTokenAt(1);
    expect(session).toMatchObject({ userId: user.id, activeOrganizationId: ORG, createdAt: NOW, lastSeenAt: NOW });
    expect(session.tokenHash.equals(hashSessionToken(token))).toBe(true);
    expect(session.expiresAt).toEqual(new Date(NOW.getTime() + Math.min(SESSION_POLICY.idleSeconds, SESSION_POLICY.absoluteSeconds) * 1000));
    expect(result.sessionToken).toBe(token); expect(result.maxAgeSeconds).toBe(7 * 86400);
    expect(result.body).toEqual({ user: { id: user.id, email: 'nuevo@example.com', name: 'Nuevo Usuario' }, organization: { id: ORG, name: 'Equipo Norte' },
      membership: { id: membership.id, role: 'client' }, csrfToken: deriveCsrfToken(token), expiresAt: session.expiresAt.toISOString() });
    expect(db.outcomes.at(-1)).toBe('commit');
  });
  it('el token de sesión no es enumerable: serializar el resultado no lo expone', async () => {
    const { accept, invite, sessionTokenAt } = setup();
    const result = await accept((await invite()).token);
    expect(JSON.stringify(result)).not.toContain(sessionTokenAt(1));
    expect(Object.keys(result)).toEqual(['body', 'maxAgeSeconds']);
    expect(result.sessionToken).toBe(sessionTokenAt(1));
  });
  it('el nombre sale normalizado y el correo siempre de la invitación; un correo del cliente se ignora', async () => {
    const { db, accept, invite } = setup();
    const made = await invite();
    await accept(made.token, { name: '  Ana   María ', email: 'otro@example.com' });
    expect([...db.users.values()][0]).toMatchObject({ name: 'Ana María', email: 'nuevo@example.com' });
  });
  it('sentencias en orden: lectura previa, hash, bloqueo, lectura de empresas, existencia del correo y las cinco escrituras', async () => {
    const { db, accept, invite } = setup();
    const made = await invite(); const start = db.statements.length;
    await accept(made.token);
    expect(db.statements.slice(start).map(s => s.sql)).toEqual([INSPECT_INVITATION_SQL, USER_EXISTS_BY_EMAIL_SQL, LOCK_INVITATION_BY_TOKEN_SQL, ACCEPTANCE_COMPANIES_SQL,
      USER_EXISTS_BY_EMAIL_SQL, INSERT_USER_SQL, INSERT_MEMBERSHIP_SQL, INSERT_ACCESSES_SQL, MARK_ACCEPTED_SQL, INSERT_SESSION_SQL]);
    expect(db.outcomes.slice(-2)).toEqual(['commit', 'commit']); // lectura previa y transacción de escritura, separadas
  });
  it('no revoca ni cambia las sesiones previas: no recibe ninguna cookie', async () => {
    const { db, accept, invite } = setup();
    const other = { id: uuid(0x900), tokenHash: Buffer.alloc(32, 1), userId: uuid(0x901), activeOrganizationId: ORG, createdAt: NOW, lastSeenAt: NOW, expiresAt: new Date(NOW.getTime() + DAY) };
    db.sessions.set(other.id, other);
    await accept((await invite()).token);
    expect(db.sessions.get(other.id)).toEqual(other); expect(db.sessions.size).toBe(2);
    expect(db.statements.some(s => /UPDATE public\.user_sessions/.test(s.sql))).toBe(false);
  });
});

describe('contraseña: se hashea antes de la transacción con el hasher limitado', () => {
  it('lectura previa, luego el hash, luego el bloqueo: el reloj se lee después del bloqueo y no se reutiliza la lectura previa', async () => {
    const { accept, invite, events } = setup();
    const made = await invite(); events.length = 0;
    await accept(made.token);
    expect(events).toEqual(['inspect', 'clock', 'hash', 'lock', 'clock']);
  });
  it('lo que ya no puede prosperar se rechaza antes de gastar Argon2', async () => {
    const { db, accept, invite, invitations, hasher, setNow } = setup();
    const done = await invite({ email: 'a@example.com' }); await accept(done.token);
    const revoked = await invite({ email: 'b@example.com' }); await invitations.revoke(scope, revoked.id);
    const short = await invite({ email: 'c@example.com', validityDays: 1 });
    const existing = await invite({ email: 'd@example.com' });
    db.users.set(uuid(0x700), { id: uuid(0x700), email: 'd@example.com', name: 'Existente', passwordHash: '$argon2id$otro', createdAt: NOW });
    setNow(new Date(NOW.getTime() + 2 * DAY));
    (hasher.hash as jest.Mock).mockClear();
    for (const [token, code] of [[done.token, 'invitation_unavailable'], [revoked.token, 'invitation_unavailable'], [Buffer.alloc(32, 99).toString('base64url'), 'invitation_unavailable'],
      [short.token, 'invitation_expired'], [existing.token, 'account_exists']] as const) {
      const error = await rejection(accept(token));
      expect(error).toMatchObject({ code });
    }
    expect(hasher.hash).not.toHaveBeenCalled();
  });
  it('entrada inválida: 400 sin base de datos ni hash; token mal formado: 404 uniforme sin base de datos', async () => {
    const { db, accept, hasher, invite } = setup();
    const made = await invite(); const runs = db.runs;
    expect(await rejection(accept(made.token, { name: '' }))).toMatchObject({ code: 'invalid_input', field: 'name' });
    expect(await rejection(accept(made.token, { password: 'corta' }))).toMatchObject({ code: 'invalid_input', field: 'password' });
    expect(await rejection(accept('mal', { name: '', password: 'x' }))).toMatchObject({ code: 'invitation_unavailable', httpStatus: 404 });
    expect(db.runs).toBe(runs); expect(hasher.hash).not.toHaveBeenCalled();
  });
  it('con el limitador saturado responde 503 sin escribir y la invitación sigue abierta', async () => {
    const { db, invite } = setup();
    const gate: { release: () => void } = { release: () => undefined };
    const inner = { hash: jest.fn(() => new Promise<string>(resolve => { gate.release = () => resolve('$argon2id$x'); })), verify: jest.fn(), needsRehash: jest.fn() } as unknown as PasswordHasher;
    const limited = new LimitedPasswordHasher(inner, 1, 0);
    const first = new InvitationAcceptanceService(limited, db.runner, { next: () => uuid(Math.floor(Math.random() * 1e9)) }, { now: () => NOW }, () => generateSessionToken());
    const made = await invite(); const other = await invite({ email: 'otro@example.com' });
    const pending = first.accept({ token: made.token, name: 'Ana', password: PASSWORD });
    await new Promise(resolve => setTimeout(resolve, 20));
    const snap = snapshot(db);
    const error = await rejection(first.accept({ token: other.token, name: 'Beto', password: PASSWORD }));
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(snapshot(db)).toBe(snap); expect(empty(db)).toBe(true);
    gate.release(); await pending;
    expect(db.users.size).toBe(1);
  });
});

describe('estado revalidado tras el bloqueo', () => {
  it('revocada entre la lectura previa y el bloqueo: 404 y nada escrito', async () => {
    const { db, accept, invite } = setup();
    const made = await invite();
    db.before.set(LOCK_INVITATION_BY_TOKEN_SQL, () => { db.invitations.get(made.id)!.revokedAt = new Date(NOW.getTime() - 1); });
    expect(await rejection(accept(made.token))).toMatchObject({ code: 'invitation_unavailable', httpStatus: 404 });
    expect(empty(db)).toBe(true);
  });
  it('aceptada por otra entre la lectura previa y el bloqueo: 404 y nada escrito por esta', async () => {
    const { db, accept, invite } = setup();
    const made = await invite();
    db.before.set(LOCK_INVITATION_BY_TOKEN_SQL, () => { const i = db.invitations.get(made.id)!; i.acceptedAt = NOW; i.acceptedByUserId = uuid(0x777); });
    expect(await rejection(accept(made.token))).toMatchObject({ code: 'invitation_unavailable' });
    expect(empty(db)).toBe(true);
  });
  it('vence mientras espera el bloqueo: 409 invitation_expired con el reloj leído después', async () => {
    const { db, accept, invite, setNow } = setup();
    const made = await invite({ validityDays: 1 });
    db.before.set(LOCK_INVITATION_BY_TOKEN_SQL, () => setNow(new Date(NOW.getTime() + 2 * DAY))); // la espera cruza el vencimiento
    expect(await rejection(accept(made.token))).toMatchObject({ code: 'invitation_expired', httpStatus: 409 });
    expect(empty(db)).toBe(true); expect(db.invitations.get(made.id)!.acceptedAt).toBeNull();
  });
  it('un reloj anterior a created_at tras el bloqueo es un 503 controlado y no escribe nada (sin GREATEST)', async () => {
    const { db, accept, invite, setNow } = setup();
    const made = await invite();
    db.before.set(LOCK_INVITATION_BY_TOKEN_SQL, () => setNow(new Date(NOW.getTime() - 5000)));
    const error = await rejection(accept(made.token));
    expect(error).toBeInstanceOf(ServiceUnavailableError); expect(error).toMatchObject({ code: 'service_unavailable', httpStatus: 503 });
    expect(empty(db)).toBe(true); expect(db.invitations.get(made.id)!.acceptedAt).toBeNull();
    expect(db.statements.some(s => s.sql === INSERT_USER_SQL)).toBe(false);
  });
  it('la marca de aceptación es exactamente la lectura posterior al bloqueo', async () => {
    const { db, accept, invite, setNow } = setup();
    const made = await invite();
    db.before.set(LOCK_INVITATION_BY_TOKEN_SQL, () => setNow(new Date(NOW.getTime() + 1234)));
    await accept(made.token);
    expect(db.invitations.get(made.id)!.acceptedAt).toEqual(new Date(NOW.getTime() + 1234));
    expect([...db.users.values()][0].createdAt).toEqual(new Date(NOW.getTime() + 1234));
  });
  it('si la marca no cambia ninguna fila, todo se revierte', async () => {
    const { db, accept, invite } = setup();
    const made = await invite();
    db.before.set(MARK_ACCEPTED_SQL, () => { db.invitations.get(made.id)!.expiresAt = new Date(NOW.getTime() - 1); }); // estado incoherente bajo el bloqueo
    expect(await rejection(accept(made.token))).toMatchObject({ code: 'invitation_unavailable' });
    expect(empty(db)).toBe(true); expect(db.outcomes.at(-1)).toBe('rollback');
  });
});

describe('cuenta existente y colisión de correo: sin vincular, sin cambiar contraseñas, sin reintento', () => {
  it('un correo ya registrado: 409 account_exists, la invitación sigue abierta y nada cambia', async () => {
    const { db, accept, invite } = setup();
    const made = await invite();
    const existing = { id: uuid(0x700), email: 'nuevo@example.com', name: 'Existente', passwordHash: '$argon2id$original', createdAt: NOW };
    db.users.set(existing.id, existing);
    const snap = snapshot(db);
    expect(await rejection(accept(made.token))).toMatchObject({ code: 'account_exists', httpStatus: 409 });
    expect(snapshot(db)).toBe(snap);
    expect(db.users.get(existing.id)!.passwordHash).toBe('$argon2id$original');
    expect(db.invitations.get(made.id)!.acceptedAt).toBeNull(); expect(db.memberships.size).toBe(0);
    expect(db.statements.some(s => [INSERT_USER_SQL, INSERT_MEMBERSHIP_SQL].includes(s.sql))).toBe(false);
  });
  it('la cuenta aparece entre la lectura previa y la transacción: se detecta dentro y no se escribe', async () => {
    const { db, accept, invite, hasher } = setup();
    const made = await invite();
    db.before.set(LOCK_INVITATION_BY_TOKEN_SQL, () => db.users.set(uuid(0x701), { id: uuid(0x701), email: 'nuevo@example.com', name: 'X', passwordHash: '$argon2id$otra', createdAt: NOW }));
    expect(await rejection(accept(made.token))).toMatchObject({ code: 'account_exists' });
    expect(hasher.hash).toHaveBeenCalledTimes(1); expect(db.users.size).toBe(1); expect(db.memberships.size + db.sessions.size + db.accesses.length).toBe(0);
  });
  it('colisión de UQ_users_email en el INSERT: rollback completo, mismo account_exists y una sola ejecución', async () => {
    const { db, accept, invite } = setup();
    const made = await invite();
    db.before.set(INSERT_USER_SQL, () => db.users.set(uuid(0x702), { id: uuid(0x702), email: 'nuevo@example.com', name: 'Otro', passwordHash: '$argon2id$ganador', createdAt: NOW }));
    const runs = db.runs;
    const error = await rejection(accept(made.token));
    expect(error).toBeInstanceOf(InvitationAcceptanceError); expect(error).toMatchObject({ code: 'account_exists', httpStatus: 409 });
    expect(db.users.size).toBe(1); expect(db.users.get(uuid(0x702))!.passwordHash).toBe('$argon2id$ganador');
    expect(db.memberships.size + db.sessions.size + db.accesses.length).toBe(0);
    expect(db.invitations.get(made.id)!.acceptedAt).toBeNull();
    expect(db.statements.filter(s => s.sql === INSERT_USER_SQL)).toHaveLength(1);
    expect(db.runs - runs).toBe(2); // lectura previa + una transacción: ningún reintento
  });
  it('dos invitaciones al mismo correo en organizaciones distintas: la segunda es account_exists', async () => {
    const { db, accept, invite } = setup();
    const first = await invite();
    await accept(first.token);
    const otherOrg = uuid(0xb0);
    db.companies.set(otherOrg, new Set([uuid(9)])); db.organizations.set(otherOrg, 'Otro');
    const second = await new InvitationsService(db.runner, { next: () => uuid(0x800) }, { now: () => NOW }, { next: () => Buffer.alloc(32, 77).toString('base64url') })
      .create({ ...scope, organizationId: otherOrg }, { email: 'nuevo@example.com', role: 'worker', companyIds: [uuid(9)], validityDays: 7 });
    expect(await rejection(accept(second.token))).toMatchObject({ code: 'account_exists' });
    expect(db.users.size).toBe(1);
  });
});

describe('fallo en cada escritura: se revierte todo', () => {
  it.each([[INSERT_USER_SQL, 'usuario'], [INSERT_MEMBERSHIP_SQL, 'membresía'], [INSERT_ACCESSES_SQL, 'accesos'], [MARK_ACCEPTED_SQL, 'marca de aceptación'], [INSERT_SESSION_SQL, 'sesión']])(
    'si falla %s no queda usuario, membresía, accesos, marca ni sesión, y el siguiente intento funciona', async (failing, name) => {
      expect(name).toBeTruthy();
      const { db, accept, invite } = setup();
      const made = await invite();
      const snap = snapshot(db);
      db.failOn = sql => (sql === failing ? { severity: 'ERROR', code: '23514', constraint: 'CK_otra', detail: 'secreto' } : null);
      const error = await rejection(accept(made.token));
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(JSON.stringify(error)).not.toContain('secreto');
      expect(snapshot(db)).toBe(snap); expect(empty(db)).toBe(true);
      expect(db.outcomes.at(-1)).toBe('rollback');
      expect(db.statements.filter(s => s.sql === failing)).toHaveLength(1);
      db.failOn = null;
      await expect(accept(made.token)).resolves.toMatchObject({ body: { membership: { role: 'client' } } });
    });
  it('un bloqueo agotado es un 503 reintentable y no se reintenta solo', async () => {
    const { db, accept, invite } = setup();
    const made = await invite();
    db.failOn = sql => (sql === INSERT_ACCESSES_SQL ? { severity: 'ERROR', code: '55P03' } : null);
    const error = await rejection(accept(made.token)) as DatabaseOperationError;
    expect(error).toBeInstanceOf(DatabaseOperationError);
    expect(error.context).toEqual({ operation: 'insert', atomic: true, valuesOrigin: 'request' });
    expect(mapDatabaseFailure(error.failure, { method: 'POST', registry: new ConstraintRegistry(), context: error.context })).toMatchObject({ status: 503, code: 'service_unavailable' });
    expect(db.statements.filter(s => s.sql === INSERT_ACCESSES_SQL)).toHaveLength(1);
  });
  it('las FK de los accesos protegen la organización: una empresa fuera de ella falla y revierte', async () => {
    const { db, accept, invite } = setup();
    const made = await invite();
    db.companies.get(ORG)!.delete(uuid(1)); // la empresa desaparece tras crear la invitación
    expect(await rejection(accept(made.token))).toBeInstanceOf(DatabaseOperationError);
    expect(empty(db)).toBe(true);
  });
});

describe('resultado de commit incierto: sin token de sesión y sin reintento', () => {
  it.each([[true], [false]])('commit fallido con 08006 (aplicado=%s): 503 outcome_unknown, sin el token y con una sola transacción de escritura', async applied => {
    const { db, accept, invite, sessionTokenAt } = setup();
    const made = await invite();
    db.commitFailure = { error: { severity: 'ERROR', code: '08006', message: 'secreto del driver' }, applied };
    // La lectura previa también usa el ejecutor: solo falla el commit de la transacción de escritura.
    const original = db.runner.run.bind(db.runner); let calls = 0;
    (db.runner as { run: unknown }).run = (work: never) => { calls++; if (calls === 1) { const saved = db.commitFailure; db.commitFailure = null; return original(work).finally(() => { db.commitFailure = saved; }); } return original(work); };
    const error = await rejection(accept(made.token));
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(error).toMatchObject({ code: 'outcome_unknown', httpStatus: 503, message: ACCEPTANCE_OUTCOME_UNKNOWN_MESSAGE });
    const text = JSON.stringify(error) + String((error as Error).message) + String((error as Error).stack ?? '');
    for (const secret of [sessionTokenAt(1), deriveCsrfToken(sessionTokenAt(1)), PASSWORD, 'secreto']) expect(text).not.toContain(secret);
    expect(db.statements.filter(s => s.sql === INSERT_USER_SQL)).toHaveLength(1);
    expect(calls).toBe(2);
    expect(db.users.size).toBe(applied ? 1 : 0); // lo que el cliente no puede saber
    expect(db.outcomes.at(-1)).toBe(applied ? 'commit-unknown' : 'rollback');
  });
  it('tras un commit incierto ya aplicado, repetir la aceptación da 404 y la cuenta existe: es el camino de recuperación por login', async () => {
    const { db, accept, invite } = setup();
    const made = await invite();
    const original = db.runner.run.bind(db.runner); let calls = 0;
    (db.runner as { run: unknown }).run = (work: never) => { calls++; if (calls === 2) db.commitFailure = { error: { severity: 'ERROR', code: '08006' }, applied: true }; return original(work).finally(() => { db.commitFailure = null; }); };
    await rejection(accept(made.token));
    expect(db.users.size).toBe(1);
    expect(await rejection(accept(made.token))).toMatchObject({ code: 'invitation_unavailable' });
  });
  it('translateAcceptanceError: dominio intacto, unicidad exacta, incierto sin detalle y el resto conserva su clasificación', () => {
    const domain = new InvitationConflictError('invitation_revoked');
    expect(translateAcceptanceError(domain)).toBe(domain);
    expect(translateAcceptanceError({ severity: 'ERROR', code: '23505', constraint: 'UQ_users_email' })).toMatchObject({ code: 'account_exists' });
    for (const constraint of ['UQ_other', 'uq_users_email', 'UQ_users_email_x']) expect(translateAcceptanceError({ severity: 'ERROR', code: '23505', constraint })).toBeInstanceOf(DatabaseOperationError);
    for (const code of ['08006', 'ECONNRESET']) expect(translateAcceptanceError({ severity: 'ERROR', code, message: 'secreto' })).toBeInstanceOf(OutcomeUnknownError);
    expect(translateAcceptanceError(new Error('interno'))).toEqual(new Error('interno'));
    expect(translateAcceptanceError(null)).toBeNull();
  });
});

describe('aceptación concurrente y carreras con revocar y renovar', () => {
  it('dos aceptaciones del mismo token: una gana, la otra recibe 404 y queda un solo usuario, una membresía y una sesión', async () => {
    const { db, accept, invite } = setup();
    const made = await invite();
    const results = await Promise.allSettled([accept(made.token, { name: 'Ana' }), accept(made.token, { name: 'Beto' })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'invitation_unavailable', httpStatus: 404 });
    expect(db.users.size === 1 && db.memberships.size === 1 && db.sessions.size === 1 && db.accesses.length === 2).toBe(true);
    expect(db.invitations.get(made.id)!.acceptedByUserId).toBe([...db.users.values()][0].id);
  });
  it('aceptar primero y revocar después: aceptar tiene éxito y revocar recibe 409 invitation_accepted', async () => {
    const { db, accept, invite, invitations } = setup();
    const made = await invite();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.runner.run(async manager => { await manager.query(LOCK_INVITATION_BY_TOKEN_SQL, [db.invitations.get(made.id)!.tokenHash]); await gate; });
    const accepting = accept(made.token).catch((e: unknown) => e);
    await issued(db, LOCK_INVITATION_BY_TOKEN_SQL, 2); // la lectura previa y el hash ya pasaron: espera el bloqueo
    const revoking = invitations.revoke(scope, made.id).catch((e: unknown) => e);
    await new Promise(resolve => setTimeout(resolve, 10));
    release(); await holder;
    const [accepted, revoked] = await Promise.all([accepting, revoking]);
    expect(accepted).toMatchObject({ body: { membership: { role: 'client' } } });
    expect(revoked).toMatchObject({ code: 'invitation_accepted', httpStatus: 409 });
    expect(db.users.size).toBe(1); expect(db.invitations.get(made.id)!.revokedAt).toBeNull();
  });
  it('revocar primero y aceptar después: revocar tiene éxito y aceptar recibe 404 sin escribir', async () => {
    const { db, accept, invite, invitations } = setup();
    const made = await invite();
    const revoked = await invitations.revoke(scope, made.id);
    expect(revoked.status).toBe('revoked');
    expect(await rejection(accept(made.token))).toMatchObject({ code: 'invitation_unavailable' });
    expect(empty(db)).toBe(true);
  });
  it('renovar invalida el token anterior y el nuevo se puede aceptar; la anterior no', async () => {
    const { db, accept, invite, invitations } = setup();
    const made = await invite();
    const renewed = await invitations.renew(scope, made.id);
    expect(await rejection(accept(made.token))).toMatchObject({ code: 'invitation_unavailable' });
    await expect(accept(renewed.token)).resolves.toBeDefined();
    expect(db.users.size).toBe(1); expect(db.invitations.get(renewed.id)!.acceptedAt).toEqual(NOW);
  });
  it('renovar una invitación ya aceptada da 409 y aceptar con el token viejo tras renovar no crea nada', async () => {
    const { db, accept, invite, invitations } = setup();
    const made = await invite();
    await accept(made.token);
    expect(await rejection(invitations.renew(scope, made.id))).toMatchObject({ code: 'invitation_accepted' });
    expect(await rejection(accept(made.token))).toMatchObject({ code: 'invitation_unavailable' });
    expect(db.users.size).toBe(1);
  });
  it('cada petición vuelve a leer el estado: ninguna decisión se comparte entre llamadas', async () => {
    const { accept, invite, db } = setup();
    const a = await invite({ email: 'a@example.com' }); const b = await invite({ email: 'b@example.com' });
    await accept(a.token); await accept(b.token);
    expect(db.users.size).toBe(2); expect(db.statements.filter(s => s.sql === LOCK_INVITATION_BY_TOKEN_SQL)).toHaveLength(2);
  });
});

describe('ningún secreto en errores ni en sentencias de lectura', () => {
  it('los errores de todas las rutas no contienen contraseña, token, hash ni sesión', async () => {
    const { db, accept, invite, sessionTokenAt } = setup();
    const made = await invite({ email: 'x@example.com' });
    const secrets = [PASSWORD, made.token, sessionTokenAt(1)];
    const errors: unknown[] = [];
    errors.push(await rejection(accept(made.token, { password: 'corta' })));
    errors.push(await rejection(accept('mal')));
    db.failOn = sql => (sql === INSERT_USER_SQL ? { severity: 'ERROR', code: '08006', message: `${PASSWORD} ${made.token}` } : null);
    errors.push(await rejection(accept(made.token)));
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      const text = JSON.stringify(error) + String((error as Error).message);
      for (const secret of secrets) expect(text).not.toContain(secret);
      expect(error instanceof DomainError || error instanceof DatabaseOperationError).toBe(true);
    }
  });
  it('el hash del token es lo único que viaja a las consultas: el token en claro no aparece en ninguna sentencia', async () => {
    const { db, accept, invite } = setup();
    const made = await invite({ email: 'y@example.com' });
    await accept(made.token);
    expect(JSON.stringify(db.statements.filter(s => s.sql === LOCK_INVITATION_BY_TOKEN_SQL || s.sql === INSPECT_INVITATION_SQL))).not.toContain(made.token);
    expect(JSON.stringify(db.statements.filter(s => s.sql === INSERT_USER_SQL))).not.toContain(PASSWORD);
  });
});
