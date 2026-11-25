import type { InvitationStatus } from './invitation-constants';

export interface InvitationStateFields { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }

/**
 * Accepted wins, then revoked, then expired (at the exact expiry instant it is already expired), otherwise open.
 * The schema forbids accepted and revoked together, but precedence is still defined for any input.
 */
export function invitationStatus(row: InvitationStateFields, now: Date): InvitationStatus {
  if (row.acceptedAt !== null) return 'accepted';
  if (row.revokedAt !== null) return 'revoked';
  return row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'open';
}

/** Revoke is idempotent on a revoked invitation and conflicts on an accepted one; open and expired ones are revoked. */
export type RevokeDecision = 'revoke' | 'already_revoked' | 'conflict';
export function revokeDecision(status: InvitationStatus): RevokeDecision {
  return status === 'revoked' ? 'already_revoked' : status === 'accepted' ? 'conflict' : 'revoke';
}

/** Renew replaces an open or expired invitation; an accepted or revoked one is never renewed. */
export type RenewDecision = 'renew' | 'conflict';
export function renewDecision(status: InvitationStatus): RenewDecision {
  return status === 'open' || status === 'expired' ? 'renew' : 'conflict';
}
