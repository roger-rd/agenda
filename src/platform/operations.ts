import type { AdminSession, PlatformState, Result, AccessStatus } from './types';
import { platformCan, type PlatformAction } from './permissions';
import { validateOrganization, validateReason } from './validation';
import { generatePlatformSeed } from './seed';
import { resolveDirectory, organizationDisplayName, type WorkspaceDirectory } from './directory';
export const denied = (): Result<never> => ({ ok: false, code: 'no_admin_session', reason: 'Se requiere una sesión de administrador de plataforma.' });
export function listOrganizations(state: PlatformState, session: AdminSession | null, workspace: WorkspaceDirectory) {
  if (!platformCan(session, 'listOrganizations')) return denied();
  return { ok: true as const, value: state.organizations.map(o => ({ ...o, name: organizationDisplayName(state, workspace, o.id)! })) };
}
export function viewOrganization(state: PlatformState, session: AdminSession | null, id: string, workspace: WorkspaceDirectory) {
  if (!platformCan(session, 'viewOrganization')) return denied();
  if (typeof id !== 'string' || !id.trim()) return { ok: false as const, code: 'invalid_input' as const, reason: 'Indica una organización.' };
  const organization = state.organizations.find(o => o.id === id.trim());
  if (!organization) return { ok: false as const, code: 'not_found' as const, reason: 'Organización no encontrada.' };
  return { ok: true as const, value: { organization: { ...organization, name: organizationDisplayName(state, workspace, organization.id)! },
    directory: resolveDirectory(state, workspace, organization.id), memberAccess: state.memberAccess.filter(a => a.organizationId === organization.id) } };
}
export function createOrganization(state: PlatformState, session: AdminSession | null, input: unknown,
  now = new Date(), id = crypto.randomUUID(), workspace?: WorkspaceDirectory): Result {
  if (!platformCan(session, 'createOrganization')) return denied();
  const valid = validateOrganization(state, input, workspace);
  if (!valid.ok) return valid;
  if (state.organizations.some(o => o.id === id) || state.members.some(m => m.id === `${id}-manager`))
    return { ok: false, code: 'invalid_input', reason: 'Identificador ya utilizado.' };
  const createdAt = now.toISOString(), userId = `${id}-manager`;
  return { ok: true, value: { ...state,
    organizations: [...state.organizations, { id, name: valid.value.name, status: 'active', createdAt, workspaceLinked: false }],
    members: [...state.members, { id: userId, organizationId: id, name: valid.value.managerName, email: valid.value.email,
      role: 'community_manager', example: false, invitation: { simulated: true, createdAt } }],
    memberAccess: [...state.memberAccess, { organizationId: id, userId, status: 'active' }],
  } };
}
export interface StatusInput { organizationId: string; reason?: string }
export interface MemberStatusInput extends StatusInput { userId: string }
function changeAccess(state: PlatformState, session: AdminSession | null, input: StatusInput | MemberStatusInput,
  status: AccessStatus, action: PlatformAction, member: boolean, now: Date): Result {
  if (!platformCan(session, action)) return denied();
  const organizationId = typeof input?.organizationId === 'string' ? input.organizationId.trim() : '';
  const reason = validateReason(input?.reason);
  if (!organizationId || !reason.ok) return !reason.ok ? reason : { ok: false, code: 'invalid_input', reason: 'Indica una organización.' };
  const org = state.organizations.find(o => o.id === organizationId);
  if (!org) return { ok: false, code: 'not_found', reason: 'Organización no encontrada.' };
  const rawUserId = 'userId' in input ? input.userId : '';
  const userId = typeof rawUserId === 'string' ? rawUserId.trim() : '';
  const access = state.memberAccess.find(a => a.organizationId === organizationId && a.userId === userId);
  if (member && (!userId || (org.workspaceLinked ? !access : !state.members.some(m => m.organizationId === organizationId && m.id === userId))))
    return { ok: false, code: 'unknown_member', reason: 'Miembro desconocido en esta organización.' };
  if ((member ? access?.status ?? 'active' : org.status) === status)
    return { ok: false, code: 'no_change', reason: 'El acceso ya se encuentra en ese estado.' };
  const suspension = status === 'suspended' ? { at: now.toISOString(), ...(reason.value ? { reason: reason.value } : {}) } : undefined;
  const nextAccess = { organizationId, userId, status, ...(suspension ? { suspension } : {}) };
  return { ok: true, value: member ? { ...state, memberAccess: access
    ? state.memberAccess.map(record => record === access ? nextAccess : record)
    : [...state.memberAccess, nextAccess],
  } : { ...state, organizations: state.organizations.map(o => {
    if (o !== org) return o;
    const next = { ...o, status }; delete next.suspension;
    return { ...next, ...(suspension ? { suspension } : {}) };
  }) } };
}
export const suspendOrganization = (s: PlatformState, session: AdminSession | null, input: StatusInput, now = new Date()) => changeAccess(s, session, input, 'suspended', 'suspendOrganization', false, now);
export const reactivateOrganization = (s: PlatformState, session: AdminSession | null, input: StatusInput, now = new Date()) => changeAccess(s, session, input, 'active', 'reactivateOrganization', false, now);
export const suspendMember = (s: PlatformState, session: AdminSession | null, input: MemberStatusInput, now = new Date()) => changeAccess(s, session, input, 'suspended', 'suspendMember', true, now);
export const reactivateMember = (s: PlatformState, session: AdminSession | null, input: MemberStatusInput, now = new Date()) => changeAccess(s, session, input, 'active', 'reactivateMember', true, now);
export function resetPlatform(state: PlatformState, session: AdminSession | null): Result {
  if (!platformCan(session, 'resetPlatform')) return denied();
  return { ok: true, value: { ...generatePlatformSeed(), revision: state.revision } };
}
