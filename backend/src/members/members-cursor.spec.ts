import { InvalidInputError } from '../common/errors/domain-error';
import { decodeMembersCursor, encodeMembersCursor } from './members-cursor';

const id = '01900000-0000-7000-8000-00000000000a';
const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('cursor de miembros (orden por id, sin promesa cronológica)', () => {
  it('ida y vuelta con la forma exacta', () => {
    expect(encodeMembersCursor({ id })).toBe(raw({ i: id }));
    expect(decodeMembersCursor(encodeMembersCursor({ id }))).toEqual({ id });
  });
  it('no codifica ids no canónicos', () => {
    for (const bad of ['x', id.toUpperCase(), id.replace('-7000-', '-4000-')]) expect(() => encodeMembersCursor({ id: bad })).toThrow('Cursor de miembros inválido');
  });
  it.each(['', '!', 'a'.repeat(513), raw(null), raw([]), raw({}), raw({ i: id, n: 'x' }), raw({ n: id }), raw({ i: 5 }), raw({ i: id.toUpperCase() }),
    raw({ i: id.replace('-7000-', '-4000-') }), raw({ i: id.replace('-8000-', '-c000-') }), raw({ i: id }) + '=', Buffer.from('{').toString('base64url')])(
    'rechaza %p con el campo cursor', text => {
      expect(() => decodeMembersCursor(text)).toThrow(InvalidInputError);
      try { decodeMembersCursor(text); } catch (error) { expect(error).toMatchObject({ message: 'Datos de entrada inválidos.', field: 'cursor' }); }
    });
});
