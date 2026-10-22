import { PLATFORM_ADMIN_ID } from '../platform/ids';
import { adminSession } from '../platform/session';
import type { AdminSession } from '../platform/types';
import { updateWorkspaceSession } from '../store';
export interface SessionDependencies {
  setWorkspace: (authenticated: boolean, role: 'community_manager') => void;
  admin: { setSession(session: AdminSession | null): void };
}
export function createSessionCoordinator({ setWorkspace, admin }: SessionDependencies) {
  const leaveWorkspace = () => setWorkspace(false, 'community_manager');
  const leaveAdmin = () => admin.setSession(null);
  return {
    enterWorkspace: () => { leaveAdmin(); setWorkspace(true, 'community_manager'); },
    enterPlatformAdmin: () => {
      // Cerrar primero evita acumular permisos durante las notificaciones del almacén.
      leaveWorkspace(); admin.setSession({ kind: 'platform_admin', adminId: PLATFORM_ADMIN_ID });
    },
    leaveWorkspace, leaveAdmin,
    logoutAll: () => { leaveAdmin(); leaveWorkspace(); },
  };
}
export const { enterWorkspace, enterPlatformAdmin, leaveWorkspace, leaveAdmin, logoutAll } = createSessionCoordinator({
  setWorkspace: authenticated => updateWorkspaceSession(authenticated), admin: adminSession,
});
