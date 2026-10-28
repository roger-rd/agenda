import { DatabaseConnectionConfig, DatabaseCredentials } from '../config/database-credentials';
import { assertSafeDataSourceOptions, createDataSourceOptions, describeDataSourceOptions } from './data-source-options';
import { SafeTypeOrmLogger } from './safe-typeorm-logger';
import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions';

const password = 'fake-password-for-unit-tests-0001';
const logger = new SafeTypeOrmLogger({ warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
const database = new DatabaseConnectionConfig('localhost', 5433, 'agenda_test', new DatabaseCredentials('agenda_test_app', password), 5);
const create = () => createDataSourceOptions(database, { logger });
it('centraliza todas las opciones y revela la contraseña solo en la fábrica', () => {
  const reveal = jest.spyOn(DatabaseCredentials.prototype, 'revealPassword');
  try {
    const options = create();
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(options).toEqual({ type: 'postgres', host: 'localhost', port: 5433, database: 'agenda_test', username: 'agenda_test_app', password,
      entities: [], migrations: [], synchronize: false, dropSchema: false, migrationsRun: false,
      invalidWhereValuesBehavior: { null: 'throw', undefined: 'throw' }, logger, logging: ['error', 'warn'], maxQueryExecutionTime: 1000,
      extra: { max: 5, application_name: 'agenda-backend', connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 } });
    expect(describeDataSourceOptions(options)).toBe('agenda_test_app@localhost:5433/agenda_test');
    expect(describeDataSourceOptions(options)).not.toContain(password);
    expect(() => assertSafeDataSourceOptions(options)).not.toThrow();
  } finally { reveal.mockRestore(); }
});
it.each([
  { synchronize: true }, { synchronize: undefined }, { dropSchema: true }, { dropSchema: undefined },
  { migrationsRun: true }, { migrationsRun: undefined }, { invalidWhereValuesBehavior: undefined },
  { invalidWhereValuesBehavior: { null: 'ignore', undefined: 'throw' } },
  { invalidWhereValuesBehavior: { null: 'throw', undefined: 'ignore' } },
  { invalidWhereValuesBehavior: { null: 'throw', undefined: 'throw', extra: 'CANARIO_SECRETO_123' } },
  { migrations: ['CANARIO_SECRETO_123'] }, { migrations: undefined }, { username: 'CANARIO_SECRETO_123_owner' },
])('rechaza opciones inseguras sin reflejar valores %#', patch => {
  expect(() => assertSafeDataSourceOptions({ ...create(), ...patch } as PostgresDataSourceOptions)).toThrow('Opciones de base de datos inseguras.');
});
it('la fábrica rechaza owner', () => {
  expect(() => createDataSourceOptions(new DatabaseConnectionConfig('localhost', 5433, 'agenda_test',
    new DatabaseCredentials('agenda_test_owner', password), 5), { logger })).toThrow('Opciones de base de datos inseguras.');
});
