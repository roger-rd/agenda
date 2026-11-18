import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Clock } from '../common/clock/clock';
import type { Response } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { ForbiddenError, UnauthenticatedError } from '../common/errors/domain-error';
import { readSessionCookie, serializeClearedSessionCookie, serializeSessionCookie, sessionCookieConfig } from '../common/http/cookies';
import { verifyCsrfToken } from '../identity/session-token';
import { SessionService } from './session.service';
import type { SessionRequest } from './current-session.decorator';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly config: AppConfigService, private readonly sessions: SessionService,
    private readonly clock: Clock) {}
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
    if (session.renewed) {
      const maxAge = Math.max(1, Math.min(2678400, Math.floor((session.expiresAt.getTime() - this.clock.now().getTime()) / 1000)));
      res.setHeader('Set-Cookie', serializeSessionCookie(config, cookie.token, maxAge));
    }
    req.currentSession = { token: cookie.token, session };
    return true;
  }
}
