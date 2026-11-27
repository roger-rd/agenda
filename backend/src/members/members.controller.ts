import { Body, Controller, Get, HttpCode, Param, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentSession, CurrentSessionValue } from '../auth/current-session.decorator';
import { RequireRole } from '../auth/require-role';
import { RoleGuard } from '../auth/role.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { InvalidInputError } from '../common/errors/domain-error';
import { JsonBody } from '../common/http/content-type';
import { OriginProtected } from '../common/http/origin.guard';
import { ListMembersQuery } from './list-members.query';
import type { AccessUpdateResult, MemberView } from './member-contracts';
import { MembersService } from './members.service';
import { membersScope } from './members-scope';
import { UpdateAccessesDto } from './update-accesses.dto';

/**
 * Order of controls (global guards first): Origin and JSON content type, then the session (cookie, CSRF on the write, authentication)
 * and the role. Both routes require the community manager and the organization comes from the session. `Cache-Control: no-store` for
 * the whole prefix, errors included, is set before routing in configureHttpApp. Responses are projected field by field.
 */
@Controller('members')
@OriginProtected()
@UseGuards(SessionAuthGuard, RoleGuard)
@RequireRole('community_manager')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  async list(@CurrentSession() current: CurrentSessionValue, @Query() query: ListMembersQuery) {
    const page = await this.members.list(membersScope(current.session), query);
    return { items: page.items.map(publicMember), nextCursor: page.nextCursor };
  }

  @Put(':id/accesses')
  @JsonBody()
  @HttpCode(200)
  async updateAccesses(@CurrentSession() current: CurrentSessionValue, @Param('id') id: string, @Body() dto: UpdateAccessesDto,
    @Query() query: Record<string, unknown>) {
    if (Object.keys(query).length) throw new InvalidInputError('Datos de entrada inválidos.');
    return publicAccessUpdate(await this.members.updateAccesses(membersScope(current.session), id, dto));
  }
}

export function publicMember(member: MemberView): MemberView {
  return {
    id: member.id, user: { name: member.user.name, email: member.user.email }, role: member.role, status: member.status, version: member.version,
    companyAccess: member.companyAccess, companyIds: [...member.companyIds], createdAt: member.createdAt,
  };
}
export function publicAccessUpdate(result: AccessUpdateResult): AccessUpdateResult {
  return { id: result.id, role: result.role, version: result.version, companyIds: [...result.companyIds] };
}
