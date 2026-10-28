import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { Environment } from './env.validation';
import { EnvironmentValidationError } from './validation-rules';
import { validateDatabaseEnvironment } from './database-environment';
import type { DatabaseConnectionConfig } from './database-credentials';

export function migrationEnvFile(nodeEnv: Environment): string | undefined {
  return nodeEnv === 'production' ? undefined : nodeEnv === 'test' ? '.env.test.migration' : '.env.migration';
}

export function loadMigrationEnvironment({ nodeEnv, cwd = process.cwd(), env = process.env,
  readFile = (path: string) => readFileSync(path, 'utf8'),
}: { nodeEnv: Environment; cwd?: string; env?: Record<string, unknown>; readFile?: (path: string) => string }): DatabaseConnectionConfig {
  const file = migrationEnvFile(nodeEnv);
  let input = env;
  if (file) {
    let contents: string;
    try { contents = readFile(resolve(cwd, file)); }
    catch { throw new EnvironmentValidationError(`No se pudo leer el archivo de migración ${file}`); }
    try { input = parseEnv(contents); }
    catch { throw new EnvironmentValidationError(`Formato inválido en el archivo de migración ${file}`); }
  }
  return validateDatabaseEnvironment(input, { nodeEnv, role: 'owner' });
}
