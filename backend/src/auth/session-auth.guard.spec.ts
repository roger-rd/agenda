import { ExecutionContext } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { deriveCsrfToken, generateSessionToken } from '../identity/session-token';
import { SessionService } from './session.service';
import { SessionAuthGuard } from './session-auth.guard';

it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('%s exige CSRF antes de authenticate', async method => {
  const token = generateSessionToken();
  const authenticate = jest.fn().mockResolvedValue({ renewed: false });
  const setHeader = jest.fn();
  const req = { method, headers: { cookie: `agenda_session=${token}`, 'x-csrf-token': '' } };
  const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader }) }) } as unknown as ExecutionContext;
  const guard = new SessionAuthGuard({ env: 'test' } as AppConfigService, { authenticate } as unknown as SessionService);
  await expect(guard.canActivate(context)).rejects.toMatchObject({ httpStatus: 403 });
  expect(authenticate).not.toHaveBeenCalled();
  expect(setHeader).not.toHaveBeenCalled();
  req.headers['x-csrf-token'] = deriveCsrfToken(token);
  await expect(guard.canActivate(context)).resolves.toBe(true);
  expect(authenticate).toHaveBeenCalledWith(token);
  expect(req).toHaveProperty('currentSession.token', token);
});

it.each(['GET', 'HEAD', 'OPTIONS'])('%s autentica sin exigir CSRF', async method => {
  const token = generateSessionToken();
  const authenticate = jest.fn().mockResolvedValue({ renewed: false });
  const req = { method, headers: { cookie: `agenda_session=${token}` } };
  const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader: jest.fn() }) }) } as unknown as ExecutionContext;
  const guard = new SessionAuthGuard({ env: 'test' } as AppConfigService, { authenticate } as unknown as SessionService);
  await expect(guard.canActivate(context)).resolves.toBe(true);
  expect(authenticate).toHaveBeenCalledWith(token);
});
