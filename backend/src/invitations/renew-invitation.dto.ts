import { IsIn, ValidateIf } from 'class-validator';
import { INVITATION_VALIDITY_DAYS, type InvitationValidityDays } from './invitation-constants';

/** The body is optional content: `{}` renews for the default 7 days. Unknown fields are rejected by the global pipe. */
export class RenewInvitationDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(INVITATION_VALIDITY_DAYS)
  validityDays?: InvitationValidityDays;
}
