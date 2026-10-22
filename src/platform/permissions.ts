import { PLATFORM_ADMIN_ID } from './ids';
import type { AdminSession } from './types';
export const PLATFORM_ACTIONS = ['listOrganizations', 'viewOrganization', 'createOrganization',
  'suspendOrganization', 'reactivateOrganization', 'suspendMember', 'reactivateMember', 'resetPlatform'] as const;
export type PlatformAction = typeof PLATFORM_ACTIONS[number];
export function platformCan(session: AdminSession | null, action: PlatformAction): boolean {
  return session?.kind === 'platform_admin' && session.adminId === PLATFORM_ADMIN_ID && PLATFORM_ACTIONS.includes(action);
}
