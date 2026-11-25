import { InvalidInputError } from '../common/errors/domain-error';

/**
 * Keyset of `IX_invitations_org_created`: newest first by (created_at, id).
 * PostgreSQL keeps microseconds in timestamptz while a JavaScript Date keeps milliseconds, so the cursor carries the instant as the
 * exact text PostgreSQL produced (`created_at_us`, six fractional digits) and hands the same text back as the comparison bound.
 * No Date is ever built from it for the comparison, so no microsecond is lost, whatever wrote the row.
 */
export interface InvitationsCursor { createdAt: string; id: string }
const MICRO_ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Calendar-valid instant with exactly six fractional digits (the day, hour and so on are checked through the millisecond part). */
export function isMicrosecondInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = MICRO_ISO.exec(value);
  if (!match) return false;
  const date = new Date(`${match[1]}Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString() === `${match[1]}Z`;
}

export function encodeInvitationsCursor({ createdAt, id }: InvitationsCursor): string {
  if (!isMicrosecondInstant(createdAt) || !UUID_V7.test(id)) throw new Error('Cursor de invitaciones inválido');
  return Buffer.from(JSON.stringify({ c: createdAt, i: id })).toString('base64url');
}
// Not signed: every page re-applies the organization and the role of the session.
export function decodeInvitationsCursor(text: string): InvitationsCursor {
  try {
    if (!text || text.length > 512 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error();
    const bytes = Buffer.from(text, 'base64url');
    if (bytes.toString('base64url') !== text) throw new Error();
    const json = bytes.toString('utf8');
    if (!Buffer.from(json).equals(bytes)) throw new Error();
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const keys = Object.keys(value);
    if (keys.length !== 2 || !keys.includes('c') || !keys.includes('i')) throw new Error();
    const { c, i } = value as { c: unknown; i: unknown };
    if (!isMicrosecondInstant(c) || typeof i !== 'string' || !UUID_V7.test(i)) throw new Error();
    return { createdAt: c, id: i };
  } catch { throw new InvalidInputError('Datos de entrada inválidos.', 'cursor'); }
}
