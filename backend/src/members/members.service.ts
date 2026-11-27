import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock/clock';
import { DomainError, ForbiddenError, InvalidInputError, ServiceUnavailableError } from '../common/errors/domain-error';
import { classifyDatabaseError, createOperationContext } from '../database/errors/database-failure';
import { DatabaseOperationError } from '../database/errors/database-operation-error';
import { TransactionRunner } from '../registration/transaction-runner';
import type { ListMembersQuery } from './list-members.query';
import { accessDiff, accessUpdateResult, memberUpdateDecision, memberUpdateFailure, memberView, normalizeAccessUpdate, type AccessUpdateResult, type LockedMember, type MemberView } from './member-contracts';
import type { MemberRole } from './member-constants';
import { MemberConflictError } from './member-errors';
import { BUMP_MEMBER_VERSION_SQL, COUNT_ORG_COMPANIES_SQL, CURRENT_ACCESSES_SQL, DELETE_ACCESSES_SQL, INSERT_ACCESSES_SQL, LIST_MEMBERS_SQL, LOCK_MEMBER_SQL } from './member-sql';
import { decodeMembersCursor, encodeMembersCursor } from './members-cursor';
import type { MembersScope } from './members-scope';

interface ListRow {
  id: string; name: string; email: string; role: MemberRole; deactivated_at: Date | null; version: number; created_at: Date; company_ids: string[];
}
interface LockedRow { id: string; role: MemberRole; version: number; deactivated_at: Date | null }

/**
 * Domain errors pass through. A company that stopped existing between the check and the insert (composite foreign key) is the same
 * invalid input. Everything else keeps its classification with an atomic context: a lock timeout is a repeatable 503, an unconfirmed
 * commit is outcome_unknown. Nothing is retried.
 */
export function translateMemberWriteError(error: unknown): unknown {
  if (error instanceof DomainError) return error;
  const failure = error instanceof DatabaseOperationError ? error.failure : classifyDatabaseError(error);
  if (!failure) return error;
  if (failure.category === 'foreign_key' && failure.constraint === 'FK_company_accesses_company') return new InvalidInputError('Datos de entrada inválidos.', 'companyIds');
  return new DatabaseOperationError(failure, createOperationContext({ operation: 'update', table: 'company_accesses', atomic: true, valuesOrigin: 'request' }));
}

@Injectable()
export class MembersService {
  constructor(private readonly runner: TransactionRunner, private readonly clock: Clock) {}

  /** Reads change nothing: a database failure is a retryable 503. */
  async list(scope: MembersScope, query: ListMembersQuery): Promise<{ items: MemberView[]; nextCursor: string | null }> {
    this.assertManager(scope);
    const cursor = query.cursor === undefined ? null : decodeMembersCursor(query.cursor);
    let rows: ListRow[];
    try {
      rows = await this.runner.run(async manager => await manager.query(LIST_MEMBERS_SQL,
        [scope.organizationId, cursor?.id ?? null, query.role ?? null, query.status, query.limit + 1])) as ListRow[];
    } catch (error) {
      if (error instanceof DomainError || !classifyDatabaseError(error)) throw error;
      throw new ServiceUnavailableError(undefined, 1);
    }
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(row => memberView({ id: row.id, name: row.name, email: row.email, role: row.role, deactivatedAt: row.deactivated_at,
        version: row.version, createdAt: row.created_at, companyIds: row.company_ids })),
      nextCursor: rows.length > query.limit && last ? encodeMembersCursor({ id: last.id }) : null,
    };
  }

  /**
   * Replaces the company accesses of one member in a single transaction: the membership is locked (scoped by the organization of the
   * session) BEFORE any diagnosis, then existence, version, role and state; the companies are checked and the sets compared. Only the
   * differences are written and the version rises once; the same set writes nothing (neither version nor updated_at). `[]` removes every
   * access and leaves the member active. Any failure rolls everything back; there are no retries.
   */
  async updateAccesses(scope: MembersScope, id: string, dto: { version: unknown; companyIds: unknown }): Promise<AccessUpdateResult> {
    this.assertManager(scope);
    const input = normalizeAccessUpdate({ memberId: id, version: dto.version, companyIds: dto.companyIds });
    if (!input.ok) throw input.error;
    const now = this.clock.now();
    try {
      return await this.runner.run(async manager => {
        const rows = await manager.query(LOCK_MEMBER_SQL, [input.memberId, scope.organizationId]) as LockedRow[];
        const member: LockedMember | null = rows.length === 1
          ? { id: rows[0].id, role: rows[0].role, version: rows[0].version, deactivatedAt: rows[0].deactivated_at } : null;
        const decision = memberUpdateDecision(member, input.version);
        if (decision !== 'proceed' || member === null) throw memberUpdateFailure(decision === 'proceed' ? 'not_found' : decision);
        if (input.companyIds.length > 0) {
          const [{ found }] = await manager.query(COUNT_ORG_COMPANIES_SQL, [scope.organizationId, input.companyIds]) as { found: number }[];
          if (found !== input.companyIds.length) throw new InvalidInputError('Datos de entrada inválidos.', 'companyIds');
        }
        const current = (await manager.query(CURRENT_ACCESSES_SQL, [member.id, scope.organizationId]) as { company_id: string }[]).map(r => r.company_id);
        const diff = accessDiff(current, input.companyIds);
        if (!diff.changed) return accessUpdateResult({ id: member.id, role: member.role, version: member.version, companyIds: input.companyIds });
        if (diff.remove.length > 0) await manager.query(DELETE_ACCESSES_SQL, [member.id, scope.organizationId, diff.remove]);
        if (diff.add.length > 0) await manager.query(INSERT_ACCESSES_SQL, [member.id, scope.organizationId, member.role, now, diff.add]);
        // TypeORM returns UPDATE ... RETURNING as [rows, affected]. No row would mean the version moved under the lock: roll everything back.
        const [bumped] = await manager.query(BUMP_MEMBER_VERSION_SQL, [member.id, scope.organizationId, now, member.version]) as [{ version: number }[], number];
        if (bumped.length !== 1) throw new MemberConflictError('version_conflict');
        return accessUpdateResult({ id: member.id, role: member.role, version: bumped[0].version, companyIds: input.companyIds });
      });
    } catch (error) { throw translateMemberWriteError(error); }
  }

  private assertManager(scope: MembersScope): void {
    if (scope.role !== 'community_manager') throw new ForbiddenError('Acceso denegado.');
  }
}
