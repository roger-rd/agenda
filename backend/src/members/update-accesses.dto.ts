import { ArrayMaxSize, IsArray, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_VERSION, MEMBER_MAX_COMPANIES } from './member-constants';

/**
 * Shape only. `[]` is valid (it removes every access). Canonical ids and uniqueness are checked by normalizeAccessUpdate; the global
 * pipe rejects unknown fields.
 */
export class UpdateAccessesDto {
  @IsInt()
  @Min(1)
  @Max(MAX_VERSION)
  version!: number;

  @IsArray()
  @ArrayMaxSize(MEMBER_MAX_COMPANIES)
  @IsString({ each: true })
  @MaxLength(36, { each: true })
  companyIds!: string[];
}
