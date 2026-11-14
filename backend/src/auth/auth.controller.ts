import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Clock } from '../common/clock/clock';
import { ForbiddenError } from '../common/errors/domain-error';
import { JsonBody } from '../common/http/content-type';
import { readSessionCookie, serializeClearedSessionCookie, serializeSessionCookie, sessionCookieConfig } from '../common/http/cookies';
import { OriginProtected } from '../common/http/origin.guard';
import { AppConfigService } from '../config/app-config.service';
import { deriveCsrfToken, verifyCsrfToken } from '../identity/session-token';
import { AuthenticationService } from './authentication.service';
import { CurrentSession, CurrentSessionValue } from './current-session.decorator';
import { LoginRequestDto } from './login.dto';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionService } from './session.service';

@Controller('auth')
@OriginProtected()
export class AuthController {
  constructor(private readonly authentication: AuthenticationService, private readonly sessions: SessionService,
    private readonly config: AppConfigService, private readonly clock: Clock) {}

  @Post('login')
  @JsonBody()
  @HttpCode(200)
  async login(@Body() dto: LoginRequestDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const config = sessionCookieConfig(this.config.env);
    const cookie = readSessionCookie(req.headers.cookie, config.name);
    const result = await this.authentication.login({ email: dto.email, password: dto.password,
      presentedSessionToken: cookie.status === 'ok' ? cookie.token : undefined });
    res.setHeader('Set-Cookie', serializeSessionCookie(config, result.token, result.maxAgeSeconds));
    return { user: result.user, organization: result.organization, membership: result.membership,
      csrfToken: result.csrfToken, expiresAt: result.expiresAt.toISOString() };
  }

  @Get('session')
  @UseGuards(SessionAuthGuard)
  session(@CurrentSession() current: CurrentSessionValue, @Res({ passthrough: true }) res: Response) {
    const { token, session } = current;
    if (session.renewed) {
      const maxAge = Math.max(1, Math.min(2678400, Math.floor((session.expiresAt.getTime() - this.clock.now().getTime()) / 1000)));
      res.setHeader('Set-Cookie', serializeSessionCookie(sessionCookieConfig(this.config.env), token, maxAge));
    }
    return { user: session.user, organization: session.organization, membership: session.membership,
      csrfToken: deriveCsrfToken(token), expiresAt: session.expiresAt.toISOString() };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const config = sessionCookieConfig(this.config.env);
    const cookie = readSessionCookie(req.headers.cookie, config.name);
    if (cookie.status === 'ok') {
      if (!verifyCsrfToken(cookie.token, req.headers['x-csrf-token'])) throw new ForbiddenError('Acceso denegado.');
      await this.sessions.revoke(cookie.token);
    }
    res.setHeader('Set-Cookie', serializeClearedSessionCookie(config));
  }
}
