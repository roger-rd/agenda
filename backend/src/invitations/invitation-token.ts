import { createHash, randomBytes } from 'node:crypto';
import { INVITATION_LINK_PATH } from './invitation-constants';

/**
 * Invitation token contract (shared by creation, renewal and acceptance):
 *  - 32 random bytes, shown once as 43 base64url characters; never stored in clear, never logged, never in a URL path or query.
 *  - Stored value: SHA-256 over a fixed domain prefix, a NUL separator and the 32 raw bytes. Session tokens hash the raw bytes
 *    alone, so the same bytes never produce the same stored hash in both tables: a session token cannot redeem an invitation
 *    and an invitation token cannot be used as a session.
 *  - The link carries the token in the fragment: `/invitacion#<token>`.
 */
export const INVITATION_TOKEN_BYTES = 32;
export const INVITATION_HASH_DOMAIN = 'agenda-invitation-token-v1';
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}(?![\s\S])/;

export function generateInvitationToken(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(INVITATION_TOKEN_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length !== INVITATION_TOKEN_BYTES) throw new Error('El generador debe devolver un Buffer de 32 bytes');
  return bytes.toString('base64url');
}

/** Canonical form only: 43 characters whose last one carries no stray bits, so one byte string has exactly one spelling. */
export function isInvitationToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_FORMAT.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
}

export function hashInvitationToken(token: string): Buffer {
  if (!isInvitationToken(token)) throw new Error('Token de invitación inválido');
  return createHash('sha256').update(INVITATION_HASH_DOMAIN).update(Buffer.from([0])).update(Buffer.from(token, 'base64url')).digest();
}

export function buildInvitationLink(token: string): string {
  if (!isInvitationToken(token)) throw new Error('Token de invitación inválido');
  return `${INVITATION_LINK_PATH}#${token}`;
}

/** Injectable source of tokens, so the service can be tested with fixed bytes. */
export abstract class InvitationTokens {
  abstract next(): string;
}
export class RandomInvitationTokens extends InvitationTokens {
  next(): string { return generateInvitationToken(); }
}
