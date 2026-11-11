import { normalizeEmail } from './email';

describe('normalizeEmail', () => {
  const valid = ['A@B.C', ' \t\n\r\f\vUser.Name+tag@EXAMPLE.COM \t\n\r\f\v',
    "!#$%&'*+/=?^_`{|}~-@a.b", 'a@sub-domain.example', 'a@1.2',
    'a'.repeat(64) + '@b.co', 'a@' + 'b'.repeat(63) + '.co',
    'a'.repeat(64) + '@' + 'b'.repeat(53) + '.c'];
  it.each(valid)('normaliza ASCII válido %# y es idempotente', input => {
    const result = normalizeEmail(input);
    expect(result).not.toBeNull();
    expect(result).toBe(input.trim().toLowerCase());
    expect(normalizeEmail(result)).toBe(result);
  });
  it.each([undefined, null, 1, {}, '', 'a@b', 'a@@b.c', '@b.c', 'a@', 'á@b.c', 'a@例.com',
    '\u00a0a@b.c', 'a@b.c\u00a0', 'a b@c.d', 'a\tb@c.d', 'a\nb@c.d', 'a\0@b.c', 'a\x7f@b.c',
    'a\x1f@b.c', '\ud800@b.c', '.a@b.c', 'a.@b.c', 'a..b@c.d', 'a@b', 'a@.b.c', 'a@b..c',
    'a@b.c.', 'a@-b.c', 'a@b-.c', 'a@b_c.d', 'a:b@c.d', '"a"@b.c', 'a@b/c.d',
    'a'.repeat(65) + '@b.c', 'a@' + 'b'.repeat(64) + '.c',
    'a'.repeat(64) + '@' + 'b'.repeat(54) + '.c'])('rechaza entrada inválida %#', input => {
    expect(normalizeEmail(input)).toBeNull();
  });
  it('límites totales 3/120/121; tres caracteres no permiten dominio de dos etiquetas', () => {
    expect(normalizeEmail('a@b')).toBeNull();
    const longest = 'a'.repeat(64) + '@' + 'b'.repeat(53) + '.c';
    expect(longest).toHaveLength(120);
    expect(normalizeEmail(longest)).toBe(longest);
    expect(normalizeEmail(longest + 'c')).toBeNull();
  });
});
