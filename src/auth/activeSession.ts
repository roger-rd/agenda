import type { AdminSession } from '../platform/types';
export type ActiveSession = 'none' | 'workspace' | 'platform_admin';

// Fail-closed para dos sesiones activas EN MEMORIA en esta pestaña.
// La marca compartida de otra pestaña ya se neutraliza al restaurar el store.
export function selectActiveSession(authenticated: boolean, admin: AdminSession | null): ActiveSession {
  if (authenticated && admin) return 'none';
  return authenticated ? 'workspace' : admin ? 'platform_admin' : 'none';
}
export function closeConflictingSessions(authenticated: boolean, admin: AdminSession | null, logoutAll: () => void) {
  if (authenticated && admin) logoutAll();
}
