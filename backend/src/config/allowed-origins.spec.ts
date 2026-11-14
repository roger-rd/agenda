import { parseAllowedOrigins } from './allowed-origins';
import { EnvironmentValidationError } from './validation-rules';

it('aplica los valores por defecto por entorno', () => {
  expect(parseAllowedOrigins(undefined, 'development')).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  expect(parseAllowedOrigins(undefined, 'test')).toEqual([]);
  expect(() => parseAllowedOrigins(undefined, 'production')).toThrow(EnvironmentValidationError);
});
it.each(['', 'http://agenda.test'])('producción rechaza %p', raw => {
  expect(() => parseAllowedOrigins(raw, 'production')).toThrow('APP_ALLOWED_ORIGINS:');
});
it('acepta https exactos y devuelve una lista inmutable', () => {
  const origins = parseAllowedOrigins('https://agenda.test,https://agenda.test:8443', 'production');
  expect(origins).toEqual(['https://agenda.test', 'https://agenda.test:8443']);
  expect(Object.isFrozen(origins)).toBe(true);
});
it.each(['https://a.test/ruta', 'https://a.test/', 'ftp://a.test', 'https://u:p@a.test',
  'https://a.test,https://a.test', 'https://a.test,', ' https://a.test', 'https://A.test', 'https://a.test:443', 42, null])('rechaza sin normalizar %p', raw => {
  expect(() => parseAllowedOrigins(raw, 'test')).toThrow(EnvironmentValidationError);
});
