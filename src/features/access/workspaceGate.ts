import type { ActiveSession } from '../../auth/activeSession';
import type { WorkspaceAccessCauses } from '../../platform/access';
export function resolveWorkspaceGate(session: ActiveSession, causes: WorkspaceAccessCauses) {
  return { access: session === 'workspace' && causes.allowed ? 'allowed' as const : 'blocked' as const, causes };
}
