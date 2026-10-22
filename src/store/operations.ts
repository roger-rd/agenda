import type { PostStatus, State } from '../types';
import { can, type Action } from './permissions';
import { selectAssignableUsers, selectCompany, selectPost, selectUser } from './selectors';
import { changePostStatus, transitionPost, statuses } from './transitions';
import { metadata, validateDraft, type PostInput } from '../features/posts/validation';
import { zonedFormat } from '../lib/dates';

export type Result = { ok: true; state: State } | { ok: false; reason: string; code?: WorkspaceError };
const reject = (reason: string): Result => ({ ok: false, reason });
function authorized(s: State, action: Action, companyId: string) {
  return s.authenticated && can(s.role, action) && !!selectCompany(s, companyId);
}
function validate(s: State, input: PostInput): string | undefined {
  try {
    return Object.values(validateDraft({ ...input,
      day: zonedFormat(input.scheduledAt, 'yyyy-MM-dd'),
      time: zonedFormat(input.scheduledAt, 'HH:mm'),
    }, s))[0];
  } catch { return 'La fecha y hora no son válidas.'; }
}
export function savePost(s: State, input: PostInput, id?: string, now = new Date()): Result {
  if (!s.authenticated) return reject('Debes iniciar sesión en el espacio de trabajo.');
  const previous = id ? selectPost(s, id) : undefined;
  if (!authorized(s, id ? 'editPost' : 'createPost', input.companyId)
    || (id && (!previous || previous.companyId !== input.companyId)))
    return reject('No tienes permiso para guardar esta publicación.');
  const error = validate(s, input);
  if (error) return reject(error);
  const post = transitionPost(previous, {
    ...input, id: id ?? crypto.randomUUID(), attachments: input.attachments.map(metadata),
  }, selectUser(s).id, now);
  return { ok: true, state: { ...s, posts: id
    ? s.posts.map(p => p.id === id ? post : p) : [...s.posts, post] } };
}
export function deletePost(s: State, id: string): Result {
  if (!s.authenticated) return reject('Debes iniciar sesión en el espacio de trabajo.');
  const post = selectPost(s, id);
  if (!post || !authorized(s, 'deletePost', post.companyId))
    return reject('No tienes permiso para eliminar esta publicación.');
  if (!selectAssignableUsers(s, post.companyId).some(u => u.id === post.responsibleId))
    return reject('El responsable no está autorizado para esta empresa.');
  return { ok: true, state: { ...s, posts: s.posts.filter(p => p.id !== id),
    comments: s.comments.filter(c => c.postId !== id) } };
}
export function setStatus(s: State, id: string, status: PostStatus, now = new Date()): Result {
  if (!s.authenticated) return reject('Debes iniciar sesión en el espacio de trabajo.');
  const post = selectPost(s, id);
  if (!post || !authorized(s, 'changeStatus', post.companyId))
    return reject('No tienes permiso para cambiar el estado.');
  if (!selectAssignableUsers(s, post.companyId).some(u => u.id === post.responsibleId))
    return reject('El responsable no está autorizado para esta empresa.');
  if (!statuses.includes(status)) return reject('Estado no válido.');
  return { ok: true, state: changePostStatus(s, id, status, now) };
}
export function addComment(s: State, postId: string, body: string, now = new Date()): Result {
  if (!s.authenticated) return reject('Debes iniciar sesión en el espacio de trabajo.');
  const post = selectPost(s, postId);
  if (!post || !authorized(s, 'comment', post.companyId))
    return reject('No tienes permiso para comentar esta publicación.');
  if (!selectAssignableUsers(s, post.companyId).some(u => u.id === post.responsibleId))
    return reject('El responsable no está autorizado para esta empresa.');
  if (!body.trim() || body.length > 2000) return reject('Escribe un comentario de entre 1 y 2000 caracteres.');
  return { ok: true, state: { ...s, comments: [...s.comments, {
    id: crypto.randomUUID(), postId, body: body.trim(), authorId: selectUser(s).id,
    createdAt: now.toISOString(),
  }] } };
}
export function serializeState(s: State): string {
  return JSON.stringify({ ...s, posts: s.posts.map(p => ({
    ...p, attachments: p.attachments.map(metadata),
  })) });
}

export type WorkspaceError = 'conflict' | 'storage_unavailable' | 'forbidden' | 'invalid_input' |
  'not_found' | 'used' | 'revoked' | 'expired' | 'organization_unavailable' |
  'invalid_companies' | 'session_active' | 'existing_member' | 'duplicate_email';
