import { IsIn, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../common/http/pagination.dto';
import { INVITATION_STATUSES, type InvitationStatus } from './invitation-constants';

export class ListInvitationsQuery extends PaginationQueryDto {
  /** Absent means every status; `null` and any value outside the closed set are rejected. */
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(INVITATION_STATUSES)
  status?: InvitationStatus;
}
