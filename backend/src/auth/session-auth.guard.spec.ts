import { Clock } from '../common/clock/clock';
import { ExecutionContext } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { deriveCsrfToken, generateSessionToken } from '../identity/session-token';
import { SessionService } from './session.service';
import { SessionAuthGuard } from './session-auth.guard';

const now = new Date('2026-01-01T00:00:00Z');
const clock: Clock = { now: () => now };

it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('%s exige CSRF antes de authenticate', async method => {
  const token = generateSessionToken();
  const authenticate = jest.fn().mockResolvedValue({ renewed: false });
  const setHeader = jest.fn();
  const req = { method, headers: { cookie: `agenda_session=${token}`, 'x-csrf-token': '' } };
  const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader }) }) } as unknown as ExecutionContext;
  const guard = new SessionAuthGuard({ env: 'test' } as AppConfigService, { authenticate } as unknown as SessionService, clock);
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
  const setHeader = jest.fn();
  const req = { method, headers: { cookie: `agenda_session=${token}` } };
  const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader }) }) } as unknown as ExecutionContext;
  const guard = new SessionAuthGuard({ env: 'test' } as AppConfigService, { authenticate } as unknown as SessionService, clock);
  await expect(guard.canActivate(context)).resolves.toBe(true);
  expect(authenticate).toHaveBeenCalledWith(token);
  expect(setHeader).not.toHaveBeenCalled();
});

it.each([[-1000, 1], [500, 1], [3600500, 3600], [999999999999, 2678400]])(
  'limita Max-Age al renovar con diferencia %p ms a %p segundos', async (delta, maxAge) => {
    await compruebaRenovacion('test', new Date(now.getTime() + delta), maxAge);
  });

it('respeta expiresAt cerca del tope absoluto de createdAt + 30 días', async () => {
  const createdAt = new Date(now.getTime() - 30 * 86400000 + 12500);
  const expiresAt = new Date(createdAt.getTime() + 30 * 86400000);
  await compruebaRenovacion('test', expiresAt, 12, createdAt);
});

it.each(['development', 'test', 'production'] as const)('reemite el mismo token con atributos de %s', async env => {
  await compruebaRenovacion(env, new Date(now.getTime() + 3600500), 3600);
});

async function compruebaRenovacion(env: 'development' | 'test' | 'production', expiresAt: Date, maxAge: number, createdAt = now) {
  const token = generateSessionToken();
  const session = { renewed: true, expiresAt, createdAt };
  const authenticate = jest.fn().mockResolvedValue(session);
  const setHeader = jest.fn();
  const name = env === 'production' ? '__Host-agenda_session' : 'agenda_session';
  const req = { method: 'GET', headers: { cookie: `${name}=${token}` } };
  const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader }) }) } as unknown as ExecutionContext;
  const guard = new SessionAuthGuard({ env } as AppConfigService, { authenticate } as unknown as SessionService, clock);
  await expect(guard.canActivate(context)).resolves.toBe(true);
  expect(authenticate).toHaveBeenCalledTimes(1);
  expect(authenticate).toHaveBeenCalledWith(token);
  expect(setHeader).toHaveBeenCalledTimes(1);
  expect(setHeader).toHaveBeenCalledWith('Set-Cookie',
    `${name}=${token}; Path=/; HttpOnly; ${env === 'production' ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${maxAge}`);
  expect(req).toHaveProperty('currentSession', { token, session });
}
