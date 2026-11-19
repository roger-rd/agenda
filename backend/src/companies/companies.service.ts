import { Clock } from '../common/clock/clock';
import { ForbiddenError, InvalidInputError } from '../common/errors/domain-error';
import { IdGenerator } from '../common/ids/id-generator';
import { TransactionRunner } from '../registration/transaction-runner';
import { CreateCompanyDto } from './create-company.dto';
import { normalizeCompanyName, normalizeCompanyColor } from './company-input';
import { translateCompanyWriteError } from './company-errors';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Company } from '../persistence/entities/company.entity';
import { decodeCursor, encodeCursor } from './companies-cursor';
import { CompaniesScope } from './companies-scope';
import { ListCompaniesQuery } from './list-companies.query';

export const LIST_COMPANIES_SQL = 'SELECT c.id, c.name, c.color, c.version, c.name_key FROM public.companies c WHERE c.organization_id = $1 AND ($2::text IS NULL OR (c.name_key, c.id) > ($2::text, $3::uuid)) ORDER BY c.name_key, c.id LIMIT $4';
export const LIST_ACCESSIBLE_COMPANIES_SQL = 'SELECT c.id, c.name, c.color, c.version, c.name_key FROM public.companies c JOIN public.company_accesses a ON a.company_id = c.id AND a.organization_id = c.organization_id WHERE c.organization_id = $1 AND a.organization_id = $1 AND a.membership_id = $5 AND ($2::text IS NULL OR (c.name_key, c.id) > ($2::text, $3::uuid)) ORDER BY c.name_key, c.id LIMIT $4';
interface CompanyRow { id: string; name: string; color: string; version: number; name_key: string }

@Injectable()
export class CompaniesService {
  constructor(@InjectRepository(Company) private readonly repository: Repository<Company>,
    private readonly runner: TransactionRunner, private readonly ids: IdGenerator, private readonly clock: Clock) {}

  async create(scope: CompaniesScope, dto: CreateCompanyDto) {
    if (scope.role !== 'community_manager') throw new ForbiddenError('Acceso denegado.');
    const normalized = normalizeCompanyName(dto.name);
    if (normalized === null) throw new InvalidInputError('Datos de entrada inválidos.', 'name');
    const color = normalizeCompanyColor(dto.color);
    if (color === null) throw new InvalidInputError('Datos de entrada inválidos.', 'color');
    const { name, nameKey } = normalized;
    const id = this.ids.next();
    const now = this.clock.now();
    try {
      await this.runner.run(manager => manager.insert(Company, {
        id, organizationId: scope.organizationId, name, nameKey, color, version: 1, createdAt: now, updatedAt: now,
      }));
      return { id, name, color, version: 1 };
    } catch (error) { throw translateCompanyWriteError(error); }
  }

  async list(scope: CompaniesScope, query: ListCompaniesQuery) {
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const manager = scope.role === 'community_manager';
    const params = [scope.organizationId, cursor?.nameKey ?? null, cursor?.id ?? null, query.limit + 1];
    if (!manager) params.push(scope.membershipId);
    const rows = await this.repository.query(manager ? LIST_COMPANIES_SQL : LIST_ACCESSIBLE_COMPANIES_SQL, params) as CompanyRow[];
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return { items: page.map(({ id, name, color, version }) => ({ id, name, color, version })),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ nameKey: last.name_key, id: last.id }) : null };
  }
}
