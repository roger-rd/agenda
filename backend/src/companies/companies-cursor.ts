import { InvalidInputError } from '../common/errors/domain-error';

export interface CompaniesCursor { nameKey: string; id: string }
export function encodeCursor({ nameKey, id }: CompaniesCursor): string {
  return Buffer.from(JSON.stringify({ n: nameKey, i: id })).toString('base64url');
}
// No se firma: cada página reaplica la organización y los accesos de la sesión.
export function decodeCursor(text: string): CompaniesCursor {
  try {
    if (!text || text.length > 512 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error();
    const bytes = Buffer.from(text, 'base64url');
    if (bytes.toString('base64url') !== text) throw new Error();
    const json = bytes.toString('utf8');
    if (!Buffer.from(json).equals(bytes)) throw new Error();
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const keys = Object.keys(value);
    if (keys.length !== 2 || !keys.includes('n') || !keys.includes('i')) throw new Error();
    const { n, i } = value as { n: unknown; i: unknown };
    if (typeof n !== 'string' || [...n].length < 2 || [...n].length > 80 || n.trim() !== n || n.toLowerCase() !== n ||
        typeof i !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(i)) throw new Error();
    return { nameKey: n, id: i };
  } catch { throw new InvalidInputError('Datos de entrada inválidos.', 'cursor'); }
}
