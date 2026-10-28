import { ConstraintRegistry } from './errors/constraint-registry';
import { Module } from '@nestjs/common';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions } from 'typeorm';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { createDataSourceOptions } from './data-source-options';
import { SafeTypeOrmLogger } from './safe-typeorm-logger';
import { DatabaseIdentityService } from './database-identity.service';

export function databaseOptionsFactory(config: AppConfigService, pinoLogger: PinoLogger): TypeOrmModuleOptions {
  return { ...createDataSourceOptions(config.database, { logger: new SafeTypeOrmLogger(pinoLogger) }),
    autoLoadEntities: true, retryAttempts: 3, retryDelay: 1000, verboseRetryLog: false };
}
function safeErrorCode(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const code: unknown = Reflect.get(value, 'code');
    return typeof code === 'string' && /^(E[A-Z0-9_]+|[0-9][0-9A-Z]{4})$/.test(code) ? code : undefined;
  } catch { return undefined; }
}
function connectionError(original?: unknown): Error {
  let code = safeErrorCode(original);
  if (!code && original instanceof AggregateError && Array.isArray(original.errors)) {
    for (const entry of original.errors) {
      code = safeErrorCode(entry);
      if (code) break;
    }
  }
  const error = Object.assign(new Error(`No se pudo establecer la conexión con la base de datos${code ? ` (${code})` : ''}.`),
    code ? { code } : {});
  // handleRetry de Nest imprime stack incluso con verboseRetryLog: false.
  error.stack = undefined;
  return error;
}
export async function safeDataSourceFactory(options?: DataSourceOptions): Promise<DataSource> {
  try {
    if (!options) throw connectionError();
    const source = new DataSource(options);
    await source.initialize();
    return source;
  } catch (error) { throw connectionError(error); }
}

@Module({
  imports: [TypeOrmModule.forRootAsync({ inject: [AppConfigService, PinoLogger],
    useFactory: databaseOptionsFactory, dataSourceFactory: safeDataSourceFactory })],
  providers: [DatabaseIdentityService, ConstraintRegistry],
  exports: [TypeOrmModule, ConstraintRegistry],
})
export class DatabaseModule {}
