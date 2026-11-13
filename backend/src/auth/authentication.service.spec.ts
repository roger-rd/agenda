import * as native from '@node-rs/argon2';
import { Argon2idPasswordHasher } from '../identity/password-hasher';
import { EntityManager, Repository } from 'typeorm';
import { ServiceUnavailableError, UnauthenticatedError } from '../common/errors/domain-error';
import { DatabaseOperationError } from '../database/errors/database-operation-error';
import { deriveCsrfToken, hashSessionToken } from '../identity/session-token';
import { User } from '../persistence/entities/user.entity';
import { UserSession } from '../persistence/entities/user-session.entity';
import { TransactionRunner } from '../registration/transaction-runner';
import { AuthenticationService, ROTATE_SESSION_SQL } from './authentication.service';

const now = new Date('2026-01-01T00:00:00Z');
const token = Buffer.alloc(32, 1).toString('base64url');
const previous = Buffer.alloc(32, 2).toString('base64url');
const input = { email: ' ANA@EXAMPLE.CL ', password: 'contraseña válida privada' };
function setup() {
  const user = { id: 'u1', email: 'ana@example.cl', name: 'Ana', passwordHash: 'hash-privado' };
  const getOne = jest.fn().mockResolvedValue(user);
  const userQuery = { addSelect: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), getOne };
  const users = { createQueryBuilder: jest.fn(() => userQuery) };
  const active = { id: 'm1', organizationId: 'o1', role: 'community_manager', organization: { id: 'o1', name: 'Equipo' } };
  const getMany = jest.fn().mockResolvedValue([active]);
  const membershipQuery = { innerJoinAndMapOne: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), addOrderBy: jest.fn().mockReturnThis(), getMany };
  const manager = { createQueryBuilder: jest.fn(() => membershipQuery), query: jest.fn().mockResolvedValue([[], 1]), insert: jest.fn().mockResolvedValue({}) };
  let committedRevocations = 0;
  const run = jest.fn(async <T>(work: (manager: EntityManager) => Promise<T>) => {
    const result = await work(manager as unknown as EntityManager);
    committedRevocations += manager.query.mock.calls.length;
    return result;
  });
  const hasher = { hash: jest.fn().mockResolvedValue('ficticio'), verify: jest.fn().mockResolvedValue(true), needsRehash: jest.fn() };
  const factory = jest.fn(() => token);
  const service = new AuthenticationService(hasher, { now: () => now }, { next: () => 's1' }, { run } as TransactionRunner,
    users as unknown as Repository<User>, factory);
  return { service, hasher, getOne, userQuery, users, user, getMany, active, membershipQuery, manager, run, factory,
    committedRevocations: () => committedRevocations };
}

it('crea sesión con una membresía, token y csrf coherentes, sin hashes en el resultado', async () => {
  const s = setup();
  const result = await s.service.login(input);
  expect(result).toEqual({ token, csrfToken: deriveCsrfToken(token), expiresAt: new Date('2026-01-08T00:00:00Z'), maxAgeSeconds: 604800,
    user: { id: 'u1', email: 'ana@example.cl', name: 'Ana' }, organization: { id: 'o1', name: 'Equipo' }, membership: { id: 'm1', role: 'community_manager' } });
  expect(s.userQuery.addSelect).toHaveBeenCalledWith('user.passwordHash');
  expect(s.userQuery.where).toHaveBeenCalledWith('user.email = :email', { email: 'ana@example.cl' });
  expect(s.manager.insert).toHaveBeenCalledWith(UserSession, { id: 's1', tokenHash: hashSessionToken(token), userId: 'u1', activeOrganizationId: 'o1',
    createdAt: now, lastSeenAt: now, expiresAt: result.expiresAt, revokedAt: null });
  const inserted = s.manager.insert.mock.calls[0][1] as { tokenHash: Buffer };
  expect(inserted.tokenHash).toHaveLength(32);
  expect(JSON.stringify(result)).not.toMatch(/passwordHash|tokenHash|hash-privado/);
  expect(JSON.stringify(inserted)).not.toContain(token);
  expect(s.hasher.verify).toHaveBeenCalledTimes(1);
  expect(s.hasher.verify.mock.invocationCallOrder[0]).toBeLessThan(s.run.mock.invocationCallOrder[0]);
  expect(s.membershipQuery.andWhere).toHaveBeenCalledWith('membership.deactivatedAt IS NULL');
  expect(s.membershipQuery.orderBy).toHaveBeenCalledWith('membership.createdAt', 'ASC');
  expect(s.membershipQuery.addOrderBy).toHaveBeenCalledWith('membership.id', 'ASC');
});
it.each(['inexistente', 'incorrecta', 'email inválido', 'contraseña inválida'])('responde el mismo 401 para %s', async kind => {
  const s = setup();
  if (kind === 'inexistente') s.getOne.mockResolvedValue(null);
  s.hasher.verify.mockResolvedValue(false);
  const attempt = { ...input, ...(kind === 'email inválido' ? { email: null } : {}), ...(kind === 'contraseña inválida' ? { password: null } : {}) };
  const error = await s.service.login(attempt).catch((error: unknown) => error);
  expect(error).toEqual(new UnauthenticatedError('Credenciales inválidas.'));
  expect(error).toMatchObject({ code: 'unauthenticated', httpStatus: 401, field: undefined });
  expect(s.hasher.verify).toHaveBeenCalledTimes(1);
  expect(s.hasher.verify.mock.calls[0][0]).toBe(kind === 'incorrecta' ? 'hash-privado' : 'ficticio');
  expect(s.run).not.toHaveBeenCalled();
});
it('memoriza el ficticio y no memoriza un rechazo al generarlo', async () => {
  const s = setup(); s.getOne.mockResolvedValue(null);
  const failure = new ServiceUnavailableError();
  s.hasher.hash.mockRejectedValueOnce(failure);
  await expect(s.service.login(input)).rejects.toBe(failure);
  expect(s.hasher.verify).not.toHaveBeenCalled();
  for (let i = 0; i < 2; i++) await expect(s.service.login(input)).rejects.toThrow(UnauthenticatedError);
  expect(s.hasher.hash).toHaveBeenCalledTimes(2);
  expect(s.hasher.verify).toHaveBeenCalledTimes(2);
});
it.each([1, undefined])('propaga indisponibilidad con retryAfter %s antes de la transacción', async retry => {
  const s = setup(); const error = new ServiceUnavailableError(undefined, retry);
  s.hasher.verify.mockRejectedValue(error);
  await expect(s.service.login(input)).rejects.toBe(error);
  expect(error.retryAfterSeconds).toBe(retry);
  expect(s.run).not.toHaveBeenCalled();
});
it('rechaza usuarios sin membresías activas', async () => {
  const s = setup(); s.getMany.mockResolvedValue([]);
  await expect(s.service.login(input)).rejects.toEqual(new UnauthenticatedError('Credenciales inválidas.'));
  expect(s.manager.insert).not.toHaveBeenCalled();
});
it('deja sin organización activa al usuario con varias membresías', async () => {
  const s = setup(); s.getMany.mockResolvedValue([s.active, { ...s.active, id: 'm2' }]);
  expect(await s.service.login(input)).toMatchObject({ organization: null, membership: null });
  expect(s.manager.insert.mock.calls[0][1]).toMatchObject({ activeOrganizationId: null });
});
it.each(['vigente', 'vencida', 'revocada', 'otro usuario'])('rota cookie %s con SQL y parámetros exactos antes del insert', async state => {
  const s = setup(); s.manager.query.mockResolvedValue([[], state === 'vigente' ? 1 : 0]);
  await s.service.login({ ...input, presentedSessionToken: previous });
  expect(s.manager.query).toHaveBeenCalledTimes(1);
  expect(s.manager.query).toHaveBeenCalledWith('UPDATE user_sessions SET revoked_at = GREATEST($1::timestamptz, created_at) WHERE token_hash = $2 AND user_id = $3 AND revoked_at IS NULL AND expires_at > $1::timestamptz', [now, hashSessionToken(previous), 'u1']);
  expect(s.manager.query.mock.calls[0][0]).toBe(ROTATE_SESSION_SQL);
  expect(s.run.mock.invocationCallOrder[0]).toBeLessThan(s.manager.query.mock.invocationCallOrder[0]);
  expect(s.manager.query.mock.invocationCallOrder[0]).toBeLessThan(s.manager.insert.mock.invocationCallOrder[0]);
  expect(s.manager.insert).toHaveBeenCalledTimes(1);
});
it.each([undefined, null, '', 'inválida', { status: 'duplicate' }])('omite revocación para cookie inválida o ausente %#', async presentedSessionToken => {
  const s = setup(); await s.service.login({ ...input, presentedSessionToken });
  expect(s.manager.query).not.toHaveBeenCalled();
});
it.each(['55P03', '08006'])('descarta revocación si falla insert y traduce %s sin reintentar', async code => {
  const s = setup(); s.manager.insert.mockRejectedValue({ severity: 'ERROR', code });
  const error = await s.service.login({ ...input, presentedSessionToken: previous }).catch((error: unknown) => error) as DatabaseOperationError;
  expect(error).toBeInstanceOf(DatabaseOperationError);
  expect(error.context).toEqual({ operation: 'insert', atomic: true, valuesOrigin: 'system' });
  expect(error.failure.outcome).toBe(code === '08006' ? 'unknown' : 'not_applied');
  expect(s.committedRevocations()).toBe(0);
  expect(s.manager.query).toHaveBeenCalledTimes(1);
  expect(s.manager.insert).toHaveBeenCalledTimes(1);
  expect(s.run).toHaveBeenCalledTimes(1);
});

// Espías envolventes: hash y verify ejecutan la biblioteca nativa real.
jest.mock('@node-rs/argon2', () => {
  const actual = jest.requireActual<typeof import('@node-rs/argon2')>('@node-rs/argon2');
  return { ...actual, hash: jest.fn(actual.hash), verify: jest.fn(actual.verify), parseOptions: jest.fn(actual.parseOptions) };
});

it('documenta seis rutas de login con Argon2 real y un único hash ficticio compartido', async () => {
  const s = setup();
  const hasher = new Argon2idPasswordHasher();
  const realHash = await hasher.hash(input.password);
  const verify = jest.spyOn(hasher, 'verify');
  const hash = jest.spyOn(hasher, 'hash');
  jest.mocked(native.hash).mockClear(); // Excluir únicamente el hash real de preparación.
  const service = new AuthenticationService(hasher, { now: () => now }, { next: () => 's1' }, { run: s.run } as TransactionRunner,
    s.users as unknown as Repository<User>, s.factory);
  const cases = [
    { label: 'email malformado', email: 'inválido', password: input.password, exists: false, query: 0, native: 1 },
    { label: 'contraseña malformada', email: input.email, password: null, exists: true, query: 0, native: 0 },
    { label: 'ambos malformados', email: 'inválido', password: null, exists: false, query: 0, native: 0 },
    { label: 'usuario inexistente', email: 'nadie@example.cl', password: input.password, exists: false, query: 1, native: 1 },
    { label: 'contraseña incorrecta', email: input.email, password: input.password + '!', exists: true, query: 1, native: 1 },
    { label: 'éxito', email: input.email, password: input.password, exists: true, query: 1, native: 1 },
  ];
  let dummyHash: string | undefined;
  const failures: unknown[] = [];
  for (const attempt of cases) {
    s.users.createQueryBuilder.mockClear(); s.getOne.mockClear();
    s.getOne.mockResolvedValue(attempt.exists ? { ...s.user, passwordHash: realHash } : null);
    verify.mockClear(); jest.mocked(native.verify).mockClear();
    const result: unknown = await service.login(attempt).catch((error: unknown) => error);
    expect([attempt.label, s.users.createQueryBuilder.mock.calls.length, s.getOne.mock.calls.length,
      verify.mock.calls.length, jest.mocked(native.verify).mock.calls.length])
      .toEqual([attempt.label, attempt.query, attempt.query, 1, attempt.native]);
    const expectedHash = attempt.query && attempt.exists ? realHash : (dummyHash ??= verify.mock.calls[0][0] as string);
    expect(verify).toHaveBeenCalledWith(expectedHash, attempt.password);
    if (attempt.native) expect(native.verify).toHaveBeenCalledWith(expectedHash, attempt.password);
    if (attempt.label === 'éxito') {
      expect(result).toMatchObject({ token, user: { id: s.user.id }, membership: { id: s.active.id } });
    } else {
      expect(result).toBeInstanceOf(UnauthenticatedError);
      expect(result).toMatchObject({ code: 'unauthenticated', httpStatus: 401, message: 'Credenciales inválidas.', field: undefined });
      expect(result).toEqual(new UnauthenticatedError('Credenciales inválidas.'));
      failures.push(result);
      expect(s.run).not.toHaveBeenCalled();
    }
  }
  expect(failures[3]).toEqual(failures[4]);
  expect(dummyHash).not.toBe(realHash);
  expect(hash).toHaveBeenCalledTimes(1);
  expect(native.hash).toHaveBeenCalledTimes(1);
  expect(s.run).toHaveBeenCalledTimes(1);
  expect(s.manager.insert).toHaveBeenCalledTimes(1);
});
