import type { State } from '../../types';
import { companyAccess } from '../../store/teamAccess';
import type { Result } from '../../store/operations';
export function retainedContent(s: State, userId: string, companyIds: string[]) {
  const worker = s.users.find(u => u.id === userId)?.role === 'worker';
  return companyIds.map(companyId => {
    const posts = s.posts.filter(p => p.companyId === companyId);
    return { companyId, name: s.companies.find(c => c.id === companyId)?.name ?? 'Empresa no disponible',
      posts: worker ? posts.filter(p => p.responsibleId === userId).length : undefined,
      comments: s.comments.filter(c => c.authorId === userId && posts.some(p => p.id === c.postId)).length };
  });
}
export function retentionText(rows: ReturnType<typeof retainedContent>, past = false) {
  return rows.map(row => `${row.name}: ${past ? 'Se conservaron' : 'Se conservarán'} ${row.posts === undefined ? '' : `${row.posts} publicaciones y `}${row.comments} comentarios.${row.posts === undefined ? '' : past ? ' Las publicaciones asignadas ya no tienen un responsable con acceso: elige uno nuevo al editarlas.' : ' Las publicaciones asignadas a esta persona en esta empresa quedarán sin responsable con acceso.'} Los comentarios corresponden a esta persona en esta empresa.`).join('\n');
}
export const accessLabel = (s: State, userId: string) => s.users.find(u => u.id === userId)?.role === 'community_manager'
  ? 'Todas las empresas' : companyAccess(s, userId).length ? '' : 'Sin empresas asignadas';
export interface AccessDraft { selected: string[]; baseline: string[]; revision: number; message: string; ready: boolean }
export const accessDraft = (s: State, userId: string): AccessDraft => ({ selected: companyAccess(s, userId), baseline: companyAccess(s, userId), revision: s.revision, message: '', ready: true });
export function draftValidity(s: State, userId: string, draft: AccessDraft) {
  const user = s.users.find(u => u.id === userId);
  return { valid: !!user && user.role !== 'community_manager' && draft.selected.every(id => s.companies.some(c => c.id === id && c.organizationId === s.organization.id)),
    changed: draft.revision !== s.revision };
}
// Refrescar no ejecuta la operación de nuevo. La selección sigue siendo la decisión de la persona.
export function recoverAccessDraft<T extends { message: string; ready: boolean }>(draft: T, result: Result, refresh: () => boolean | void): T {
  if (result.ok) return draft;
  const ready = refresh() !== false;
  return { ...draft, message: result.reason, ready };
}
