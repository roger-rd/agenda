import { IsString, MaxLength } from 'class-validator';

/**
 * Shape only: the token travels in the body, never in the URL. A well-formed request with a token that is not canonical is not an HTTP
 * error: it simply is `unavailable`. Wrong JSON, wrong types, a token over 128 characters or unknown properties keep the usual 400.
 */
export class InspectInvitationDto {
  @IsString()
  @MaxLength(128)
  token!: string;
}
