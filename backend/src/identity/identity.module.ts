import { Module } from '@nestjs/common';
import { Argon2idPasswordHasher, PasswordHasher } from './password-hasher';

@Module({
  providers: [{ provide: PasswordHasher, useClass: Argon2idPasswordHasher }],
  exports: [PasswordHasher],
})
export class IdentityModule {}
