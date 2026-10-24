import { normalized } from './validation';
import { organizationDisplayName, type WorkspaceDirectory } from './directory';
import type { PlatformState } from './types';
export const ACCESS_MESSAGES = {
  organization_suspended: 'El acceso a esta organización está suspendido.',
  member_suspended: 'Tu acceso individual está suspendido.',
  organization_unknown: 'La organización no está disponible.',
};
export type EffectiveAccess = { allowed: true } | { allowed: false; code: keyof typeof ACCESS_MESSAGES };
export function resolveAccess(state: PlatformState, organizationId: string, userId: string): EffectiveAccess {
  const causes = accessCausesForWorkspace(state, organizationId, userId);
  if (causes.organizationUnknown) return { allowed: false, code: 'organization_unknown' };
  if (causes.organizationSuspended) return { allowed: false, code: 'organization_suspended' };
  if (causes.memberSuspended) return { allowed: false, code: 'member_suspended' };
  return { allowed: true };
}
// Solo comunica el código; los motivos administrativos nunca salen hacia el espacio de trabajo.
export const accessForWorkspace = resolveAccess;
export function accessCauses(state: PlatformState, organizationId: string, userId: string) {
  const organization = state.organizations.find(o => o.id === organizationId);
  const organizationSuspended = organization?.status === 'suspended';
  const memberSuspended = state.memberAccess.some(a => a.organizationId === organizationId && a.userId === userId && a.status === 'suspended');
  return { allowed: !!organization && !organizationSuspended && !memberSuspended, organizationSuspended, memberSuspended };
}
export function accessCauseLabel(causes: ReturnType<typeof accessCauses>) {
  if (causes.organizationSuspended && causes.memberSuspended) return 'Bloqueado por ambas causas';
  if (causes.organizationSuspended) return 'Bloqueado por la organización';
  if (causes.memberSuspended) return 'Bloqueado individualmente';
  return causes.allowed ? 'Permitido' : 'Organización no disponible';
}

// Frontera pública: solo booleanos, nunca metadatos administrativos.
export function accessCausesForWorkspace(state: PlatformState, organizationId: string, userId: string) {
  return { ...accessCauses(state, organizationId, userId),
    organizationUnknown: !state.organizations.some(o => o.id === organizationId) };
}
export type WorkspaceAccessCauses = ReturnType<typeof accessCausesForWorkspace>;

// Solo decisiones de lectura para invitaciones; no entrega motivos ni directorios privados.
export function workspacePolicy(state: PlatformState, workspace?: WorkspaceDirectory) {
  return {
    organizationNameTaken: (name: string, exceptOrganizationId: string) => state.organizations.some(o =>
      o.id !== exceptOrganizationId && normalized(workspace ? organizationDisplayName(state, workspace, o.id)! : o.name) === normalized(name)),
    memberSuspended: (organizationId: string, userId: string) => state.memberAccess.some(a => a.organizationId === organizationId && a.userId === userId && a.status === 'suspended'),
    organizationActive: (id: string) => state.organizations.some(o => o.id === id && o.status === 'active'),
    emailExists: (email: string) => state.members.some(m => m.email.trim().toLowerCase() === email),
    accessAllowed: (organizationId: string, userId: string) => accessForWorkspace(state, organizationId, userId).allowed,
  };
}
export type WorkspacePolicy = ReturnType<typeof workspacePolicy>;
