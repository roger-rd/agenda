import { inspect } from 'node:util';
import { EntityManager, getMetadataArgsStorage } from 'typeorm';
import { InvalidInputError, ServiceUnavailableError } from '../common/errors/domain-error';
import { Uuid7Generator, isUuidV7 } from '../common/ids/uuid7-generator';
import { User } from '../persistence/entities/user.entity';
import { Organization } from '../persistence/entities/organization.entity';
import { OrganizationMembership } from '../persistence/entities/organization-membership.entity';
import { TransactionRunner } from './transaction-runner';
import { RegistrationService, registrationNormalizers } from './registration.service';

const password = 'contraseña secreta suficientemente larga';
const hashValue = '$argon2id$hash-falso-solo-para-pruebas';
const input = { email: '  ANA@EXAMPLE.COM ', password, name: ' Ana  María ', organizationName: ' ÁCME\u00a0Sur ' };
function setup() {
  const hash = jest.fn().mockResolvedValue(hashValue);
  const insert = jest.fn().mockResolvedValue({});
  const manager = { insert } as unknown as EntityManager;
  const run = jest.fn(async <T>(work: (manager: EntityManager) => Promise<T>): Promise<T> => work(manager));
  const date = new Date('2026-01-02T03:04:05Z');
  const now = jest.fn(() => date);
  const generator = new Uuid7Generator();
  const ids = [generator.next(), generator.next(), generator.next()];
  const next = jest.fn().mockReturnValueOnce(ids[0]).mockReturnValueOnce(ids[1]).mockReturnValueOnce(ids[2]);
  const service = new RegistrationService({ hash, verify: jest.fn(), needsRehash: jest.fn() }, { next }, { run: run as TransactionRunner['run'] }, now, registrationNormalizers);
  return { hash, insert, manager, run, now, date, ids, next, service };
}
function expectNoSecrets(value: unknown) {
  for (const text of [JSON.stringify(value), inspect(value)]) {
    expect(text).not.toContain(password);
    expect(text).not.toContain(hashValue);
  }
}

describe('registro atómico con dobles', () => {
  it('inserta payloads exactos con un solo manager y devuelve únicamente datos públicos', async () => {
    const { service, hash, run, now, date, ids, insert, manager } = setup();
    const result = await service.register(input);
    const common = { version: 1, createdAt: date, updatedAt: date };
    expect(insert.mock.calls).toEqual([
      [User, { ...common, id: ids[0], email: 'ana@example.com', name: 'Ana María', passwordHash: hashValue, passwordChangedAt: date }],
      [Organization, { ...common, id: ids[1], name: 'ÁCME Sur', nameKey: 'acme sur' }],
      [OrganizationMembership, { ...common, id: ids[2], userId: ids[0], organizationId: ids[1], role: 'community_manager', deactivatedAt: null }],
    ]);
    expect(ids.every(isUuidV7)).toBe(true);
    expect(insert.mock.contexts).toEqual([manager, manager, manager]);
    for (const [entity, payload] of insert.mock.calls as [typeof User, Record<string, unknown>][]) {
      const columns = getMetadataArgsStorage().columns.filter(column => column.target === entity).map(column => column.propertyName);
      expect(Object.keys(payload).sort()).toEqual(columns.sort());
      expect(payload.createdAt).toBe(date);
      expect(payload.updatedAt).toBe(date);
    }
    expect(insert.mock.calls[0][1].passwordChangedAt).toBe(date);
    expect(hashValue).not.toBe(password);
    expect(result).toEqual({ user: { id: ids[0], email: 'ana@example.com', name: 'Ana María' }, organization: { id: ids[1], name: 'ÁCME Sur' }, membership: { id: ids[2], role: 'community_manager' } });
    expectNoSecrets(result);
    expect(hash).toHaveBeenCalledTimes(1);
    expect(hash).toHaveBeenCalledWith(password);
    expect(run).toHaveBeenCalledTimes(1);
    expect(now).toHaveBeenCalledTimes(1);
    expect(hash.mock.invocationCallOrder[0]).toBeLessThan(now.mock.invocationCallOrder[0]);
    expect(now.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
  });
  it.each([['email', 'bad'], ['name', 'A\nB'], ['organizationName', 'A'], ['organizationName', 'ﬃ'.repeat(27)], ['password', 'short']])('rechaza %s antes del hash', async (field, value) => {
    const { service, hash, run, now } = setup();
    const error: unknown = await service.register({ ...input, [field]: value }).catch((error: unknown) => error);
    expect(error).toEqual(new InvalidInputError('Datos de entrada inválidos.', field));
    expectNoSecrets(error);
    expect(hash).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });
  it('espera el hash resuelto antes de abrir la transacción', async () => {
    const { service, hash, run, now } = setup();
    let resolveHash!: (value: string) => void;
    hash.mockReturnValue(new Promise<string>(resolve => { resolveHash = resolve; }));
    const pending = service.register(input);
    expect(run).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    resolveHash(hashValue);
    await pending;
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('fallo de hash no abre transacción', async () => {
    const { service, hash, run, now } = setup();
    const error = new ServiceUnavailableError();
    hash.mockRejectedValueOnce(error);
    await expect(service.register(input)).rejects.toBe(error);
    expectNoSecrets(error);
    expect(run).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3])('fallo en inserción %i detiene el flujo y no reintenta', async position => {
    const { service, insert, run } = setup();
    for (let i = 1; i < position; i++) insert.mockResolvedValueOnce({});
    insert.mockRejectedValueOnce({ severity: 'ERROR', code: '23505', table: 'users', constraint: 'UQ_users_email', detail: `${password} ${hashValue}` });
    const error: unknown = await service.register(input).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'conflict', field: 'email' });
    expectNoSecrets(error);
    expect(insert).toHaveBeenCalledTimes(position);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('traduce el fallo de confirmación del runner sin reintentar', async () => {
    const { service, run } = setup();
    run.mockRejectedValueOnce({ severity: 'ERROR', code: '08006', table: 'users', detail: `${password} ${hashValue}` });
    const error: unknown = await service.register(input).catch((error: unknown) => error);
    expect(error).toMatchObject({ failure: { outcome: 'unknown' }, context: { atomic: true } });
    expectNoSecrets(error);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
