import { InvalidInputError } from '../common/errors/domain-error';
import { decodeInvitationsCursor, encodeInvitationsCursor } from './invitations-cursor';

const id = '01900000-0000-7000-8000-00000000000a';
const createdAt = new Date('2026-11-25T12:34:56.789Z');
const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('cursor de invitaciones estricto', () => {
  it('ida y vuelta con milisegundos y forma exacta', () => {
    const text = encodeInvitationsCursor({ createdAt, id });
    expect(text).toBe(raw({ c: '2026-11-25T12:34:56.789Z', i: id }));
    expect(decodeInvitationsCursor(text)).toEqual({ createdAt, id });
    expect(decodeInvitationsCursor(text).createdAt.getTime()).toBe(createdAt.getTime());
  });
  it('cubre los extremos del año y de los milisegundos', () => {
    for (const iso of ['2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z']) {
      const value = { createdAt: new Date(iso), id };
      expect(decodeInvitationsCursor(encodeInvitationsCursor(value))).toEqual(value);
    }
  });
  it.each([
    '', '!', 'a'.repeat(513), 'e31', raw(null), raw([]), raw({ c: '2026-11-25T12:34:56.789Z' }), raw({ i: id }),
    raw({ c: '2026-11-25T12:34:56.789Z', i: id, extra: true }), raw({ c: 5, i: id }), raw({ c: '2026-11-25T12:34:56.789Z', i: 4 }),
    raw({ c: '2026-11-25T12:34:56Z', i: id }), raw({ c: '2026-11-25T12:34:56.78Z', i: id }), raw({ c: '2026-11-25 12:34:56.789Z', i: id }),
    raw({ c: '2026-11-25T12:34:56.789+01:00', i: id }), raw({ c: '2026-02-30T12:34:56.789Z', i: id }), raw({ c: '2026-13-01T00:00:00.000Z', i: id }),
    raw({ c: 'no-es-fecha', i: id }), raw({ c: '2026-11-25T12:34:56.789Z', i: id.replace('-7000-', '-4000-') }),
    raw({ c: '2026-11-25T12:34:56.789Z', i: id.replace('-8000-', '-c000-') }), raw({ c: '2026-11-25T12:34:56.789Z', i: id.toUpperCase() }),
    raw({ c: '2026-11-25T12:34:56.789Z', i: id }) + '=', Buffer.from('{').toString('base64url'),
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
