import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_TOKEN_BYTES = 32;

export function generateSessionToken(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(SESSION_TOKEN_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length !== SESSION_TOKEN_BYTES) {
    throw new Error('El generador debe devolver un Buffer de 32 bytes');
  }
  return bytes.toString('base64url');
}

export function isSessionToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}(?![\s\S])/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}

function sessionTokenBytes(token: string): Buffer {
  if (!isSessionToken(token)) throw new Error('Token de sesión inválido');
  return Buffer.from(token, 'base64url');
}

export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(sessionTokenBytes(token)).digest();
}

export function deriveCsrfToken(token: string): string {
  return createHash('sha256').update('agenda-csrf-v1').update(sessionTokenBytes(token)).digest('base64url');
}

export function verifyCsrfToken(sessionToken: unknown, presented: unknown): boolean {
  if (!isSessionToken(sessionToken) || !isSessionToken(presented)) return false;
  return timingSafeEqual(Buffer.from(deriveCsrfToken(sessionToken), 'base64url'), Buffer.from(presented, 'base64url'));
}
