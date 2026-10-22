import { resolveDirectory, type WorkspaceDirectory } from '../../platform/directory';
import type { PlatformOrganization, PlatformState } from '../../platform/types';
import { cleanName, normalized } from '../../platform/validation';

export interface OrganizationRow {
  id: string; name: string; status: 'active' | 'suspended'; isExample: boolean;
  managers: { name: string; email: string | null; example: boolean; invitationSimulated: boolean }[];
}
export function organizationRows(organizations: PlatformOrganization[], state: PlatformState, workspace: WorkspaceDirectory): OrganizationRow[] {
  return organizations.map(organization => {
    const managers = resolveDirectory(state, workspace, organization.id).members
      .filter(member => member.role === 'community_manager').map(member => ({
        name: member.name, email: 'email' in member && typeof member.email === 'string' ? member.email : null, example: member.example === true,
        invitationSimulated: !organization.workspaceLinked && state.members.some(m => m.id === member.userId && m.invitation?.simulated),
      }));
    return { id: organization.id, name: organization.name, status: organization.status, managers,
      isExample: managers.length > 0 && managers.every(manager => manager.example) };
  }).sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
}
export type OrganizationFilter = 'todas' | 'activas' | 'suspendidas';
export interface OrganizationQuery { q: string; estado: OrganizationFilter }
export function parseOrganizationQuery(search: string): OrganizationQuery {
  const params = new URLSearchParams(search), status = params.get('estado');
  return { q: cleanName(params.get('q')), estado: status === 'activas' || status === 'suspendidas' ? status : 'todas' };
}
export function organizationQueryString(query: OrganizationQuery) {
  const params = new URLSearchParams();
  if (cleanName(query.q)) params.set('q', cleanName(query.q));
  if (query.estado !== 'todas') params.set('estado', query.estado);
  return params.toString();
}
export function matchesOrganization(row: OrganizationRow, query: OrganizationQuery) {
  const term = normalized(query.q);
  return (query.estado === 'todas' || row.status === (query.estado === 'activas' ? 'active' : 'suspended')) &&
    [row.name, ...row.managers.flatMap(m => [m.name, m.email ?? ''])].some(value => normalized(value).includes(term));
}
export function organizationResults(rows: OrganizationRow[], query: OrganizationQuery) {
  const searched = rows.filter(row => matchesOrganization(row, { ...query, estado: 'todas' }));
  const activas = searched.filter(row => row.status === 'active').length;
  return { counts: { todas: searched.length, activas, suspendidas: searched.length - activas },
    rows: searched.filter(row => matchesOrganization(row, query)) };
}

export function createdOrganizationVisibility(id: string | null, rows: OrganizationRow[], query: OrganizationQuery) {
  if (!id) return null;
  return rows.some(row => row.id === id && matchesOrganization(row, query)) ? 'visible' : 'hidden';
}

export const CREATION_INVITATION_NOTICE = 'Invitación simulada: no se envió ningún correo ni se creó un espacio de trabajo funcional.';
