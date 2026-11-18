import type { AuthenticatedSession } from '../auth/session.service';
import { ForbiddenError } from '../common/errors/domain-error';
import { companiesScope } from './companies-scope';

const session = (organization: unknown, membership: unknown) => ({ organization, membership }) as AuthenticatedSession;
describe('alcance exclusivo de la sesión', () => {
  it.each(['community_manager', 'worker', 'client'])('admite %s', role => {
    expect(companiesScope(session({ id: 'organización' }, { id: 'membresía', role })))
      .toEqual({ organizationId: 'organización', membershipId: 'membresía', role });
  });
  it.each([[null, null], [null, { id: 'm', role: 'worker' }], [{ id: 'o' }, null],
    [{ id: 'o' }, { id: 'm', role: 'admin' }]])('rechaza organización %p y membresía %p', (organization, membership) => {
    expect(() => companiesScope(session(organization, membership))).toThrow(new ForbiddenError('Acceso denegado.'));
  });
});
