import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '../common/errors/domain-error';
import { RequireRole } from './require-role';
import { RoleGuard } from './role.guard';

class Routes {
  @RequireRole('community_manager') protected() {}
  @RequireRole('worker', 'client') multiple() {}
  @RequireRole() empty() {}
  unmarked() {}
}
@RequireRole('community_manager')
class ProtectedRoutes {
  route() {}
  @RequireRole('worker') override() {}
}
const session = (role = 'community_manager') => ({ organization: { id: 'o1' }, membership: { id: 'm1', role } });
function context(target: typeof Routes | typeof ProtectedRoutes, handler: () => void, value: unknown) {
  return { getClass: () => target, getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ currentSession: value }) }) } as unknown as ExecutionContext;
}
const guard = new RoleGuard(new Reflector());
describe.each([[Routes, Routes.prototype.protected], [ProtectedRoutes, ProtectedRoutes.prototype.route]] as const)('roles en handler o clase %p', (target, handler) => {
  it('permite el rol requerido', () => {
    expect(guard.canActivate(context(target, handler, { session: session() }))).toBe(true);
  });
  it.each([undefined, {}, { session: null }, { session: { ...session(), organization: null } },
    { session: { ...session(), membership: null } }, { session: session('worker') }, { session: session('client') }])('falla cerrado con 403 para %p', value => {
    const run = () => guard.canActivate(context(target, handler, value));
    expect(run).toThrow(new ForbiddenError('Acceso denegado.'));
    try { run(); } catch (error) { expect(error).toMatchObject({ httpStatus: 403 }); }
  });
});
it('sin metadatos pasa sin consultar la sesión', () => {
  const execution = context(Routes, Routes.prototype.unmarked, undefined);
  execution.switchToHttp = jest.fn(() => { throw new Error('No debe consultar la sesión.'); });
  expect(guard.canActivate(execution)).toBe(true);
  expect(execution.switchToHttp).not.toHaveBeenCalled();
});
it.each(['worker', 'client'])('acepta varios roles: %s', role => {
  expect(guard.canActivate(context(Routes, Routes.prototype.multiple, { session: session(role) }))).toBe(true);
});
it('el handler sustituye los roles de clase', () => {
  expect(guard.canActivate(context(ProtectedRoutes, ProtectedRoutes.prototype.override, { session: session('worker') }))).toBe(true);
  expect(() => guard.canActivate(context(ProtectedRoutes, ProtectedRoutes.prototype.override, { session: session() }))).toThrow(ForbiddenError);
});
it('una marca sin roles deniega el acceso', () => {
  expect(() => guard.canActivate(context(Routes, Routes.prototype.empty, { session: session() }))).toThrow(ForbiddenError);
});
