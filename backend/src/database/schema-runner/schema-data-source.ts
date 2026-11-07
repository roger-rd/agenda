import type { Logger } from 'typeorm';
import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions';
import type { DatabaseConnectionConfig } from '../../config/database-credentials';
import { SCHEMA_MANIFEST } from '../migrations/schema-manifest';
import { assertOwnerTarget } from './credential-file';
import { APPLICATION_NAME, BUDGET, MIGRATIONS_TABLE, SchemaRunnerError, TARGET, type SchemaCommand } from './schema-target';

/**
 * Options of the DataSource used ONLY by the schema runner. Differences with the application DataSource are
 * deliberate and verified by assertSafeSchemaDataSourceOptions: the user is the owner (not the application role),
 * the manifest is the only list of migrations, entities stay empty, no synchronization, no automatic run, no
 * extension installation. The password is revealed once, in this file and nowhere else.
 */
const readOnlyOption = (mode: SchemaCommand): string => `-c default_transaction_read_only=${mode === 'plan' ? 'on' : 'off'}`;

const ALLOWED_KEYS: readonly string[] = Object.freeze([
  'type', 'host', 'port', 'database', 'username', 'password', 'schema', 'entities', 'migrations', 'migrationsTableName',
  'migrationsTransactionMode', 'synchronize', 'dropSchema', 'migrationsRun', 'installExtensions', 'ssl', 'logging', 'logger', 'extra',
]);

export function createSchemaDataSourceOptions(config: DatabaseConnectionConfig, mode: SchemaCommand, extras: { logger: Logger }): PostgresDataSourceOptions {
  assertOwnerTarget(config);
  const options: PostgresDataSourceOptions = {
    type: 'postgres', host: config.host, port: config.port, database: config.name, username: config.credentials.user,
    // Único punto del runner autorizado para revelar la contraseña.
    password: config.credentials.revealPassword(),
    schema: TARGET.schema,
    entities: [],
    migrations: SCHEMA_MANIFEST.map(entry => entry.migration),
    migrationsTableName: MIGRATIONS_TABLE,
    migrationsTransactionMode: 'all',
    synchronize: false, dropSchema: false, migrationsRun: false, installExtensions: false,
    // Loopback only: nothing crosses a network, so TLS is neither needed nor configured.
    ssl: false,
    logger: extras.logger, logging: ['error'],
    extra: {
      max: 1, application_name: APPLICATION_NAME,
      connectionTimeoutMillis: BUDGET.connectMs, statement_timeout: BUDGET.statementMs, lock_timeout: BUDGET.lockMs,
      idle_in_transaction_session_timeout: BUDGET.idleInTransactionMs, options: readOnlyOption(mode),
    },
  };
  assertSafeSchemaDataSourceOptions(options, mode);
  return options;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Refuses anything that is not exactly the options built above. Throws a code, never the options. */
export function assertSafeSchemaDataSourceOptions(options: PostgresDataSourceOptions, mode: SchemaCommand): void {
  const bad = (): never => { throw new SchemaRunnerError('options_unsafe'); };
  if (options === null || typeof options !== 'object') bad();
  if (Object.keys(options).some(k => !ALLOWED_KEYS.includes(k))) bad();
  const extra = options.extra as Record<string, unknown> | undefined;
  if (options.type !== 'postgres' || options.database !== TARGET.database || options.username !== TARGET.owner ||
    options.port !== TARGET.port || options.schema !== TARGET.schema) bad();
  if (typeof options.host !== 'string' || !['127.0.0.1', '::1', 'localhost'].includes(options.host)) bad();
  if (typeof options.password !== 'string' || options.password.length === 0) bad();
  if (!Array.isArray(options.entities) || options.entities.length !== 0) bad();
  const migrations = options.migrations;
  if (!Array.isArray(migrations) || migrations.length !== SCHEMA_MANIFEST.length || !SCHEMA_MANIFEST.every((e, i) => migrations[i] === e.migration)) bad();
  if (options.migrationsTableName !== MIGRATIONS_TABLE || options.migrationsTransactionMode !== 'all') bad();
  if (options.synchronize !== false || options.dropSchema !== false || options.migrationsRun !== false || options.installExtensions !== false) bad();
  if (options.ssl !== false || !same(options.logging, ['error'])) bad();
  const expected = {
    max: 1, application_name: APPLICATION_NAME, connectionTimeoutMillis: BUDGET.connectMs, statement_timeout: BUDGET.statementMs,
    lock_timeout: BUDGET.lockMs, idle_in_transaction_session_timeout: BUDGET.idleInTransactionMs, options: readOnlyOption(mode),
  };
  if (extra === undefined || !same(Object.entries(extra).sort(), Object.entries(expected).sort())) bad();
}

/** Non-secret description. */
export function describeSchemaDataSource(options: PostgresDataSourceOptions): string {
  return `${options.username}@${options.host}:${options.port}/${options.database}`;
}
