import { ExecutionContext, UnsupportedMediaTypeException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JsonBody, JsonBodyGuard } from './content-type';
class Routes {
  @JsonBody() json() { return true; }
  empty() { return true; }
}
it('solo exige JSON con metadata explícita de ruta', () => {
  const guard = new JsonBodyGuard(new Reflector());
  const context = (handler: () => boolean) => ({ getHandler: () => handler, getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ is: () => false }) }) }) as unknown as ExecutionContext;
  expect(guard.canActivate(context(Routes.prototype.empty))).toBe(true);
  expect(() => guard.canActivate(context(Routes.prototype.json))).toThrow(UnsupportedMediaTypeException);
});

import type { INestApplication } from '@nestjs/common';
import { configureHttpApp } from './configure-http-app';
import { setupHttpLogging } from '../../logging/setup-http-logging';
import { securityHeaders } from './security-headers';
jest.mock('../../logging/setup-http-logging', () => ({ setupHttpLogging: jest.fn().mockResolvedValue(undefined) }));
it('prefijo, seguridad, logging antes del parser y validación global', async () => {
  const disable = jest.fn();
  const setNotFoundHandler = jest.fn();
  const adapter = { getInstance: () => ({ disable }), setNotFoundHandler };
  const app = { setGlobalPrefix: jest.fn(), getHttpAdapter: () => adapter,
    use: jest.fn(), useGlobalPipes: jest.fn(), useGlobalGuards: jest.fn(), get: () => new Reflector() };
  await configureHttpApp(app as unknown as INestApplication);
  expect(app.setGlobalPrefix).toHaveBeenCalledWith('api/v1');
  // Nest entrega un proxy que ya contiene AllExceptionsFilter. No sustituirlo
  // ni registrar el catch-all antes de que Nest haya registrado las rutas.
  expect(setNotFoundHandler).not.toHaveBeenCalled();
  const proxy = jest.fn();
  app.getHttpAdapter().setNotFoundHandler(proxy, 'api/v1', []);
  expect(setNotFoundHandler).toHaveBeenCalledWith(proxy);
  expect(disable).toHaveBeenCalledWith('x-powered-by');
  expect(app.use).toHaveBeenNthCalledWith(1, securityHeaders);
  expect(jest.mocked(setupHttpLogging).mock.invocationCallOrder[0]).toBeLessThan(app.use.mock.invocationCallOrder[1]);
  expect(app.useGlobalPipes).toHaveBeenCalledTimes(1);
  expect(app.useGlobalGuards).toHaveBeenCalledTimes(1);
});
