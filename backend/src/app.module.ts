import { IdentityModule } from './identity/identity.module';
import { HealthModule } from './health/health.module';
import { ConstraintRegistry } from './database/errors/constraint-registry';
import { registerSchemaConstraints } from './database/errors/register-schema-constraints';
import { DatabaseModule } from './database/database.module';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppConfigModule } from './config/app-config.module';
import { IdsModule } from './common/ids/ids.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { LoggingModule } from './logging/logging.module';

@Module({
  imports: [IdentityModule, AppConfigModule, IdsModule, LoggingModule, DatabaseModule, HealthModule],
  providers: [{ provide: 'SCHEMA_CONSTRAINTS_REGISTERED', inject: [ConstraintRegistry], useFactory: registerSchemaConstraints }, { provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
