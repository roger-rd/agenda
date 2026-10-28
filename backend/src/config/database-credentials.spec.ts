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
