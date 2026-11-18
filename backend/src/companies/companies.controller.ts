import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentSession, CurrentSessionValue } from '../auth/current-session.decorator';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { OriginProtected } from '../common/http/origin.guard';
import { CompaniesService } from './companies.service';
import { companiesScope } from './companies-scope';
import { ListCompaniesQuery } from './list-companies.query';

@Controller('companies')
@OriginProtected()
@UseGuards(SessionAuthGuard)
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}
  @Get()
  list(@CurrentSession() current: CurrentSessionValue, @Query() query: ListCompaniesQuery) {
    return this.companies.list(companiesScope(current.session), query);
  }
}
