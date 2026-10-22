import { platformStore } from '../platform/store';
import { createAccessGuard, ACCESS_DENIED } from './accessGuard';
import { adminSession } from '../platform/session';
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
        && ['community_manager', 'worker', 'client'].includes(s.role)) {
        // La marca persistida es compartida y puede proceder de otra pestaña.
        // Al arrancar con administrador local, neutralizarla solo en memoria:
        // no cerrar sesiones ni escribir almacenamiento durante la restauración.
        return adminSession.getSession() ? { ...s, authenticated: false } : s;
      }
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
export function updateWorkspaceSession(authenticated: boolean) {
  if (authenticated) { platformStore.refresh(); adminSession.setSession(null); }
  update({ ...state, authenticated, role: 'community_manager' });
}
const unauthenticated = (): Result => ({ ok: false, reason: 'Debes iniciar sesión en el espacio de trabajo.' });
const accessAllowed = createAccessGuard({ getWorkspaceState: getState, isAccessAllowed: platformStore.isAccessAllowed });
const blocked = (): Result => ({ ok: false, reason: ACCESS_DENIED });
function guarded(operation: () => Result): Result {
  return accessAllowed() ? apply(operation()) : blocked();
}
export const actions = {
  createPost: (input: PostInput) => guarded(() => savePost(state, input)),
  updatePost: (id: string, input: PostInput) => guarded(() => savePost(state, input, id)),
  deletePost: (id: string) => guarded(() => deletePost(state, id)),
  addComment: (id: string, body: string) => guarded(() => addComment(state, id, body)),
  changeStatus: (id: string, status: PostStatus) => guarded(() => setStatus(state, id, status)),
  login: () => updateWorkspaceSession(true),
  logout: () => updateWorkspaceSession(false),
  setRole: (role: Role): Result => {
    platformStore.refresh();
    if (!state.authenticated) return unauthenticated();
    if (!['community_manager', 'worker', 'client'].includes(role)) return { ok: false, reason: 'Perfil no válido.' };
    const next = { ...state, role };
    next.activeCompanyId = selectCompanies(next)[0]?.id ?? '';
    update(next);
    return { ok: true, state };
  },
  setCompany: (id: string): Result => {
    if (!accessAllowed()) return blocked();
    if (!state.authenticated) return unauthenticated();
    if (selectCompanies(state).some(c => c.id === id))
      update({ ...state, activeCompanyId: id });
    return { ok: true, state };
  },
  createCompany: (name: string, color: string) => {
    if (!accessAllowed()) return blocked();
    if (!state.authenticated) return unauthenticated();
    if (!can(state.role, 'createCompany') || !name.trim())
      return { ok: false, reason: 'No tienes permiso o el nombre de empresa no es válido.' } as const;
    const id = crypto.randomUUID();
    const company = { id, name: name.trim().slice(0, 80), color, organizationId: state.organization.id };
    update({ ...state, companies: [...state.companies, company] });
    return { ok: true, state } as const;
  },
  reset: (): Result => {
    if (!accessAllowed()) return blocked();
    if (!state.authenticated) return unauthenticated();
    if (can(state.role, 'resetDemo')) {
      attachmentFiles.clear();
      // Vaciar el navegador restablece toda la demo; en producción autoriza el servidor.
      update({ ...generateDemo(), authenticated: true });
      return { ok: true, state };
    }
    return { ok: false, reason: 'No tienes permiso para restablecer la demostración.' };
  },
};
