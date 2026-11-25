import { DomainError, InvalidInputError } from '../common/errors/domain-error';
import { classifyDatabaseError, createOperationContext } from '../database/errors/database-failure';
import { DatabaseOperationError } from '../database/errors/database-operation-error';

/** Distinguishable 409 conflicts: each has its own stable code and a message that is safe for the client. */
export const INVITATION_CONFLICTS = Object.freeze({
  invitation_pending_exists: 'Ya existe una invitación pendiente para ese correo. Renuévala o revócala antes de crear otra.',
  member_already_active: 'Ese correo ya pertenece a un miembro activo de la organización.',
  member_deactivated: 'Ese correo pertenece a un miembro desactivado de la organización. Una invitación no reactiva membresías.',
  invitation_accepted: 'La invitación ya fue aceptada.',
  invitation_revoked: 'La invitación fue revocada.',
} as const);
export type InvitationConflictCode = keyof typeof INVITATION_CONFLICTS;

export class InvitationConflictError extends DomainError {
  constructor(code: InvitationConflictCode) { super(code, 409, INVITATION_CONFLICTS[code]); }
}

/**
 * Domain errors pass through. The open-invitation unique index and the invited-company foreign key become domain errors; anything else
 * keeps its classification (an unknown outcome is preserved and never retried: no rollback is assumed).
 */
export function translateInvitationWriteError(error: unknown, operation: 'insert' | 'update' = 'insert'): unknown {
  if (error instanceof DomainError) return error;
  const failure = error instanceof DatabaseOperationError ? error.failure : classifyDatabaseError(error);
  if (!failure) return error;
  if (failure.category === 'unique_violation' && failure.constraint === 'UQ_invitations_open_email') return new InvitationConflictError('invitation_pending_exists');
  if (failure.category === 'foreign_key' && failure.constraint === 'FK_invitation_companies_company') return new InvalidInputError('Datos de entrada inválidos.', 'companyIds');
  return new DatabaseOperationError(failure, createOperationContext({ operation, table: 'invitations', atomic: true, valuesOrigin: 'request' }));
}
