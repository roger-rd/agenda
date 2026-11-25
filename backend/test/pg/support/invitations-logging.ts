import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { IdGenerator } from '../../../src/common/ids/id-generator';
import { IdsModule } from '../../../src/common/ids/ids.module';
import { AppConfigModule } from '../../../src/config/app-config.module';
import { AppConfigService } from '../../../src/config/app-config.service';
import { createLoggerOptions } from '../../../src/logging/logger-options';
import { LogCapture } from './invitations-log-capture';

export { LogCapture };

export const logCapture = new LogCapture();

/**
 * Same options factory as LoggingModule (serializers, redaction, messages, request ids, level from LOG_LEVEL): only the destination
 * stream is replaced by the in-memory capture.
 */
@Module({
  imports: [LoggerModule.forRootAsync({
    imports: [AppConfigModule, IdsModule],
    inject: [AppConfigService, IdGenerator],
    useFactory: (config: AppConfigService, ids: IdGenerator) => ({ pinoHttp: createLoggerOptions(config, logCapture.stream, ids), useExisting: true }),
  })],
})
export class CapturingLoggingModule {}
