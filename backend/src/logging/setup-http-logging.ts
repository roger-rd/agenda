import type { INestApplication } from '@nestjs/common';
import { Logger, PinoLogger } from 'nestjs-pino';
import { pinoHttp } from 'pino-http';
import { AppConfigService } from '../config/app-config.service';
import { IdGenerator } from '../common/ids/id-generator';
import { createLoggerOptions } from './logger-options';

export async function setupHttpLogging(app: INestApplication): Promise<void> {
  app.useLogger(app.get(Logger));
  // app.use se registra antes del parser automático de Nest (app.init/listen).
  app.use(pinoHttp({
    ...createLoggerOptions(app.get(AppConfigService), undefined, app.get(IdGenerator)),
    logger: (await app.resolve(PinoLogger)).logger,
  }));
}
