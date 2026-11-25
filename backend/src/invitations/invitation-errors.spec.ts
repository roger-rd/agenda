import { ConflictError, ForbiddenError, InvalidInputError } from '../common/errors/domain-error';
import { ConstraintRegistry } from '../database/errors/constraint-registry';
import { mapDatabaseFailure } from '../database/errors/database-http';
import { DatabaseOperationError } from '../database/errors/database-operation-error';
import { INVITATION_CONFLICTS, InvitationConflictError, translateInvitationWriteError } from './invitation-errors';
import { invitationsScope } from './invitations-scope';
import type { AuthenticatedSession } from '../auth/session.service';

describe('conflictos de invitación distinguibles', () => {
  it('cada código tiene su mensaje, todos son 409 y ninguno es el conflict genérico', () => {
    const codes = Object.keys(INVITATION_CONFLICTS) as (keyof typeof INVITATION_CONFLICTS)[];
    expect(codes).toEqual(['invitation_pending_exists', 'member_already_active', 'member_deactivated', 'invitation_accepted', 'invitation_revoked']);
    expect(new Set(codes.map(c => INVITATION_CONFLICTS[c])).size).toBe(codes.length);
    for (const code of codes) {
      const error = new InvitationConflictError(code);
      expect(error).toMatchObject({ code, httpStatus: 409, message: INVITATION_CONFLICTS[code] });
      expect(error).not.toBeInstanceOf(ConflictError);
    }
  });
  it('el mensaje de miembro desactivado aclara que no se reactiva', () => {
    expect(INVITATION_CONFLICTS.member_deactivated).toMatch(/no reactiva/);
  });
});

describe('traducción de errores de escritura de invitaciones', () => {
  it('conserva errores de dominio y los no clasificables', () => {
    for (const error of [new ForbiddenError(), new InvalidInputError(), new Error('interno'), null]) expect(translateInvitationWriteError(error)).toBe(error);
  });
  it('traduce solo la unicidad exacta del índice de invitaciones abiertas', () => {
    expect(translateInvitationWriteError({ severity: 'ERROR', code: '23505', constraint: 'UQ_invitations_open_email' })).toMatchObject({ code: 'invitation_pending_exists', httpStatus: 409 });
    for (const constraint of ['UQ_invitations_token_hash', 'uq_invitations_open_email', 'UQ_invitations_open_email_x']) {
      expect(translateInvitationWriteError({ severity: 'ERROR', code: '23505', constraint })).toBeInstanceOf(DatabaseOperationError);
    }
  });
  it('la FK de empresas se informa como entrada inválida; otras FK conservan su clasificación', () => {
    expect(translateInvitationWriteError({ severity: 'ERROR', code: '23503', constraint: 'FK_invitation_companies_company' })).toMatchObject({ code: 'invalid_input', field: 'companyIds' });
    expect(translateInvitationWriteError({ severity: 'ERROR', code: '23503', constraint: 'FK_invitations_created_by' })).toBeInstanceOf(DatabaseOperationError);
  });
  it.each([['23514', 400, 'invalid_input'], ['55P03', 503, 'service_unavailable'], ['57014', 503, 'service_unavailable'], ['08006', 503, 'outcome_unknown'], ['ECONNRESET', 503, 'outcome_unknown']])(
    'conserva el mapeo de %s y el contexto, sin filtrar el driver', (code, status, mappedCode) => {
      const error = translateInvitationWriteError({ severity: 'ERROR', code, message: 'secreto' }, 'update') as DatabaseOperationError;
      expect(error.context).toEqual({ operation: 'update', table: 'invitations', atomic: true, valuesOrigin: 'request' });
      expect(mapDatabaseFailure(error.failure, { method: 'POST', registry: new ConstraintRegistry(), context: error.context })).toMatchObject({ status, code: mappedCode });
      const again = translateInvitationWriteError(error, 'update') as DatabaseOperationError;
      expect(again.failure).toEqual(error.failure);
      expect(JSON.stringify(again)).not.toContain('secreto');
    });
});

describe('alcance de invitaciones', () => {
  const session = (membership: { id: string; role: string } | null, organization: { id: string } | null) =>
    ({ organization, membership } as unknown as AuthenticatedSession);
  it('toma la organización y la membresía de la sesión, solo para un community manager', () => {
    expect(invitationsScope(session({ id: 'm1', role: 'community_manager' }, { id: 'o1' }))).toEqual({ organizationId: 'o1', membershipId: 'm1', role: 'community_manager' });
  });
  it.each([['worker'], ['client'], ['otro']])('rechaza el rol %s', role => {
    expect(() => invitationsScope(session({ id: 'm1', role }, { id: 'o1' }))).toThrow(ForbiddenError);
  });
  it('rechaza una sesión sin organización o sin membresía', () => {
    expect(() => invitationsScope(session(null, { id: 'o1' }))).toThrow(ForbiddenError);
    expect(() => invitationsScope(session({ id: 'm1', role: 'community_manager' }, null))).toThrow(ForbiddenError);
  });
});
