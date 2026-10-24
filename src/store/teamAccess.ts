import type { State } from '../types';
import type { Result } from './operations';
import { can } from './permissions';
import { selectUser } from './selectors';

export const companyAccess = (s: State, userId: string) => s.memberships.filter(m => m.userId === userId).map(m => m.companyId);
export function setCompanyAccess(s: State, userId: string, companyIds: string[], admin = false): Result {
  if (admin || !s.authenticated || !selectUser(s) || !can(selectUser(s).role, 'manageTeamAccess'))
    return { ok: false, code: 'forbidden', reason: 'Solo el community manager puede gestionar accesos.' };
  const user = s.users.find(u => u.id === userId);
  if (!user || user.role === 'community_manager' || !Array.isArray(companyIds)
    || companyIds.some(id => !s.companies.some(c => c.id === id && c.organizationId === s.organization.id)))
    return { ok: false, code: 'invalid_input', reason: 'Selecciona un trabajador o cliente y empresas de la organización.' };
  const ids = [...new Set(companyIds)], previous = companyAccess(s, userId);
  if (ids.length === previous.length && ids.every(id => previous.includes(id))) return { ok: true, state: s };
  const used = new Set(s.memberships.map(m => m.id));
  const added = ids.filter(id => !previous.includes(id)).map(companyId => {
    let id = crypto.randomUUID();
    while (used.has(id)) id = crypto.randomUUID();
    used.add(id);
    return { id, userId, companyId };
  });
  return { ok: true, state: { ...s, memberships: [...s.memberships.filter(m => m.userId !== userId || ids.includes(m.companyId)), ...added] } };
}
export function changeCompanyAccess(s: State, userId: string, companyId: string, assign: boolean, admin = false): Result {
  if (!s.companies.some(c => c.id === companyId && c.organizationId === s.organization.id))
    return { ok: false, code: 'invalid_input', reason: 'Empresa no válida.' };
  const ids = companyAccess(s, userId);
  return setCompanyAccess(s, userId, assign ? [...ids, companyId] : ids.filter(id => id !== companyId), admin);
}
