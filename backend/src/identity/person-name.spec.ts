import { normalizePersonName, organizationNameKey } from './person-name';

describe('nombres Unicode', () => {
  it.each([null, undefined, 12, {}, '', 'a', '\ud800', '\udc00', 'A\tB', 'A\nB', 'A\rB', 'A\u200dB', 'A\u202eB', 'A\ue000B', 'A\u0378B', '😀'.repeat(81)])('rechaza %p', input => {
    expect(normalizePersonName(input)).toBeNull();
  });
  it.each([
    ['  Ana\u00a0\u2003María  ', 'Ana María'], ['Jose\u0301', 'José'],
    ['A\u2028\u2029B', 'A B'], ['😀😀', '😀😀'], ['😀'.repeat(80), '😀'.repeat(80)],
  ])('normaliza e idempotencia %p', (input, expected) => {
    expect(normalizePersonName(input)).toBe(expected);
    expect(normalizePersonName(expected)).toBe(expected);
  });
  it.each([['  ÁCME\u00a0  Sur ', 'acme sur'], ['ﬃ Co', 'ffi co'], ['École', 'ecole'], ['E\u0301cole', 'ecole'], ['😀😀', '😀😀'], ['A'.repeat(80), 'a'.repeat(80)]])('pliega solo claves de organizaciones %p', (input, expected) => {
    const key = organizationNameKey(input);
    expect(key).toBe(expected);
    expect(organizationNameKey(expected)).toBe(expected);
    expect(expected.toLowerCase()).toBe(expected);
    expect(expected).toBe(expected.trim());
    expect(expected).not.toContain('  ');
  });
  it.each(['a', 'Á', 'ﬃ'.repeat(27), 'a'.repeat(81), '\u0301\u0302'])('rechaza clave fuera de longitud %p', name => {
    expect(organizationNameKey(name)).toBeNull();
  });
});
