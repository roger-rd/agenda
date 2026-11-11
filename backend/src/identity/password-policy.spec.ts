import { preparePassword } from './password-policy';

describe('preparePassword', () => {
  it.each([undefined, null, 1, {}, [], true, 'a'.repeat(14), 'a'.repeat(129), '\ud800'.repeat(15), '\udc00'.repeat(15), 'a'.repeat(15) + '\0'])('rechaza entrada inválida %#', input => {
    const result = preparePassword(input);
    expect(result.ok).toBe(false);
    expect(Object.keys(result)).toEqual(['ok', 'reason']);
  });
  it.each([15, 128])('acepta %i puntos de código incluso emoji', length => {
    for (const character of ['a', '😀']) {
      expect(preparePassword(character.repeat(length))).toEqual({ ok: true, value: character.repeat(length) });
    }
  });
  it.each([14, 129])('rechaza %i emoji', length => {
    expect(preparePassword('😀'.repeat(length)).ok).toBe(false);
  });
  it('normaliza antes de contar y conserva todos los espacios', () => {
    expect(preparePassword('e\u0301'.repeat(14)).ok).toBe(false);
    expect(preparePassword('e\u0301'.repeat(15))).toEqual({ ok: true, value: 'é'.repeat(15) });
    expect(preparePassword(' '.repeat(15))).toEqual({ ok: true, value: ' '.repeat(15) });
    expect(preparePassword(' a'.repeat(8) + ' ')).toEqual({ ok: true, value: ' a'.repeat(8) + ' ' });
  });
});
