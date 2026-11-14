import type { Environment } from './env.validation';
import { EnvironmentValidationError } from './validation-rules';

export function parseAllowedOrigins(raw: unknown, env: Environment): readonly string[] {
  const value = raw === undefined
    ? env === 'development' ? 'http://localhost:5173,http://127.0.0.1:5173' : ''
    : raw;
  const fail = () => new EnvironmentValidationError('APP_ALLOWED_ORIGINS: debe contener orígenes exactos http o https, sin duplicados; en producción es obligatoria y solo admite https');
  if (typeof value !== 'string') throw fail();
  if (value === '') {
    if (env === 'production') throw fail();
    return Object.freeze([]);
  }
  const origins = value.split(',');
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw fail(); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin ||
        (env === 'production' && url.protocol !== 'https:')) throw fail();
  }
  if (new Set(origins).size !== origins.length) throw fail();
  return Object.freeze(origins);
}
