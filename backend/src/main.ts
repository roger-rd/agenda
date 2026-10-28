import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from './config/app-config.service';
import { startupErrorMessage } from './startup-error';
import { setupHttpLogging } from './logging/setup-http-logging';
import { installFatalHandlers } from './logging/fatal-handlers';

async function bootstrap(): Promise<void> {
  // La importación diferida permite capturar también errores de ConfigModule.forRoot.
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create(AppModule, { bufferLogs: true, autoFlushLogs: false, abortOnError: false });
  await setupHttpLogging(app);
  app.flushLogs();
  app.enableShutdownHooks();
  const config = app.get(AppConfigService);
  const logger = await app.resolve(PinoLogger);
  installFatalHandlers(logger);
  await app.listen(config.port, config.host);
  logger.info({ host: config.host, port: config.port, env: config.env, logLevel: config.logLevel }, 'Servidor escuchando.');
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(`${startupErrorMessage(error)}\n`);
  process.exit(1);
});
