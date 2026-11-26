import { deriveCsrfToken, hashSessionToken } from '../identity/session-token';
import { SESSION_POLICY } from './session-policy';

/**
 * Single source of the session policy at creation: used by the login (through the entity insert) and by the acceptance of an
 * invitation (through INSERT_SESSION_SQL). Pure: no persistence imports, no clock and no random source of its own. It does not
 * rotate or revoke anything: the login keeps its own rotation of the presented session.
 */
export interface SessionRow {
  id: string; tokenHash: Buffer; userId: string; activeOrganizationId: string | null;
  createdAt: Date; lastSeenAt: Date; expiresAt: Date; revokedAt: null;
}
export interface SessionIssue { token: string; csrfToken: string; expiresAt: Date; maxAgeSeconds: number; row: SessionRow }

export function issueSession(input: { now: Date; token: string; id: string; userId: string; activeOrganizationId: string | null }): SessionIssue {
  const maxAgeSeconds = Math.min(SESSION_POLICY.idleSeconds, SESSION_POLICY.absoluteSeconds);
  const expiresAt = new Date(input.now.getTime() + maxAgeSeconds * 1000);
  return {
    token: input.token, csrfToken: deriveCsrfToken(input.token), expiresAt, maxAgeSeconds,
    row: { id: input.id, tokenHash: hashSessionToken(input.token), userId: input.userId, activeOrganizationId: input.activeOrganizationId,
      createdAt: input.now, lastSeenAt: input.now, expiresAt, revokedAt: null },
  };
}

/** $1 id, $2 token hash, $3 user, $4 active organization, $5 created and last seen, $6 expiry; never revoked at creation. */
export const INSERT_SESSION_SQL = 'INSERT INTO public.user_sessions (id, token_hash, user_id, active_organization_id, created_at, last_seen_at, expires_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $5, $6, NULL)';
export function sessionInsertParams(row: SessionRow): unknown[] {
  return [row.id, row.tokenHash, row.userId, row.activeOrganizationId, row.createdAt, row.expiresAt];
}
