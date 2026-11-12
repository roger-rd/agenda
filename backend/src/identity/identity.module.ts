import { Module } from '@nestjs/common';
import { Argon2idPasswordHasher, PasswordHasher } from './password-hasher';
import { LimitedPasswordHasher } from './limited-password-hasher';

@Module({
  providers: [{ provide: PasswordHasher, useFactory: () => new LimitedPasswordHasher(new Argon2idPasswordHasher()) }],
  exports: [PasswordHasher],
})
export class IdentityModule {}
