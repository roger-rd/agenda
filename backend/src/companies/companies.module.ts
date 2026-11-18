import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Company } from '../persistence/entities/company.entity';
import { CompanyAccess } from '../persistence/entities/company-access.entity';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([Company, CompanyAccess])],
  providers: [CompaniesService],
  controllers: [CompaniesController],
})
export class CompaniesModule {}
