import 'reflect-metadata';
import { ArgumentsHost, HttpException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError, UnauthenticatedError } from './domain-error';
import { Uuid7Generator, isUuidV7 } from '../ids/uuid7-generator';

function invoke(error: unknown) {
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  const response = { headersSent: false, setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
  const host = { switchToHttp: () => ({ getRequest: () => ({ headers: {} }), getResponse: () => response }) } as ArgumentsHost;
  new AllExceptionsFilter({ logger } as unknown as PinoLogger, new Uuid7Generator()).catch(error, host);
  return { logger, response, body: response.json.mock.calls[0][0] as { error: { code: string; message: string; requestId: string; field?: string } } };
}

describe('Contrato del filtro sin sockets', () => {
  it.each([
    [new InvalidInputError('Entrada incorrecta.', 'title'), 400, 'invalid_input'],
    [new NotFoundError(), 404, 'not_found'], [new ForbiddenError(), 403, 'forbidden'],
    [new ConflictError(), 409, 'conflict'], [new UnauthenticatedError(), 401, 'unauthenticated'],
  ] as const)('respeta DomainError %s', (error, status, code) => {
    const { response, body } = invoke(error);
    expect(response.status).toHaveBeenCalledWith(status);
    expect(body.error.code).toBe(code);
    expect(body.error.message).toBe(error.message);
    expect(body.error.field).toBe(error.field);
  });
  it.each([
    [400, 'invalid_input'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'],
    [405, 'method_not_allowed'], [409, 'conflict'], [413, 'payload_too_large'], [415, 'unsupported_media_type'],
    [418, 'request_error'], [422, 'invalid_input'], [429, 'rate_limited'], [503, 'service_unavailable'],
  ] as const)('mapea HTTP %i', (status, code) => {
    const { response, body, logger } = invoke(new HttpException('secreto /Users/x', status));
    expect(response.status).toHaveBeenCalledWith(status);
    expect(body.error.code).toBe(code);
    expect(JSON.stringify(body)).not.toMatch(/secreto|Users/);
    expect(isUuidV7(body.error.requestId)).toBe(true);
    expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', body.error.requestId);
    if (status < 500) {
      expect(logger.error).not.toHaveBeenCalled();
      const log = status === 404 ? logger.info : logger.warn;
      expect(log.mock.calls[0][0]).not.toHaveProperty('err');
    }
  });
  it.each([new Error('password=hunter2 /Users/x'), new TypeError('secret'), 'texto', { secret: 'x' }, null, undefined, new HttpException('secret', 502), { status: 403, expose: false }])('protege errores inesperados %p', error => {
    const { response, body, logger } = invoke(error);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(body).toEqual({ error: { code: 'internal_error', message: 'Error interno del servidor.', requestId: expect.any(String) } });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
  it.each([{ status: 400, expose: true }, { statusCode: 413, expose: true }])('acepta middleware expuesto %p', error => {
    const { response } = invoke(error);
    expect(response.status).toHaveBeenCalledWith('status' in error ? error.status : error.statusCode);
  });
});
