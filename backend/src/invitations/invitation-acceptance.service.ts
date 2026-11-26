import { Inject, Injectable } from '@nestjs/common';
import { SESSION_TOKEN_FACTORY } from '../auth/authentication.service';
import { INSERT_SESSION_SQL, issueSession, sessionInsertParams } from '../auth/session-issue';
import { Clock } from '../common/clock/clock';
import { DomainError, OutcomeUnknownError, ServiceUnavailableError } from '../common/errors/domain-error';
import { IdGenerator } from '../common/ids/id-generator';
import { classifyDatabaseError, createOperationContext } from '../database/errors/database-failure';
import { DatabaseOperationError } from '../database/errors/database-operation-error';
import { PasswordHasher } from '../identity/password-hasher';
import { TransactionRunner } from '../registration/transaction-runner';
import type { InvitationRole } from './invitation-constants';
import {
  acceptanceDecision, acceptanceFailure, acceptanceInstant, acceptanceResponse, inspectionView, normalizeAcceptance, normalizeInvitationToken,
  type AcceptanceResponse, type InspectionRow, type InspectionView, type LockedInvitation,
} from './invitation-acceptance';
import { ACCEPTANCE_OUTCOME_UNKNOWN_MESSAGE, InvitationAcceptanceError } from './invitation-acceptance-errors';
import {
  ACCEPTANCE_COMPANIES_SQL, INSERT_ACCESSES_SQL, INSERT_MEMBERSHIP_SQL, INSERT_USER_SQL, INSPECT_INVITATION_SQL, LOCK_INVITATION_BY_TOKEN_SQL,
  MARK_ACCEPTED_SQL, USER_EXISTS_BY_EMAIL_SQL,
} from './invitation-acceptance-sql';
import { normalizeCompanyIds } from './invitation-input';
import { hashInvitationToken } from './invitation-token';

interface InspectionDbRow {
  id: string; email: string; role: InvitationRole; created_at: Date; expires_at: Date; revoked_at: Date | null; accepted_at: Date | null;
  organization_name: string; company_names: string[];
}
interface LockedDbRow extends Omit<InspectionDbRow, 'company_names'> { organization_id: string }

/**
 * What an accepted invitation returns to the controller. The session token is NOT an enumerable property: serializing this object (or
 * returning it by mistake) can never expose it; the controller reads `sessionToken` explicitly, after the commit, to set the cookie.
 */
export interface AcceptanceResult { readonly body: AcceptanceResponse; readonly maxAgeSeconds: number; readonly sessionToken: string }

/**
 * Failures of a write transaction. Domain errors pass through. UQ_users_email (another account took the address, in the window between
 * the check and the insert) is the same `account_exists` as an existing account: the whole transaction is rolled back and nothing is
 * retried. A failure whose outcome is unknown (the commit could not be confirmed) becomes the 503 outcome_unknown with the recovery
 * message and carries nothing else: the session token was never returned. Anything else keeps its classification, with an atomic
 * context, so a lock timeout is a repeatable 503.
 */
export function translateAcceptanceError(error: unknown): unknown {
  if (error instanceof DomainError) return error;
  const failure = error instanceof DatabaseOperationError ? error.failure : classifyDatabaseError(error);
  if (!failure) return error;
  if (failure.category === 'unique_violation' && failure.constraint === 'UQ_users_email') return new InvitationAcceptanceError('account_exists');
  if (failure.outcome === 'unknown') return new OutcomeUnknownError(ACCEPTANCE_OUTCOME_UNKNOWN_MESSAGE);
  return new DatabaseOperationError(failure, createOperationContext({ operation: 'insert', atomic: true, valuesOrigin: 'request' }));
}
/** Reads change nothing: any database failure is a retryable 503, never an unknown outcome. */
function translateReadError(error: unknown): unknown {
  if (error instanceof DomainError) return error;
  return classifyDatabaseError(error) || error instanceof DatabaseOperationError ? new ServiceUnavailableError(undefined, 1) : error;
}

@Injectable()
export class InvitationAcceptanceService {
  constructor(
    private readonly hasher: PasswordHasher,
    private readonly runner: TransactionRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(SESSION_TOKEN_FACTORY) private readonly newSessionToken: () => string,
  ) {}

  /** Public and read-only. unknown or malformed never reaches the database. */
  async inspect(input: { token: unknown }): Promise<InspectionView> {
    const token = normalizeInvitationToken(input.token);
    if (token === null) return { status: 'unavailable' };
    try {
      const rows = await this.runner.run(async manager => await manager.query(INSPECT_INVITATION_SQL, [hashInvitationToken(token)])) as InspectionDbRow[];
      const row: InspectionRow | null = rows.length === 1 ? {
        organizationName: rows[0].organization_name, role: rows[0].role, email: rows[0].email, companyNames: rows[0].company_names,
        createdAt: rows[0].created_at, expiresAt: rows[0].expires_at, revokedAt: rows[0].revoked_at, acceptedAt: rows[0].accepted_at,
      } : null;
      return inspectionView(row, this.clock.now());
    } catch (error) { throw translateReadError(error); }
  }

  /**
   * Accepts an invitation with a NEW account. Order, all of it before the write transaction opens: validate (token, name, password),
   * a cheap unlocked read to refuse early what cannot succeed (so Argon2 is not spent on it), then the hash with the shared limited
   * hasher. Inside the transaction nothing from the early read is trusted: the row is locked, the clock is read AFTER the lock and the
   * decision is taken again. User, membership, accesses, acceptance mark and session are one transaction; any failure rolls back all.
   * No session is revoked or replaced (a previous cookie is rejected by the controller, later); no retry is ever made.
   */
  async accept(input: { token: unknown; name: unknown; password: unknown }): Promise<AcceptanceResult> {
    const normalized = normalizeAcceptance(input);
    if (!normalized.ok) throw normalized.error;
    const tokenHash = hashInvitationToken(normalized.token);
    await this.refuseEarly(tokenHash);
    const passwordHash = await this.hasher.hash(normalized.password);
    const sessionToken = this.newSessionToken();
    try {
      return await this.runner.run(async manager => {
        const rows = await manager.query(LOCK_INVITATION_BY_TOKEN_SQL, [tokenHash]) as LockedDbRow[];
        const locked: (LockedInvitation & { organizationName: string }) | null = rows.length === 1 ? {
          id: rows[0].id, organizationId: rows[0].organization_id, email: rows[0].email, role: rows[0].role, createdAt: rows[0].created_at,
          expiresAt: rows[0].expires_at, revokedAt: rows[0].revoked_at, acceptedAt: rows[0].accepted_at, organizationName: rows[0].organization_name,
        } : null;
        const now = this.clock.now(); // read after the lock was granted: a wait can cross the expiry
        const decision = acceptanceDecision(locked, now);
        if (decision !== 'proceed' || locked === null) throw acceptanceFailure(decision === 'proceed' ? 'unavailable' : decision);
        const instant = acceptanceInstant(locked, now);
        const companies = normalizeCompanyIds((await manager.query(ACCEPTANCE_COMPANIES_SQL, [locked.id, locked.organizationId]) as { company_id: string }[]).map(r => r.company_id));
        if (companies === null) throw new InvitationAcceptanceError('invitation_unavailable'); // every invitation has 1 to 50 companies
        if ((await manager.query(USER_EXISTS_BY_EMAIL_SQL, [locked.email]) as unknown[]).length > 0) throw new InvitationAcceptanceError('account_exists');
        const userId = this.ids.next(), membershipId = this.ids.next();
        await manager.query(INSERT_USER_SQL, [userId, locked.email, normalized.name, passwordHash, instant]);
        await manager.query(INSERT_MEMBERSHIP_SQL, [membershipId, locked.organizationId, userId, locked.role, instant]);
        await manager.query(INSERT_ACCESSES_SQL, [membershipId, locked.organizationId, locked.role, instant, companies]);
        // TypeORM returns UPDATE ... RETURNING as [rows, affected]. No row means the state moved under the lock: roll everything back.
        const [marked] = await manager.query(MARK_ACCEPTED_SQL, [locked.id, instant, userId]) as [{ id: string }[], number];
        if (marked.length !== 1) throw new InvitationAcceptanceError('invitation_unavailable');
        const session = issueSession({ now: instant, token: sessionToken, id: this.ids.next(), userId, activeOrganizationId: locked.organizationId });
        await manager.query(INSERT_SESSION_SQL, sessionInsertParams(session.row));
        const result = {
          body: acceptanceResponse({ user: { id: userId, email: locked.email, name: normalized.name },
            organization: { id: locked.organizationId, name: locked.organizationName }, membership: { id: membershipId, role: locked.role },
            csrfToken: session.csrfToken, expiresAt: session.expiresAt }),
          maxAgeSeconds: session.maxAgeSeconds,
        };
        Object.defineProperty(result, 'sessionToken', { value: session.token, enumerable: false });
        return result as AcceptanceResult;
      });
    } catch (error) { throw translateAcceptanceError(error); }
  }

  /** Unlocked read with its own clock reading. It only refuses what is already impossible; the transaction decides again from scratch. */
  private async refuseEarly(tokenHash: Buffer): Promise<void> {
    try {
      const { row, exists } = await this.runner.run(async manager => {
        const rows = await manager.query(INSPECT_INVITATION_SQL, [tokenHash]) as InspectionDbRow[];
        const email = rows.length === 1 ? rows[0].email : null;
        const found = email === null ? [] : await manager.query(USER_EXISTS_BY_EMAIL_SQL, [email]) as unknown[];
        return { row: rows.length === 1 ? rows[0] : null, exists: found.length > 0 };
      });
      const decision = acceptanceDecision(row === null ? null : { createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at, acceptedAt: row.accepted_at }, this.clock.now());
      if (decision !== 'proceed') throw acceptanceFailure(decision);
      if (exists) throw new InvitationAcceptanceError('account_exists');
    } catch (error) { throw translateReadError(error); }
  }
}
