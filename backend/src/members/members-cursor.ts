import { InvalidInputError } from '../common/errors/domain-error';

/**
 * Keyset over the member id, ascending. The ids are UUIDv7, so the order roughly follows creation, but the contract is only "order by
 * id": it does not promise an exact chronological order (ids from different instants of clocks may interleave).
 */
export interface MembersCursor { id: string }
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function encodeMembersCursor({ id }: MembersCursor): string {
  if (!UUID_V7.test(id)) throw new Error('Cursor de miembros inválido');
  return Buffer.from(JSON.stringify({ i: id })).toString('base64url');
}
// Not signed: every page re-applies the organization, the filters and the role of the session.
export function decodeMembersCursor(text: string): MembersCursor {
  try {
    if (!text || text.length > 512 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error();
    const bytes = Buffer.from(text, 'base64url');
    if (bytes.toString('base64url') !== text) throw new Error();
    const json = bytes.toString('utf8');
    if (!Buffer.from(json).equals(bytes)) throw new Error();
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== 'i') throw new Error();
    const { i } = value as { i: unknown };
    if (typeof i !== 'string' || !UUID_V7.test(i)) throw new Error();
    return { id: i };
  } catch { throw new InvalidInputError('Datos de entrada inválidos.', 'cursor'); }
}
