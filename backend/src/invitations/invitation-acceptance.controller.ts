import { Body, Controller, HttpCode, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { InvalidInputError } from '../common/errors/domain-error';
import { JsonBody } from '../common/http/content-type';
import { serializeSessionCookie, sessionCookieConfig } from '../common/http/cookies';
import { OriginProtected } from '../common/http/origin.guard';
import { AppConfigService } from '../config/app-config.service';
import { AcceptInvitationDto } from './accept-invitation.dto';
import { InspectInvitationDto } from './inspect-invitation.dto';
import type { AcceptanceResponse, InspectionView } from './invitation-acceptance';
import { InvitationAcceptanceService } from './invitation-acceptance.service';
import { NoSessionCookieGuard } from './no-session-cookie.guard';

/**
 * Public routes (no session, no role) under the same prefix as the management ones. Origin protected, JSON only, and covered by the
 * `Cache-Control: no-store` of the whole prefix, errors included. The token travels only in the body. Responses are projected field by
 * field here: nothing a service returns reaches the client unless it is listed.
 */
@Controller('invitations')
@OriginProtected()
export class InvitationAcceptanceController {
  constructor(private readonly acceptance: InvitationAcceptanceService, private readonly config: AppConfigService) {}

  @Post('inspect')
  @JsonBody()
  @HttpCode(200)
  async inspect(@Body() dto: InspectInvitationDto, @Query() query: Record<string, unknown>) {
    noQuery(query);
    return publicInspection(await this.acceptance.inspect({ token: dto.token }));
  }

  @Post('accept')
  @JsonBody()
  @HttpCode(201)
  @UseGuards(NoSessionCookieGuard)
  async accept(@Body() dto: AcceptInvitationDto, @Query() query: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    noQuery(query);
    const result = await this.acceptance.accept({ token: dto.token, name: dto.name, password: dto.password });
    // Only reached when the transaction committed: any error above propagates without a cookie. The session token lives only here.
    res.setHeader('Set-Cookie', serializeSessionCookie(sessionCookieConfig(this.config.env), result.sessionToken, result.maxAgeSeconds));
    return publicAcceptance(result.body);
  }
}

export function publicAcceptance(body: AcceptanceResponse): AcceptanceResponse {
  return {
    user: { id: body.user.id, email: body.user.email, name: body.user.name },
    organization: { id: body.organization.id, name: body.organization.name },
    membership: { id: body.membership.id, role: body.membership.role },
    csrfToken: body.csrfToken,
    expiresAt: body.expiresAt,
  };
}

export function publicInspection(view: InspectionView): InspectionView {
  if (view.status !== 'open') return { status: view.status };
  return {
    status: 'open', organization: { name: view.organization.name }, role: view.role,
    companies: view.companies.map(company => ({ name: company.name })), email: view.email, expiresAt: view.expiresAt,
  };
}

function noQuery(query: Record<string, unknown>): void {
  if (Object.keys(query).length) throw new InvalidInputError('Datos de entrada inválidos.');
}
