import { createHash } from 'node:crypto';
import { SESSION_TOKEN_BYTES, generateSessionToken, isSessionToken, hashSessionToken, deriveCsrfToken, verifyCsrfToken } from './session-token';

const token = Buffer.alloc(32).toString('base64url');
const malformed: unknown[] = [undefined, null, 1, {}, [], Buffer.alloc(32), '', token.slice(1), token + 'A',
  '+' + token.slice(1), '/' + token.slice(1), token + '=', token + '\n', token + '\r\n',
  ' ' + token, token.slice(0, -1) + ' ', token.slice(0, -1) + 'B', 'á' + token.slice(1)];

describe('Tokens de sesión y CSRF', () => {
  it('genera tokens canónicos únicos con aleatoriedad real', () => {
    const tokens = Array.from({ length: 1000 }, () => generateSessionToken());
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const value of tokens) {
      expect(value).toHaveLength(43);
      expect(isSessionToken(value)).toBe(true);
      expect(Buffer.from(value, 'base64url')).toHaveLength(SESSION_TOKEN_BYTES);
    }
  });
  it('solicita 32 bytes y admite un generador determinista', () => {
    let sequence = 0;
    const random = jest.fn((n: number) => Buffer.alloc(n, sequence++));
    const tokens = Array.from({ length: 256 }, () => generateSessionToken(random));
    expect(new Set(tokens).size).toBe(256);
    expect(tokens.every(isSessionToken)).toBe(true);
    expect(random).toHaveBeenCalledWith(32);
    expect(tokens[0]).toBe(token);
  });
  it.each([0, 31, 33, 64])('rechaza un generador que devuelve %i bytes', size => {
    expect(() => generateSessionToken(() => Buffer.alloc(size))).toThrow();
  });
  it('rechaza un resultado que no sea Buffer', () => {
    expect(() => generateSessionToken(() => new Uint8Array(32) as Buffer)).toThrow();
  });
  it.each(malformed)('rechaza entradas malformadas %# sin lanzar al verificar', value => {
    expect(isSessionToken(value)).toBe(false);
    expect(() => hashSessionToken(value as string)).toThrow();
    expect(() => deriveCsrfToken(value as string)).toThrow();
    expect(verifyCsrfToken(value, deriveCsrfToken(token))).toBe(false);
    expect(verifyCsrfToken(token, value)).toBe(false);
  });
  it('rechaza los tres valores no canónicos de los bits de relleno', () => {
    for (const last of ['B', 'C', 'D']) {
      const nonCanonical = token.slice(0, -1) + last;
      expect(Buffer.from(nonCanonical, 'base64url')).toEqual(Buffer.from(token, 'base64url'));
      expect(isSessionToken(nonCanonical)).toBe(false);
    }
  });
  it.each([Buffer.alloc(32), Buffer.alloc(32, 255), Buffer.from(Array.from({ length: 32 }, (_, i) => i))])(
    'coincide con vectores calculados localmente sobre bytes %#', bytes => {
      const value = bytes.toString('base64url');
      const expectedHash = createHash('sha256').update(bytes).digest();
      const expectedCsrf = createHash('sha256').update(Buffer.concat([Buffer.from('agenda-csrf-v1'), bytes])).digest('base64url');
      expect(hashSessionToken(value)).toEqual(expectedHash);
      // Debe coincidir con LIMITS.tokenHashBytes de persistence/constants (32).
      expect(hashSessionToken(value)).toHaveLength(32);
      expect(hashSessionToken(value)).not.toEqual(bytes);
      expect(hashSessionToken(value).toString('base64url')).not.toBe(value);
      expect(hashSessionToken(value)).toEqual(hashSessionToken(value));
      expect(deriveCsrfToken(value)).toBe(expectedCsrf);
      expect(isSessionToken(expectedCsrf)).toBe(true);
      expect(expectedCsrf).not.toBe(expectedHash.toString('base64url'));
      expect(verifyCsrfToken(value, expectedCsrf)).toBe(true);
    });
  it('deriva valores distintos por sesión y rechaza otro CSRF válido', () => {
    const other = Buffer.alloc(32, 1).toString('base64url');
    expect(deriveCsrfToken(token)).not.toBe(deriveCsrfToken(other));
    expect(verifyCsrfToken(token, deriveCsrfToken(other))).toBe(false);
    expect(verifyCsrfToken(token, token)).toBe(false);
  });
});
