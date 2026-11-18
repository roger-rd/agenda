import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '../common/errors/domain-error';
import type { SessionRequest } from './current-session.decorator';
import { REQUIRED_ROLES, type RequiredRole } from './require-role';

/** Usar después de SessionAuthGuard: primero autenticar, luego autorizar. */
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<RequiredRole[]>(REQUIRED_ROLES, [context.getHandler(), context.getClass()]);
    if (roles === undefined) return true;
    const session = context.switchToHttp().getRequest<SessionRequest>().currentSession?.session;
    if (!session?.organization || !session.membership || !roles.some(role => role === session.membership?.role)) {
      throw new ForbiddenError('Acceso denegado.');
    }
    return true;
  }
}
