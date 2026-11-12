import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { Writable } from 'node:stream';
import type { EntityManager } from 'typeorm';
import request from 'supertest';
import { AllExceptionsFilter } from '../common/errors/all-exceptions.filter';
import { ServiceUnavailableError } from '../common/errors/domain-error';
import { configureHttpApp } from '../common/http/configure-http-app';
import { IdGenerator } from '../common/ids/id-generator';
import { AppConfigService } from '../config/app-config.service';
import { LimitedPasswordHasher } from '../identity/limited-password-hasher';
import { PasswordHasher } from '../identity/password-hasher';
import { createLoggerOptions } from '../logging/logger-options';
import { RegistrationController } from './registration.controller';
import { RegistrationService, registrationNormalizers, REGISTRATION_NORMALIZERS, REGISTRATION_NOW } from './registration.service';
import { TransactionRunner } from './transaction-runner';

const password = '  registration-password-canary  ';
const hash = 'registration-hash-canary';
const input = { email: 'ana@example.test', password, name: 'Ana', organizationName: 'Equipo' };
const path = '/api/v1/auth/register';

describe('POST auth/register con servicio, pipeline y logging reales', () => {
  let app: INestApplication;
  let output: string;
  let hasher: PasswordHasher;
  let failure: unknown;
  let sequence: number;
  const hashMock = jest.fn<Promise<string>, [unknown]>();
  const insert = jest.fn().mockResolvedValue({});
  const runner: TransactionRunner = {
    async run<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
      if (failure) throw failure;
      return work({ insert } as unknown as EntityManager);
    },
  };
  beforeEach(async () => {
    output = ''; failure = undefined; sequence = 0;
    insert.mockClear();
    hashMock.mockReset().mockResolvedValue(hash);
    hasher = { hash: hashMock, verify: async () => false, needsRehash: () => false };
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const ids = { next: () => `test-id-${++sequence}` };
    const module = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: createLoggerOptions({ logLevel: 'info' }, stream, ids), useExisting: true })],
      controllers: [RegistrationController],
      providers: [RegistrationService,
        { provide: PasswordHasher, useValue: { hash: (value: unknown) => hasher.hash(value) } },
        { provide: IdGenerator, useValue: ids }, { provide: TransactionRunner, useValue: runner },
        { provide: REGISTRATION_NOW, useValue: () => new Date(0) },
        { provide: REGISTRATION_NORMALIZERS, useValue: registrationNormalizers },
        { provide: AppConfigService, useValue: { logLevel: 'info' } },
        { provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await configureHttpApp(app);
    await app.init();
    output = '';
  });
  afterEach(async () => { await app?.close(); });

  function secure(response: request.Response) {
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.headers['x-request-id']).not.toBe('');
    expect(response.text).not.toContain(password);
    expect(response.text).not.toContain(hash);
    expect(response.text).not.toContain('passwordHash');
    expect(response.text.replace(/"field"\s*:\s*"password"/g, '')).not.toContain('password');
    const lines = output.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some(line => line.includes('Solicitud finalizada.'))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain(password);
      expect(line).not.toContain(hash);
    }
  }
  function error(response: request.Response, status: number, code: string, field?: string) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: { code, message: expect.any(String),
      requestId: response.headers['x-request-id'], ...(field ? { field } : {}) } });
    secure(response);
  }
  const post = (body: object = input) => request(app.getHttpServer()).post(path).send(body);
  const databaseError = (code: string, constraint?: string) => ({ severity: 'ERROR', code, constraint,
    table: 'users', detail: `${password} ${hash}`, message: `${password} ${hash}` });

  it('201 devuelve exclusivamente el resultado público y conserva los espacios de la contraseña', async () => {
    const response = await post().expect(201);
    expect(response.body).toEqual({ user: { id: expect.any(String), email: input.email, name: input.name },
      organization: { id: expect.any(String), name: input.organizationName },
      membership: { id: expect.any(String), role: 'community_manager' } });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers).not.toHaveProperty('location');
    expect(hashMock).toHaveBeenCalledWith(password);
    expect(insert).toHaveBeenCalledTimes(3);
    secure(response);
  });
  it('rechaza Content-Type distinto de JSON', async () => {
    error(await request(app.getHttpServer()).post(path).type('text').send(password), 415, 'unsupported_media_type');
    expect(hashMock).not.toHaveBeenCalled();
  });
  it('rechaza cuerpos mayores de 100 KB', async () => {
    error(await post({ ...input, name: 'x'.repeat(101 * 1024) }), 413, 'payload_too_large');
    expect(hashMock).not.toHaveBeenCalled();
  });
  it.each(['email', 'password', 'name', 'organizationName'] as const)('valida ausencia, tipo y longitud gruesa de %s', async field => {
    const missing: Record<string, unknown> = { ...input }; delete missing[field];
    error(await post(missing), 400, 'invalid_input', field);
    error(await post({ ...input, [field]: 42 }), 400, 'invalid_input', field);
    const max = { email: 254, password: 1024, name: 200, organizationName: 200 }[field];
    error(await post({ ...input, [field]: 'x'.repeat(max + 1) }), 400, 'invalid_input', field);
    expect(hashMock).not.toHaveBeenCalled();
  });
  it('omite field si hay propiedad desconocida incluso junto a otro error', async () => {
    error(await post({ ...input, extra: true }), 400, 'invalid_input');
    error(await post({ ...input, email: 42, extra: true }), 400, 'invalid_input');
  });
  it.each([['email', 'invalid'], ['name', ' '], ['organizationName', ' '], ['password', 'short']])('conserva validación fina de %s', async (field, value) => {
    error(await post({ ...input, [field]: value }), 400, 'invalid_input', field);
    expect(hashMock).not.toHaveBeenCalled();
  });
  it.each([['UQ_users_email', 'email'], ['UQ_organizations_name_key', 'organizationName']])('409 para %s', async (constraint, field) => {
    failure = databaseError('23505', constraint);
    error(await post(), 409, 'conflict', field);
    expect(hashMock).toHaveBeenCalledWith(password);
  });
  it('503 por saturación tiene Retry-After y permite terminar la primera petición', async () => {
    let release!: (value: string) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    hashMock.mockImplementation(() => { entered(); return new Promise<string>(resolve => { release = resolve; }); });
    hasher = new LimitedPasswordHasher(hasher, 1, 0);
    const first = post().then(response => response);
    try {
      await started;
      const response = await post();
      error(response, 503, 'service_unavailable');
      expect(response.headers['retry-after']).toBe('1');
      expect(hashMock).toHaveBeenCalledTimes(1);
    } finally {
      release(hash);
      const response = await first;
      expect(response.status).toBe(201);
      secure(response);
    }
  });
  it('503 por fallo nativo no tiene Retry-After', async () => {
    hashMock.mockRejectedValue(new ServiceUnavailableError());
    const response = await post();
    error(response, 503, 'service_unavailable');
    expect(response.headers).not.toHaveProperty('retry-after');
  });
  it('503 outcome_unknown impide cachear', async () => {
    failure = databaseError('08006');
    const response = await post();
    error(response, 503, 'outcome_unknown');
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('503 por lock_timeout conocido incluye Retry-After', async () => {
    failure = databaseError('55P03');
    const response = await post();
    error(response, 503, 'service_unavailable');
    expect(response.headers['retry-after']).toBe('1');
  });
  it('500 para otro error de base de datos', async () => {
    failure = databaseError('XX000');
    error(await post(), 500, 'internal_error');
  });
  it.each(['get', 'put', 'delete'] as const)('%s no registra la ruta', async method => {
    error(await request(app.getHttpServer())[method](path), 404, 'not_found');
    expect(hashMock).not.toHaveBeenCalled();
  });
});
