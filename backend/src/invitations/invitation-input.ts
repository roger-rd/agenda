import { normalizeEmail } from '../identity/email';
import { DAY_MS, DEFAULT_INVITATION_VALIDITY_DAYS, INVITATION_MAX_COMPANIES, INVITATION_MIN_COMPANIES, INVITATION_VALIDITY_DAYS, type InvitationValidityDays } from './invitation-constants';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Same identity rules as registration: ASCII only, lower-cased, 3 to 120 characters. */
export function normalizeInvitationEmail(input: unknown): string | null {
  return normalizeEmail(input);
}

/** 1 to 50 canonical UUIDv7 values, all different. Returns the list unchanged, or null if any rule fails; it never reorders or fixes values. */
export function normalizeCompanyIds(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length < INVITATION_MIN_COMPANIES || input.length > INVITATION_MAX_COMPANIES) return null;
  if (!input.every((id): id is string => typeof id === 'string' && UUID_V7.test(id))) return null;
  return new Set(input).size === input.length ? [...input] : null;
}

/** Absent means the default. Any value outside 1, 7 or 30 (a string, 0, 7.5, null) is rejected, not coerced. */
export function normalizeValidityDays(input: unknown): InvitationValidityDays | null {
  if (input === undefined) return DEFAULT_INVITATION_VALIDITY_DAYS;
  return INVITATION_VALIDITY_DAYS.find(days => days === input) ?? null;
}

/** Fixed 24-hour days from the clock reading; the result is always strictly after `now`. */
export function computeExpiresAt(now: Date, days: InvitationValidityDays): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('Fecha inválida');
  return new Date(now.getTime() + days * DAY_MS);
}
