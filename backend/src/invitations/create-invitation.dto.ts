import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsString, MaxLength, ValidateIf } from 'class-validator';
import { DEFAULT_INVITATION_VALIDITY_DAYS, INVITATION_MAX_COMPANIES, INVITATION_MIN_COMPANIES, INVITATION_ROLES, INVITATION_VALIDITY_DAYS, type InvitationRole, type InvitationValidityDays } from './invitation-constants';

/**
 * Shape only. Email normalization, canonical UUIDv7 ids and uniqueness live in invitation-input.ts and are applied by the
 * service, so a rule is written once. The global pipe forbids unknown fields.
 */
export class CreateInvitationDto {
  @IsString()
  @MaxLength(200)
  email!: string;

  @IsIn(INVITATION_ROLES)
  role!: InvitationRole;

  @IsArray()
  @ArrayMinSize(INVITATION_MIN_COMPANIES)
  @ArrayMaxSize(INVITATION_MAX_COMPANIES)
  @IsString({ each: true })
  @MaxLength(36, { each: true })
  companyIds!: string[];

  /** Absent means 7 days. `null` and any other value are rejected. */
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(INVITATION_VALIDITY_DAYS)
  validityDays: InvitationValidityDays = DEFAULT_INVITATION_VALIDITY_DAYS;
}
