import { RegistrationController } from './registration.controller';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { User } from '../persistence/entities/user.entity';
import { Organization } from '../persistence/entities/organization.entity';
import { OrganizationMembership } from '../persistence/entities/organization-membership.entity';
import { RegistrationService, REGISTRATION_NOW, REGISTRATION_NORMALIZERS, registrationNormalizers } from './registration.service';
import { DataSourceTransactionRunner, TransactionRunner } from './transaction-runner';

@Module({
  imports: [IdentityModule, TypeOrmModule.forFeature([User, Organization, OrganizationMembership])],
  controllers: [RegistrationController],
  providers: [RegistrationService, { provide: TransactionRunner, useClass: DataSourceTransactionRunner },
    { provide: REGISTRATION_NOW, useValue: () => new Date() },
    { provide: REGISTRATION_NORMALIZERS, useValue: registrationNormalizers }],
  exports: [RegistrationService],
})
export class RegistrationModule {}
