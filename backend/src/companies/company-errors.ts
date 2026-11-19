import { ConflictError, DomainError } from '../common/errors/domain-error';
import { classifyDatabaseError, createOperationContext } from '../database/errors/database-failure';
import { DatabaseOperationError } from '../database/errors/database-operation-error';

export function translateCompanyWriteError(error: unknown, operation: 'insert' | 'update' = 'insert'): unknown {
  if (error instanceof DomainError) return error;
  const failure = error instanceof DatabaseOperationError ? error.failure : classifyDatabaseError(error);
  if (!failure) return error;
  if (failure.category === 'unique_violation' && failure.constraint === 'UQ_companies_org_name_key') {
    return new ConflictError('El nombre de empresa ya está registrado.', 'name');
  }
  // El resultado incierto se conserva y no se reintenta: no se supone un rollback.
  return new DatabaseOperationError(failure, createOperationContext({ operation, atomic: true, valuesOrigin: 'request' }));
}
