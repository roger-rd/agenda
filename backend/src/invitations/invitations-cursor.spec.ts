import { InvalidInputError } from '../common/errors/domain-error';
import { decodeInvitationsCursor, encodeInvitationsCursor } from './invitations-cursor';

const id = '01900000-0000-7000-8000-00000000000a';
const createdAt = '2026-11-25T12:34:56.789123Z';
const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('cursor de invitaciones estricto', () => {
  it('ida y vuelta con los seis decimales exactos y forma exacta', () => {
    const text = encodeInvitationsCursor({ createdAt, id });
    expect(text).toBe(raw({ c: '2026-11-25T12:34:56.789123Z', i: id }));
    expect(decodeInvitationsCursor(text)).toEqual({ createdAt, id });
  });
  it('conserva los microsegundos: dos instantes del mismo milisegundo dan cursores distintos', () => {
    const a = encodeInvitationsCursor({ createdAt: '2026-11-25T12:34:56.789001Z', id });
    const b = encodeInvitationsCursor({ createdAt: '2026-11-25T12:34:56.789999Z', id });
    expect(a).not.toBe(b);
    expect(decodeInvitationsCursor(a).createdAt).toBe('2026-11-25T12:34:56.789001Z');
    expect(decodeInvitationsCursor(b).createdAt).toBe('2026-11-25T12:34:56.789999Z');
  });
  it('cubre los extremos del año, de los milisegundos y de los microsegundos', () => {
    for (const iso of ['2026-01-01T00:00:00.000000Z', '2026-12-31T23:59:59.999999Z', '2028-02-29T00:00:00.000001Z']) {
      const value = { createdAt: iso, id };
      expect(decodeInvitationsCursor(encodeInvitationsCursor(value))).toEqual(value);
    }
  });
  it('no codifica un valor mal formado', () => {
    expect(() => encodeInvitationsCursor({ createdAt: '2026-11-25T12:34:56.789Z', id })).toThrow('Cursor de invitaciones inválido');
    expect(() => encodeInvitationsCursor({ createdAt, id: 'x' })).toThrow('Cursor de invitaciones inválido');
  });
  it.each([
    '', '!', 'a'.repeat(513), 'e31', raw(null), raw([]), raw({ c: createdAt }), raw({ i: id }),
    raw({ c: createdAt, i: id, extra: true }), raw({ c: 5, i: id }), raw({ c: createdAt, i: 4 }),
    raw({ c: '2026-11-25T12:34:56Z', i: id }), raw({ c: '2026-11-25T12:34:56.78Z', i: id }), raw({ c: '2026-11-25T12:34:56.789Z', i: id }), raw({ c: '2026-11-25T12:34:56.7891Z', i: id }), raw({ c: '2026-11-25T12:34:56.7891234Z', i: id }), raw({ c: '2026-11-25 12:34:56.789123Z', i: id }),
    raw({ c: '2026-11-25T12:34:56.789123+01:00', i: id }), raw({ c: '2026-02-30T12:34:56.789123Z', i: id }), raw({ c: '2026-13-01T00:00:00.000000Z', i: id }), raw({ c: '2026-11-25T24:00:00.000000Z', i: id }),
    raw({ c: 'no-es-fecha', i: id }), raw({ c: createdAt, i: id.replace('-7000-', '-4000-') }),
    raw({ c: createdAt, i: id.replace('-8000-', '-c000-') }), raw({ c: createdAt, i: id.toUpperCase() }),
    raw({ c: createdAt, i: id }) + '=', Buffer.from('{').toString('base64url'),
  ])('rechaza %p con el campo cursor', text => {
    expect(() => decodeInvitationsCursor(text)).toThrow(InvalidInputError);
    try { decodeInvitationsCursor(text); } catch (error) {
      expect(error).toMatchObject({ message: 'Datos de entrada inválidos.', field: 'cursor' });
    }
  });
  it('no filtra el contenido del cursor en el error', () => {
    try { decodeInvitationsCursor(raw({ c: 'secreto-7Q', i: id })); } catch (error) {
      expect(JSON.stringify(error)).not.toContain('secreto-7Q'); expect(String((error as Error).message)).not.toContain('secreto-7Q');
    }
  });
});
