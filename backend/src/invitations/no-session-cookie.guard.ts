import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { sessionCookieConfig } from '../common/http/cookies';
import { AppConfigService } from '../config/app-config.service';
import { acceptanceCookieGateFromHeader } from './invitation-acceptance';

/**
 * Only for the acceptance: ANY session cookie present (valid, invalid, empty or duplicated) is 409 session_active. As a guard it runs
 * after Origin and the JSON content type and BEFORE the validation pipe, the hashing and the service. It never sets, clears or revokes
 * anything: the person logs out first (GET /auth/session then POST /auth/logout, or logout alone for a cookie that is not usable).
 */
@Injectable()
export class NoSessionCookieGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const gate = acceptanceCookieGateFromHeader(request.headers.cookie, sessionCookieConfig(this.config.env).name);
    if (!gate.proceed) throw gate.error;
    return true;
  }
}
