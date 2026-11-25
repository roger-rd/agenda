import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentSession, CurrentSessionValue } from '../auth/current-session.decorator';
import { RequireRole } from '../auth/require-role';
import { RoleGuard } from '../auth/role.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { InvalidInputError } from '../common/errors/domain-error';
import { JsonBody } from '../common/http/content-type';
import { OriginProtected } from '../common/http/origin.guard';
import { CreateInvitationDto } from './create-invitation.dto';
import { InvitationsService } from './invitations.service';
import { invitationsScope } from './invitations-scope';
import { ListInvitationsQuery } from './list-invitations.query';
import { RenewInvitationDto } from './renew-invitation.dto';

/**
 * Order of controls (global guards first): Origin, JSON content type (only where a body is read), then the session (cookie, CSRF on
 * writes, authentication) and finally the role. Every route, the list included, requires the community manager; the organization
 * comes from the session. `Cache-Control: no-store` for the whole prefix, errors included, is set before routing in configureHttpApp.
 */
@Controller('invitations')
@OriginProtected()
@UseGuards(SessionAuthGuard, RoleGuard)
@RequireRole('community_manager')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @JsonBody()
  @HttpCode(201)
  create(@CurrentSession() current: CurrentSessionValue, @Body() dto: CreateInvitationDto, @Query() query: Record<string, unknown>) {
    noQuery(query);
    return this.invitations.create(invitationsScope(current.session), dto);
  }

  @Get()
  list(@CurrentSession() current: CurrentSessionValue, @Query() query: ListInvitationsQuery) {
    return this.invitations.list(invitationsScope(current.session), query);
  }

  /** No body: revoking is idempotent and carries nothing to configure. */
  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@CurrentSession() current: CurrentSessionValue, @Param('id') id: string, @Query() query: Record<string, unknown>) {
    noQuery(query);
    return this.invitations.revoke(invitationsScope(current.session), id);
  }

  @Post(':id/renew')
  @JsonBody()
  @HttpCode(200)
  renew(@CurrentSession() current: CurrentSessionValue, @Param('id') id: string, @Body() dto: RenewInvitationDto, @Query() query: Record<string, unknown>) {
    noQuery(query);
    return this.invitations.renew(invitationsScope(current.session), id, dto.validityDays);
  }
}

function noQuery(query: Record<string, unknown>): void {
  if (Object.keys(query).length) throw new InvalidInputError('Datos de entrada inválidos.');
}
