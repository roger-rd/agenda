import type { Invitation, State } from '../types';
import { generateDemo } from '../data/demo';
import { profileIds, selectCompanies } from './selectors';
import { normalizeEmail, validEmail } from './invitations';
export function normalizeSession(s: State): State {
  const user = s.users.find(u => u.id === s.activeUserId);
  const next = user ? { ...s, role: user.role } : { ...s, authenticated: false };
  const companies = selectCompanies(next);
  return { ...next, activeCompanyId: companies.some(c => c.id === s.activeCompanyId) ? s.activeCompanyId : companies[0]?.id ?? '' };
}
export function mergeShared(shared: State, local: State): State {
  return normalizeSession({ ...shared, authenticated: local.authenticated, activeUserId: local.activeUserId,
    role: local.role, activeCompanyId: local.activeCompanyId });
}
function sanitizeInvitations(value: unknown): Invitation[] {
  if (!Array.isArray(value)) throw new Error();
  const codes = new Set<string>(), ids = new Set<string>();
  return value.map(i => {
    if (!i || typeof i.id !== 'string' || !i.id || ids.has(i.id) || typeof i.code !== 'string'
      || !/^[a-f0-9]{32,}$/i.test(i.code) || codes.has(i.code) || typeof i.organizationId !== 'string'
      || typeof i.email !== 'string' || !validEmail(i.email) || !['worker', 'client'].includes(i.role)
      || ![1, 7, 30].includes(i.validityDays) || !Array.isArray(i.companyIds) || !i.companyIds.length
      || !i.companyIds.every((id: unknown) => typeof id === 'string' && id.length > 0)
      || !Number.isFinite(Date.parse(i.createdAt)) || !Number.isFinite(Date.parse(i.expiresAt))
      || Date.parse(i.expiresAt) <= Date.parse(i.createdAt)
      || (i.usedAt !== undefined && (!Number.isFinite(Date.parse(i.usedAt)) || typeof i.usedBy !== 'string'))
      || (i.usedBy !== undefined && !i.usedAt) || (i.revokedAt !== undefined && !Number.isFinite(Date.parse(i.revokedAt)))
      || (i.usedAt && i.revokedAt)) throw new Error();
    codes.add(i.code); ids.add(i.id);
    return { id: i.id, code: i.code, organizationId: i.organizationId, email: normalizeEmail(i.email), role: i.role,
      companyIds: [...new Set<string>(i.companyIds)], validityDays: i.validityDays, createdAt: i.createdAt, expiresAt: i.expiresAt,
      ...(i.usedAt ? { usedAt: i.usedAt, usedBy: i.usedBy } : {}), ...(i.revokedAt ? { revokedAt: i.revokedAt } : {}) };
  });
}
export function restoreWorkspace(raw: string | null, admin = false): State {
  try {
    if (!raw) return generateDemo();
    const s = JSON.parse(raw);
    if (![2, 3].includes(s.version) || !s.organization || typeof s.organization.id !== 'string'
      || !['community_manager', 'worker', 'client'].includes(s.role)
      || !['comments', 'posts', 'companies', 'users', 'memberships'].every(key => Array.isArray(s[key]))
      || !s.users.every((u: State['users'][number]) => u && typeof u.id === 'string' && typeof u.name === 'string'
        && ['community_manager', 'worker', 'client'].includes(u.role) && (u.email === undefined || typeof u.email === 'string')))
      throw new Error();
    const migrated: State = { ...s, version: 3, revision: s.version === 2 ? 0 : s.revision,
      activeUserId: s.version === 2 ? profileIds[s.role as State['role']] : s.activeUserId,
      invitations: s.version === 2 ? [] : sanitizeInvitations(s.invitations), authenticated: admin ? false : s.authenticated };
    if (!Number.isSafeInteger(migrated.revision) || migrated.revision < 0 || typeof migrated.activeUserId !== 'string') throw new Error();
    return normalizeSession(migrated);
  } catch { return generateDemo(); }
}
