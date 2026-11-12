import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import { JsonBody } from '../common/http/content-type';
import { RegisterRequestDto } from './register.dto';
import { RegistrationResult, RegistrationService } from './registration.service';

@Controller('auth')
export class RegistrationController {
  constructor(private readonly registration: RegistrationService) {}

  @Post('register')
  @JsonBody()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  register(@Body() dto: RegisterRequestDto): Promise<RegistrationResult> {
    return this.registration.register(dto);
  }
}
