import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedSession } from './session.service';

export interface CurrentSessionValue { token: string; session: AuthenticatedSession }
export type SessionRequest = Request & { currentSession?: CurrentSessionValue };
export const CurrentSession = createParamDecorator((_data: unknown, context: ExecutionContext): CurrentSessionValue | undefined =>
  context.switchToHttp().getRequest<SessionRequest>().currentSession);
