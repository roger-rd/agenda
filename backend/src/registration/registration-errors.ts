import { ConflictError } from '../common/errors/domain-error';
import { classifyDatabaseError, createOperationContext } from '../database/errors/database-failure';
import { DatabaseOperationError } from '../database/errors/database-operation-error';

const context = createOperationContext({ operation: 'insert', atomic: true, valuesOrigin: 'request' });

/** Traducción local al registro: no modifica el registro global de constraints. */
export function translateRegistrationError(error: unknown): unknown {
  const failure = error instanceof DatabaseOperationError ? error.failure : classifyDatabaseError(error);
  if (!failure) return error;
  if (failure.category === 'unique_violation') {
    if (failure.constraint === 'UQ_users_email') return new ConflictError('El email ya está registrado.', 'email');
    if (failure.constraint === 'UQ_organizations_name_key') return new ConflictError('El nombre de organización ya está registrado.', 'organizationName');
  }
  // Si falla la confirmación con resultado incierto, classifyDatabaseError conserva
  // outcome 'unknown'; mapDatabaseFailure responde 503 outcome_unknown incluso con
  // atomic:true. El servicio no reintenta ni supone que hubo rollback.
  return new DatabaseOperationError(failure, context);
}
