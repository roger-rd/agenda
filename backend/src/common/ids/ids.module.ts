import { Global, Module } from '@nestjs/common';
import { IdGenerator } from './id-generator';
import { Uuid7Generator } from './uuid7-generator';

@Global()
@Module({ providers: [{ provide: IdGenerator, useClass: Uuid7Generator }], exports: [IdGenerator] })
export class IdsModule {}
