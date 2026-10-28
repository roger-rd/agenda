import { classifyDatabaseError, DatabaseFailure, isOperationContext, OperationContext } from './database-failure';
export class DatabaseOperationError extends Error {
  readonly failure: DatabaseFailure;
  readonly context?: OperationContext;
  constructor(failure: DatabaseFailure, context?: unknown) {
    super('Error de operación de base de datos.');
    this.name = 'DatabaseOperationError';
    this.failure = Object.freeze({ ...failure });
    if (isOperationContext(context)) this.context = context;
  }
  toJSON(): object { return { name: 'DatabaseOperationError', message: 'Error de operación de base de datos.' }; }
}
export function wrapDatabaseError(error: unknown, context?: unknown): unknown {
  try { const failure = classifyDatabaseError(error); return failure ? new DatabaseOperationError(failure, context) : error; }
  catch { return error; }
}
