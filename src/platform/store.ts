import { adminSession } from './session';
import { accessForWorkspace } from './access';
import { restorePlatform } from './restore';
import * as operations from './operations';
import type { AdminSession, PlatformState, Result, StorageLike } from './types';
import { reconcileWithDirectory, type WorkspaceDirectory } from './directory';
export const PLATFORM_KEY = 'agenda-platform-v1';
interface StoreOptions {
  getSession?: () => AdminSession | null;
  windowTarget?: EventTarget;
  documentTarget?: EventTarget;
}
export function browserLocalStorage(): StorageLike | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}
export function createPlatformStore(storage: StorageLike | undefined, options: StoreOptions = {}) {
  const session = options.getSession ?? adminSession.getSession;
  const listeners = new Set<() => void>();
  let warning = storage ? '' : 'No se pudo leer el almacenamiento de plataforma.', lastRaw: string | null = null;
  try { lastRaw = storage?.getItem(PLATFORM_KEY) ?? null; }
  catch { warning = 'No se pudo leer el almacenamiento de plataforma.'; }
  let state = restorePlatform(lastRaw);
  const notify = () => listeners.forEach(listener => listener());
  function refresh() {
    try {
      if (!storage) return;
      const raw = storage.getItem(PLATFORM_KEY);
      // Un fallo de escritura mantiene la copia en memoria mientras no llegue otro dato externo.
      if (raw === lastRaw) return;
      const next = restorePlatform(raw);
      const previousWarning = warning;
      if (raw === null) warning = 'Se perdió el almacenamiento de plataforma. Se han recuperado los datos de ejemplo.';
      lastRaw = raw;
      if (next.revision !== state.revision || JSON.stringify(next) !== JSON.stringify(state)) {
        state = next; notify();
      } else if (previousWarning !== warning) notify();
    } catch {
      const nextWarning = 'No se pudo actualizar el almacenamiento de plataforma; se conserva la copia en memoria.';
      if (warning !== nextWarning) { warning = nextWarning; notify(); }
    }
  }
  function write(operation: (state: PlatformState, session: AdminSession | null) => Result): Result {
    refresh();
    const result = operation(state, session());
    if (!result.ok) return result;
    if (result.value === state) return result;
    state = { ...result.value, revision: state.revision + 1 };
    try {
      if (!storage) throw new Error('Almacenamiento no disponible');
      const raw = JSON.stringify(state);
      storage.setItem(PLATFORM_KEY, raw); lastRaw = raw; warning = '';
    } catch { warning = 'No se pudieron guardar los cambios de plataforma. Se conservarán durante esta sesión.'; }
    notify();
    return { ok: true, value: state };
  }
  const windowTarget = options.windowTarget ?? (typeof window !== 'undefined' ? window : undefined);
  const documentTarget = options.documentTarget ?? (typeof document !== 'undefined' ? document : undefined);
  const onStorage = (event: Event) => { const key = (event as StorageEvent).key; if (key === PLATFORM_KEY || key === null) refresh(); };
  windowTarget?.addEventListener('storage', onStorage);
  windowTarget?.addEventListener('focus', refresh);
  documentTarget?.addEventListener('visibilitychange', refresh);
  return {
    getState: () => state,
    getStorageWarning: () => warning,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    dispose: () => {
      windowTarget?.removeEventListener('storage', onStorage);
      windowTarget?.removeEventListener('focus', refresh);
      documentTarget?.removeEventListener('visibilitychange', refresh);
      listeners.clear();
    },
    isAccessAllowed: (organizationId: string, userId: string) => { refresh(); return accessForWorkspace(state, organizationId, userId); },
    listOrganizations: (workspace: WorkspaceDirectory) => { refresh(); return operations.listOrganizations(state, session(), workspace); },
    viewOrganization: (id: string, workspace: WorkspaceDirectory) => { refresh(); return operations.viewOrganization(state, session(), id, workspace); },
    createOrganization: (input: unknown) => write((s, session) => operations.createOrganization(s, session, input)),
    suspendOrganization: (input: operations.StatusInput) => write((s, session) => operations.suspendOrganization(s, session, input)),
    reactivateOrganization: (input: operations.StatusInput) => write((s, session) => operations.reactivateOrganization(s, session, input)),
    suspendMember: (input: operations.MemberStatusInput) => write((s, session) => operations.suspendMember(s, session, input)),
    reactivateMember: (input: operations.MemberStatusInput) => write((s, session) => operations.reactivateMember(s, session, input)),
    // Mantenimiento sin privilegios: únicamente elimina accesos huérfanos.
    reconcileWithWorkspace: (userIds: readonly string[]) => {
      refresh();
      const next = reconcileWithDirectory(state, userIds);
      if (next === state) return false;
      write(s => ({ ok: true, value: reconcileWithDirectory(s, userIds) }));
      return true;
    },
    resetPlatform: () => write(operations.resetPlatform),
  };
}
export const platformStore = createPlatformStore(browserLocalStorage());
