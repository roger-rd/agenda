import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { ForbiddenError, UnauthenticatedError } from '../common/errors/domain-error';
import { readSessionCookie, serializeClearedSessionCookie, sessionCookieConfig } from '../common/http/cookies';
import { verifyCsrfToken } from '../identity/session-token';
import { SessionService } from './session.service';
import type { SessionRequest } from './current-session.decorator';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly config: AppConfigService, private readonly sessions: SessionService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<SessionRequest>();
    const res = http.getResponse<Response>();
    const config = sessionCookieConfig(this.config.env);
    const cookie = readSessionCookie(req.headers.cookie, config.name);
    if (cookie.status !== 'ok') {
      if (cookie.status !== 'absent') res.setHeader('Set-Cookie', serializeClearedSessionCookie(config));
      throw new UnauthenticatedError('Autenticación requerida.');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !verifyCsrfToken(cookie.token, req.headers['x-csrf-token'])) {
      throw new ForbiddenError('Acceso denegado.');
    }
    const session = await this.sessions.authenticate(cookie.token);
    if (!session) {
      res.setHeader('Set-Cookie', serializeClearedSessionCookie(config));
      throw new UnauthenticatedError('Autenticación requerida.');
    }
    req.currentSession = { token: cookie.token, session };
    return true;
  }
}
