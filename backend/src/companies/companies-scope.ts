import type { AuthenticatedSession } from '../auth/session.service';
import { ForbiddenError } from '../common/errors/domain-error';

const COMPANY_ROLES = ['community_manager', 'worker', 'client'] as const;
export interface CompaniesScope { organizationId: string; membershipId: string; role: typeof COMPANY_ROLES[number] }
export function companiesScope(session: AuthenticatedSession): CompaniesScope {
  const { organization, membership } = session;
  if (!organization || !membership || !COMPANY_ROLES.some(role => role === membership.role)) {
    throw new ForbiddenError('Acceso denegado.');
  }
  return { organizationId: organization.id, membershipId: membership.id, role: membership.role as CompaniesScope['role'] };
}
