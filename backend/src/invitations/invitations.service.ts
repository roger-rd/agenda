import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock/clock';
import { ForbiddenError, InvalidInputError, NotFoundError } from '../common/errors/domain-error';
import { IdGenerator } from '../common/ids/id-generator';
import { TransactionRunner } from '../registration/transaction-runner';
import { CreateInvitationDto } from './create-invitation.dto';
import { InvitationConflictError, translateInvitationWriteError } from './invitation-errors';
import { computeExpiresAt, normalizeCompanyIds, normalizeInvitationEmail, normalizeValidityDays } from './invitation-input';
import type { InvitationRole, InvitationStatus } from './invitation-constants';
import { invitationStatus, renewDecision, revokeDecision } from './invitation-status';
import { buildInvitationLink, hashInvitationToken, InvitationTokens } from './invitation-token';
import { decodeInvitationsCursor, encodeInvitationsCursor } from './invitations-cursor';
import type { InvitationsScope } from './invitations-scope';
import type { ListInvitationsQuery } from './list-invitations.query';

const COMPANY_IDS = `ARRAY(SELECT ic.company_id::text FROM public.invitation_companies ic WHERE ic.invitation_id = i.id AND ic.organization_id = i.organization_id ORDER BY ic.company_id)::text[] AS company_ids`;

/** $1 organization, $2 company ids. Rows found must equal the ids asked: a company of another organization looks like a missing one. */
export const COUNT_COMPANIES_SQL = 'SELECT count(*)::int AS found FROM public.companies WHERE organization_id = $1 AND id = ANY($2::uuid[])';
/** $1 organization, $2 normalized email. The (organization, user) pair is unique, so there is at most one row; active or deactivated. */
export const MEMBER_BY_EMAIL_SQL = 'SELECT (m.deactivated_at IS NULL) AS active FROM public.organization_memberships m JOIN public.users u ON u.id = m.user_id WHERE m.organization_id = $1 AND u.email = $2 LIMIT 1';
export const INSERT_INVITATION_SQL = 'INSERT INTO public.invitations (id, organization_id, email, role, token_hash, created_by_membership_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';
export const INSERT_INVITATION_COMPANIES_SQL = 'INSERT INTO public.invitation_companies (invitation_id, company_id, organization_id) SELECT $1::uuid, c, $2::uuid FROM unnest($3::uuid[]) AS c';
/** Locks the row until the end of the transaction; READ COMMITTED re-reads it after a wait, so a second caller sees the first one's outcome. */
export const SELECT_INVITATION_FOR_UPDATE_SQL = `SELECT i.id, i.email, i.role, i.created_at, i.expires_at, i.revoked_at, i.accepted_at, ${COMPANY_IDS} FROM public.invitations i WHERE i.id = $1 AND i.organization_id = $2 FOR UPDATE OF i`;
/** Only an unaccepted, unrevoked row changes; revoked_at never precedes created_at. */
export const REVOKE_INVITATION_SQL = 'UPDATE public.invitations SET revoked_at = GREATEST($3::timestamptz, created_at) WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING revoked_at';
/** $1 organization, $2 cursor instant (microsecond text) or null, $3 cursor id, $4 limit + 1, $5 status or null, $6 now. created_at_us keeps microseconds. */
export const LIST_INVITATIONS_SQL = `SELECT i.id, i.email, i.role, i.created_at, i.expires_at, i.revoked_at, i.accepted_at, to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_us, ${COMPANY_IDS} FROM public.invitations i WHERE i.organization_id = $1 AND ($2::timestamptz IS NULL OR (i.created_at, i.id) < ($2::timestamptz, $3::uuid)) AND ($5::text IS NULL OR CASE $5::text WHEN 'accepted' THEN i.accepted_at IS NOT NULL WHEN 'revoked' THEN i.revoked_at IS NOT NULL WHEN 'open' THEN i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > $6::timestamptz WHEN 'expired' THEN i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at <= $6::timestamptz END) ORDER BY i.created_at DESC, i.id DESC LIMIT $4`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface InvitationRow {
  id: string; email: string; role: InvitationRole; created_at: Date; expires_at: Date; revoked_at: Date | null; accepted_at: Date | null;
  company_ids: string[]; created_at_us?: string;
}
export interface InvitationView {
  id: string; email: string; role: InvitationRole; companyIds: string[]; status: InvitationStatus;
  createdAt: string; expiresAt: string; revokedAt: string | null; acceptedAt: string | null;
}
/** The token and the link exist only in the response of the call that created them; they are never stored or listed. */
export interface IssuedInvitation extends InvitationView { token: string; link: string }

function view(row: InvitationRow, now: Date): InvitationView {
  return {
    id: row.id, email: row.email, role: row.role, companyIds: [...row.company_ids],
    status: invitationStatus({ acceptedAt: row.accepted_at, revokedAt: row.revoked_at, expiresAt: row.expires_at }, now),
    createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null, acceptedAt: row.accepted_at?.toISOString() ?? null,
  };
}

type Manager = { query(sql: string, params?: unknown[]): Promise<unknown> };

@Injectable()
export class InvitationsService {
  constructor(private readonly runner: TransactionRunner, private readonly ids: IdGenerator, private readonly clock: Clock,
    private readonly tokens: InvitationTokens) {}

  async create(scope: InvitationsScope, dto: CreateInvitationDto): Promise<IssuedInvitation> {
    this.assertManager(scope);
    const email = normalizeInvitationEmail(dto.email);
    if (email === null) throw new InvalidInputError('Datos de entrada inválidos.', 'email');
    if (dto.role !== 'worker' && dto.role !== 'client') throw new InvalidInputError('Datos de entrada inválidos.', 'role');
    const companyIds = normalizeCompanyIds(dto.companyIds);
    if (companyIds === null) throw new InvalidInputError('Datos de entrada inválidos.', 'companyIds');
    const days = normalizeValidityDays(dto.validityDays);
    if (days === null) throw new InvalidInputError('Datos de entrada inválidos.', 'validityDays');
    const now = this.clock.now();
    try {
      return await this.runner.run(async manager => {
        await this.assertCompanies(manager, scope, companyIds);
        await this.assertNotMember(manager, scope, email);
        return this.issue(manager, scope, { email, role: dto.role, companyIds, expiresAt: computeExpiresAt(now, days), now });
      });
    } catch (error) { throw translateInvitationWriteError(error); }
  }

  async list(scope: InvitationsScope, query: ListInvitationsQuery): Promise<{ items: InvitationView[]; nextCursor: string | null }> {
    this.assertManager(scope);
    const cursor = query.cursor === undefined ? null : decodeInvitationsCursor(query.cursor);
    const now = this.clock.now();
    const rows = await this.runner.run(async manager => await manager.query(LIST_INVITATIONS_SQL,
      [scope.organizationId, cursor?.createdAt ?? null, cursor?.id ?? null, query.limit + 1, query.status ?? null, now])) as InvitationRow[];
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(row => view(row, now)),
      nextCursor: rows.length > query.limit && last?.created_at_us !== undefined ? encodeInvitationsCursor({ createdAt: last.created_at_us, id: last.id }) : null,
    };
  }

  async revoke(scope: InvitationsScope, id: string): Promise<{ id: string; status: 'revoked'; revokedAt: string }> {
    this.assertManager(scope);
    if (!UUID.test(id)) throw new NotFoundError();
    const now = this.clock.now();
    try {
      return await this.runner.run(async manager => {
        const row = await this.lock(manager, scope, id);
        const decision = revokeDecision(view(row, now).status);
        if (decision === 'already_revoked') return { id, status: 'revoked' as const, revokedAt: (row.revoked_at as Date).toISOString() };
        if (decision === 'conflict') throw new InvitationConflictError('invitation_accepted');
        return { id, status: 'revoked' as const, revokedAt: await this.revokeLocked(manager, scope, id, now) };
      });
    } catch (error) { throw translateInvitationWriteError(error, 'update'); }
  }

  /**
   * Renewal is revoke + create in ONE transaction: the previous row is locked and re-validated, revoked, and replaced by a new
   * invitation (new id, new token) for the same email, role and companies. Any failure rolls the whole thing back, leaving the previous
   * invitation untouched. Two concurrent renewals of the same id serialize on the row lock: the first succeeds and the second finds it
   * revoked and gets a conflict; no second replacement is ever created.
   */
  async renew(scope: InvitationsScope, id: string, validityDays?: unknown): Promise<IssuedInvitation> {
    this.assertManager(scope);
    if (!UUID.test(id)) throw new NotFoundError();
    const days = normalizeValidityDays(validityDays);
    if (days === null) throw new InvalidInputError('Datos de entrada inválidos.', 'validityDays');
    const now = this.clock.now();
    try {
      return await this.runner.run(async manager => {
        const row = await this.lock(manager, scope, id);
        const status = invitationStatus({ acceptedAt: row.accepted_at, revokedAt: row.revoked_at, expiresAt: row.expires_at }, now);
        if (renewDecision(status) === 'conflict') throw new InvitationConflictError(status === 'accepted' ? 'invitation_accepted' : 'invitation_revoked');
        // Every invitation has 1 to 50 companies; a row that does not is not replaced with an empty one.
        const companyIds = normalizeCompanyIds(row.company_ids);
        if (companyIds === null) throw new InvalidInputError('Datos de entrada inválidos.', 'companyIds');
        await this.assertNotMember(manager, scope, row.email);
        await this.revokeLocked(manager, scope, id, now);
        return this.issue(manager, scope, { email: row.email, role: row.role, companyIds, expiresAt: computeExpiresAt(now, days), now });
      });
    } catch (error) { throw translateInvitationWriteError(error); }
  }

  private assertManager(scope: InvitationsScope): void {
    if (scope.role !== 'community_manager') throw new ForbiddenError('Acceso denegado.');
  }

  private async assertCompanies(manager: Manager, scope: InvitationsScope, companyIds: readonly string[]): Promise<void> {
    const rows = await manager.query(COUNT_COMPANIES_SQL, [scope.organizationId, companyIds]) as { found: number }[];
    if (rows[0]?.found !== companyIds.length) throw new InvalidInputError('Datos de entrada inválidos.', 'companyIds');
  }

  /** Active and deactivated members of the same organization are different conflicts. Nothing here reactivates a membership. */
  private async assertNotMember(manager: Manager, scope: InvitationsScope, email: string): Promise<void> {
    const rows = await manager.query(MEMBER_BY_EMAIL_SQL, [scope.organizationId, email]) as { active: boolean }[];
    if (rows.length > 0) throw new InvitationConflictError(rows[0].active ? 'member_already_active' : 'member_deactivated');
  }

  private async lock(manager: Manager, scope: InvitationsScope, id: string): Promise<InvitationRow> {
    const rows = await manager.query(SELECT_INVITATION_FOR_UPDATE_SQL, [id, scope.organizationId]) as InvitationRow[];
    if (rows.length !== 1) throw new NotFoundError();
    return rows[0];
  }

  private async revokeLocked(manager: Manager, scope: InvitationsScope, id: string, now: Date): Promise<string> {
    // TypeORM returns UPDATE ... RETURNING as [rows, affected].
    const [rows] = await manager.query(REVOKE_INVITATION_SQL, [id, scope.organizationId, now]) as [{ revoked_at: Date }[], number];
    // Locked and validated just before: no row here means the state changed under us, which is a conflict and never a silent success.
    if (rows.length !== 1) throw new InvitationConflictError('invitation_revoked');
    return rows[0].revoked_at.toISOString();
  }

  private async issue(manager: Manager, scope: InvitationsScope,
    input: { email: string; role: InvitationRole; companyIds: readonly string[]; expiresAt: Date; now: Date }): Promise<IssuedInvitation> {
    const id = this.ids.next();
    const token = this.tokens.next();
    await manager.query(INSERT_INVITATION_SQL, [id, scope.organizationId, input.email, input.role, hashInvitationToken(token),
      scope.membershipId, input.now, input.expiresAt]);
    await manager.query(INSERT_INVITATION_COMPANIES_SQL, [id, scope.organizationId, input.companyIds]);
    return {
      id, email: input.email, role: input.role, companyIds: [...input.companyIds], status: 'open',
      createdAt: input.now.toISOString(), expiresAt: input.expiresAt.toISOString(), revokedAt: null, acceptedAt: null,
      token, link: buildInvitationLink(token),
    };
  }
}
