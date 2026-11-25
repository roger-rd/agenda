import { IsString, MaxLength } from 'class-validator';

/**
 * Acceptance with a new account. Same limits as registration. There is no email property: the address comes from the invitation, so a
 * client that sends one gets the usual 400 for an unknown property.
 */
export class AcceptInvitationDto {
  @IsString()
  @MaxLength(128)
  token!: string;

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(1024)
  password!: string;
}
