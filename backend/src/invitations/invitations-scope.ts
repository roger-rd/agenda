import type { AuthenticatedSession } from '../auth/session.service';
import { ForbiddenError } from '../common/errors/domain-error';

/** The organization always comes from the session, never from the request. Only a community manager operates on invitations. */
export interface InvitationsScope { organizationId: string; membershipId: string; role: 'community_manager' }
export function invitationsScope(session: AuthenticatedSession): InvitationsScope {
  const { organization, membership } = session;
  if (!organization || !membership || membership.role !== 'community_manager') throw new ForbiddenError('Acceso denegado.');
  return { organizationId: organization.id, membershipId: membership.id, role: 'community_manager' };
}
