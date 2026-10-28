import { format, inspect } from 'node:util';
import { DatabaseConnectionConfig, DatabaseCredentials } from './database-credentials';

it('protege las credenciales en serialización, inspección y copias', () => {
  const password = 'fake-password-for-unit-tests-0001';
  const credentials = new DatabaseCredentials('agenda_test_app', password);
  const config = new DatabaseConnectionConfig('localhost', 5433, 'agenda_test', credentials, 5);
  for (const value of [credentials, config, { nested: { config } }]) {
    const outputs = [String(value), `${value}`, JSON.stringify(value), inspect(value, { showHidden: true, depth: 100 }),
      inspect(value, { showHidden: true, depth: 100, customInspect: false }),
      ...['%s', '%j', '%o'].map(pattern => format(pattern, value)),
      JSON.stringify({ ...value }), JSON.stringify(Object.keys(value)), JSON.stringify(Object.values(value)),
      JSON.stringify(Object.entries(value)), JSON.stringify(structuredClone(value))];
    for (const output of outputs) expect(output.includes(password)).toBe(false);
  }
  expect(credentials.revealPassword() === password).toBe(true);
  expect(String(credentials)).toBe('agenda_test_app:[REDACTED]');
  expect(credentials.toJSON()).toEqual({ user: 'agenda_test_app', password: '[REDACTED]' });
  expect(config.describe()).toBe('agenda_test_app@localhost:5433/agenda_test');
  expect(Object.isFrozen(config)).toBe(true);
  expect(Object.isFrozen(credentials)).toBe(true);
});

import { activeSecretCount, resetSecretsForTests, scrubText } from '../logging/secret-registry';
import { sanitizeLogObject } from '../logging/error-sanitizer';
afterEach(resetSecretsForTests);
it('registra y libera referencias sin impedir revelar la contraseña', () => {
  const password = 'fake-password-for-unit-tests-0001';
  const before = activeSecretCount();
  const a = new DatabaseCredentials('agenda_test_app', password);
  const b = new DatabaseCredentials('agenda_test_app', password);
  expect(activeSecretCount()).toBe(before + 1);
  a.dispose(); a.dispose();
  expect(scrubText(password)).toBe('[REDACTED]');
  b.dispose(); b.dispose();
  expect(activeSecretCount()).toBe(before);
  expect(scrubText(password)).toBe(password);
  expect(a.revealPassword()).toBe(password);
  for (const text of [String(a), JSON.stringify(a), inspect(a)]) expect(text).not.toContain(password);
});
it('el registro cerrado usa las formas enmascaradas', () => {
  const c = new DatabaseCredentials('agenda_test_app', 'fake-password-for-unit-tests-0001');
  const config = new DatabaseConnectionConfig('localhost', 5433, 'agenda_test', c, 5);
  expect(sanitizeLogObject({ c, config })).toMatchObject({ c: c.toJSON(), config: config.toJSON() });
  c.dispose();
});
