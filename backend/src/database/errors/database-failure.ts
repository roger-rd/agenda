import { TypeORMError, EntityNotFoundError, OptimisticLockVersionMismatchError, CannotExecuteNotConnectedError, ConnectionIsNotSetError } from 'typeorm';
import { databaseVerb, extractDatabaseFields, inspectable, isDatabaseError, own } from '../../logging/error-sanitizer';
import { CONNECTION_CODES, CONNECTION_MESSAGES, sqlstateClass, TRANSACTION_CONFLICTS } from './sqlstate';

export type DatabaseOperation = 'insert' | 'update' | 'delete' | 'select';
export type ValuesOrigin = 'request' | 'derived' | 'system';
export interface OperationContext { readonly operation: DatabaseOperation; readonly table?: string; readonly valuesOrigin?: ValuesOrigin; readonly atomic?: boolean }
const contexts = new WeakSet<object>();
// Información interna: nunca construir a partir de req.body/query/params/headers.
export function createOperationContext(input: OperationContext): OperationContext {
  const operation = own(input, 'operation'), table = own(input, 'table'), valuesOrigin = own(input, 'valuesOrigin'), atomic = own(input, 'atomic');
  if (!['insert', 'update', 'delete', 'select'].includes(operation as string) ||
    (table !== undefined && (typeof table !== 'string' || !/^[a-z][a-z0-9_]{0,62}$(?![\s\S])/.test(table))) ||
    (valuesOrigin !== undefined && !['request', 'derived', 'system'].includes(valuesOrigin as string)) ||
    (atomic !== undefined && typeof atomic !== 'boolean')) throw new Error('Contexto de operación inválido.');
  const context = Object.freeze({ operation, ...(table !== undefined ? { table } : {}), ...(valuesOrigin !== undefined ? { valuesOrigin } : {}), ...(atomic !== undefined ? { atomic } : {}) }) as OperationContext;
  contexts.add(context); return context;
}
export function isOperationContext(value: unknown): value is OperationContext {
  return value !== null && typeof value === 'object' && contexts.has(value);
}
export type Outcome = 'not_started' | 'not_applied' | 'unknown';
export type FailureCategory = 'unique_violation' | 'foreign_key' | 'not_null' | 'check_violation' | 'exclusion_violation' | 'integrity_other' | 'data_exception' | 'transaction_conflict' | 'lock_timeout' | 'statement_timeout' | 'connection' | 'resource' | 'not_found' | 'optimistic_lock' | 'permission_misconfig' | 'programming' | 'internal' | 'unknown';
export interface DatabaseFailure { category: FailureCategory; outcome: Outcome; sqlState?: string; constraint?: string; table?: string; column?: string; verb?: ReturnType<typeof databaseVerb>; ormClass?: string; retryable: boolean }
function stateFailure(code?: string): Pick<DatabaseFailure, 'category' | 'outcome' | 'retryable'> {
  const cls = sqlstateClass(code);
  let category: FailureCategory = 'unknown', outcome: Outcome = 'unknown';
  if (cls === '23') { category = ({ '23505': 'unique_violation', '23503': 'foreign_key', '23502': 'not_null', '23514': 'check_violation', '23P01': 'exclusion_violation' } as Record<string, FailureCategory>)[code!] ?? 'integrity_other'; outcome = 'not_applied'; }
  else if (cls === '22') { category = 'data_exception'; outcome = 'not_applied'; }
  else if (TRANSACTION_CONFLICTS.some(c => c === code)) { category = 'transaction_conflict'; outcome = 'not_applied'; }
  else if (code === '55P03' || code === '57014') { category = code === '55P03' ? 'lock_timeout' : 'statement_timeout'; outcome = 'not_applied'; }
  else if (cls === '08' || ['40003', '57P01', '57P02', '57P03'].includes(code ?? '')) { category = 'connection'; outcome = ['08001', '08004', '57P03'].includes(code!) ? 'not_started' : 'unknown'; }
  else if (cls === '53') { category = 'resource'; outcome = code === '53300' ? 'not_started' : 'not_applied'; }
  else if (cls === '42' || cls === '25') { category = code === '42501' ? 'permission_misconfig' : 'programming'; outcome = 'not_applied'; }
  else if (code === '0A000' || cls === 'XX' || code === 'P0001' || cls === '58') category = 'internal';
  return { category, outcome, retryable: category === 'transaction_conflict' };
}
export function classifyDatabaseError(error: unknown): DatabaseFailure | undefined {
  try {
    if (!error || typeof error !== 'object' || !inspectable(error)) return undefined;
    if (isDatabaseError(error)) {
      const fields = extractDatabaseFields(error);
      const result: DatabaseFailure = stateFailure(fields.sqlState);
      for (const key of ['sqlState', 'constraint', 'table', 'column'] as const) if (fields[key] !== undefined) result[key] = fields[key];
      const verb = databaseVerb(error); if (verb) result.verb = verb;
      return Object.freeze(result);
    }
    if (error instanceof TypeORMError) {
      const name = own(own(Object.getPrototypeOf(error), 'constructor'), 'name');
      const ormClass = typeof name === 'string' && /^[A-Za-z0-9_$]{1,60}$(?![\s\S])/.test(name) ? name : 'TypeORMError';
      let category: FailureCategory = 'programming', outcome: Outcome = 'unknown';
      if (error instanceof EntityNotFoundError) { category = 'not_found'; outcome = 'not_applied'; }
      else if (error instanceof OptimisticLockVersionMismatchError) { category = 'optimistic_lock'; outcome = 'not_applied'; }
      else if (error instanceof CannotExecuteNotConnectedError || error instanceof ConnectionIsNotSetError) { category = 'connection'; outcome = 'not_started'; }
      return Object.freeze({ category, outcome, retryable: false, ormClass });
    }
    const systemCode = own(error, 'code');
    let outcome = (typeof systemCode === 'string' ? own(CONNECTION_CODES, systemCode) : undefined) as Outcome | undefined;
    const message = own(error, 'message');
    if (!outcome && typeof message === 'string') outcome = own(CONNECTION_MESSAGES, message) as Outcome | undefined;
    if (!outcome && error instanceof AggregateError) {
      const errors = own(error, 'errors');
      if (Array.isArray(errors) && inspectable(errors)) for (let i = 0; i < Math.min(own(errors, 'length') as number, 5); i++) {
        const code = own(own(errors, String(i)), 'code');
        if (typeof code === 'string') outcome = own(CONNECTION_CODES, code) as Outcome | undefined;
        if (outcome) break;
      }
    }
    return outcome ? Object.freeze({ category: 'connection', outcome, retryable: false }) : undefined;
  } catch { return undefined; }
}
