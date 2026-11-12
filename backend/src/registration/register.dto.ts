import { IsString, MaxLength } from 'class-validator';

export class RegisterRequestDto {
  @IsString()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MaxLength(1024)
  password!: string;

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(200)
  organizationName!: string;
}
