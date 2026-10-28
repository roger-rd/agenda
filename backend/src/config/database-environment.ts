import { plainToInstance } from 'class-transformer';
import { IsInt, Matches, Max, Min, ValidateBy, validateSync } from 'class-validator';
import type { Environment } from './env.validation';
import { DatabaseConnectionConfig, DatabaseCredentials } from './database-credentials';
import { EnvironmentValidationError, hostValidator } from './validation-rules';

export type DatabaseRole = 'app' | 'owner';
const identifierRule = 'es obligatoria y debe cumplir /^[a-z][a-z0-9_]{0,62}$/';
const portRule = 'debe ser un entero entre 1 y 65535';
const poolRule = 'debe ser un entero entre 1 y 20';

export class DatabaseEnvironmentVariables {
  @ValidateBy({ name: 'host', validator: hostValidator })
  DATABASE_HOST!: string;

  @IsInt({ message: portRule })
  @Min(1, { message: portRule })
  @Max(65535, { message: portRule })
  DATABASE_PORT!: number;

  @Matches(/^[a-z][a-z0-9_]{0,62}$(?![\s\S])/, { message: identifierRule })
  DATABASE_NAME!: string;

  @Matches(/^[a-z][a-z0-9_]{0,62}$(?![\s\S])/, { message: identifierRule })
  DATABASE_USER!: string;

  @ValidateBy({ name: 'password', validator: {
    validate: (value: unknown) => typeof value === 'string' && value.length >= 16 &&
      value.length <= 128 && !/[\s\p{Cc}]/u.test(value),
    defaultMessage: () => 'es obligatoria, de 16 a 128 caracteres, sin espacios ni caracteres de control',
  } })
  DATABASE_PASSWORD!: string;

  @IsInt({ message: poolRule })
  @Min(1, { message: poolRule })
  @Max(20, { message: poolRule })
  DATABASE_POOL_MAX!: number;
}

function integer(value: unknown, fallback: number): unknown {
  if (value === undefined) return fallback;
  return typeof value === 'string' && /^[0-9]+$/.test(value) && value.trim() === value ? Number(value) : value;
}

export function validateDatabaseEnvironment(
  input: Record<string, unknown>, { nodeEnv, role }: { nodeEnv: Environment; role: DatabaseRole },
): DatabaseConnectionConfig {
  const result = plainToInstance(DatabaseEnvironmentVariables, {
    DATABASE_HOST: input.DATABASE_HOST === undefined ? '127.0.0.1' : input.DATABASE_HOST,
    DATABASE_PORT: integer(input.DATABASE_PORT, 5433),
    DATABASE_NAME: input.DATABASE_NAME,
    DATABASE_USER: input.DATABASE_USER,
    DATABASE_PASSWORD: input.DATABASE_PASSWORD,
    DATABASE_POOL_MAX: integer(input.DATABASE_POOL_MAX, nodeEnv === 'test' ? 5 : 10),
  });
  const messages = validateSync(result).map(error =>
    `${error.property}: ${[...new Set(Object.values(error.constraints ?? {}))].join('; ')}`);
  const { DATABASE_NAME: name, DATABASE_USER: user, DATABASE_HOST: host } = result;
  if (nodeEnv === 'test' || nodeEnv === 'development') {
    const suffix = nodeEnv === 'test' ? 'test' : 'dev';
    if (typeof name !== 'string' || !name.endsWith(`_${suffix}`)) messages.push(`DATABASE_NAME: debe terminar en _${suffix}`);
    if (typeof user !== 'string' || !user.startsWith(`agenda_${suffix}_`)) messages.push(`DATABASE_USER: debe empezar por agenda_${suffix}_`);
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) messages.push('DATABASE_HOST: debe ser loopback en desarrollo y pruebas');
  } else if (nodeEnv === 'production') {
    if (typeof name === 'string' && /_(dev|test)$/.test(name)) messages.push('DATABASE_NAME: no debe terminar en _dev ni _test en producción');
    if (typeof user === 'string' && /^agenda_(dev|test)_/.test(user)) messages.push('DATABASE_USER: no debe empezar por agenda_dev_ ni agenda_test_ en producción');
  }
  if (typeof user !== 'string' || !user.endsWith(`_${role}`)) messages.push(`DATABASE_USER: debe terminar en _${role}`);
  if (messages.length) throw new EnvironmentValidationError(messages.join('\n'));
  return new DatabaseConnectionConfig(host, result.DATABASE_PORT, name,
    new DatabaseCredentials(user, result.DATABASE_PASSWORD), result.DATABASE_POOL_MAX);
}
