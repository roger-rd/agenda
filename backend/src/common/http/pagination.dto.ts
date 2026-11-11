import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
export class PaginationQueryDto {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
