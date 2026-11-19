import { UpdateCompanyDto } from './update-company.dto';
import { STALE } from '../database/errors/database-http';
import { Clock } from '../common/clock/clock';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from '../common/errors/domain-error';
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

export const UPDATE_COMPANY_SQL = 'UPDATE public.companies SET name = COALESCE($3::text, name), name_key = COALESCE($4::text, name_key), color = COALESCE($5::text, color), version = version + 1, updated_at = $6 WHERE id = $1 AND organization_id = $2 AND version = $7 AND (name, color) IS DISTINCT FROM (COALESCE($3::text, name), COALESCE($5::text, color)) RETURNING id, name, color, version';
export const SELECT_COMPANY_SQL = 'SELECT id, name, color, version FROM public.companies WHERE id = $1 AND organization_id = $2';
type UpdatedCompanyRow = { id: string; name: string; color: string; version: number };

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

  async update(scope: CompaniesScope, id: string, dto: UpdateCompanyDto) {
    if (scope.role !== 'community_manager') throw new ForbiddenError('Acceso denegado.');
    if (dto.name === undefined && dto.color === undefined) throw new InvalidInputError('Datos de entrada inválidos.');
    const normalized = dto.name === undefined ? undefined : normalizeCompanyName(dto.name);
    if (normalized === null) throw new InvalidInputError('Datos de entrada inválidos.', 'name');
    const color = dto.color === undefined ? undefined : normalizeCompanyColor(dto.color);
    if (color === null) throw new InvalidInputError('Datos de entrada inválidos.', 'color');
    // El cuerpo se valida antes del id: id inválido con cuerpo inválido responde 400.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new NotFoundError();
    try {
      return await this.runner.run(async manager => {
        // TypeORM devuelve UPDATE como [filas, afectadas], verificado en la fase auth.
        const [rows] = await manager.query(UPDATE_COMPANY_SQL, [id, scope.organizationId,
          normalized?.name ?? null, normalized?.nameKey ?? null, color ?? null, this.clock.now(), dto.version]) as [UpdatedCompanyRow[], number];
        if (rows.length === 1) return rows[0];
        const current = (await manager.query(SELECT_COMPANY_SQL, [id, scope.organizationId]) as UpdatedCompanyRow[])[0];
        if (!current) throw new NotFoundError();
        // version solo crece: una versión desactualizada nunca vuelve a coincidir.
        // Si otra petición modifica entre UPDATE y SELECT, vemos una versión mayor:
        // respondemos 409 conservador, nunca un 200 falso con datos obsoletos.
        if (current.version !== dto.version) throw new ConflictError(STALE);
        if (current.name === (normalized?.name ?? current.name) && current.color === (color ?? current.color)) return current;
        throw new ConflictError(STALE);
      });
    } catch (error) { throw translateCompanyWriteError(error, 'update'); }
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
