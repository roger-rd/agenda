import { IsIn, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../common/http/pagination.dto';
import { DEFAULT_MEMBER_STATUS, MEMBER_ROLES, MEMBER_STATUS_FILTERS, type MemberRole, type MemberStatusFilter } from './member-constants';

/** limit 20 (1 to 100) and cursor from the shared pagination; role absent means every role; status defaults to active. */
export class ListMembersQuery extends PaginationQueryDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(MEMBER_ROLES)
  role?: MemberRole;

  @ValidateIf((_, value) => value !== undefined)
  @IsIn(MEMBER_STATUS_FILTERS)
  status: MemberStatusFilter = DEFAULT_MEMBER_STATUS;
}
