import { DatabaseConnectionConfig, DatabaseCredentials } from '../config/database-credentials';
import 'reflect-metadata';
import { IncomingMessage, createServer } from 'node:http';
import request from 'supertest';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { pino } from 'pino';
import { createLoggerOptions, requestId, sanitizeUrl, serializeRequest } from './logger-options';
import { installFatalHandlers } from './fatal-handlers';
import { isUuidV7, Uuid7Generator } from '../common/ids/uuid7-generator';

describe('Logging', () => {
  it('redacta cabeceras y claves anidadas sin filtrar secretos', () => {
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const options = createLoggerOptions({ logLevel: 'info' }, stream);
    // Sin serializadores para verificar también las reglas defensivas de redact.
    const logger = pino({ ...options, serializers: {} }, stream);
    logger.info({ req: { headers: { authorization: 'secret-auth', cookie: 'secret-cookie', 'x-csrf-token': 'secret-csrf', 'x-api-key': 'secret-key' } }, res: { headers: { 'set-cookie': 'secret-set' } }, password: 'secret-password', data: { token: 'secret-token', nested: { passwordHash: 'secret-hash', accessToken: 'secret-access', refreshToken: 'secret-refresh', secret: 'secret-value', apiKey: 'secret-api', cookie: 'secret-c' } } });
    expect(output).not.toContain('secret-');
    expect(output).toContain('[REDACTED]');
  });
  it('redacta la configuración y todas las claves de BD hasta cuatro contenedores', () => {
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const password = 'fake-password-for-unit-tests-0001';
    const logger = pino(createLoggerOptions({ logLevel: 'info' }, stream), stream);
    const config = new DatabaseConnectionConfig('localhost', 5433, 'agenda_test', new DatabaseCredentials('agenda_test_app', password), 5);
    logger.info({ config, DATABASE_PASSWORD: password, connectionString: 'CANARIO_SECRETO_123' });
    for (const key of ['DATABASE_PASSWORD', 'DATABASE_MIGRATION_PASSWORD', 'databasePassword', 'connectionString', 'credentials']) {
      for (let depth = 0; depth <= 4; depth++) {
        let value: Record<string, unknown> = { [key]: 'CANARIO_SECRETO_123' };
        for (let i = 0; i < depth; i++) value = { nested: value };
        logger.info(value);
      }
    }
    expect(output.includes(password)).toBe(false);
    expect(output).not.toContain('CANARIO_SECRETO_123');
    expect(output).toContain('[REDACTED]');
  });
  it('silent no emite', () => {
    const write = jest.fn();
    const stream = new Writable({ write(chunk, _encoding, done) { write(chunk); done(); } });
    pino(createLoggerOptions({ logLevel: 'silent' }), stream).fatal('mensaje');
    expect(write).not.toHaveBeenCalled();
  });
  it('sanitiza query, tokens y codificación; preserva UUID', () => {
    const uuid = new Uuid7Generator().next();
    expect(sanitizeUrl(`/x/${'a'.repeat(24)}/${uuid}?token=secret`)).toBe(`/x/[REDACTED]/${uuid}`);
    expect(sanitizeUrl(`/x/${'%61'.repeat(24)}`)).toBe('/x/[REDACTED]');
    expect(sanitizeUrl('/x/%XX')).toBe('/x/[REDACTED]');
  });
  it.each([undefined, 'short', 'x'.repeat(65), 'with spaces', 'abcdefgh\n', 'abcdefgh\r', 'abcdefgh\u0000', ['abcdefgh']])('reemplaza id inválido %p', value => expect(isUuidV7(requestId(value, new Uuid7Generator()))).toBe(true));
  it('reutiliza ids válidos', () => expect(requestId('valid_ID.123-xyz', new Uuid7Generator())).toBe('valid_ID.123-xyz'));
  it.each(['unhandledRejection', 'uncaughtException'])('fatal %s no registra el objeto y sale con 1', event => {
    const emitter = Object.assign(new EventEmitter(), { exit: jest.fn() });
    const logger = { fatal: jest.fn() };
    const remove = installFatalHandlers(logger, emitter);
    emitter.emit(event, { secret: 'no-divulgar' });
    expect(logger.fatal).toHaveBeenCalledWith({ event, err: { secret: 'no-divulgar' } }, 'Fallo fatal del proceso.');
    expect(emitter.exit).toHaveBeenCalledWith(1);
    remove();
    expect(emitter.listenerCount(event)).toBe(0);
  });
});

describe('remoteAddress mediante getter nativo', () => {
  it('omite la dirección de un socket real sin conexión sin lanzar', () => {
    const req = new IncomingMessage(new Socket());
    req.method = 'GET'; req.url = '/safe';
    expect(() => serializeRequest(req)).not.toThrow();
    expect(serializeRequest(req)).toEqual({ method: 'GET', url: '/safe' });
  });
  it('omite direcciones de objetos falsos, incluso bajo una petición real', () => {
    expect(serializeRequest({ socket: { remoteAddress: 'CANARIO_IP' } })).toEqual({});
    const req = new IncomingMessage(new Socket());
    Object.defineProperty(req, 'socket', { value: { remoteAddress: 'CANARIO_IP' } });
    expect(serializeRequest(req)).not.toHaveProperty('remoteAddress');
    expect(JSON.stringify(serializeRequest(req))).not.toContain('CANARIO_IP');
  });
  class CustomSocket extends Socket {}
  it.each([Socket, CustomSocket])('no invoca el accesor propio hostil de %p', Ctor => {
    const socket = new Ctor();
    const get = jest.fn(() => { throw new Error('CANARIO_IP'); });
    Object.defineProperty(socket, 'remoteAddress', { get });
    const req = new IncomingMessage(socket);
    expect(serializeRequest(req)).not.toHaveProperty('remoteAddress');
    expect(get).not.toHaveBeenCalled();
  });
  it('rechaza proxies de petición, socket y prototipo sin ejecutar trampas', () => {
    const trap = jest.fn(() => { throw new Error('CANARIO_PROXY'); });
    const handler = { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap };
    const req = new IncomingMessage(new Socket());
    expect(serializeRequest(new Proxy(req, handler))).toEqual({});
    Object.defineProperty(req, 'socket', { value: new Proxy(new Socket(), handler), configurable: true });
    expect(serializeRequest(req)).not.toHaveProperty('remoteAddress');
    Object.defineProperty(req, 'socket', { value: Object.create(new Proxy(Socket.prototype, handler)) });
    expect(serializeRequest(req)).not.toHaveProperty('remoteAddress');
    expect(trap).not.toHaveBeenCalled();
  });
});

describe('internos de socket hostiles con pino real', () => {
  type Mutate = (socket: Socket, req: IncomingMessage, hostile: () => string) => void;
  const cases: [string, Mutate][] = [
    ['socket genuino sin conexión', () => {}],
    ['socket falso', (_socket, req) => { Object.defineProperty(req, 'socket', { value: { remoteAddress: 'CANARIO_IP' } }); }],
    ['_getpeername propio', (socket, _req, h) => { Object.defineProperty(socket, '_getpeername', { value: h }); }],
    ['subclase con _getpeername', (socket, _req, h) => {
      class Child extends Socket { _getpeername() { return h(); } }
      Object.setPrototypeOf(socket, Child.prototype);
    }],
    ['_handle accesor', (socket, _req, h) => { Object.defineProperty(socket, '_handle', { get: h }); }],
    ['_handle con getter original y setter distinto', (socket, _req, h) => {
      const descriptor = Object.getOwnPropertyDescriptor(Socket.prototype, '_handle');
      Object.defineProperty(socket, '_handle', { get: descriptor?.get, set: h });
    }],
    ['getpeername JS', (socket, _req, h) => { Object.defineProperty(socket, '_handle', { value: { getpeername: h } }); }],
    ['getpeername accesor', (socket, _req, h) => {
      Object.defineProperty(socket, '_handle', { value: Object.defineProperty({}, 'getpeername', { get: h }) });
    }],
    ['_peername accesor', (socket, _req, h) => { Object.defineProperty(socket, '_peername', { get: h }); }],
    ['connecting accesor', (socket, _req, h) => { Object.defineProperty(socket, 'connecting', { get: h }); }],
  ];
  it.each(cases)('%s no ejecuta código ni filtra datos', (_label, mutate) => {
    const hostile = jest.fn(() => 'CANARIO_IP');
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = 'GET'; req.url = '/safe';
    mutate(socket, req, hostile);
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const logger = pino(createLoggerOptions({ logLevel: 'info' }, stream), stream);
    expect(() => logger.info({ req }, 'Seguro.')).not.toThrow();
    expect(hostile).not.toHaveBeenCalled();
    expect(output).not.toContain('CANARIO_');
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry: unknown = JSON.parse(lines[0]);
    expect(entry).toHaveProperty('req.method', 'GET');
    expect(entry).not.toHaveProperty('req.remoteAddress');
  });
});

it('serializeRequest conserva remoteAddress en una petición a un servidor HTTP real', async () => {
  let serialized: object | undefined;
  const server = createServer((req, res) => {
    Object.assign(req, { id: 'http-real-request' });
    serialized = serializeRequest(req);
    res.end('ok');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    await request(server).get('/safe?token=CANARIO_QUERY').expect(200);
    expect(serialized).toEqual({ id: 'http-real-request', method: 'GET', url: '/safe', remoteAddress: expect.any(String) });
    expect(Object.keys(serialized ?? {}).sort()).toEqual(['id', 'method', 'remoteAddress', 'url']);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
