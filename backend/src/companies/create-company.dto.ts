import { IsString, MaxLength } from 'class-validator';

export class CreateCompanyDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(20)
  color!: string;
}
