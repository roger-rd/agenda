import type { EntityManager } from 'typeorm';
import { TransactionRunner } from '../../registration/transaction-runner';
import { BUMP_MEMBER_VERSION_SQL, COUNT_ORG_COMPANIES_SQL, CURRENT_ACCESSES_SQL, DELETE_ACCESSES_SQL, INSERT_ACCESSES_SQL, LIST_MEMBERS_SQL, LOCK_MEMBER_SQL } from '../member-sql';

/**
 * In-memory stand-in for the member statements, used only by offline specs. It models what the service relies on: the membership row
 * lock held until the transaction ends (a waiter re-reads the committed state), the composite foreign key and primary key of the
 * accesses, the version predicate and rollback. It is not PostgreSQL: the real behaviour is proven by the connected phase.
 */
export interface FakeMembership {
  id: string; organizationId: string; name: string; email: string; role: 'community_manager' | 'worker' | 'client'; version: number;
  deactivatedAt: Date | null; createdAt: Date; updatedAt: Date;
}
export interface FakeAccess { membershipId: string; companyId: string; organizationId: string; role: string; createdAt: Date }
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class FakeMembersDb {
  readonly memberships = new Map<string, FakeMembership>();
  accesses: FakeAccess[] = [];
  readonly companies = new Map<string, Set<string>>();
  readonly statements: { sql: string; params: unknown[] }[] = [];
  readonly outcomes: ('commit' | 'rollback' | 'commit-unknown')[] = [];
  runs = 0;
  failOn: ((sql: string, params: unknown[]) => unknown) | null = null;
  /** One-shot hooks run right before a statement: they model another transaction committing in that window. */
  readonly before = new Map<string, () => void>();
  commitFailure: { error: unknown; applied: boolean } | null = null;
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

  accessesOf(membershipId: string): string[] { return this.accesses.filter(a => a.membershipId === membershipId).map(a => a.companyId).sort(byText); }

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
    const hook = this.before.get(sql);
    if (hook) { this.before.delete(sql); hook(); }
    const injected = this.failOn?.(sql, params);
    if (injected !== undefined && injected !== null) throw injected;
    switch (sql) {
      case LOCK_MEMBER_SQL: {
        const [id, organizationId] = params as [string, string];
        const found = this.memberships.get(id);
        if (!found || found.organizationId !== organizationId) return [];
        await this.acquire(id, release);
        const row = this.memberships.get(id)!;
        return [{ id: row.id, role: row.role, version: row.version, deactivated_at: row.deactivatedAt }];
      }
      case COUNT_ORG_COMPANIES_SQL: {
        const [organizationId, ids] = params as [string, string[]];
        return [{ found: ids.filter(id => this.companies.get(organizationId)?.has(id)).length }];
      }
      case CURRENT_ACCESSES_SQL: {
        const [membershipId, organizationId] = params as [string, string];
        return this.accesses.filter(a => a.membershipId === membershipId && a.organizationId === organizationId).map(a => a.companyId).sort(byText).map(company_id => ({ company_id }));
      }
      case DELETE_ACCESSES_SQL: {
        const [membershipId, organizationId, ids] = params as [string, string, string[]];
        const removed = this.accesses.filter(a => a.membershipId === membershipId && a.organizationId === organizationId && ids.includes(a.companyId));
        this.accesses = this.accesses.filter(a => !removed.includes(a));
        undo.push(() => { this.accesses.push(...removed); });
        return [[], removed.length];
      }
      case INSERT_ACCESSES_SQL: {
        const [membershipId, organizationId, role, now, ids] = params as [string, string, string, Date, string[]];
        const member = this.memberships.get(membershipId);
        if (!member || member.organizationId !== organizationId || member.role !== role) throw { severity: 'ERROR', code: '23503', constraint: 'FK_company_accesses_membership' };
        if (ids.some(c => !this.companies.get(organizationId)?.has(c))) throw { severity: 'ERROR', code: '23503', constraint: 'FK_company_accesses_company' };
        if (ids.some(c => this.accesses.some(a => a.membershipId === membershipId && a.companyId === c))) throw { severity: 'ERROR', code: '23505', constraint: 'PK_company_accesses' };
        const added: FakeAccess[] = ids.map(companyId => ({ membershipId, companyId, organizationId, role, createdAt: now }));
        this.accesses.push(...added);
        undo.push(() => { this.accesses = this.accesses.filter(a => !added.includes(a)); });
        return [];
      }
      case BUMP_MEMBER_VERSION_SQL: {
        const [id, organizationId, now, version] = params as [string, string, Date, number];
        const row = this.memberships.get(id);
        if (!row || row.organizationId !== organizationId || row.version !== version) return [[], 0];
        const before = { version: row.version, updatedAt: row.updatedAt };
        row.version += 1; row.updatedAt = now;
        undo.push(() => { row.version = before.version; row.updatedAt = before.updatedAt; });
        return [[{ version: row.version }], 1];
      }
      case LIST_MEMBERS_SQL: {
        const [organizationId, cursor, role, status, limit] = params as [string, string | null, string | null, string, number];
        return [...this.memberships.values()]
          .filter(m => m.organizationId === organizationId && (cursor === null || m.id > cursor) && (role === null || m.role === role)
            && (status === 'all' || (status === 'active') === (m.deactivatedAt === null)))
          .sort((a, b) => byText(a.id, b.id)).slice(0, limit)
          .map(m => ({ id: m.id, name: m.name, email: m.email, role: m.role, deactivated_at: m.deactivatedAt, version: m.version, created_at: m.createdAt, company_ids: this.accessesOf(m.id) }));
      }
      default: throw new Error(`Sentencia inesperada: ${sql}`);
    }
  }
}
