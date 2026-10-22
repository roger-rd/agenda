import { useLayoutEffect } from 'react';
import { useStore } from '../store';
import { useAdminSession } from '../platform/session';
import { logoutAll } from './sessions';
import { closeConflictingSessions, selectActiveSession } from './activeSession';

export function useActiveSession() {
  const { authenticated } = useStore();
  const admin = useAdminSession();
  // El render ya devuelve none; la limpieza ocurre antes de pintar, nunca en render.
  useLayoutEffect(() => { closeConflictingSessions(authenticated, admin, logoutAll); }, [authenticated, admin]);
  return selectActiveSession(authenticated, admin);
}
