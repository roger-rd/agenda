import type { ConfigModuleOptions } from '@nestjs/config';
import { validateEnvironment } from './env.validation';

export function appConfigOptions(environment: string | undefined): ConfigModuleOptions {
  return {
    isGlobal: true,
    ignoreEnvFile: environment === 'test',
    skipProcessEnv: true,
    validate: validateEnvironment,
  };
}
