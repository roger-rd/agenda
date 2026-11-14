import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppConfigService } from '../../config/app-config.service';
import { ForbiddenError } from '../errors/domain-error';
import { originDenialReason } from './origin-policy';

const ORIGIN_PROTECTED = Symbol('ORIGIN_PROTECTED');
export const OriginProtected = () => SetMetadata(ORIGIN_PROTECTED, true);

@Injectable()
export class OriginGuard implements CanActivate {
  constructor(private readonly config: AppConfigService, private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(ORIGIN_PROTECTED, [context.getHandler(), context.getClass()]) !== true) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const reason = originDenialReason({ origin: req.headers.origin,
      secFetchSite: req.headers['sec-fetch-site'], allowed: this.config.allowedOrigins });
    if (reason) {
      req.log?.warn({ reason });
      throw new ForbiddenError('Acceso denegado.');
    }
    return true;
  }
}
