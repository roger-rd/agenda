import { inspectable, own, resolveDescriptor } from '../../logging/error-sanitizer';
import { ConstraintRegistry } from '../../database/errors/constraint-registry';
import { classifyDatabaseError, DatabaseFailure, isOperationContext } from '../../database/errors/database-failure';
import { DatabaseOperationError } from '../../database/errors/database-operation-error';
import { mapDatabaseFailure, MappedFailure } from '../../database/errors/database-http';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Optional } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { IdGenerator } from '../ids/id-generator';
import { requestId } from '../../logging/logger-options';
import { DomainError, OutcomeUnknownError, ServiceUnavailableError } from './domain-error';
import { mappedError } from './error-codes';
import { ErrorResponse } from './error-response';

// Respeta el primer descriptor: un accesor no permite buscar datos más arriba.
function dataProperty(obj: unknown, key: PropertyKey): unknown {
  const descriptor = resolveDescriptor(obj, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logged = new WeakSet<object>();
  constructor(private readonly logger: PinoLogger, private readonly ids: IdGenerator, @Optional() private readonly registry?: ConstraintRegistry) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const id = typeof req.id === 'string' ? req.id : requestId(req.headers['x-request-id'], this.ids);
    const canInspect = exception !== null && typeof exception === 'object' && inspectable(exception);
    const rawMethod = own(req, 'method');
    const method = typeof rawMethod === 'string' && /^[A-Z]{3,10}$(?![\s\S])/.test(rawMethod) ? rawMethod : 'POST';
    let failure: DatabaseFailure | undefined;
    let context: unknown;
    let mapped: MappedFailure;
    if (canInspect && exception instanceof DomainError) {
      mapped = { status: own(exception, 'httpStatus') as number, code: own(exception, 'code') as string,
        message: own(exception, 'message') as string, field: own(exception, 'field') as string | undefined, event: '', level: 'error' };
      if (exception instanceof ServiceUnavailableError) mapped.retryAfterSeconds = own(exception, 'retryAfterSeconds') as number | undefined;
      if (exception instanceof OutcomeUnknownError) mapped.noStore = true;
    } else {
      if (canInspect && exception instanceof DatabaseOperationError) {
        failure = own(exception, 'failure') as DatabaseFailure;
        context = own(exception, 'context');
      } else failure = classifyDatabaseError(exception);
      mapped = failure ? mapDatabaseFailure(failure, { method, registry: this.registry ?? new ConstraintRegistry(), context })
        : { ...mappedError(this.statusOf(exception)), event: '', level: 'error' };
    }
    const body: ErrorResponse = { error: {
      code: mapped.code, message: mapped.message,
      ...('field' in mapped && mapped.field !== undefined ? { field: mapped.field } : {}), requestId: id,
    } };
    const object = exception !== null && (typeof exception === 'object' || typeof exception === 'function');
    if (!object || !this.logged.has(exception)) {
      if (object) this.logged.add(exception);
      const log = req.log ?? this.logger.logger;
      const data = { requestId: id, code: mapped.code, status: mapped.status };
      if (failure) {
        const metadata: Record<string, unknown> = { ...data, event: mapped.event, category: failure.category, outcome: failure.outcome, method };
        for (const key of ['sqlState', 'constraint', 'table', 'column', 'verb'] as const) if (failure[key] !== undefined) metadata[key] = failure[key];
        if (isOperationContext(context)) for (const key of ['valuesOrigin', 'operation', 'atomic'] as const) if (context[key] !== undefined) metadata[key] = context[key];
        if (mapped.tenantBoundary !== undefined) metadata.tenantBoundary = mapped.tenantBoundary;
        const messages: Record<string, string> = {
          database_transient: 'Fallo temporal de base de datos.', unique_violation: 'Conflicto de unicidad.',
          reference_violation: 'Referencia no disponible.', in_use: 'Elemento en uso.', fk_ambiguous: 'Conflicto de referencia ambiguo.',
          fk_context_mismatch: 'Contexto de referencia incoherente.', data_validation_gap: 'Fallo de validación de datos.',
          not_found: 'Recurso no encontrado.', optimistic_lock: 'Conflicto de versión.', database_internal: 'Error interno de base de datos.',
        };
        log[mapped.level]({ ...metadata, ...(mapped.level === 'error' ? { err: exception } : {}) }, messages[mapped.event] ?? 'Conflicto de integridad de datos.');
      } else if (mapped.status >= 500) log.error({ ...data, err: exception }, 'Error de solicitud.');
      else if (mapped.status === 404) log.info(data, 'Recurso no encontrado.');
      else log.warn(data, 'Solicitud rechazada.');
    }
    if (res.headersSent) { res.end(); return; }
    res.setHeader('X-Request-Id', id);
    if (mapped.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    if (mapped.noStore) res.setHeader('Cache-Control', 'no-store');
    res.status(mapped.status).json(body);
  }

  private statusOf(exception: unknown): number {
    if (!exception || typeof exception !== 'object' || !inspectable(exception)) return 500;
    if (exception instanceof HttpException) {
      const status = dataProperty(exception, 'status');
      return typeof status === 'number' ? status : 500;
    }
    if (dataProperty(exception, 'expose') === true) {
      const status = dataProperty(exception, 'status') ?? dataProperty(exception, 'statusCode');
      if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500) return status;
    }
    return 500;
  }
}
