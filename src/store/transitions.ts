import type { Post, PostStatus, State } from '../types';
import { can } from './permissions';
import { selectAssignableUsers, selectPost, selectUser } from './selectors';
export const statuses: PostStatus[] = ['Pendiente', 'En proceso', 'Completado', 'Subido'];
export function transitionPost(previous: Post | undefined, next: Post, userId: string, now = new Date()): Post {
  const result = { ...next };
  delete result.confirmadoPor;
  delete result.confirmadoEn;
  if (next.status === 'Subido') {
    result.confirmadoPor = previous?.status === 'Subido' ? previous.confirmadoPor : userId;
    result.confirmadoEn = previous?.status === 'Subido' ? previous.confirmadoEn : now.toISOString();
  }
  return result;
}
export function changePostStatus(state: State, id: string, status: PostStatus, now = new Date()): State {
  const post = selectPost(state, id);
  if (!can(state.role, 'changeStatus') || !post || !statuses.includes(status)
    || !selectAssignableUsers(state, post.companyId).some(u => u.id === post.responsibleId)
    || post.status === status) return state;
  return { ...state, posts: state.posts.map(p => p.id === id
    ? transitionPost(p, { ...p, status }, selectUser(state).id, now) : p) };
}
