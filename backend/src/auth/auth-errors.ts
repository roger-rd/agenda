import { DomainError } from '../common/errors/domain-error';
import { classifyDatabaseError, createOperationContext } from '../database/errors/database-failure';
import { DatabaseOperationError } from '../database/errors/database-operation-error';

const context = createOperationContext({ operation: 'insert', atomic: true, valuesOrigin: 'system' });

export function translateAuthPersistenceError(error: unknown): unknown {
  if (error instanceof DomainError) return error;
  const failure = error instanceof DatabaseOperationError ? error.failure : classifyDatabaseError(error);
  return failure ? new DatabaseOperationError(failure, context) : error;
}
