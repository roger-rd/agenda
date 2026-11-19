import { IsInt, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export class UpdateCompanyDto {
  @IsInt()
  @Min(1)
  @Max(2147483647)
  version!: number;

  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @MaxLength(200)
  name?: string;

  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @MaxLength(20)
  color?: string;
}
