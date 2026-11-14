import { IsString, MaxLength } from 'class-validator';

export class LoginRequestDto {
  @IsString()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MaxLength(1024)
  password!: string;
}
