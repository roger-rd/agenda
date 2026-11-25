import type { EntityManager } from 'typeorm';
import { TransactionRunner } from '../../registration/transaction-runner';
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
}
type Row = Record<string, unknown>;
const msDate = (us: string) => new Date(`${us.slice(0, 23)}Z`);

export class FakeDb {
  readonly invitations = new Map<string, FakeInvitation>();
  readonly companies = new Map<string, Set<string>>();
  readonly members: { organizationId: string; email: string; active: boolean }[] = [];
  readonly statements: { sql: string; params: unknown[] }[] = [];
  readonly outcomes: ('commit' | 'rollback')[] = [];
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
        const result = await work(manager);
        this.outcomes.push('commit');
        return result;
      } catch (error) {
        for (const step of undo.reverse()) step();
        this.outcomes.push('rollback');
        throw error;
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
      default: throw new Error(`Sentencia inesperada: ${sql}`);
    }
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
