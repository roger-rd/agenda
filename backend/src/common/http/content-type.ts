import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnsupportedMediaTypeException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
const JSON_BODY = Symbol('JSON_BODY');
export const JsonBody = () => SetMetadata(JSON_BODY, true);
@Injectable()
export class JsonBodyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(JSON_BODY, [context.getHandler(), context.getClass()])) {
      const req = context.switchToHttp().getRequest<Request>();
      if (!req.is('application/json')) throw new UnsupportedMediaTypeException();
    }
    return true;
  }
}
