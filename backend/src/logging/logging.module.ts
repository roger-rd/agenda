import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule } from '../config/app-config.module';
import { AppConfigService } from '../config/app-config.service';
import { IdsModule } from '../common/ids/ids.module';
import { IdGenerator } from '../common/ids/id-generator';
import { createLoggerOptions } from './logger-options';

@Module({ imports: [LoggerModule.forRootAsync({
  imports: [AppConfigModule, IdsModule],
  inject: [AppConfigService, IdGenerator],
  useFactory: (config: AppConfigService, ids: IdGenerator) => ({
    pinoHttp: createLoggerOptions(config, undefined, ids),
    // El middleware HTTP se monta antes del parser; Nest enlaza su contexto.
    useExisting: true,
  }),
})] })
export class LoggingModule {}
