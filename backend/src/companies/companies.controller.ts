import { InvalidInputError } from '../common/errors/domain-error';
import { UpdateCompanyDto } from './update-company.dto';
import { JsonBody } from '../common/http/content-type';
import { RoleGuard } from '../auth/role.guard';
import { RequireRole } from '../auth/require-role';
import { CreateCompanyDto } from './create-company.dto';
import { Body, Controller, Get, HttpCode, Post, Patch, Param, Query, UseGuards } from '@nestjs/common';
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
  @Post()
  @JsonBody()
  @HttpCode(201)
  @UseGuards(RoleGuard)
  @RequireRole('community_manager')
  create(@CurrentSession() current: CurrentSessionValue, @Body() dto: CreateCompanyDto) {
    return this.companies.create(companiesScope(current.session), dto);
  }

  @Patch(':id')
  @JsonBody()
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @RequireRole('community_manager')
  update(@CurrentSession() current: CurrentSessionValue, @Param('id') id: string,
    @Body() dto: UpdateCompanyDto, @Query() query: Record<string, unknown>) {
    if (Object.keys(query).length) throw new InvalidInputError('Datos de entrada inválidos.');
    return this.companies.update(companiesScope(current.session), id, dto);
  }

  @Get()
  list(@CurrentSession() current: CurrentSessionValue, @Query() query: ListCompaniesQuery) {
    return this.companies.list(companiesScope(current.session), query);
  }
}
