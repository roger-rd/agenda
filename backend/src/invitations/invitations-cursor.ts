import { InvalidInputError } from '../common/errors/domain-error';

/** Keyset of `IX_invitations_org_created`: newest first by (created_at, id). created_at has millisecond precision (application clock). */
export interface InvitationsCursor { createdAt: Date; id: string }
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function encodeInvitationsCursor({ createdAt, id }: InvitationsCursor): string {
  return Buffer.from(JSON.stringify({ c: createdAt.toISOString(), i: id })).toString('base64url');
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
    if (typeof c !== 'string' || !ISO.test(c) || typeof i !== 'string' || !UUID_V7.test(i)) throw new Error();
    const createdAt = new Date(c);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== c) throw new Error();
    return { createdAt, id: i };
  } catch { throw new InvalidInputError('Datos de entrada inválidos.', 'cursor'); }
}
