import type { PostStatus, Role, State } from '../types';
import type { StorageLike } from '../platform/types';
import type { PostInput } from '../features/posts/validation';
import { generateDemo } from '../data/demo';
import type { WorkspacePolicy } from '../platform/access';
import { can } from './permissions';
import { profileIds, selectCompanies } from './selectors';
import { restoreWorkspace, mergeShared, normalizeSession } from './migration';
import { acquireLease } from './sync';
import * as operations from './operations';
import * as invitations from './invitations';
import * as team from './teamAccess';
import { ACCESS_DENIED } from './accessGuard';
export const WORKSPACE_KEY = 'agenda-demo-v2';
interface Options {
  getPlatform: () => WorkspacePolicy;
  hasAdminSession?: () => boolean;
  closeAdminSession?: () => void;
  now?: () => number;
  windowTarget?: EventTarget;
  documentTarget?: EventTarget;
}
export function createWorkspaceStore(storage: StorageLike | undefined, options: Options) {
  const now = options.now ?? Date.now, admin = options.hasAdminSession ?? (() => false);
  let lastRaw: string | null = null, warning = '';
  try { lastRaw = storage?.getItem(WORKSPACE_KEY) ?? null; } catch { warning = 'No se pudo leer el almacenamiento.'; }
  let state = restoreWorkspace(lastRaw, admin());
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(l => l());
  function refresh() {
    try {
      if (!storage) return false;
      const raw = storage.getItem(WORKSPACE_KEY);
      if (raw === lastRaw) return true;
      state = mergeShared(restoreWorkspace(raw), state); lastRaw = raw; notify(); return true;
    } catch { warning = 'No se pudo actualizar el almacenamiento.'; return false; }
  }
  const conflict = () => invitations.failure('conflict', 'Los datos cambiaron en otra pestaña. Inténtalo de nuevo.');
  function write(operation: (s: State) => operations.Result): operations.Result {
    if (!storage) return invitations.failure('storage_unavailable', 'No se pudieron guardar los cambios en este navegador.');
    for (let attempt = 0; attempt < 3; attempt++) {
      let lease: ReturnType<typeof acquireLease>;
      try {
        lease = acquireLease(storage, WORKSPACE_KEY, now);
        if (!lease) continue;
        const raw = storage.getItem(WORKSPACE_KEY);
        const fresh = raw === lastRaw ? state : mergeShared(restoreWorkspace(raw), state);
        // Una base atrasada se reemplaza y la operación se vuelve a ejecutar sobre ella.
        if (fresh.revision < state.revision) return conflict();
        const baseRevision = fresh.revision;
        const result = operation(fresh);
        if (!result.ok) { if (raw !== lastRaw) { state = fresh; lastRaw = raw; notify(); } return result; }
        if (!lease.owns() || storage.getItem(WORKSPACE_KEY) !== raw) continue;
        if (result.state === fresh) { state = fresh; lastRaw = raw; notify(); return { ok: true, state }; }
        const next = normalizeSession({ ...result.state, revision: baseRevision + 1 });
        const serialized = operations.serializeState(next);
        storage.setItem(WORKSPACE_KEY, serialized);
        if (!lease.owns() || storage.getItem(WORKSPACE_KEY) !== serialized) { refresh(); return conflict(); }
        state = next; lastRaw = serialized; warning = ''; notify();
        return { ok: true, state };
      } catch {
        warning = 'No se pudieron guardar los cambios en este navegador.';
        return invitations.failure('storage_unavailable', warning);
      } finally { try { lease?.release(); } catch { /* El lease expira automáticamente. */ } }
    }
    return conflict();
  }
  function allowed(s: State) { return options.getPlatform().accessAllowed(s.organization.id, s.activeUserId); }
  const blocked = (): operations.Result => ({ ok: false, reason: ACCESS_DENIED });
  function guarded(operation: (s: State) => operations.Result) {
    if (!allowed(state)) return blocked();
    return write(s => !allowed(s) ? blocked() : admin() ? invitations.failure('forbidden', 'La sesión administrativa no puede gestionar el espacio de trabajo.') : operation(s));
  }
  const context = () => ({ platform: options.getPlatform(), admin: admin(), now: now() });
  function setActiveUser(userId: string): operations.Result {
    options.getPlatform();
    return write(s => {
      if (!s.authenticated) return invitations.failure('forbidden', 'Debes iniciar sesión en el espacio de trabajo.');
      const user = s.users.find(u => u.id === userId);
      if (!user) return invitations.failure('invalid_input', 'Persona no válida.');
      const next = { ...s, activeUserId: userId, role: user.role };
      return { ok: true, state: { ...next, activeCompanyId: selectCompanies(next)[0]?.id ?? '' } };
    });
  }
  function updateSession(authenticated: boolean) {
    if (authenticated) { options.getPlatform(); options.closeAdminSession?.(); }
    return write(s => ({ ok: true, state: { ...s, authenticated, role: 'community_manager',
      activeUserId: s.users.find(u => u.id === profileIds.community_manager)?.id ?? s.users.find(u => u.role === 'community_manager')?.id ?? '' } }));
  }
  const actions = {
    refresh,
    inspectInvitation: (code: string) => invitations.inspectInvitation(state, code, context()),
    enterAs: (userId: string): operations.Result => {
      options.getPlatform();
      return write(s => {
        const user = s.users.find(u => u.id === userId);
        if (!user) return invitations.failure('not_found', 'Persona no disponible.');
        options.closeAdminSession?.();
        const next = { ...s, authenticated: true, activeUserId: user.id, role: user.role };
        return { ok: true, state: { ...next, activeCompanyId: selectCompanies(next)[0]?.id ?? '' } };
      });
    },
    memberSuspended: (userId: string) => options.getPlatform().memberSuspended(state.organization.id, userId),
    createPost: (input: PostInput) => guarded(s => operations.savePost(s, input)),
    updatePost: (id: string, input: PostInput) => guarded(s => operations.savePost(s, input, id)),
    deletePost: (id: string) => guarded(s => operations.deletePost(s, id)),
    addComment: (id: string, body: string) => guarded(s => operations.addComment(s, id, body)),
    changeStatus: (id: string, status: PostStatus) => guarded(s => operations.setStatus(s, id, status)),
    login: () => updateSession(true), logout: () => updateSession(false), setActiveUser,
    setRole: (role: Role) => {
      refresh();
      return setActiveUser(state.users.find(u => u.id === profileIds[role] && u.role === role)?.id ?? state.users.find(u => u.role === role)?.id ?? '');
    },
    setCompany: (id: string) => guarded(s => !s.authenticated ? invitations.failure('forbidden', 'Debes iniciar sesión en el espacio de trabajo.')
      : selectCompanies(s).some(c => c.id === id) ? { ok: true, state: { ...s, activeCompanyId: id } } : invitations.failure('forbidden', 'Empresa no disponible.')),
    createCompany: (name: string, color: string) => guarded(s => {
      if (!s.authenticated || !can(s.role, 'createCompany') || !name.trim())
        return invitations.failure('forbidden', 'No tienes permiso o el nombre de empresa no es válido.');
      return { ok: true, state: { ...s, companies: [...s.companies,
        { id: crypto.randomUUID(), name: name.trim().slice(0, 80), color, organizationId: s.organization.id }] } };
    }),
    reset: () => guarded(s => s.authenticated && can(s.role, 'resetDemo')
      ? { ok: true, state: { ...generateDemo(), authenticated: true } }
      : invitations.failure('forbidden', 'No tienes permiso para restablecer la demostración.')),
    createInvitation: (input: invitations.InvitationInput) => guarded(s => invitations.createInvitation(s, input, context())),
    revokeInvitation: (id: string) => guarded(s => invitations.changeInvitation(s, id, 'revoke', context())),
    renewInvitation: (id: string, days?: 1 | 7 | 30) => guarded(s => invitations.changeInvitation(s, id, 'renew', context(), days)),
    acceptInvitation: (code: string, input: { name: string; email: string }) => write(s => invitations.acceptInvitation(s, code, input, context())),
    setCompanyAccess: (userId: string, ids: string[], revision?: number) => guarded(s => revision !== undefined && revision !== s.revision ? conflict() : team.setCompanyAccess(s, userId, ids, admin())),
    assignCompanyAccess: (userId: string, companyId: string) => guarded(s => team.changeCompanyAccess(s, userId, companyId, true, admin())),
    removeCompanyAccess: (userId: string, companyId: string) => guarded(s => team.changeCompanyAccess(s, userId, companyId, false, admin())),
    removeWorkerCompanyAccess: (userId: string, companyId: string) => guarded(s => invitations.removeWorkerCompanyAccess(s, userId, companyId, admin())),
    listInvitations: (): operations.Result => {
      refresh();
      return allowed(state) && invitations.canManageTeam(state, admin())
        ? { ok: true, state } : invitations.failure('forbidden', 'Solo el community manager puede ver invitaciones.');
    },
  };
  const windowTarget = options.windowTarget ?? (typeof window === 'undefined' ? undefined : window);
  const documentTarget = options.documentTarget ?? (typeof document === 'undefined' ? undefined : document);
  const onStorage = (e: Event) => { if ((e as StorageEvent).key === WORKSPACE_KEY || (e as StorageEvent).key === null) refresh(); };
  windowTarget?.addEventListener('storage', onStorage); windowTarget?.addEventListener('focus', refresh);
  documentTarget?.addEventListener('visibilitychange', refresh);
  return { actions, updateSession, refresh, getState: () => state, getStorageWarning: () => warning,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    dispose: () => { windowTarget?.removeEventListener('storage', onStorage); windowTarget?.removeEventListener('focus', refresh);
      documentTarget?.removeEventListener('visibilitychange', refresh); listeners.clear(); } };
}
