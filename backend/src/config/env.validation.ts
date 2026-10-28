import { plainToInstance } from 'class-transformer';
import { IsIn, IsInt, Max, Min, ValidateBy, validateSync } from 'class-validator';
import { EnvironmentValidationError, hostValidator } from './validation-rules';
import { validateDatabaseEnvironment } from './database-environment';
import type { DatabaseConnectionConfig } from './database-credentials';

export const environments = ['development', 'test', 'production'] as const;
export const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type Environment = (typeof environments)[number];
export type LogLevel = (typeof logLevels)[number];
const portRule = 'debe ser un entero entre 1 y 65535';

export class EnvironmentVariables {
  @IsIn(environments, { message: 'debe ser development, test o production' })
  NODE_ENV!: Environment;

  @ValidateBy({ name: 'host', validator: hostValidator })
  HOST!: string;

  @IsInt({ message: portRule })
  @Min(1, { message: portRule })
  @Max(65535, { message: portRule })
  PORT!: number;

  @IsIn(logLevels, { message: `debe ser ${logLevels.join(', ')}` })
  LOG_LEVEL!: LogLevel;
}

export { EnvironmentValidationError } from './validation-rules';

export type ValidatedEnvironment = EnvironmentVariables & { DATABASE: DatabaseConnectionConfig };

export function validateEnvironment(input: Record<string, unknown>): ValidatedEnvironment {
  const env = input.NODE_ENV === undefined ? 'development' : input.NODE_ENV;
  const port = input.PORT === undefined ? 3000 : input.PORT;
  const result = plainToInstance(EnvironmentVariables, {
    NODE_ENV: env,
    HOST: input.HOST === undefined ? '127.0.0.1' : input.HOST,
    PORT: typeof port === 'string' && /^[0-9]+$/.test(port) ? Number(port) : port,
    LOG_LEVEL: input.LOG_LEVEL === undefined ? (env === 'test' ? 'silent' : 'info') : input.LOG_LEVEL,
  });
  const errors = validateSync(result, { skipMissingProperties: false });
  const messages = errors.map(error =>
    `${error.property}: ${[...new Set(Object.values(error.constraints ?? {}))].join('; ')}`,
  );
  let database: DatabaseConnectionConfig | undefined;
  try {
    database = validateDatabaseEnvironment(input, { nodeEnv: result.NODE_ENV, role: 'app' });
  } catch (error) {
    if (!(error instanceof EnvironmentValidationError)) throw error;
    messages.push(error.message);
  }
  const migrationKeys = Object.keys(input).filter(key => key.startsWith('DATABASE_MIGRATION_'));
  if (migrationKeys.length) messages.push(`Las credenciales de migración no deben estar en el entorno de la aplicación: ${migrationKeys.sort().join(', ')}`);
  if (messages.length || !database) throw new EnvironmentValidationError(messages.join('\n'));
  return Object.assign(result, { DATABASE: database });
}
