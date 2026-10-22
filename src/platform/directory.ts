import type { Company, Organization, User } from '../types';
import { LINKED_ORGANIZATION_ID } from './ids';
import type { PlatformState } from './types';
export interface WorkspaceDirectory { organization: Organization; companies: Company[]; users: User[] }
export function organizationDisplayName(state: PlatformState, workspace: WorkspaceDirectory, id: string) {
  const organization = state.organizations.find(o => o.id === id);
  return organization?.workspaceLinked && workspace.organization.id === id ? workspace.organization.name : organization?.name;
}
export function resolveDirectory(state: PlatformState, workspace: WorkspaceDirectory, id: string) {
  const organization = state.organizations.find(o => o.id === id);
  if (!organization) return { companies: [], members: [] };
  if (organization.workspaceLinked) {
    if (workspace.organization.id !== id) return { companies: [], members: [] };
    return {
      companies: workspace.companies.filter(c => c.organizationId === id).map(({ id, name, color }) => ({ id, name, color })),
      members: workspace.users.map(({ id: userId, name, role, example }) => ({ userId, name, role, example })),
    };
  }
  return {
    companies: state.companies.filter(c => c.organizationId === id).map(({ id, name, color }) => ({ id, name, color })),
    members: state.members.filter(m => m.organizationId === id).map(({ id: userId, name, role, email, example }) => ({ userId, name, role, email, example })),
  };
}
export function reconcileWithDirectory(state: PlatformState, workspaceUserIds: readonly string[]): PlatformState {
  const memberAccess = state.memberAccess.filter(a => a.organizationId !== LINKED_ORGANIZATION_ID || workspaceUserIds.includes(a.userId));
  return memberAccess.length === state.memberAccess.length ? state : { ...state, memberAccess };
}

// Lista explícita: no propaga el estado completo al almacén administrativo.
export function workspaceDirectory({ organization, companies, users }: WorkspaceDirectory): WorkspaceDirectory {
  return { organization, companies, users };
}
