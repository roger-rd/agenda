import { InvalidInputError } from '../common/errors/domain-error';
import { decodeCursor, encodeCursor } from './companies-cursor';

const id = '01900000-0000-7000-8000-000000000001';
const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
describe('cursor de empresas estricto', () => {
  it.each(['ab', 'a'.repeat(80), 'ñá', '😀'.repeat(80)])('ida y vuelta en los límites: %s', nameKey => {
    expect(decodeCursor(encodeCursor({ nameKey, id }))).toEqual({ nameKey, id });
    expect(encodeCursor({ nameKey, id })).toBe(raw({ n: nameKey, i: id }));
  });
  it.each(['', '!', 'a'.repeat(513), 'e31', raw(null), raw([]), raw({ n: 'ab' }),
    raw({ n: 'ab', i: id, extra: true }), raw({ n: 22, i: id }), raw({ n: 'a', i: id }),
    raw({ n: 'a'.repeat(81), i: id }), raw({ n: 'Ab', i: id }), raw({ n: ' ab', i: id }),
    raw({ n: 'ab ', i: id }), raw({ n: 'ab', i: id.replace('-7000-', '-4000-') }),
    raw({ n: 'ab', i: id.replace('-8000-', '-c000-') }), raw({ n: 'ab', i: id.replace('0190', 'ABCD') }),
    raw({ n: 'ab', i: 4 }), raw({ n: 'ab', i: id }) + '=', Buffer.from('{').toString('base64url'),
  ])('rechaza %p con el campo cursor', text => {
    expect(() => decodeCursor(text)).toThrow(InvalidInputError);
    try { decodeCursor(text); } catch (error) {
      expect(error).toMatchObject({ message: 'Datos de entrada inválidos.', field: 'cursor' });
    }
  });
});
