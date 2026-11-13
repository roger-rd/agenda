import { sessionCookieConfig, serializeSessionCookie, serializeClearedSessionCookie, readSessionCookie } from './cookies';
import type { CookieEnvironment, SessionCookieConfig } from './cookies';

const token = Buffer.alloc(32).toString('base64url');
const name = 'agenda_session';
const config = sessionCookieConfig('test');

describe('Cookies de sesión', () => {
  it.each(['development', 'test', 'production'] as const)('serializa alta y borrado exactos en %s', env => {
    const production = env === 'production';
    const cookieName = production ? '__Host-agenda_session' : name;
    const attributes = `Path=/; HttpOnly; ${production ? 'Secure; ' : ''}SameSite=Lax`;
    const selected = sessionCookieConfig(env);
    expect(selected).toEqual({ name: cookieName, secure: production });
    for (const maxAge of [1, 2678400]) {
      const serialized = serializeSessionCookie(selected, token, maxAge);
      expect(serialized).toBe(`${cookieName}=${token}; ${attributes}; Max-Age=${maxAge}`);
      expect(serialized).not.toContain('Domain');
    }
    const cleared = serializeClearedSessionCookie(selected);
    expect(cleared).toBe(`${cookieName}=; ${attributes}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
    expect(cleared).not.toContain('Domain');
    expect(readSessionCookie(`${cookieName}=${token}`, selected.name)).toEqual({ status: 'ok', token });
  });
  it.each(['', 'staging', undefined, null, 1])('rechaza entorno inválido %#', env => {
    expect(() => sessionCookieConfig(env as CookieEnvironment)).toThrow();
  });
  it.each([0, -1, 2678401, 1.5, NaN, Infinity, '1', null, undefined])('rechaza duración inválida %#', age => {
    expect(() => serializeSessionCookie(config, token, age as number)).toThrow();
  });
  it.each(['', token + '\n', token + '=', token.slice(1), token.slice(0, -1) + 'B', undefined])('rechaza token inválido %#', value => {
    expect(() => serializeSessionCookie(config, value as string, 60)).toThrow();
  });
  it('rechaza configuraciones incoherentes y nombres inyectados', () => {
    for (const invalid of [{ name: '__Host-agenda_session', secure: false }, { name: 'otra; Domain=example.com', secure: true }]) {
      expect(() => serializeSessionCookie(invalid as SessionCookieConfig, token, 60)).toThrow();
      expect(() => serializeClearedSessionCookie(invalid as SessionCookieConfig)).toThrow();
    }
  });
  it.each([undefined, null, 1, {}, [], Buffer.from(''), '', 'otra=valor', 'sin_igual'])('detecta ausencia %#', header => {
    expect(readSessionCookie(header, name)).toEqual({ status: 'absent' });
  });
  it('encuentra el valor entre cookies ajenas y recorta espacios y tabs', () => {
    expect(readSessionCookie(` otra=a=b; sin_igual; \t${name}=${token}\t ; fin=%20`, name)).toEqual({ status: 'ok', token });
  });
  it.each(['', '"' + token + '"', '%41' + token.slice(1), token + '=', '+' + token.slice(1), '/' + token.slice(1),
    token.slice(1), token + 'A', token.slice(0, -1) + 'B', ' ' + token])('rechaza valor inválido %#', value => {
    expect(readSessionCookie(`${name}=${value}`, name)).toEqual({ status: 'invalid' });
  });
  it('rechaza el nombre de sesión sin igual', () => {
    expect(readSessionCookie(name, name)).toEqual({ status: 'invalid' });
  });
  it.each([`${name}=${token}; ${name}=${token}`, `${name}=; ${name}=${token}`, `${name}=${token}; ${name}=`,
    `${name}; ${name}=${token}`, `${name}=mal; ${name}=mal; ${name}=${token}`])('prioriza duplicado sobre valores inválidos %#', header => {
    expect(readSessionCookie(header, name)).toEqual({ status: 'duplicate' });
  });
  it('respeta el límite de 8192 caracteres', () => {
    const header = 'otra=' + 'a'.repeat(8192 - 5);
    expect(readSessionCookie(header, name)).toEqual({ status: 'absent' });
    expect(readSessionCookie(header + 'a', name)).toEqual({ status: 'invalid' });
  });
  it('respeta el límite de 50 pares', () => {
    const header = [...Array<string>(49).fill('otra=x'), `${name}=${token}`].join(';');
    expect(readSessionCookie(header, name)).toEqual({ status: 'ok', token });
    expect(readSessionCookie(header + ';otra=x', name)).toEqual({ status: 'invalid' });
    expect(readSessionCookie(';'.repeat(50), name)).toEqual({ status: 'invalid' });
  });
  it.each(['\0', '\n', '\r', '\x1f', '\x7f', '\v', '\f', '\t'])('rechaza controles internos incluso en cookies ajenas %#', control => {
    expect(readSessionCookie(`otra=a${control}b;${name}=${token}`, name)).toEqual({ status: 'invalid' });
  });
  it('rechaza salto de línea final', () => {
    expect(readSessionCookie(`${name}=${token}\n`, name)).toEqual({ status: 'invalid' });
  });
  it.each(['Agenda_session', 'agenda_session_extra', 'xagenda_session', '__Host-agenda_session', 'agenda%5fsession'])('no confunde nombres similares %#', other => {
    expect(readSessionCookie(`${other}=${token}`, name)).toEqual({ status: 'absent' });
  });
  it('no confunde el nombre de desarrollo con producción', () => {
    expect(readSessionCookie(`${name}=${token}`, '__Host-agenda_session')).toEqual({ status: 'absent' });
  });
});
