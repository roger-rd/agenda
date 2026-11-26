import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { DataSourceTransactionRunner, TransactionRunner } from '../registration/transaction-runner';
import { InvitationAcceptanceController } from './invitation-acceptance.controller';
import { InvitationAcceptanceService } from './invitation-acceptance.service';
import { NoSessionCookieGuard } from './no-session-cookie.guard';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { InvitationTokens, RandomInvitationTokens } from './invitation-token';

/**
 * Reads and writes go through the transaction runner with fixed SQL; no entity repositories are needed. IdentityModule provides the
 * single limited password hasher (the same instance as registration and login); AuthModule the session token factory and the guards.
 */
@Module({
  imports: [AuthModule, IdentityModule],
  providers: [InvitationsService, InvitationAcceptanceService, NoSessionCookieGuard, { provide: TransactionRunner, useClass: DataSourceTransactionRunner },
    { provide: InvitationTokens, useClass: RandomInvitationTokens }],
  controllers: [InvitationsController, InvitationAcceptanceController],
})
export class InvitationsModule {}
