import { inspect } from 'node:util';
import * as registry from './secret-registry';
const { registerSecret, scrubText, activeSecretCount, resetSecretsForTests } = registry;
const secret = 'fake-password-for-unit-tests-0001';
afterEach(resetSecretsForTests);
it('cuenta referencias y libera una sola vez', () => {
  const a = registerSecret(secret), b = registerSecret(secret);
  expect(activeSecretCount()).toBe(1);
  a(); a();
  expect(scrubText(secret)).toBe('[REDACTED]');
  b();
  expect(activeSecretCount()).toBe(0);
  expect(scrubText(secret)).toBe(secret);
});
it.each(['a'.repeat(11), 'a'.repeat(257), null, 15])('ignora tamaño o tipo inválido %#', value => {
  registerSecret(value as string)();
  expect(activeSecretCount()).toBe(0);
});
it.each([12, 256])('acepta longitud %i', length => {
  registerSecret('a'.repeat(length));
  expect(scrubText('a'.repeat(length))).toBe('[REDACTED]');
});
it('limita a 32 valores y no incluye valores en el error', () => {
  for (let i = 0; i < 32; i++) registerSecret(`CANARIO_SECRETO_${i}`);
  expect(activeSecretCount()).toBe(32);
  expect(() => registerSecret('CANARIO_DESBORDE')).toThrow('Registro de secretos lleno.');
  expect(() => registerSecret('CANARIO_SECRETO_0')).not.toThrow();
});
it('restringe el reinicio a pruebas', () => {
  const old = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    expect(resetSecretsForTests).toThrow('Reinicio de secretos permitido solo en pruebas.');
  } finally { process.env.NODE_ENV = old; }
});
it.each([
  ['postgres://user:CANARIO_CLAVE@localhost/db', 'postgres://[REDACTED]@localhost/db'],
  ['password="CANARIO_CLAVE"', 'password=[REDACTED]'],
  ["token: 'CANARIO_TOKEN'", 'token: [REDACTED]'],
  ['Bearer CANARIO_TOKEN', 'Bearer [REDACTED]'],
  ['api-key=CANARIO_KEY', 'api-key=[REDACTED]'],
])('depura patrones %s', (input, expected) => expect(scrubText(input)).toBe(expected));
it('depura antes de truncar y no expone el mapa del módulo', () => {
  registerSecret(secret);
  expect(scrubText(secret + 'abcdef', 12)).toBe('[REDACTED]ab…');
  for (const output of [inspect(registry, { showHidden: true, depth: 8 }), JSON.stringify(registry), JSON.stringify(Object.keys(registry))]) expect(output).not.toContain(secret);
});
it('authorization con Bearer depura también el token completo', () => {
  expect(scrubText('authorization: Bearer CANARIO_AUTH')).toBe('authorization: [REDACTED]');
});
