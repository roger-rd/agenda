import { createHash, randomBytes } from 'node:crypto';
import { hashSessionToken, generateSessionToken, isSessionToken } from '../identity/session-token';
import { buildInvitationLink, generateInvitationToken, hashInvitationToken, INVITATION_HASH_DOMAIN, INVITATION_TOKEN_BYTES, isInvitationToken } from './invitation-token';

const bytes = (fill: number) => Buffer.alloc(32, fill);

describe('token de invitación: generación', () => {
  it('son 32 bytes aleatorios en base64url canónico de 43 caracteres', () => {
    const token = generateInvitationToken();
    expect(INVITATION_TOKEN_BYTES).toBe(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isInvitationToken(token)).toBe(true);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });
  it('usa el generador recibido con exactamente 32 bytes y no repite valores', () => {
    const random = jest.fn((n: number) => bytes(7).subarray(0, n));
    expect(generateInvitationToken(random)).toBe(bytes(7).toString('base64url'));
    expect(random).toHaveBeenCalledWith(32);
    expect(new Set(Array.from({ length: 200 }, () => generateInvitationToken())).size).toBe(200);
  });
  it.each([Buffer.alloc(31), Buffer.alloc(33), Buffer.alloc(0), 'x' as unknown as Buffer])('rechaza un generador que no devuelve 32 bytes (%#)', value => {
    expect(() => generateInvitationToken(() => value)).toThrow('32 bytes');
  });
});

describe('token de invitación: formato canónico', () => {
  const valid = bytes(9).toString('base64url');
  it('acepta solo la ortografía canónica', () => expect(isInvitationToken(valid)).toBe(true));
  it.each([
    ['vacío', ''], ['corto', valid.slice(0, 42)], ['largo', valid + 'A'], ['relleno =', valid + '='], ['salto de línea', valid + '\n'],
    ['espacio', ' ' + valid.slice(1)], ['alfabeto base64 estándar', valid.slice(0, 40) + '+/A'], ['bits sobrantes', valid.slice(0, 42) + 'B'],
    ['número', 7], ['null', null], ['objeto', {}], ['arreglo', [valid]],
  ])('rechaza %s', (_n, value) => expect(isInvitationToken(value)).toBe(false));
});

describe('token de invitación: hash con separación de dominio', () => {
  it('es SHA-256 de dominio + NUL + los 32 bytes crudos, y mide 32 bytes', () => {
    const raw = randomBytes(32);
    const token = raw.toString('base64url');
    const expected = createHash('sha256').update(Buffer.concat([Buffer.from(INVITATION_HASH_DOMAIN), Buffer.from([0]), raw])).digest();
    expect(hashInvitationToken(token).equals(expected)).toBe(true);
    expect(hashInvitationToken(token)).toHaveLength(32) /* octet_length(token_hash) = 32 en la base */;
    expect(INVITATION_HASH_DOMAIN).toBe('agenda-invitation-token-v1');
  });
  it('es determinista y distinto para tokens distintos', () => {
    const a = bytes(1).toString('base64url'); const b = bytes(2).toString('base64url');
    expect(hashInvitationToken(a).equals(hashInvitationToken(a))).toBe(true);
    expect(hashInvitationToken(a).equals(hashInvitationToken(b))).toBe(false);
  });
  it('los mismos bytes no dan el mismo hash que una sesión: un token de sesión no canjea una invitación', () => {
    const session = generateSessionToken();
    expect(isSessionToken(session) && isInvitationToken(session)).toBe(true); // mismo formato: por eso importa el dominio
    expect(hashInvitationToken(session).equals(hashSessionToken(session))).toBe(false);
    expect(hashInvitationToken(session).equals(createHash('sha256').update(Buffer.from(session, 'base64url')).digest())).toBe(false);
  });
  it('no es el SHA-256 de la cadena del token ni del dominio sin separador', () => {
    const raw = bytes(5); const token = raw.toString('base64url');
    expect(hashInvitationToken(token).equals(createHash('sha256').update(token).digest())).toBe(false);
    expect(hashInvitationToken(token).equals(createHash('sha256').update(Buffer.concat([Buffer.from(INVITATION_HASH_DOMAIN), raw])).digest())).toBe(false);
  });
  it.each(['', 'abc', bytes(1).toString('base64url') + '=', 7 as unknown as string])('rechaza un token mal formado (%#) sin devolver un hash', value => {
    expect(() => hashInvitationToken(value)).toThrow('Token de invitación inválido');
  });
});

describe('enlace de invitación', () => {
  it('lleva el token en el fragmento, no en la ruta ni en la consulta', () => {
    const token = bytes(3).toString('base64url');
    const link = buildInvitationLink(token);
    expect(link).toBe(`/invitacion#${token}`);
    expect(new URL(link, 'https://app.agenda.test').search).toBe('');
    expect(new URL(link, 'https://app.agenda.test').pathname).toBe('/invitacion');
  });
  it('no construye un enlace con un token inválido', () => {
    expect(() => buildInvitationLink('malo')).toThrow('Token de invitación inválido');
  });
});
