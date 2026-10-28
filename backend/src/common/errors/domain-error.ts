import { OUTCOME_UNKNOWN, UNAVAILABLE } from '../../database/errors/database-http';
// Solo mensajes seguros para el cliente; nunca incluir detalles de infraestructura.
export abstract class DomainError extends Error {
  protected constructor(readonly code: string, readonly httpStatus: number, message: string, readonly field?: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class InvalidInputError extends DomainError {
  constructor(message = 'Datos de entrada inválidos.', field?: string) { super('invalid_input', 400, message, field); }
}
export class NotFoundError extends DomainError {
  constructor(message = 'Recurso no encontrado.') { super('not_found', 404, message); }
}
export class ForbiddenError extends DomainError {
  constructor(message = 'Acceso denegado.') { super('forbidden', 403, message); }
}
export class ConflictError extends DomainError {
  constructor(message = 'Conflicto con el estado del recurso.', field?: string) { super('conflict', 409, message, field); }
}
export class UnauthenticatedError extends DomainError {
  constructor(message = 'Autenticación requerida.') { super('unauthenticated', 401, message); }
}

export class ServiceUnavailableError extends DomainError {
  constructor(message = UNAVAILABLE, readonly retryAfterSeconds?: number) {
    super('service_unavailable', 503, message);
    if (retryAfterSeconds !== undefined && (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 60)) throw new Error('Intervalo de reintento inválido.');
  }
}
export class OutcomeUnknownError extends DomainError {
  constructor(message = OUTCOME_UNKNOWN) { super('outcome_unknown', 503, message); }
}
