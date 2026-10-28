import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables } from './env.validation';

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}
  get env() { return this.config.get('NODE_ENV', { infer: true }); }
  get host() { return this.config.get('HOST', { infer: true }); }
  get port() { return this.config.get('PORT', { infer: true }); }
  get logLevel() { return this.config.get('LOG_LEVEL', { infer: true }); }
  get isProduction() { return this.env === 'production'; }
  get isTest() { return this.env === 'test'; }
}
