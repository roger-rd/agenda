import type { Environment } from '../../config/env.validation';
import { isSessionToken } from '../../identity/session-token';

export type CookieEnvironment = Environment;
export type SessionCookieConfig =
  | { name: '__Host-agenda_session'; secure: true }
  | { name: 'agenda_session'; secure: false };

export function sessionCookieConfig(env: CookieEnvironment): SessionCookieConfig {
  if (env === 'production') return { name: '__Host-agenda_session', secure: true };
  if (env === 'development' || env === 'test') return { name: 'agenda_session', secure: false };
  throw new Error('Entorno de cookie inválido');
}

function cookieAttributes(config: SessionCookieConfig): string {
  if (!((config.name === '__Host-agenda_session' && config.secure === true) ||
      (config.name === 'agenda_session' && config.secure === false))) {
    throw new Error('Configuración de cookie inválida');
  }
  return `Path=/; HttpOnly; ${config.secure ? 'Secure; ' : ''}SameSite=Lax`;
}

export function serializeSessionCookie(config: SessionCookieConfig, token: string, maxAgeSeconds: number): string {
  if (!isSessionToken(token)) throw new Error('Token de sesión inválido');
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 2678400) {
    throw new Error('La duración de la cookie debe ser un entero entre 1 y 2678400 segundos');
  }
  return `${config.name}=${token}; ${cookieAttributes(config)}; Max-Age=${maxAgeSeconds}`;
}

export function serializeClearedSessionCookie(config: SessionCookieConfig): string {
  return `${config.name}=; ${cookieAttributes(config)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export type SessionCookieResult =
  | { status: 'absent' }
  | { status: 'ok'; token: string }
  | { status: 'invalid' }
  | { status: 'duplicate' };

export function readSessionCookie(header: unknown, name: string): SessionCookieResult {
  if (typeof header !== 'string') return { status: 'absent' };
  // Los tabs solo se permiten como espacio alrededor de cada par.
  if (header.length > 8192 || Array.from(header).some(char =>
    (char.charCodeAt(0) < 32 && char !== '\t') || char.charCodeAt(0) === 127)) return { status: 'invalid' };
  const pairs = header.split(';', 51);
  if (pairs.length > 50) return { status: 'invalid' };
  let count = 0;
  let token: string | undefined;
  for (const raw of pairs) {
    const pair = raw.replace(/^[ \t]+|[ \t]+$/g, '');
    if (pair.includes('\t')) return { status: 'invalid' };
    const separator = pair.indexOf('=');
    const pairName = separator === -1 ? pair : pair.slice(0, separator);
    if (pairName !== name) continue;
    count++;
    token = separator === -1 ? undefined : pair.slice(separator + 1);
  }
  if (count > 1) return { status: 'duplicate' };
  if (count === 0) return { status: 'absent' };
  return isSessionToken(token) ? { status: 'ok', token } : { status: 'invalid' };
}
