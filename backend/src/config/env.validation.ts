import { plainToInstance } from 'class-transformer';
import { IsIn, IsInt, Max, Min, ValidateBy, validateSync } from 'class-validator';
import { isIP } from 'node:net';

export const environments = ['development', 'test', 'production'] as const;
export const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type Environment = (typeof environments)[number];
export type LogLevel = (typeof logLevels)[number];
const portRule = 'debe ser un entero entre 1 y 65535';

export class EnvironmentVariables {
  @IsIn(environments, { message: 'debe ser development, test o production' })
  NODE_ENV!: Environment;

  @ValidateBy({ name: 'host', validator: {
    validate: (value: unknown) => typeof value === 'string' && value.length <= 253 &&
      (isIP(value) !== 0 || (!/^[\d.]+$/.test(value) && value.split('.').every(
        label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))),
    defaultMessage: () => 'debe ser un hostname o IP válido, sin espacios',
  } })
  HOST!: string;

  @IsInt({ message: portRule })
  @Min(1, { message: portRule })
  @Max(65535, { message: portRule })
  PORT!: number;

  @IsIn(logLevels, { message: `debe ser ${logLevels.join(', ')}` })
  LOG_LEVEL!: LogLevel;
}

export class EnvironmentValidationError extends Error {}

export function validateEnvironment(input: Record<string, unknown>): EnvironmentVariables {
  const env = input.NODE_ENV === undefined ? 'development' : input.NODE_ENV;
  const port = input.PORT === undefined ? 3000 : input.PORT;
  const result = plainToInstance(EnvironmentVariables, {
    NODE_ENV: env,
    HOST: input.HOST === undefined ? '127.0.0.1' : input.HOST,
    PORT: typeof port === 'string' && /^[0-9]+$/.test(port) ? Number(port) : port,
    LOG_LEVEL: input.LOG_LEVEL === undefined ? (env === 'test' ? 'silent' : 'info') : input.LOG_LEVEL,
  });
  const errors = validateSync(result, { skipMissingProperties: false });
  if (errors.length) {
    throw new EnvironmentValidationError(errors.map(error =>
      `${error.property}: ${[...new Set(Object.values(error.constraints ?? {}))].join('; ')}`,
    ).join('\n'));
  }
  return result;
}
