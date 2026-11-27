import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DataSourceTransactionRunner, TransactionRunner } from '../registration/transaction-runner';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

/** Reads and writes go through the transaction runner with fixed SQL; no entity repositories are needed. */
@Module({
  imports: [AuthModule],
  providers: [MembersService, { provide: TransactionRunner, useClass: DataSourceTransactionRunner }],
  controllers: [MembersController],
})
export class MembersModule {}
