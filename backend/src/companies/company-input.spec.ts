import { normalizeCompanyColor, normalizeCompanyName } from './company-input';

describe('normalización pura de empresas', () => {
  it.each([
    ['  CAFÉ\u00a0\u2003Niño  ', 'CAFÉ Niño', 'cafe nino'],
    ['МОСКВА', 'МОСКВА', 'москва'], ['Αθήνα', 'Αθήνα', 'αθηνα'], ['東京', '東京', '東京'],
    ['Cafe\u0301', 'Café', 'cafe'], ['ﬁrma', 'ﬁrma', 'firma'],
  ])('normaliza %p sin perder el nombre público', (input, name, nameKey) => {
    expect(normalizeCompanyName(input)).toEqual({ name, nameKey });
    expect([...nameKey].length).toBeGreaterThanOrEqual(2);
    expect(nameKey).toBe(nameKey.toLowerCase());
  });
  it.each([null, undefined, 42, {}, [], true, '', 'a', 'ﬁ', 'a\nB', 'a\tB', 'a\u0000B', 'a\u007fB', 'a\u200bB', '\ud800a', 'a\udfff', 'a\u0301'])('rechaza %p', input => {
    expect(normalizeCompanyName(input)).toBeNull();
  });
  it.each(['a', '😀'])('cuenta puntos de código con %s', char => {
    for (const length of [1, 2, 80, 81]) {
      const input = char.repeat(length);
      expect(normalizeCompanyName(input)).toEqual(length === 1 || length === 81 ? null : { name: input, nameKey: input });
    }
  });
  it('rechaza una clave menor de dos caracteres aunque el nombre tenga dos puntos', () => {
    expect(normalizeCompanyName('a\u0338')).toBeNull();
  });
  it('conserva las colisiones esperadas de tildes, espacios y ligaturas', () => {
    expect(['Café', 'cafe', '  CAFÉ  '].map(value => normalizeCompanyName(value)?.nameKey)).toEqual(['cafe', 'cafe', 'cafe']);
    expect(normalizeCompanyName('ﬁn')?.nameKey).toBe(normalizeCompanyName('fin')?.nameKey);
  });
  it.each([['#AABBCC', '#aabbcc'], ['#aB09Ff', '#ab09ff'], ['#000000', '#000000']])('color %s en minúsculas', (input, expected) => {
    expect(normalizeCompanyColor(input)).toBe(expected);
  });
  it.each(['#fff', '#GGGGGG', 'aabbcc', 'rgb(1,2,3)', ' #aabbcc', '#aabbcc ', '#aabbcc\n', '#aabbcc\r', null, undefined, 1, {}, []])('rechaza color %p', input => {
    expect(normalizeCompanyColor(input)).toBeNull();
  });
});
