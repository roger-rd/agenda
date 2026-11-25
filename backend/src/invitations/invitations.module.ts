import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DataSourceTransactionRunner, TransactionRunner } from '../registration/transaction-runner';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { InvitationTokens, RandomInvitationTokens } from './invitation-token';

/** Reads and writes go through the transaction runner with fixed SQL; no entity repositories are needed. */
@Module({
  imports: [AuthModule],
  providers: [InvitationsService, { provide: TransactionRunner, useClass: DataSourceTransactionRunner }, { provide: InvitationTokens, useClass: RandomInvitationTokens }],
  controllers: [InvitationsController],
})
export class InvitationsModule {}
