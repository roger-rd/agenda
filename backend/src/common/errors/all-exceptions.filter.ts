import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { IdGenerator } from '../ids/id-generator';
import { requestId } from '../../logging/logger-options';
import { DomainError } from './domain-error';
import { mappedError } from './error-codes';
import { ErrorResponse } from './error-response';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logged = new WeakSet<object>();
  constructor(private readonly logger: PinoLogger, private readonly ids: IdGenerator) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const id = typeof req.id === 'string' ? req.id : requestId(req.headers['x-request-id'], this.ids);
    const mapped = exception instanceof DomainError
      ? { status: exception.httpStatus, code: exception.code, message: exception.message, field: exception.field }
      : mappedError(this.statusOf(exception));
    const body: ErrorResponse = { error: {
      code: mapped.code, message: mapped.message,
      ...('field' in mapped && mapped.field !== undefined ? { field: mapped.field } : {}), requestId: id,
    } };
    const object = exception !== null && (typeof exception === 'object' || typeof exception === 'function');
    if (!object || !this.logged.has(exception)) {
      if (object) this.logged.add(exception);
      const log = req.log ?? this.logger.logger;
      const data = { requestId: id, code: mapped.code, status: mapped.status };
      if (mapped.status >= 500) log.error({ ...data, err: exception }, 'Error de solicitud.');
      else if (mapped.status === 404) log.info(data, 'Recurso no encontrado.');
      else log.warn(data, 'Solicitud rechazada.');
    }
    if (res.headersSent) { res.end(); return; }
    res.setHeader('X-Request-Id', id);
    res.status(mapped.status).json(body);
  }

  private statusOf(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    if (exception && typeof exception === 'object' && 'expose' in exception && exception.expose === true) {
      const value = exception as { status?: unknown; statusCode?: unknown };
      const status = value.status ?? value.statusCode;
      if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500) return status;
    }
    return 500;
  }
}
