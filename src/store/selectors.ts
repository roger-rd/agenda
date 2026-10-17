import type { State, PostStatus, PostFormat } from '../types';
import { can } from './permissions';
import { zonedFormat } from '../lib/dates';
export const selectUser = (s: State) => s.users.find(u => u.id === ({ community_manager: 'edison', worker: 'ana', client: 'roger' }[s.role]))!;
export const selectCompanies = (s: State) => s.companies.filter(c => can(s.role, 'viewAllCompanies') || s.memberships.some(m => m.companyId === c.id && m.userId === selectUser(s).id));
export const selectCompany = (s: State, id: string) => selectCompanies(s).find(c => c.id === id);
export const selectPosts = (s: State, companyId: string) => selectCompany(s, companyId) ? s.posts.filter(p => p.companyId === companyId && (can(s.role, 'viewHiddenPosts') || p.visible_para_cliente)) : [];
export const selectPost = (s: State, id: string) => { const p = s.posts.find(p => p.id === id); return p ? selectPosts(s, p.companyId).find(post => post.id === id) : undefined; };
export interface Filters {
    status: PostStatus | '';
    format: PostFormat | '';
    responsible: string;
}
export const selectFilteredPosts = (s: State, companyId: string, filters: Filters) => selectPosts(s, companyId).filter(p => (!filters.status || p.status === filters.status) && (!filters.format || p.format === filters.format) && (!filters.responsible || p.responsibleId === filters.responsible)).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
export const selectResponsibleUsers = (s: State, companyId: string) => s.users.filter(u => selectPosts(s, companyId).some(p => p.responsibleId === u.id));
export const selectCounts = (s: State, companyId: string) => { const posts = selectPosts(s, companyId); return { planned: posts.filter(p => zonedFormat(p.scheduledAt, 'yyyy-MM') === zonedFormat(new Date(), 'yyyy-MM')).length, pending: posts.filter(p => p.status === 'Pendiente' || p.status === 'En proceso').length }; };
