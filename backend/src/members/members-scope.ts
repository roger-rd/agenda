import type { AuthenticatedSession } from '../auth/session.service';
import { ForbiddenError } from '../common/errors/domain-error';

/** The organization always comes from the session. Only a community manager lists members or changes their accesses. */
export interface MembersScope { organizationId: string; membershipId: string; role: 'community_manager' }
export function membersScope(session: AuthenticatedSession): MembersScope {
  const { organization, membership } = session;
  if (!organization || !membership || membership.role !== 'community_manager') throw new ForbiddenError('Acceso denegado.');
  return { organizationId: organization.id, membershipId: membership.id, role: 'community_manager' };
}
