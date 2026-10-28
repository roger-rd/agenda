import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { pino } from 'pino';
import { Logger as NestLogger, PinoLogger } from 'nestjs-pino';
import { QueryFailedError, TypeORMError } from 'typeorm';
import { DatabaseError } from 'pg';
import { HttpException } from '@nestjs/common';
import { InvalidInputError } from '../common/errors/domain-error';
import { createLoggerOptions, serializeRequest, serializeResponse } from './logger-options';
import { createBootstrapLogger, logMethodHook, safeLogging, extraRedactPaths } from './safe-logging';
import { registerSecret, resetSecretsForTests } from './secret-registry';
import { installFatalHandlers } from './fatal-handlers';
const password = 'fake-password-for-unit-tests-0001';
function capture() {
  let output = '';
  const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const logger = pino(createLoggerOptions({ logLevel: 'trace' }, stream), stream);
  return { logger, stream, output: () => output, logs: (): Record<string, unknown>[] => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) };
}
afterEach(() => { jest.restoreAllMocks(); resetSecretsForTests(); });
it.each(['direct', 'wrapped'])('reemplaza msg derivado %s', mode => {
  const c = capture();
  const e = new QueryFailedError('CANARIO_QUERY', ['CANARIO_PARAM'], Object.assign(new Error('CANARIO_MSG'), { code: '23505', detail: 'CANARIO_DETAIL' }));
  if (mode === 'direct') c.logger.error(e); else c.logger.error({ err: e });
  expect(c.output()).not.toContain('CANARIO_');
  expect(c.logs()[0]).toMatchObject({ msg: 'Error de base de datos 23505 (violación de integridad).', err: { sqlState: '23505' } });
});
it('depura mensajes explícitos e interpolaciones', () => {
  registerSecret(password);
  const c = capture();
  c.logger.error(password);
  c.logger.error({}, password);
  c.logger.error(new Error('safe'), password);
  c.logger.error('value %s %j', password, { secret: password });
  expect(c.output()).not.toContain(password);
  expect(c.logs()).toHaveLength(4);
});
it('protege getters previos al formatter, proxies y fallos del destino', () => {
  const c = capture();
  const get = jest.fn(() => { throw new Error('CANARIO_GET'); });
  c.logger.error(Object.defineProperty({}, 'method', { get, enumerable: true }));
  c.logger.error(new Proxy({}, { get, getPrototypeOf: get, ownKeys: get }));
  expect(get).not.toHaveBeenCalled();
  const method = jest.fn(() => { throw new Error('CANARIO_SINK'); });
  expect(() => logMethodHook.call(c.logger, [new Error('safe')], method, 50)).not.toThrow();
  expect(c.output()).not.toContain('CANARIO_');
});
it('compone las cuatro capas y mantiene redact como defensa independiente', () => {
  const options = createLoggerOptions({ logLevel: 'info' });
  expect(options.hooks).toBe(safeLogging.hooks);
  expect(options.formatters).toBe(safeLogging.formatters);
  expect(options.serializers).toMatchObject(safeLogging.serializers);
  expect(options.wrapSerializers).toBe(false);
  const c = capture();
  const logger = pino({ ...options, hooks: {}, formatters: {}, serializers: {} }, c.stream);
  for (const key of ['query', 'parameters', 'driverError', 'detail', 'hint', 'where', 'internalQuery']) logger.error({ err: { [key]: 'CANARIO_REDACT' }, x: { [key]: 'CANARIO_REDACT' } });
  expect(c.output()).not.toContain('CANARIO_');
  expect(extraRedactPaths).toEqual(['err.query', 'err.parameters', 'err.driverError', 'err.detail', 'err.hint', 'err.where', 'err.internalQuery', '*.query', '*.parameters', '*.driverError', '*.detail', '*.hint', '*.where', '*.internalQuery']);
});
it('bootstrap usa stderr, nivel fatal y saneamiento real', () => {
  const c = capture();
  const destination = jest.spyOn(pino, 'destination').mockReturnValue(c.stream as unknown as ReturnType<typeof pino.destination>);
  registerSecret(password);
  const logger = createBootstrapLogger();
  expect(destination).toHaveBeenCalledWith(2);
  logger.error('no emitir');
  logger.fatal({ err: new Error(`password=${password}`) });
  expect(c.logs()).toHaveLength(1);
  expect(c.logs()[0].level).toBe(60);
  expect(c.output()).not.toContain(password);
});
it.each(['uncaughtException', 'unhandledRejection'])('fatal %s sanea motivo y omite segundo argumento', event => {
  registerSecret('CANARIO_STRING');
  const reasons = [new Error('password=CANARIO_ERROR'), new QueryFailedError('CANARIO_SQL', ['CANARIO_PARAM'], new Error('CANARIO_DRIVER')), 'CANARIO_STRING', { secret: 'CANARIO_OBJECT' }];
  for (const reason of reasons) {
    const c = capture();
    const emitter = Object.assign(new EventEmitter(), { exit: jest.fn() });
    const remove = installFatalHandlers(c.logger, emitter);
    emitter.emit(event, reason, { origin: 'CANARIO_ORIGIN', promise: 'CANARIO_PROMISE' });
    expect(c.output()).not.toContain('CANARIO_');
    expect(c.logs()).toHaveLength(1);
    expect(emitter.exit).toHaveBeenCalledWith(1);
    remove();
    expect(emitter.listenerCount(event)).toBe(0);
  }
});
it('fatal sale aunque el logger lance', () => {
  const emitter = Object.assign(new EventEmitter(), { exit: jest.fn() });
  const remove = installFatalHandlers({ fatal() { throw new Error(); } }, emitter);
  expect(() => emitter.emit('uncaughtException', new Error())).not.toThrow();
  expect(emitter.exit).toHaveBeenCalledWith(1);
  remove();
});
it('req/res validan tipos y nunca invocan accesores', () => {
  const get = jest.fn(() => 'CANARIO_GET');
  expect(serializeRequest({ id: 'x'.repeat(81), method: 'GET\n', url: 42, socket: { remoteAddress: 'x'.repeat(65) } })).toEqual({});
  expect(serializeResponse({ statusCode: 600 })).toEqual({});
  expect(serializeResponse({ statusCode: 200.5 })).toEqual({});
  expect(serializeRequest(Object.defineProperty({}, 'url', { get }))).toEqual({});
  expect(serializeResponse(Object.defineProperty({}, 'statusCode', { get }))).toEqual({});
  const proxy = new Proxy({}, { get, getOwnPropertyDescriptor() { get(); return undefined; } });
  expect(serializeRequest(proxy)).toEqual({}); expect(serializeResponse(proxy)).toEqual({});
  expect(get).not.toHaveBeenCalled();
  const req = serializeRequest({ id: 'safe', method: 'POST', url: '/safe?token=CANARIO_URL', socket: { remoteAddress: '127.0.0.1' }, body: 'CANARIO_BODY' });
  expect(req).toEqual({ id: 'safe', method: 'POST', url: '/safe' });
  expect(serializeRequest(req)).toBe(req);
  const res = serializeResponse({ statusCode: 201, headers: 'CANARIO_HEADERS' });
  expect(serializeResponse(res)).toBe(res);
});
it('context y claves arbitrarias atraviesan pino real', () => {
  const c = capture();
  c.logger.warn({ context: 'Error\n    at CANARIO_TRACE', payload: new QueryFailedError('CANARIO_SQL', [], new Error('CANARIO_MSG')), nested: { context: { secret: 'CANARIO_CONTEXT' } },
    req: { headers: { authorization: 'CANARIO_AUTH' }, body: 'CANARIO_BODY', secret: 'CANARIO_REQ' }, res: { body: 'CANARIO_RES' } });
  expect(c.output()).not.toContain('CANARIO_');
  expect(c.logs()[0]).toMatchObject({ context: '[CONTEXTO_OMITIDO]', nested: { context: '[CONTEXTO_OMITIDO]' }, req: {}, res: {} });
});

it('un proxy invocable tampoco ejecuta trampas al ser el primer argumento', () => {
  const c = capture();
  const trap = jest.fn(() => { throw new Error('CANARIO_TRAP'); });
  c.logger.error(new Proxy(() => {}, { get: trap, apply: trap, getPrototypeOf: trap }));
  expect(trap).not.toHaveBeenCalled();
  expect(c.output()).toContain('[PROXY]');
});

it('nestjs-pino real convierte stack/context sin filtrar el mensaje de BD', () => {
  const c = capture();
  const adapter = new NestLogger({ error: c.logger.error.bind(c.logger), warn: c.logger.warn.bind(c.logger) } as unknown as PinoLogger, {});
  const error = new QueryFailedError('CANARIO_SQL', ['CANARIO_PARAM'], Object.assign(new Error('CANARIO_PG'), { code: '23505' }));
  adapter.error(error);
  adapter.error('Mensaje seguro.', 'CANARIO_STACK\n    at safe.ts:1:2');
  adapter.error('Mensaje seguro.', 'CANARIO_STACK\n    at safe.ts:1:2', 'Contexto');
  adapter.warn({ e: error });
  expect(c.output()).not.toContain('CANARIO_');
  expect(c.logs()[0]).toMatchObject({ msg: 'Error de base de datos 23505 (violación de integridad).', err: { sqlState: '23505' } });
  expect(c.logs()[1]).toHaveProperty('context', '[CONTEXTO_OMITIDO]');
  expect(c.logs()[2]).toMatchObject({ context: 'Contexto', err: { message: 'Mensaje seguro.', stack: '    at safe.ts:1:2' } });
  expect(c.logs()[3]).toHaveProperty('e.sqlState', '23505');
});

describe('cabeceras hostiles con pino real', () => {
  type Factory = (hostile: () => string) => Error;
  const inherited = (key: string, hostile: () => string) => {
    class Child extends Error {}
    Object.defineProperty(Child.prototype, key, { get: hostile });
    return new Child();
  };
  const cases: [string, Factory][] = [
    ['name heredado', h => inherited('name', h)],
    ['message heredado', h => inherited('message', h)],
    ['name propio', h => Object.defineProperty(new Error('safe'), 'name', { get: h })],
    ['message dato con toString', h => Object.defineProperty(new Error(), 'message', { value: { toString: h } })],
    ['constructor propio de TypeORMError', h => {
      class Child extends TypeORMError {}
      return Object.defineProperty(new Child('safe'), 'constructor', { get: h });
    }],
    ['static name de TypeORMError', h => {
      class Child extends TypeORMError {}
      Object.defineProperty(Child, 'name', { get: h });
      return new Child('safe');
    }],
  ];
  it.each(cases)('%s no ejecuta código ni filtra datos', (_label, factory) => {
    const hostile = jest.fn(() => 'CANARIO_HEADER');
    const e = factory(hostile);
    const c = capture();
    expect(() => c.logger.error({ err: e }, 'Seguro.')).not.toThrow();
    expect(hostile).not.toHaveBeenCalled();
    expect(c.output()).not.toContain('CANARIO_');
    expect(c.logs()).toHaveLength(1);
    expect(c.logs()[0]).toHaveProperty('err.stack', '[ACCESOR]');
  });
  it('un getter heredado que lanza tampoco se invoca', () => {
    const hostile = jest.fn(() => { throw new Error('CANARIO_THROW'); });
    const e = inherited('name', hostile);
    const c = capture();
    expect(() => c.logger.error({ err: e })).not.toThrow();
    expect(hostile).not.toHaveBeenCalled();
    expect(c.output()).not.toContain('CANARIO_');
    expect(c.logs()).toHaveLength(1);
    expect(c.logs()[0]).toHaveProperty('err.stack', '[ACCESOR]');
  });
  it('datos propios sombrean los accesores hostiles del prototipo', () => {
    const hostile = jest.fn(() => 'CANARIO_INHERITED');
    class Child extends Error {}
    Object.defineProperties(Child.prototype, { name: { get: hostile }, message: { get: hostile } });
    const e = new Child();
    Object.defineProperties(e, { name: { value: 'Child' }, message: { value: 'safe' } });
    const c = capture();
    expect(() => c.logger.error({ err: e })).not.toThrow();
    expect(hostile).not.toHaveBeenCalled();
    expect(c.output()).not.toContain('CANARIO_');
    expect(c.logs()).toHaveLength(1);
    expect(c.logs()[0]).toHaveProperty('err.stack', expect.stringMatching(/^\s+at\s/));
  });
  it.each(['error', 'prototipo'])('Proxy como %s no ejecuta trampas', mode => {
    const hostile = jest.fn(() => { throw new Error('CANARIO_PROXY'); });
    const e = new Error('safe');
    const proxy = new Proxy(mode === 'error' ? e : Error.prototype, {
      get: hostile, getPrototypeOf: hostile, getOwnPropertyDescriptor: hostile, ownKeys: hostile,
    });
    const value = mode === 'error' ? proxy : Object.setPrototypeOf(e, proxy) as Error;
    const c = capture();
    expect(() => c.logger.error({ err: value })).not.toThrow();
    expect(hostile).not.toHaveBeenCalled();
    expect(c.output()).not.toContain('CANARIO_');
    expect(c.logs()).toHaveLength(1);
    expect(c.logs()[0]).toHaveProperty('err.message', '[PROXY]');
  });
  it.each(['cause', 'errors'])('error hostil dentro de %s se omite sin ejecutarlo', key => {
    const hostile = jest.fn(() => 'CANARIO_NESTED');
    const child = inherited('name', hostile);
    const e = key === 'cause' ? new Error('safe', { cause: child }) : new AggregateError([child], 'safe');
    const c = capture();
    expect(() => c.logger.error({ err: e })).not.toThrow();
    expect(hostile).not.toHaveBeenCalled();
    expect(c.output()).not.toContain('CANARIO_');
    expect(c.logs()).toHaveLength(1);
    expect(c.logs()[0]).toHaveProperty(key === 'cause' ? 'err.cause.stack' : 'err.errors.0.stack', '[ACCESOR]');
  });
  class DataNameError extends Error { override name = 'DataNameError'; }
  class OrmChild extends TypeORMError {}
  const legitimate: [string, () => Error][] = [
    ['Error', () => new Error('safe')], ['TypeError', () => new TypeError('safe')],
    ['subclase con name de datos', () => new DataNameError('safe')],
    ['DomainError', () => new InvalidInputError('safe')], ['HttpException', () => new HttpException('safe', 503)],
    ['AggregateError', () => new AggregateError([], 'safe')], ['TypeORMError hijo', () => new OrmChild('safe')],
    ['QueryFailedError real', () => new QueryFailedError('CANARIO_SQL', ['CANARIO_PARAM'],
      Object.assign(new DatabaseError('CANARIO_PG', 42, 'error'), { code: '23505', detail: 'CANARIO_DETAIL' }))],
  ];
  it.each(legitimate)('%s conserva marcos', (_label, factory) => {
    const c = capture();
    expect(() => c.logger.error({ err: factory() })).not.toThrow();
    expect(c.output()).not.toContain('CANARIO_');
    expect(c.logs()).toHaveLength(1);
    expect(c.logs()[0]).toHaveProperty('err.stack', expect.stringMatching(/^\s+at\s/));
  });
});
it.each(['query', 'parameters', 'driverError', 'detail', 'hint', 'where', 'internalQuery'])('redact protege el objeto plano x.%s con todas las capas activas', key => {
  const c = capture();
  c.logger.error({ x: { [key]: 'CANARIO_FLAT' } });
  expect(c.output()).not.toContain('CANARIO_');
  expect(c.logs()).toHaveLength(1);
  if (key === 'driverError') expect(c.logs()[0]).toHaveProperty('x.database', true);
  else expect(c.logs()[0]).toHaveProperty(`x.${key}`, '[REDACTED]');
});
