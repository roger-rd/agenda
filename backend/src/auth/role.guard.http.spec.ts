import 'reflect-metadata';
import { Clock } from '../common/clock/clock';
import { Body, Controller, INestApplication, Post, UseGuards } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { IsString, Length } from 'class-validator';
import { LoggerModule } from 'nestjs-pino';
import { Writable } from 'node:stream';
import request from 'supertest';
import { AllExceptionsFilter } from '../common/errors/all-exceptions.filter';
import { configureHttpApp } from '../common/http/configure-http-app';
import { JsonBody } from '../common/http/content-type';
import { OriginProtected } from '../common/http/origin.guard';
import { IdGenerator } from '../common/ids/id-generator';
import { IdsModule } from '../common/ids/ids.module';
import { AppConfigService } from '../config/app-config.service';
import { deriveCsrfToken, generateSessionToken } from '../identity/session-token';
import { createLoggerOptions } from '../logging/logger-options';
import { RequireRole } from './require-role';
import { RoleGuard } from './role.guard';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionService } from './session.service';

class Input { @IsString() @Length(2, 80) name!: string; }
const service = jest.fn();
@Controller('prueba-rol')
class RoleTestController {
  @Post() @OriginProtected() @UseGuards(SessionAuthGuard, RoleGuard) @RequireRole('community_manager') @JsonBody()
  create(@Body() body: Input) { return service(body); }
}
const token = generateSessionToken(() => Buffer.alloc(32, 7));
const cookie = `agenda_session=${token}`;
const csrf = deriveCsrfToken(token);
const origin = 'https://permitido.test';
const now = new Date('2026-01-01T00:00:00Z');
const session = { organization: { id: 'o1' }, membership: { id: 'm1', role: 'community_manager' } };

describe('Origin → JSON/415 → cookie → CSRF → authenticate → rol → validación → servicio', () => {
  let app: INestApplication;
  let output: string;
  const authenticate = jest.fn();
  beforeEach(async () => {
    output = ''; authenticate.mockReset().mockResolvedValue(session); service.mockReset().mockReturnValue({ ok: true });
    let sequence = 0;
    const ids = { next: () => `petición-${++sequence}` };
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const module = await Test.createTestingModule({
      imports: [IdsModule, LoggerModule.forRoot({ pinoHttp: createLoggerOptions({ logLevel: 'info' }, stream, ids), useExisting: true })],
      controllers: [RoleTestController],
      providers: [{ provide: Clock, useValue: { now: () => now } }, SessionAuthGuard, RoleGuard, { provide: SessionService, useValue: { authenticate } },
        { provide: AppConfigService, useValue: { env: 'test', logLevel: 'info', allowedOrigins: [origin] } },
        { provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).overrideProvider(IdGenerator).useValue(ids).compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    await configureHttpApp(app); await app.init();
  });
  afterEach(async () => { await app?.close(); });
  const post = () => request(app.getHttpServer()).post('/api/v1/prueba-rol').set('Origin', origin);
  const authorized = () => post().set('Cookie', cookie).set('X-CSRF-Token', csrf);
  function rejected(response: request.Response, status: number) {
    expect(response.status).toBe(status); expect(service).not.toHaveBeenCalled();
    expect(output).toContain('Solicitud finalizada.');
  }
  it('Origin rechazado → 403 antes de JSON/415, cookie, CSRF y authenticate', async () => {
    const response = await post().set('Origin', 'null').type('text').send('texto');
    rejected(response, 403); expect(response.headers['set-cookie']).toBeUndefined();
    expect(authenticate).not.toHaveBeenCalled();
  });
  it('JSON/415 precede a cookie, CSRF y authenticate', async () => {
    rejected(await post().type('text').send('texto'), 415);
    expect(authenticate).not.toHaveBeenCalled();
  });
  it('cookie inválida → 401 antes de CSRF y authenticate', async () => {
    rejected(await post().set('Cookie', 'agenda_session=incorrecta').send({}), 401);
    expect(authenticate).not.toHaveBeenCalled();
  });
  it.each([undefined, 'incorrecto'])('CSRF %p → 403 antes de authenticate y de la base', async value => {
    const req = post().set('Cookie', cookie).send({});
    if (value !== undefined) req.set('X-CSRF-Token', value);
    const response = await req;
    rejected(response, 403); expect(response.headers['set-cookie']).toBeUndefined(); expect(authenticate).not.toHaveBeenCalled();
  });
  it('authenticate rechaza cookie sin sesión vigente → 401 antes del rol', async () => {
    authenticate.mockResolvedValue(null);
    rejected(await authorized().send({}), 401); expect(authenticate).toHaveBeenCalledTimes(1);
  });
  it.each(['worker', 'client'])('authenticate → rol %s con cuerpo inválido → 403, antes de validación y servicio', async role => {
    // La sesión ya se renovó en servidor: el rechazo posterior por rol conserva la cookie reemitida.
    authenticate.mockResolvedValue({ ...session, renewed: true, expiresAt: new Date(now.getTime() + 12500), membership: { id: 'm1', role } });
    const response = await authorized().send({ name: 123, extra: true });
    rejected(response, 403);
    expect(response.headers['set-cookie']).toEqual([
      `agenda_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=12`,
    ]);
    expect(authenticate).toHaveBeenCalledTimes(1); expect(authenticate).toHaveBeenCalledWith(token);
  });
  it.each([{}, { name: 123 }, { name: 'Empresa', extra: true }])('community_manager: authenticate → rol → validación inválida %p → 400 sin servicio', async body => {
    rejected(await authorized().send(body), 400); expect(authenticate).toHaveBeenCalledTimes(1);
  });
  it('community_manager: authenticate → rol → validación válida → servicio → 201', async () => {
    const response = await authorized().send({ name: 'Empresa' });
    expect(response.status).toBe(201); expect(response.body).toEqual({ ok: true });
    expect(authenticate).toHaveBeenCalledTimes(1); expect(service).toHaveBeenCalledTimes(1);
    expect(service).toHaveBeenCalledWith({ name: 'Empresa' });
  });
});
