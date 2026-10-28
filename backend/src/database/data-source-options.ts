import type { Logger } from 'typeorm';
import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions';
import type { DatabaseConnectionConfig } from '../config/database-credentials';

export function assertSafeDataSourceOptions(options: PostgresDataSourceOptions): void {
  const behavior = options.invalidWhereValuesBehavior;
  if (options.synchronize !== false || options.dropSchema !== false || options.migrationsRun !== false ||
    !behavior || behavior.null !== 'throw' || behavior.undefined !== 'throw' || Object.keys(behavior).length !== 2 ||
    !Array.isArray(options.migrations) || options.migrations.length !== 0 || options.username?.endsWith('_owner')) {
    throw new Error('Opciones de base de datos inseguras.');
  }
}

export function createDataSourceOptions(database: DatabaseConnectionConfig, extras: { logger: Logger }): PostgresDataSourceOptions {
  // pg exige contraseña string: NUNCA registrar, serializar ni exponer este objeto.
  const options: PostgresDataSourceOptions = {
    type: 'postgres', host: database.host, port: database.port, database: database.name,
    username: database.credentials.user,
    // Único punto de runtime autorizado para revelar la contraseña.
    password: database.credentials.revealPassword(),
    entities: [], migrations: [], synchronize: false, dropSchema: false, migrationsRun: false,
    invalidWhereValuesBehavior: { null: 'throw', undefined: 'throw' },
    logger: extras.logger, logging: ['error', 'warn'], maxQueryExecutionTime: 1000,
    extra: { max: database.poolMax, application_name: 'agenda-backend', connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 },
    // SSL pendiente de decisión de despliegue.
  };
  assertSafeDataSourceOptions(options);
  return options;
}

export function describeDataSourceOptions(options: PostgresDataSourceOptions): string {
  return `${options.username}@${options.host}:${options.port}/${options.database}`;
}
