import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { appConfigOptions } from './app.config';

@Global()
@Module({
  imports: [ConfigModule.forRoot(appConfigOptions(process.env.NODE_ENV))],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
