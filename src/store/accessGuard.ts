import type { State } from '../types';
import { currentUserId, workspaceOrganizationId } from './selectors';

export const ACCESS_DENIED = 'Tu acceso a esta organización está suspendido.';
export function createAccessGuard({ getWorkspaceState, isAccessAllowed }: {
  getWorkspaceState: () => State;
  // La implementación debe releer el almacenamiento antes de decidir.
  isAccessAllowed: (organizationId: string, userId: string) => { allowed: boolean };
}) {
  return () => {
    const state = getWorkspaceState();
    return isAccessAllowed(workspaceOrganizationId(state), currentUserId(state)).allowed;
  };
}
