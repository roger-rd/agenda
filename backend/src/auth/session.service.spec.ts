import { Repository } from 'typeorm';
import { UserSession } from '../persistence/entities/user-session.entity';
import { OrganizationMembership } from '../persistence/entities/organization-membership.entity';
import { hashSessionToken } from '../identity/session-token';
import { SessionService, REVOKE_SESSION_SQL, TOUCH_SESSION_SQL } from './session.service';
import { SESSION_POLICY } from './session-policy';

const token = Buffer.alloc(32, 3).toString('base64url');
const created = new Date('2026-01-01T00:00:00Z');
function setup() {
  let now = new Date(created);
  const row = { id: 's1', userId: 'u1', activeOrganizationId: 'o1', createdAt: created, lastSeenAt: created,
    expiresAt: new Date('2026-01-08T00:00:00Z'), revokedAt: null as Date | null,
    user: { id: 'u1', email: 'ana@example.cl', name: 'Ana' },
    membership: { id: 'm1', role: 'community_manager', deactivatedAt: null as Date | null }, organization: { id: 'o1', name: 'Equipo' } };
  const getOne = jest.fn().mockImplementation(async () => ({ ...row }));
  const qb = { innerJoinAndMapOne: jest.fn().mockReturnThis(), leftJoinAndMapOne: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), getOne };
  const query = jest.fn().mockImplementation(async () => [[{ last_seen_at: now,
    expires_at: new Date(Math.min(created.getTime() + SESSION_POLICY.absoluteSeconds * 1000, now.getTime() + SESSION_POLICY.idleSeconds * 1000)) }], 1]);
  const sessions = { createQueryBuilder: jest.fn(() => qb), query };
  const service = new SessionService({ now: () => now }, sessions as unknown as Repository<UserSession>);
  return { service, row, getOne, qb, sessions, query, setNow: (value: Date) => { now = value; } };
}
it.each([undefined, null, '', 'inválido', 'A'.repeat(44)])('rechaza token inválido %# sin consultas', async token => {
  const s = setup();
  expect(await s.service.authenticate(token)).toBeNull();
  expect(await s.service.revoke(token)).toBe(false);
  expect(s.sessions.createQueryBuilder).not.toHaveBeenCalled();
  expect(s.query).not.toHaveBeenCalled();
});
it.each(['inexistente', 'revocada', 'vencida', 'desactivada', 'sin membresía'])('rechaza sesión %s', async state => {
  const s = setup();
  if (state === 'inexistente') s.getOne.mockResolvedValue(null);
  if (state === 'revocada') s.row.revokedAt = created;
  if (state === 'vencida') s.setNow(s.row.expiresAt);
  if (state === 'desactivada') s.row.membership.deactivatedAt = created;
  if (state === 'sin membresía') s.getOne.mockResolvedValue({ ...s.row, membership: null });
  expect(await s.service.authenticate(token)).toBeNull();
  expect(s.query).not.toHaveBeenCalled();
});
it('lee usuario y membresía actual juntos, sin cachear rol', async () => {
  const s = setup();
  expect(await s.service.authenticate(token)).toMatchObject({ sessionId: 's1', user: s.row.user, organization: s.row.organization,
    membership: { id: 'm1', role: 'community_manager' }, createdAt: created, lastSeenAt: created, expiresAt: s.row.expiresAt, renewed: false });
  s.row.membership.role = 'client';
  expect(await s.service.authenticate(token)).toMatchObject({ membership: { role: 'client' } });
  expect(s.qb.where).toHaveBeenCalledWith('session.tokenHash = :hash', { hash: hashSessionToken(token) });
  expect(s.qb.leftJoinAndMapOne).toHaveBeenCalledWith('session.membership', OrganizationMembership, 'membership',
    'membership.organizationId = session.activeOrganizationId AND membership.userId = session.userId AND membership.deactivatedAt IS NULL');
});
it('admite sesión sin organización ni rol', async () => {
  const s = setup(); s.getOne.mockResolvedValue({ ...s.row, activeOrganizationId: null, membership: null, organization: null });
  expect(await s.service.authenticate(token)).toMatchObject({ organization: null, membership: null, renewed: false });
});
it('renueva desde los cinco minutos con un solo UPDATE parametrizado', async () => {
  const s = setup();
  s.setNow(new Date(created.getTime() + 299999));
  expect(await s.service.authenticate(token)).toMatchObject({ renewed: false });
  expect(s.query).not.toHaveBeenCalled();
  const now = new Date(created.getTime() + 300000); s.setNow(now);
  expect(await s.service.authenticate(token)).toMatchObject({ renewed: true, lastSeenAt: now, expiresAt: new Date(now.getTime() + 604800000) });
  expect(s.query).toHaveBeenCalledTimes(1);
  expect(s.query).toHaveBeenCalledWith("UPDATE user_sessions SET last_seen_at = $1::timestamptz, expires_at = LEAST(created_at + $2 * INTERVAL '1 second', $1::timestamptz + $3 * INTERVAL '1 second') WHERE id = $4 AND revoked_at IS NULL AND expires_at > $1::timestamptz RETURNING last_seen_at, expires_at",
    [now, 2592000, 604800, 's1']);
  expect(s.query.mock.calls[0][0]).toBe(TOUCH_SESSION_SQL);
});
it('respeta el tope absoluto y rechaza al alcanzarlo', async () => {
  const s = setup(); s.row.expiresAt = new Date('2026-01-31T00:00:00Z');
  s.setNow(new Date('2026-01-30T00:00:00Z'));
  expect(await s.service.authenticate(token)).toMatchObject({ renewed: true, expiresAt: new Date('2026-01-31T00:00:00Z') });
  s.setNow(new Date('2026-01-31T00:00:00Z'));
  expect(await s.service.authenticate(token)).toBeNull();
});
it('devuelve null si pierde la carrera del UPDATE', async () => {
  const s = setup(); s.setNow(new Date(created.getTime() + 300000)); s.query.mockResolvedValue([[], 0]);
  expect(await s.service.authenticate(token)).toBeNull();
});
it('revoca de forma idempotente y protege created_at ante retroceso del reloj', async () => {
  const s = setup(); s.query.mockResolvedValueOnce([[], 1]).mockResolvedValueOnce([[], 0]);
  expect(await s.service.revoke(token)).toBe(true);
  expect(await s.service.revoke(token)).toBe(false);
  expect(s.query).toHaveBeenCalledWith(REVOKE_SESSION_SQL, [created, hashSessionToken(token)]);
  expect(REVOKE_SESSION_SQL).toBe('UPDATE user_sessions SET revoked_at = GREATEST($1::timestamptz, created_at) WHERE token_hash = $2 AND revoked_at IS NULL');
});
it('mantiene inmutable la política', () => {
  expect(Object.isFrozen(SESSION_POLICY)).toBe(true);
  expect(SESSION_POLICY).toEqual({ idleSeconds: 604800, absoluteSeconds: 2592000, touchIntervalSeconds: 300 });
});
