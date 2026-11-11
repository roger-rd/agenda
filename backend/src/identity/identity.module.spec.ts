import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { IdentityModule } from './identity.module';
import { Argon2idPasswordHasher, PasswordHasher } from './password-hasher';

@Module({ imports: [IdentityModule], providers: [{ provide: 'consumer', inject: [PasswordHasher], useFactory: (hasher: PasswordHasher) => hasher }] })
class ConsumerModule {}

it('exporta PasswordHasher para consumidores sin controladores ni sockets', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [ConsumerModule] }).compile();
  try {
    expect(moduleRef.get<PasswordHasher>('consumer')).toBeInstanceOf(Argon2idPasswordHasher);
    expect(Reflect.getMetadata('controllers', IdentityModule) ?? []).toEqual([]);
  } finally { await moduleRef.close(); }
});
