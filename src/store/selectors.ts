import { WORKSPACE_USER_IDS } from '../platform/ids';
import type { State, PostStatus, PostFormat } from '../types';
import { can } from './permissions';
import { zonedFormat } from '../lib/dates';
import { dateKey, periodRange, type View } from '../lib/periods';

export const profileIds = { community_manager: WORKSPACE_USER_IDS.manager, worker: WORKSPACE_USER_IDS.worker, client: WORKSPACE_USER_IDS.client };
// El selector de demo cambia la identidad simulada y su acceso individual.
export const currentUserId = (s: State) => s.activeUserId;
export const workspaceOrganizationId = (s: State) => s.organization.id;
export const selectUser = (s: State) => s.users.find(u => u.id === currentUserId(s))!;
export const selectCompanies = (s: State) => s.companies.filter(c =>
  c.organizationId === s.organization.id && (can(s.role, 'viewAllCompanies')
    || s.memberships.some(m => m.companyId === c.id && m.userId === currentUserId(s))));
export const selectCompany = (s: State, id: string) => selectCompanies(s).find(c => c.id === id);
export const selectPosts = (s: State, companyId: string) => selectCompany(s, companyId)
  ? s.posts.filter(p => p.companyId === companyId && (can(s.role, 'viewHiddenPosts') || p.visible_para_cliente)) : [];
export function selectPost(s: State, id: string) {
  const post = s.posts.find(p => p.id === id);
  return post ? selectPosts(s, post.companyId).find(p => p.id === id) : undefined;
}
export interface Filters { status: PostStatus | ''; format: PostFormat | ''; responsible: string; }
export const emptyFilters: Filters = { status: '', format: '', responsible: '' };
export const selectFilteredPosts = (s: State, companyId: string, filters: Filters) =>
  selectPosts(s, companyId).filter(p => (!filters.status || p.status === filters.status)
    && (!filters.format || p.format === filters.format)
    && (!filters.responsible || p.responsibleId === filters.responsible))
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
export function selectViewPosts(s: State, companyId: string, filters: Filters, reference: string, view: View) {
  if (view === 'tablero' && !can(s.role, 'changeStatus')) return [];
  const { start, end } = periodRange(reference, view);
  return selectFilteredPosts(s, companyId, filters).filter(p => {
    const day = zonedFormat(p.scheduledAt, 'yyyy-MM-dd');
    return day >= dateKey(start) && day <= dateKey(end);
  });
}
export const selectResponsibleUsers = (s: State, companyId: string) =>
  s.users.filter(u => selectPosts(s, companyId).some(p => p.responsibleId === u.id));
export function selectCounts(s: State, companyId: string, now = new Date()) {
  const month = zonedFormat(now, 'yyyy-MM');
  const posts = selectPosts(s, companyId).filter(p => zonedFormat(p.scheduledAt, 'yyyy-MM') === month);
  return { planned: posts.length, pending: posts.filter(p => p.status === 'Pendiente' || p.status === 'En proceso').length };
}

export const selectAssignableUsers = (s: State, companyId: string) =>
  s.companies.some(c => c.id === companyId && c.organizationId === s.organization.id)
    ? s.users.filter(u => u.role === 'community_manager' || (u.role === 'worker'
      && s.memberships.some(m => m.userId === u.id && m.companyId === companyId))) : [];
export const selectComments = (s: State, postId: string) => selectPost(s, postId)
  ? s.comments.filter(c => c.postId === postId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];

export function selectRequestedPost(s: State, companyId: string, id: string) {
  const post = selectPost(s, id);
  return post?.companyId === companyId ? post : undefined;
}

export const isResponsibleAuthorized = (s: State, companyId: string, responsibleId: string) =>
  selectAssignableUsers(s, companyId).some(u => u.id === responsibleId);
export const selectPostsWithUnauthorizedResponsible = (s: State, companyId: string) =>
  selectPosts(s, companyId).filter(p => !isResponsibleAuthorized(s, companyId, p.responsibleId))
    .map(post => ({ post, previousResponsible: s.users.find(u => u.id === post.responsibleId) }));

export const responsibleLabel = (s: State, companyId: string, userId: string) =>
  `${s.users.find(u => u.id === userId)?.name ?? 'Persona no disponible'}${isResponsibleAuthorized(s, companyId, userId) ? '' : ' (sin acceso)'}`;

export function selectDemoGroups(s: State, memberSuspended: (id: string) => boolean) {
  return (['community_manager', 'worker', 'client'] as const).map(role => ({
    role, label: { community_manager: 'Community manager', worker: 'Trabajadores', client: 'Clientes' }[role],
    people: s.users.filter(u => u.role === role).sort((a, b) => a.name.localeCompare(b.name, 'es')).map(u => ({
      id: u.id, label: `${u.name}${u.id === s.activeUserId ? ' (persona actual)' : ''}${u.example ? ' (datos de ejemplo)' : ''}${memberSuspended(u.id) ? ' (acceso suspendido)' : ''}`,
    })),
  }));
}
