import type { EntityManager } from 'typeorm';
import { TransactionRunner } from '../../registration/transaction-runner';
import { INSERT_SESSION_SQL } from '../../auth/session-issue';
import {
  ACCEPTANCE_COMPANIES_SQL, INSERT_ACCESSES_SQL, INSERT_MEMBERSHIP_SQL, INSERT_USER_SQL, INSPECT_INVITATION_SQL, LOCK_INVITATION_BY_TOKEN_SQL,
  MARK_ACCEPTED_SQL, USER_EXISTS_BY_EMAIL_SQL,
} from '../invitation-acceptance-sql';
import {
  COUNT_COMPANIES_SQL, INSERT_INVITATION_COMPANIES_SQL, INSERT_INVITATION_SQL, LIST_INVITATIONS_SQL, MEMBER_BY_EMAIL_SQL,
  REVOKE_INVITATION_SQL, SELECT_INVITATION_FOR_UPDATE_SQL,
} from '../invitations.service';

/**
 * In-memory stand-in for the statements of InvitationsService, used only by offline specs. It models what the service relies on: the
 * open-email unique index, the composite company foreign key, a row lock held until the transaction ends (a waiter re-reads the
 * committed state afterwards) and rollback of every write of a failed transaction. It is not PostgreSQL: the real behaviour is
 * proven by the connected phase.
 */
export interface FakeInvitation {
  id: string; organizationId: string; email: string; role: 'worker' | 'client'; tokenHash: Buffer; createdByMembershipId: string;
  createdAtUs: string; expiresAt: Date; revokedAt: Date | null; acceptedAt: Date | null; companyIds: string[];
  /** Set only by an acceptance. */
  acceptedByUserId?: string | null;
}
export interface FakeUser { id: string; email: string; name: string; passwordHash: string; createdAt: Date }
export interface FakeMembership { id: string; organizationId: string; userId: string; role: string; deactivatedAt: Date | null; createdAt: Date }
export interface FakeAccess { membershipId: string; companyId: string; organizationId: string; role: string; createdAt: Date }
export interface FakeSession { id: string; tokenHash: Buffer; userId: string; activeOrganizationId: string | null; createdAt: Date; lastSeenAt: Date; expiresAt: Date }
type Row = Record<string, unknown>;
const msDate = (us: string) => new Date(`${us.slice(0, 23)}Z`);

export class FakeDb {
  readonly invitations = new Map<string, FakeInvitation>();
  readonly companies = new Map<string, Set<string>>();
  readonly members: { organizationId: string; email: string; active: boolean }[] = [];
  readonly statements: { sql: string; params: unknown[] }[] = [];
  readonly outcomes: ('commit' | 'rollback' | 'commit-unknown')[] = [];
  /** Acceptance tables and names. */
  readonly users = new Map<string, FakeUser>();
  readonly memberships = new Map<string, FakeMembership>();
  readonly accesses: FakeAccess[] = [];
  readonly sessions = new Map<string, FakeSession>();
  readonly organizations = new Map<string, string>();
  readonly companyNames = new Map<string, string>();
  /** Observes every statement as it is issued (before it runs or waits for a lock). */
  onStatement: ((sql: string, params: unknown[]) => void) | null = null;
  /** One-shot hooks run right before a statement executes: they model another transaction committing in that window. */
  readonly before = new Map<string, () => void>();
  /** The COMMIT fails with this error. applied tells whether PostgreSQL had committed (the outcome is unknown to the caller either way). */
  commitFailure: { error: unknown; applied: boolean } | null = null;
  runs = 0;
  /** Throws this error when the statement runs (after counting it). */
  failOn: ((sql: string, params: unknown[]) => unknown) | null = null;
  /** Called after a statement ran, to interleave other work deterministically. */
  private readonly locks = new Map<string, Promise<void>>();

  readonly runner: TransactionRunner = {
    run: async <T>(work: (manager: EntityManager) => Promise<T>): Promise<T> => {
      this.runs++;
      const undo: (() => void)[] = []; const release: (() => void)[] = [];
      const manager = { query: (sql: string, params: unknown[] = []) => this.query(sql, params, undo, release) } as unknown as EntityManager;
      try {
        let result: T;
        try { result = await work(manager); }
        catch (error) {
          for (const step of undo.reverse()) step();
          this.outcomes.push('rollback');
          throw error;
        }
        // COMMIT. A failure here is outside the work: when `applied`, PostgreSQL did commit and the caller cannot know.
        if (this.commitFailure) {
          const { error, applied } = this.commitFailure;
          if (!applied) for (const step of undo.reverse()) step();
          this.outcomes.push(applied ? 'commit-unknown' : 'rollback');
          throw error;
        }
        this.outcomes.push('commit');
        return result;
      } finally { for (const free of release) free(); }
    },
  };

  private async acquire(id: string, release: (() => void)[]): Promise<void> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let free!: () => void;
    const mine = new Promise<void>(resolve => { free = resolve; });
    this.locks.set(id, previous.then(() => mine));
    release.push(free);
    await previous;
  }

  private async query(sql: string, params: unknown[], undo: (() => void)[], release: (() => void)[]): Promise<unknown> {
    this.statements.push({ sql, params });
    this.onStatement?.(sql, params);
    const hook = this.before.get(sql);
    if (hook) { this.before.delete(sql); hook(); }
    const injected = this.failOn?.(sql, params);
    if (injected !== undefined && injected !== null) throw injected;
    switch (sql) {
      case COUNT_COMPANIES_SQL: {
        const [organizationId, ids] = params as [string, string[]];
        return [{ found: ids.filter(id => this.companies.get(organizationId)?.has(id)).length }];
      }
      case MEMBER_BY_EMAIL_SQL: {
        const [organizationId, email] = params as [string, string];
        return this.members.filter(m => m.organizationId === organizationId && m.email === email).slice(0, 1).map(m => ({ active: m.active }));
      }
      case INSERT_INVITATION_SQL: {
        const [id, organizationId, email, role, tokenHash, createdByMembershipId, createdAt, expiresAt] = params as
          [string, string, string, 'worker' | 'client', Buffer, string, Date, Date];
        if ([...this.invitations.values()].some(i => i.organizationId === organizationId && i.email === email && i.acceptedAt === null && i.revokedAt === null)) {
          throw { severity: 'ERROR', code: '23505', constraint: 'UQ_invitations_open_email' };
        }
        const createdAtUs = createdAt.toISOString().replace('Z', '000Z');
        this.invitations.set(id, { id, organizationId, email, role, tokenHash, createdByMembershipId, createdAtUs, expiresAt, revokedAt: null, acceptedAt: null, companyIds: [] });
        undo.push(() => { this.invitations.delete(id); });
        return [];
      }
      case INSERT_INVITATION_COMPANIES_SQL: {
        const [id, organizationId, ids] = params as [string, string, string[]];
        const row = this.invitations.get(id);
        if (!row || row.organizationId !== organizationId) throw { severity: 'ERROR', code: '23503', constraint: 'FK_invitation_companies_invitation' };
        if (ids.some(c => !this.companies.get(organizationId)?.has(c))) throw { severity: 'ERROR', code: '23503', constraint: 'FK_invitation_companies_company' };
        row.companyIds = [...ids];
        return [];
      }
      case SELECT_INVITATION_FOR_UPDATE_SQL: {
        const [id, organizationId] = params as [string, string];
        const exists = this.invitations.get(id);
        if (!exists || exists.organizationId !== organizationId) return [];
        await this.acquire(id, release);
        const row = this.invitations.get(id);
        return row && row.organizationId === organizationId ? [this.asRow(row)] : [];
      }
      case REVOKE_INVITATION_SQL: {
        const [id, organizationId, now] = params as [string, string, Date];
        const row = this.invitations.get(id);
        if (!row || row.organizationId !== organizationId || row.acceptedAt !== null || row.revokedAt !== null) return [[], 0];
        const before = row.revokedAt; row.revokedAt = now;
        undo.push(() => { row.revokedAt = before; });
        return [[{ revoked_at: now }], 1];
      }
      case LIST_INVITATIONS_SQL: return this.list(params);
      case INSPECT_INVITATION_SQL: {
        const row = this.byTokenHash(params[0] as Buffer);
        return row ? [this.acceptanceRow(row, true)] : [];
      }
      case LOCK_INVITATION_BY_TOKEN_SQL: {
        const found = this.byTokenHash(params[0] as Buffer);
        if (!found) return [];
        await this.acquire(found.id, release);
        const row = this.byTokenHash(params[0] as Buffer); // the state after the lock was granted
        return row ? [this.acceptanceRow(row, false)] : [];
      }
      case ACCEPTANCE_COMPANIES_SQL: {
        const [invitationId] = params as [string, string];
        return [...(this.invitations.get(invitationId)?.companyIds ?? [])].sort().map(company_id => ({ company_id }));
      }
      case USER_EXISTS_BY_EMAIL_SQL: return [...this.users.values()].some(u => u.email === params[0]) ? [{ found: 1 }] : [];
      case INSERT_USER_SQL: {
        const [id, email, name, passwordHash, now] = params as [string, string, string, string, Date];
        if ([...this.users.values()].some(u => u.email === email)) throw { severity: 'ERROR', code: '23505', constraint: 'UQ_users_email' };
        this.users.set(id, { id, email, name, passwordHash, createdAt: now });
        undo.push(() => { this.users.delete(id); });
        return [];
      }
      case INSERT_MEMBERSHIP_SQL: {
        const [id, organizationId, userId, role, now] = params as [string, string, string, string, Date];
        this.memberships.set(id, { id, organizationId, userId, role, deactivatedAt: null, createdAt: now });
        undo.push(() => { this.memberships.delete(id); });
        return [];
      }
      case INSERT_ACCESSES_SQL: {
        const [membershipId, organizationId, role, now, companyIds] = params as [string, string, string, Date, string[]];
        const membership = this.memberships.get(membershipId);
        if (!membership || membership.organizationId !== organizationId || membership.role !== role) throw { severity: 'ERROR', code: '23503', constraint: 'FK_company_accesses_membership' };
        if (companyIds.some(c => !this.companies.get(organizationId)?.has(c))) throw { severity: 'ERROR', code: '23503', constraint: 'FK_company_accesses_company' };
        const added = companyIds.map(companyId => ({ membershipId, companyId, organizationId, role, createdAt: now }));
        this.accesses.push(...added);
        undo.push(() => { for (const a of added) this.accesses.splice(this.accesses.indexOf(a), 1); });
        return [];
      }
      case MARK_ACCEPTED_SQL: {
        const [id, instant, userId] = params as [string, Date, string];
        const row = this.invitations.get(id);
        const at = BigInt(instant.getTime()) * 1000n;
        const created = BigInt(Date.parse(`${row?.createdAtUs.slice(0, 23)}Z`)) * 1000n + BigInt(row?.createdAtUs.slice(23, 26) ?? 0);
        if (!row || row.acceptedAt !== null || row.revokedAt !== null || created > at || BigInt(row.expiresAt.getTime()) * 1000n <= at) return [[], 0];
        row.acceptedAt = instant; row.acceptedByUserId = userId;
        undo.push(() => { row.acceptedAt = null; row.acceptedByUserId = null; });
        return [[{ id }], 1];
      }
      case INSERT_SESSION_SQL: {
        const [id, tokenHash, userId, activeOrganizationId, createdAt, expiresAt] = params as [string, Buffer, string, string | null, Date, Date];
        this.sessions.set(id, { id, tokenHash, userId, activeOrganizationId, createdAt, lastSeenAt: createdAt, expiresAt });
        undo.push(() => { this.sessions.delete(id); });
        return [];
      }
      default: throw new Error(`Sentencia inesperada: ${sql}`);
    }
  }

  private byTokenHash(hash: Buffer): FakeInvitation | undefined {
    return [...this.invitations.values()].find(i => i.tokenHash.equals(hash));
  }

  private acceptanceRow(i: FakeInvitation, inspection: boolean): Row {
    const base = { id: i.id, email: i.email, role: i.role, created_at: msDate(i.createdAtUs), expires_at: i.expiresAt, revoked_at: i.revokedAt,
      accepted_at: i.acceptedAt, organization_name: this.organizations.get(i.organizationId) ?? 'Equipo' };
    return inspection
      ? { ...base, company_names: i.companyIds.map(c => this.companyNames.get(c) ?? `Empresa ${c.slice(-4)}`).sort() }
      : { ...base, organization_id: i.organizationId };
  }

  private asRow(i: FakeInvitation): Row {
    return { id: i.id, email: i.email, role: i.role, created_at: msDate(i.createdAtUs), expires_at: i.expiresAt, revoked_at: i.revokedAt,
      accepted_at: i.acceptedAt, created_at_us: i.createdAtUs, company_ids: [...i.companyIds].sort() }; // ARRAY(... ORDER BY company_id)
  }

  private list(params: unknown[]): Row[] {
    const [organizationId, cursorAt, cursorId, limit, status, now] = params as [string, string | null, string | null, number, string | null, Date];
    return [...this.invitations.values()]
      .filter(i => i.organizationId === organizationId)
      // Row comparison (created_at, id) < (cursor): the cursor instant is compared with microsecond precision, as PostgreSQL does.
      .filter(i => cursorAt === null || i.createdAtUs < cursorAt || (i.createdAtUs === cursorAt && i.id < (cursorId as string)))
      .filter(i => status === null || (status === 'accepted' ? i.acceptedAt !== null : status === 'revoked' ? i.revokedAt !== null
        : i.acceptedAt === null && i.revokedAt === null && (status === 'open' ? i.expiresAt.getTime() > now.getTime() : i.expiresAt.getTime() <= now.getTime())))
      .sort((a, b) => (a.createdAtUs === b.createdAtUs ? (a.id < b.id ? 1 : -1) : a.createdAtUs < b.createdAtUs ? 1 : -1))
      .slice(0, limit).map(i => this.asRow(i));
  }
}
