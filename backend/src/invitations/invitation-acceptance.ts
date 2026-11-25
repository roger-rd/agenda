import { DomainError, InvalidInputError } from '../common/errors/domain-error';
import { readSessionCookie, type SessionCookieResult } from '../common/http/cookies';
import { normalizePersonName } from '../identity/person-name';
import { preparePassword } from '../identity/password-policy';
import type { InvitationRole } from './invitation-constants';
import { clockBeforeCreationError, InvitationAcceptanceError } from './invitation-acceptance-errors';
import { isInvitationToken } from './invitation-token';

/* ------------------------------------------- token and input ------------------------------------------- */

/** The canonical 43-character token, exactly as issued (no trimming, no case or alphabet repair), or null. */
export function normalizeInvitationToken(input: unknown): string | null { return isInvitationToken(input) ? input : null; }

export type AcceptanceInput = { ok: true; token: string; name: string; password: string } | { ok: false; error: DomainError };
/**
 * Order is part of the contract: token first, then name, then password, all before touching the database or the hasher.
 *  - a token that is not canonical is the uniform 404 whatever the rest says, so a malformed link never reveals which field was wrong;
 *  - well-formed tokens never consult the database before a 400, so a 400 says nothing about whether a token exists;
 *  - the password comes back NFC-normalized, ready to hash; the name collapsed, as in registration.
 */
export function normalizeAcceptance(input: { token: unknown; name: unknown; password: unknown }): AcceptanceInput {
  const token = normalizeInvitationToken(input.token);
  if (token === null) return { ok: false, error: new InvitationAcceptanceError('invitation_unavailable') };
  const name = normalizePersonName(input.name);
  if (name === null) return { ok: false, error: new InvalidInputError('Datos de entrada inválidos.', 'name') };
  const password = preparePassword(input.password);
  if (!password.ok) return { ok: false, error: new InvalidInputError('Datos de entrada inválidos.', 'password') };
  return { ok: true, token, name, password: password.value };
}

/* --------------------------------------- previous session cookie --------------------------------------- */

/**
 * Accepting an invitation with a new account requires NO session cookie. Exact contract:
 *  - absent (no Cookie header, or none named like the session cookie)               -> proceed;
 *  - a valid cookie, an invalid one (empty value, malformed token, control characters, header too long) or a duplicated one
 *                                                                                   -> 409 session_active, before the body is validated,
 *    before any hashing and before any write.
 * A rejection emits no Set-Cookie, revokes nothing and replaces nothing: the person must log out first (logout clears the cookie
 * whatever state it is in). The check runs as a guard, after Origin and the JSON content type and before the validation pipe.
 */
export type CookieGate =
  | { proceed: true }
  | { proceed: false; error: InvitationAcceptanceError; setCookie: false; revokeSession: false };
export function acceptanceCookieGate(cookie: SessionCookieResult): CookieGate {
  return cookie.status === 'absent'
    ? { proceed: true }
    : { proceed: false, error: new InvitationAcceptanceError('session_active'), setCookie: false, revokeSession: false };
}
export function acceptanceCookieGateFromHeader(header: unknown, cookieName: string): CookieGate {
  return acceptanceCookieGate(readSessionCookie(header, cookieName));
}

/* -------------------------------------------- state decisions -------------------------------------------- */

export interface LockedInvitation {
  id: string; organizationId: string; email: string; role: InvitationRole;
  createdAt: Date; expiresAt: Date; revokedAt: Date | null; acceptedAt: Date | null;
}
export type AcceptanceDecision = 'proceed' | 'unavailable' | 'expired' | 'clock_before_creation';
/**
 * Evaluated with the row locked and a clock read AFTER the lock was acquired (a wait can cross the expiry). Precedence: no row,
 * accepted or revoked -> unavailable; a clock earlier than created_at -> controlled failure (never hidden with GREATEST: it would
 * risk an acceptance mark outside the validity window); expires_at <= now -> expired; otherwise proceed.
 */
export function acceptanceDecision(row: LockedInvitation | null, now: Date): AcceptanceDecision {
  if (row === null || row.acceptedAt !== null || row.revokedAt !== null) return 'unavailable';
  if (now.getTime() < row.createdAt.getTime()) return 'clock_before_creation';
  return row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'proceed';
}
/** The error for a decision that is not 'proceed'. */
export function acceptanceFailure(decision: Exclude<AcceptanceDecision, 'proceed'>): DomainError {
  switch (decision) {
    case 'unavailable': return new InvitationAcceptanceError('invitation_unavailable');
    case 'expired': return new InvitationAcceptanceError('invitation_expired');
    case 'clock_before_creation': return clockBeforeCreationError();
  }
}
/** accepted_at is exactly the lock-time reading, valid only when created_at <= now < expires_at (CK_invitations_times). */
export function acceptanceInstant(row: LockedInvitation, now: Date): Date {
  if (acceptanceDecision(row, now) !== 'proceed') throw new Error('Instante de aceptación fuera de vigencia');
  return new Date(now.getTime());
}

/* ------------------------------------------------ views ------------------------------------------------ */

export interface InspectionRow {
  organizationName: string; role: InvitationRole; email: string; companyNames: readonly string[];
  createdAt: Date; expiresAt: Date; revokedAt: Date | null; acceptedAt: Date | null;
}
export type InspectionView =
  | { status: 'open'; organization: { name: string }; role: InvitationRole; companies: { name: string }[]; email: string; expiresAt: string }
  | { status: 'expired' }
  | { status: 'unavailable' };
/**
 * Public, read-only. unknown, malformed, accepted and revoked collapse into `unavailable`, so the response is not an oracle for token
 * format or state; `expired` is only reachable with a real token. A clock earlier than created_at is `unavailable` (acceptance would
 * fail, so it is not promised). Carries no ids and no information about accounts.
 */
export function inspectionView(row: InspectionRow | null, now: Date): InspectionView {
  if (row === null || row.acceptedAt !== null || row.revokedAt !== null || now.getTime() < row.createdAt.getTime()) return { status: 'unavailable' };
  if (row.expiresAt.getTime() <= now.getTime()) return { status: 'expired' };
  return {
    status: 'open', organization: { name: row.organizationName }, role: row.role, email: row.email, expiresAt: row.expiresAt.toISOString(),
    companies: [...row.companyNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(name => ({ name })),
  };
}

/** Body of the 201: the same identity fields as the login, never a token (the session token travels only in the cookie). */
export interface AcceptanceResponse {
  user: { id: string; email: string; name: string };
  organization: { id: string; name: string };
  membership: { id: string; role: InvitationRole };
  csrfToken: string;
  expiresAt: string;
}
export function acceptanceResponse(input: {
  user: { id: string; email: string; name: string }; organization: { id: string; name: string };
  membership: { id: string; role: InvitationRole }; csrfToken: string; expiresAt: Date;
}): AcceptanceResponse {
  return {
    user: { id: input.user.id, email: input.user.email, name: input.user.name },
    organization: { id: input.organization.id, name: input.organization.name },
    membership: { id: input.membership.id, role: input.membership.role },
    csrfToken: input.csrfToken, expiresAt: input.expiresAt.toISOString(),
  };
}
