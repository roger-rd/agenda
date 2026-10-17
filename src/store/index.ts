import { useSyncExternalStore } from 'react';
import type { PostStatus, Role, State } from '../types';
import { generateDemo } from '../data/demo';
import { can } from './permissions';
import { selectCompanies } from './selectors';
import { savePost, deletePost, setStatus, addComment, serializeState, type Result } from './operations';
import type { PostInput } from '../features/posts/validation';
import { attachmentFiles } from '../features/posts/attachmentFiles';
const KEY = 'agenda-demo-v2';
function restore(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s.version === 2
        && Array.isArray(s.comments)
        && Array.isArray(s.posts)
        && Array.isArray(s.companies)
        && Array.isArray(s.users)
        && Array.isArray(s.memberships)
        && ['community_manager', 'worker', 'client'].includes(s.role))
        return s;
    }
  }
  catch { /* Storage can be unavailable. */ }
  return generateDemo();
}
let state = restore();
const listeners = new Set<() => void>();
let storageWarning = '';
function update(next: State) {
  state = next;
  try {
    localStorage.setItem(KEY, serializeState(state));
    storageWarning = '';
  }
  catch {
    storageWarning = 'No se pudieron guardar los cambios en este navegador. Se conservarán durante esta sesión.';
  }
  listeners.forEach(l => l());
}
export const useStore = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => state);
export const getState = () => state;
export const getStorageWarning = () => storageWarning;
function apply(result: Result): Result {
  if (result.ok && result.state !== state) {
    const retained = new Set(result.state.posts.flatMap(p => p.attachments.map(a => a.id)));
    for (const id of attachmentFiles.keys()) if (!retained.has(id)) attachmentFiles.delete(id);
    update(result.state);
  }
  return result;
}
export const actions = {
  createPost: (input: PostInput) => apply(savePost(state, input)),
  updatePost: (id: string, input: PostInput) => apply(savePost(state, input, id)),
  deletePost: (id: string) => apply(deletePost(state, id)),
  addComment: (id: string, body: string) => apply(addComment(state, id, body)),
  changeStatus: (id: string, status: PostStatus) => apply(setStatus(state, id, status)),
  login: () => update({ ...state, authenticated: true, role: 'community_manager' }),
  logout: () => update({ ...state, authenticated: false }),
  setRole: (role: Role) => {
    const next = { ...state, role };
    next.activeCompanyId = selectCompanies(next)[0]?.id ?? '';
    update(next);
  },
  setCompany: (id: string) => {
    if (selectCompanies(state).some(c => c.id === id))
      update({ ...state, activeCompanyId: id });
  },
  createCompany: (name: string, color: string) => {
    if (!can(state.role, 'createCompany') || !name.trim())
      return { ok: false, reason: 'No tienes permiso o el nombre de empresa no es válido.' } as const;
    const id = crypto.randomUUID();
    const company = { id, name: name.trim().slice(0, 80), color, organizationId: state.organization.id };
    update({ ...state, companies: [...state.companies, company] });
    return { ok: true, state } as const;
  },
  reset: () => {
    if (can(state.role, 'resetDemo')) {
      attachmentFiles.clear();
      update({ ...generateDemo(), authenticated: true });
    }
  },
};
