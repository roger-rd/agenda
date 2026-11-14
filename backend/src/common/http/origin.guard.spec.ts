import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfigService } from '../../config/app-config.service';
import { ForbiddenError } from '../errors/domain-error';
import { OriginGuard, OriginProtected } from './origin.guard';

class Routes {
  @OriginProtected() protected() { return true; }
  unmarked() { return true; }
}
@OriginProtected()
class ProtectedRoutes { route() { return true; } }

const targets = [
  [Routes, Routes.prototype.protected],
  [ProtectedRoutes, ProtectedRoutes.prototype.route],
] as const;
function context(target: typeof Routes | typeof ProtectedRoutes, handler: () => boolean, headers: object, warn = jest.fn()) {
  return { getClass: () => target, getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ headers, log: { warn } }) }) } as unknown as ExecutionContext;
}
const guard = () => new OriginGuard({ allowedOrigins: ['https://permitido.test'] } as unknown as AppConfigService, new Reflector());

it('una ruta sin marca pasa sin consultar la petición ni la configuración', () => {
  const switchToHttp = jest.fn(() => { throw new Error('no debe consultar HTTP'); });
  const config = { get allowedOrigins(): string[] { throw new Error('no debe consultar configuración'); } };
  const execution = { getClass: () => Routes, getHandler: () => Routes.prototype.unmarked, switchToHttp } as unknown as ExecutionContext;
  expect(new OriginGuard(config as unknown as AppConfigService, new Reflector()).canActivate(execution)).toBe(true);
  expect(switchToHttp).not.toHaveBeenCalled();
});

describe.each(targets)('marca en %p', (target, handler) => {
  it.each([
    [{ origin: 'https://permitido.test' }, true],
    [{ origin: 'https://otro.test' }, false],
    [{ origin: 'null' }, false],
    [{ 'sec-fetch-site': 'same-origin' }, true],
    [{ 'sec-fetch-site': 'cross-site' }, false],
    [{}, true],
  ])('aplica la política a %p', (headers, allowed) => {
    const execution = context(target, handler, headers);
    if (allowed) expect(guard().canActivate(execution)).toBe(true);
    else expect(() => guard().canActivate(execution)).toThrow(new ForbiddenError('Acceso denegado.'));
  });
});

it('registra únicamente el código de rechazo', () => {
  const warn = jest.fn();
  const execution = context(Routes, Routes.prototype.protected, { origin: 'https://secreto.test' }, warn);
  expect(() => guard().canActivate(execution)).toThrow(new ForbiddenError('Acceso denegado.'));
  expect(warn).toHaveBeenCalledWith({ reason: 'origin_not_allowed' });
});
