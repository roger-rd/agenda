import { useSyncExternalStore } from 'react';
import { PLATFORM_ADMIN_ID } from './ids';
import { platformCan } from './permissions';
import type { AdminSession, StorageLike } from './types';
export const SESSION_KEY = 'agenda-platform-session-v1';
export function browserSessionStorage(): StorageLike | undefined {
  try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage; } catch { return undefined; }
}
export function createAdminSession(storage?: StorageLike) {
  let session: AdminSession | null = null;
  try {
    const candidate = JSON.parse(storage?.getItem(SESSION_KEY) ?? 'null');
    if (platformCan(candidate, 'viewOrganization')) session = { kind: 'platform_admin', adminId: PLATFORM_ADMIN_ID };
  } catch { /* Una sesión corrupta no concede permisos. */ }
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSession: () => session,
    setSession: (next: AdminSession | null) => {
      const valid = platformCan(next, 'viewOrganization');
      if (Boolean(session) === valid) return;
      session = valid ? { kind: 'platform_admin', adminId: PLATFORM_ADMIN_ID } : null;
      try { storage?.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* Alcance en memoria de esta pestaña. */ }
      listeners.forEach(listener => listener());
    },
  };
}
export const adminSession = createAdminSession(browserSessionStorage());

export const useAdminSession = () => useSyncExternalStore(adminSession.subscribe, adminSession.getSession);
