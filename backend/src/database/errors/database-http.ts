import { mappedError } from '../../common/errors/error-codes';
import { ConstraintRegistry } from './constraint-registry';
import { DatabaseFailure, isOperationContext } from './database-failure';
export const GENERIC_INVALID = 'Alguno de los datos enviados no es válido.';
export const REFERENCE_INVALID = 'La referencia indicada no existe o no está disponible.';
export const IN_USE = 'No se puede completar la operación porque el elemento está en uso.';
export const NEUTRAL_CONFLICT = 'La operación no se pudo completar por el estado actual de los datos.';
export const STALE = 'Los datos cambiaron mientras los editabas. Actualiza e inténtalo de nuevo.';
export const UNAVAILABLE = 'Servicio no disponible temporalmente. Inténtalo de nuevo en unos segundos.';
export const OUTCOME_UNKNOWN = 'No fue posible confirmar si la operación se completó. Verifica el estado antes de repetirla.';
export interface MappedFailure { status: number; code: string; message: string; field?: string; retryAfterSeconds?: number; noStore?: boolean; event: string; level: 'info' | 'warn' | 'error'; tenantBoundary?: boolean }
export function mapDatabaseFailure(failure: DatabaseFailure, input: { method: string; registry: ConstraintRegistry; context?: unknown }): MappedFailure {
  const context = isOperationContext(input.context) ? input.context : undefined;
  const registry = input.registry;
  const generic = (status: number, event: string, level: MappedFailure['level']): MappedFailure => ({ ...mappedError(status), event, level });
  const internal = (event = 'database_internal') => generic(500, event, 'error');
  const invalid = (): MappedFailure => ({ status: 400, code: 'invalid_input', message: GENERIC_INVALID, event: 'data_validation_gap', level: 'warn' });
  switch (failure.category) {
    case 'transaction_conflict': case 'lock_timeout': case 'statement_timeout': case 'connection': case 'resource': {
      const repeatable = ['GET', 'HEAD', 'OPTIONS'].includes(input.method) || (context?.atomic === true && failure.outcome !== 'unknown');
      return { status: 503, code: repeatable ? 'service_unavailable' : 'outcome_unknown', message: repeatable ? UNAVAILABLE : OUTCOME_UNKNOWN,
        ...(repeatable ? { retryAfterSeconds: failure.category === 'transaction_conflict' || failure.category === 'lock_timeout' ? 1 : failure.category === 'statement_timeout' ? 2 : 5 } : { noStore: true }), event: 'database_transient', level: 'warn' };
    }
    case 'unique_violation': {
      const e = registry.unique(failure.constraint);
      return { ...generic(409, 'unique_violation', 'warn'), ...(e ? { code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) } : {}) };
    }
    case 'exclusion_violation': case 'integrity_other': return generic(409, failure.category, 'warn');
    case 'not_null': case 'check_violation': {
      const e = failure.category === 'not_null' ? registry.notNull(failure.table, failure.column) : registry.check(failure.constraint);
      if (e) return e.origin === 'internal' ? internal('data_validation_gap') : { ...invalid(), code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) };
      return context?.valuesOrigin === 'request' ? invalid() : internal('data_validation_gap');
    }
    case 'data_exception': return context?.valuesOrigin === 'derived' || context?.valuesOrigin === 'system' ? internal('data_validation_gap') : invalid();
    case 'foreign_key': {
      const e = registry.foreignKey(failure.constraint);
      let side: 'child' | 'parent' | 'ambiguous' | 'mismatch' = 'ambiguous';
      if (context) {
        if (context.operation === 'insert') side = 'child';
        else if (context.operation === 'delete') side = 'parent';
        else if (context.operation === 'update' && e && e.childTable !== e.parentTable) side = context.table === e.childTable ? 'child' : context.table === e.parentTable ? 'parent' : 'ambiguous';
        if (failure.verb && failure.verb !== 'OTHER' && !(context.operation === 'select' ? ['SELECT', 'WITH'].includes(failure.verb) : failure.verb === context.operation.toUpperCase())) side = 'mismatch';
      } else if (failure.verb === 'INSERT') side = 'child';
      else if (failure.verb === 'DELETE') side = 'parent';
      if (side === 'child') return { ...(e?.referenceIn === 'path' ? mappedError(404) : { status: 400, code: 'invalid_input', message: e?.writeMessage ?? REFERENCE_INVALID, ...(e?.field ? { field: e.field } : {}) }), event: 'reference_violation', level: 'warn', tenantBoundary: e?.tenantBoundary === true };
      if (side === 'parent') return { status: 409, code: e?.restrictCode ?? 'conflict', message: IN_USE, event: 'in_use', level: 'warn' };
      return { status: 409, code: 'conflict', message: NEUTRAL_CONFLICT, event: side === 'mismatch' ? 'fk_context_mismatch' : 'fk_ambiguous', level: 'warn' };
    }
    case 'not_found': return generic(404, 'not_found', 'info');
    case 'optimistic_lock': return { ...generic(409, 'optimistic_lock', 'warn'), message: STALE };
    default: return internal();
  }
}
