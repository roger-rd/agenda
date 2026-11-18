import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClockModule } from '../common/clock/clock.module';
import { IdentityModule } from '../identity/identity.module';
import { generateSessionToken } from '../identity/session-token';
import { User } from '../persistence/entities/user.entity';
import { Organization } from '../persistence/entities/organization.entity';
import { OrganizationMembership } from '../persistence/entities/organization-membership.entity';
import { UserSession } from '../persistence/entities/user-session.entity';
import { DataSourceTransactionRunner, TransactionRunner } from '../registration/transaction-runner';
import { AuthController } from './auth.controller';
import { RoleGuard } from './role.guard';
import { SessionAuthGuard } from './session-auth.guard';
import { AuthenticationService, SESSION_TOKEN_FACTORY } from './authentication.service';
import { SessionService } from './session.service';

@Module({
  imports: [IdentityModule, ClockModule, TypeOrmModule.forFeature([User, Organization, OrganizationMembership, UserSession])],
  controllers: [AuthController],
  providers: [SessionAuthGuard, RoleGuard, SessionService, AuthenticationService, { provide: TransactionRunner, useClass: DataSourceTransactionRunner },
    { provide: SESSION_TOKEN_FACTORY, useValue: () => generateSessionToken() }],
  exports: [AuthenticationService, SessionService, SessionAuthGuard, RoleGuard],
})
export class AuthModule {}
