import 'reflect-metadata';
import { validateDatabaseEnvironment } from '../../src/config/database-environment';
import { validateStructure } from '../../scripts/harness/env-files.cjs';
import type { Connection, Role } from '../../scripts/harness/env-files.cjs';
import { generator, input } from './support/env-fixtures';

const numbers: unknown[] = [undefined, 1, '1', 20, '20', 21, '21', 5433, '5433', 65535, '65535',
  65536, '65536', 0, '0', -1, '-1', '+1', ' 1', '1 ', '1\n', '1.0', 1.5, '1.5', '01', '0005433',
  NaN, Infinity, null, true, false, {}, [], '', '1e1', '0x10'];
const candidates: Record<string, unknown[]> = {
  DATABASE_HOST: [undefined, '127.0.0.1', '::1', 'localhost', 'LOCALHOST', 'localhost.', '127.1', '127.0.0.2',
    '0.0.0.0', '::ffff:127.0.0.1', 'host.example', '-host', 'a..b', '123.456.789.0', ' localhost', 'localhost\n', '', null, 1, {}],
  DATABASE_PORT: numbers,
  DATABASE_POOL_MAX: numbers,
  DATABASE_NAME: [undefined, 'a_test', 'synthetic_test', 'a'.repeat(58) + '_test', 'a'.repeat(59) + '_test',
    'a_dev', 'test', '_test', '1_test', 'A_test', 'a-test', 'a_test\n', 'a_test ', '', null, 1, {}],
  DATABASE_USER: [undefined, 'agenda_test_app', 'agenda_test_owner', 'agenda_test_x_app', 'agenda_test_x_owner',
    'agenda_dev_x_app', 'agenda_test_app\n', 'agenda_test_x_app ', 'Agenda_test_x_app', 'agenda_test_x_appx',
    'agenda_test_' + 'a'.repeat(47) + '_app', 'agenda_test_' + 'a'.repeat(48) + '_app', '', null, 1, {}],
  DATABASE_PASSWORD: [undefined, 'a'.repeat(15), 'a'.repeat(16), 'a'.repeat(128), 'a'.repeat(129),
    'ValidPassword_123#', 'ValidPassword_123 ', 'ValidPassword_123\t', 'ValidPassword_123\n',
    'ValidPassword_123\0', 'ValidPassword_123\x7f', 'ValidPassword_123\u0085', 'ValidPassword_123\u00a0',
    'é'.repeat(16), '😀'.repeat(8), '', null, 1, {}, []],
};
const cases: { label: string; role: Role; value: Record<string, unknown> }[] = [];
for (const role of ['app', 'owner'] as const) {
  cases.push({ label: `${role}:defaults`, role, value: input(role) });
  for (const [key, values] of Object.entries(candidates)) {
    values.forEach((value, index) => cases.push({ label: `${role}:${key}:${index}`, role, value: { ...input(role), [key]: value } }));
  }
}
const next = generator(0xc7b12002);
const keys = Object.keys(candidates);
for (let i = 0; i < 300; i++) {
  const role: Role = next(2) ? 'owner' : 'app';
  const value = input(role);
  for (let j = 0; j < 1 + i % 3; j++) {
    const key = keys[next(keys.length)];
    value[key] = candidates[key][next(candidates[key].length)];
  }
  cases.push({ label: `seed:${i}`, role, value });
}

describe('P5: deriva CJS frente al validador TypeScript', () => {
  it('contiene al menos 200 casos reproducibles', () => { expect(cases.length).toBeGreaterThanOrEqual(200); });
  it.each(cases)('$label', ({ role, value }) => {
    let cjs: Readonly<Connection> | undefined;
    let typescript: Connection | undefined;
    try { cjs = validateStructure(value, role); } catch { /* Rechazo estructural. */ }
    try {
      const config = validateDatabaseEnvironment(value, { nodeEnv: 'test', role });
      try {
        typescript = { host: config.host, port: config.port, database: config.name,
          user: config.credentials.user, poolMax: config.poolMax };
      } finally { config.credentials.dispose(); }
    } catch { /* Rechazo estructural; no se compara ni revela la contraseña. */ }
    expect(cjs !== undefined).toBe(typescript !== undefined);
    if (cjs) expect(cjs).toEqual(typescript);
  });
});
