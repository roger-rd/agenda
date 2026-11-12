import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { IdentityModule } from './identity.module';
import { PasswordHasher } from './password-hasher';
import { LimitedPasswordHasher } from './limited-password-hasher';

@Module({ imports: [IdentityModule], providers: [{ provide: 'consumer', inject: [PasswordHasher], useFactory: (hasher: PasswordHasher) => hasher }] })
class ConsumerModule {}

it('exporta PasswordHasher para consumidores sin controladores ni sockets', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [ConsumerModule] }).compile();
  try {
    const hasher = moduleRef.get<PasswordHasher>('consumer');
    expect(hasher).toBeInstanceOf(LimitedPasswordHasher);
    expect(moduleRef.get(PasswordHasher)).toBe(hasher);
    expect(moduleRef.get<PasswordHasher>('consumer')).toBe(hasher);
    expect(Reflect.getMetadata('controllers', IdentityModule) ?? []).toEqual([]);
  } finally { await moduleRef.close(); }
});
