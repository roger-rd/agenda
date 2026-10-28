import 'reflect-metadata';
import { QueryFailedError, TypeORMError } from 'typeorm';
import { DatabaseError } from 'pg';
import { HttpException } from '@nestjs/common';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { InvalidInputError } from '../common/errors/domain-error';
import { DatabaseCredentials, DatabaseConnectionConfig } from '../config/database-credentials';
import { createLoggerOptions, serializeRequest, serializeResponse } from './logger-options';
import { SENSITIVE_LOG_KEYS, sanitizeError, sanitizeLogObject, resolveDescriptor, safeContext, registerSafeSerializer, framesOnly } from './error-sanitizer';
import { registerSecret, resetSecretsForTests } from './secret-registry';
afterEach(() => { jest.restoreAllMocks(); resetSecretsForTests(); });
function database(code = '23505') {
  const driver = new DatabaseError('CANARIO_MSG_PG', 12, 'error');
  Object.assign(driver, { code, severity: 'ERROR', constraint: 'unique_name', table: 'content', column: 'title', schema: 'public', routine: '_bt_check_unique',
    detail: 'CANARIO_DETAIL', where: 'CANARIO_WHERE', hint: 'CANARIO_HINT', internalQuery: 'CANARIO_SQL' });
  return new QueryFailedError('CANARIO_SQL', ['CANARIO_PARAM'], driver);
}
it.each(['23505', '22000', '40001', '40P01', '42000', '08006', '53000', '55000', '57014', 'XX000'])('lista blanca de BD %s', code => {
  const e = database(code);
  const result = sanitizeError(e);
  expect(result).toMatchObject({ type: 'QueryFailedError', database: true, sqlState: code, constraint: 'unique_name', table: 'content', severity: 'ERROR' });
  expect(JSON.stringify(result)).not.toContain('CANARIO_');
  expect(result).toHaveProperty('stack', expect.stringContaining('at '));
  expect(sanitizeError(result)).toBe(result);
  if (code === '40001' || code === '40P01') expect(result).toHaveProperty('retryable', true);
});
it('reconoce pg suelto y descarta valores inválidos', () => {
  expect(sanitizeError(database().driverError)).toMatchObject({ database: true, sqlState: '23505' });
  const e = database('23505\n');
  Object.assign(e.driverError, { constraint: 'invalid-name', table: 'CANARIO_TABLE', severity: 'WARNING', routine: 'bad space' });
  const output = sanitizeError(e);
  expect(output).toMatchObject({ message: 'Error de base de datos.' });
  for (const key of ['sqlState', 'constraint', 'table', 'severity', 'routine']) expect(output).not.toHaveProperty(key);
});
it.each([new Error('password=CANARIO_MSG'), new TypeORMError('password=CANARIO_MSG'), new InvalidInputError('password=CANARIO_MSG'), new HttpException('password=CANARIO_MSG', 503)])('errores genéricos %#', e => {
  Object.assign(e, { config: { password: 'CANARIO_CONFIG' }, request: 'CANARIO_REQUEST', response: 'CANARIO_RESPONSE', code: 'valid.code', statusCode: 503 });
  expect(sanitizeError(e)).toMatchObject({ message: 'password=[REDACTED]', code: 'valid.code', statusCode: 503 });
  expect(JSON.stringify(sanitizeError(e))).not.toContain('CANARIO_');
});
it('sanea causas, AggregateError, ciclos y profundidad', () => {
  const e = new Error('safe', { cause: database() });
  expect(sanitizeError(e)).toHaveProperty('cause.sqlState', '23505');
  const aggregate = new AggregateError(Array.from({ length: 8 }, () => database()), 'safe');
  expect(sanitizeError(aggregate)).toHaveProperty('errors', expect.arrayContaining([expect.objectContaining({ database: true })]));
  expect((sanitizeError(aggregate) as { errors: unknown[] }).errors).toHaveLength(5);
  e.cause = e;
  expect(JSON.stringify(sanitizeError(e))).toContain('[CICLO]');
  let deep: Error = database();
  for (let i = 0; i < 6; i++) deep = new Error('safe', { cause: deep });
  expect(JSON.stringify(sanitizeError(deep))).toContain('[PROFUNDIDAD]');
  expect(JSON.stringify(sanitizeError(deep))).not.toContain('CANARIO_');
});
it('cadenas y objetos lanzados', () => {
  expect(sanitizeError('token:CANARIO_TOKEN')).toEqual({ type: 'string', message: 'token:[REDACTED]' });
  expect(sanitizeError({ message: 'CANARIO_OBJ' })).toEqual({ type: 'Object' });
  expect(sanitizeError(17)).toEqual({ type: 'number' });
  expect(sanitizeError(null)).toEqual({ type: 'object' });
});
it('no ejecuta accesores ni trampas de errores o prototipos', () => {
  const get = jest.fn(() => { throw new Error('CANARIO_GET'); });
  const e = new Error();
  // Materializa stack antes de reemplazar message (V8 puede calcularlo perezosamente).
  e.stack = 'CANARIO_STACK\n    at safe (file.ts:1:2)';
  Object.defineProperties(e, { message: { get }, code: { get } });
  expect(sanitizeError(e)).toMatchObject({ message: '[NO_INSPECCIONABLE]' });
  const proxy = new Proxy({}, { get, ownKeys: get, getPrototypeOf: get, getOwnPropertyDescriptor: get });
  expect(sanitizeError(proxy)).toHaveProperty('message', '[PROXY]');
  expect(sanitizeLogObject(proxy)).toEqual({ saneado: '[PROXY]' });
  expect(sanitizeLogObject({ proxy })).toEqual({ proxy: '[PROXY]' });
  expect(sanitizeError(Object.create(proxy))).toHaveProperty('message', '[PROXY]');
  expect(get).not.toHaveBeenCalled();
});
it('solo conserva hasta 30 marcos, depurados y truncados', () => {
  registerSecret('CANARIO_CAUSE');
  const stack = ['    at CANARIO_FIRST', 'CANARIO_OTHER', ...Array(40).fill('    at CANARIO_CAUSE ' + 'x'.repeat(400))].join('\n');
  const result = framesOnly(stack)!;
  expect(result.split('\n')).toHaveLength(30);
  expect(result).not.toContain('CANARIO_');
  expect(result.split('\n')[0]).toHaveLength(301);
});
it('recorre datos con límites, ciclos y accesores', () => {
  const get = jest.fn(() => 'CANARIO_GET');
  const payload = Object.defineProperty({}, 'secret', { get, enumerable: true });
  expect(sanitizeLogObject({ payload })).toEqual({ payload: { secret: '[ACCESOR]' } });
  expect(get).not.toHaveBeenCalled();
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  expect(sanitizeLogObject({ cycle })).toHaveProperty('cycle.self', '[CICLO]');
  expect(sanitizeLogObject({ a: { b: { c: { d: { e: 'CANARIO_DEEP' } } } } })).toHaveProperty('a.b.c.d', '[PROFUNDIDAD]');
  expect(sanitizeLogObject({ a: Array(51).fill('CANARIO_ARRAY') })).toEqual({ a: '[LIMITE]' });
  const huge = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [i, 'CANARIO_VALUE']));
  expect(sanitizeLogObject(huge)).toEqual({ saneado: '[LIMITE]' });
  expect(sanitizeLogObject({ huge })).toEqual({ huge: '[LIMITE]' });
  expect(JSON.stringify(sanitizeLogObject({ many: Array.from({ length: 50 }, () => Array(50).fill(1)) }))).toContain('[LIMITE]');
});
it('no ejecuta métodos de clases arbitrarias y omite bytes', () => {
  const call = jest.fn();
  class Custom { toJSON() { call(); return 'CANARIO_JSON'; } }
  class Throws { toJSON() { call(); throw new Error(); } }
  const output = sanitizeLogObject({ custom: new Custom(), throws: new Throws(), map: new Map(), set: new Set(),
    buffer: Buffer.from('CANARIO_BYTES'), uint: new Uint8Array(4), array: new ArrayBuffer(7) });
  expect(output).toMatchObject({ custom: { type: 'Custom' }, throws: { type: 'Throws' }, map: { type: 'Map' }, set: { type: 'Set' },
    buffer: { type: 'Buffer', byteLength: 13 }, uint: { type: 'Uint8Array', byteLength: 4 }, array: { type: 'ArrayBuffer', byteLength: 7 } });
  expect(call).not.toHaveBeenCalled();
  expect(JSON.stringify(output)).not.toContain('CANARIO_');
});
it('serializadores registrados, URL y credenciales', () => {
  const credentials = new DatabaseCredentials('agenda_test_app', 'fake-password-for-unit-tests-0001');
  const config = new DatabaseConnectionConfig('localhost', 5433, 'agenda_test', credentials, 5);
  expect(sanitizeLogObject({ credentials, config, url: new URL('https://user:CANARIO_PASSWORD@example.test/path?token=CANARIO_QUERY#CANARIO_HASH') })).toMatchObject({
    credentials: { user: 'agenda_test_app', password: '[REDACTED]' }, config: { host: 'localhost', credentials: { password: '[REDACTED]' } }, url: 'https://example.test/path',
  });
  class Registered {}
  registerSafeSerializer(Registered, () => { throw new Error('CANARIO_THROW'); });
  expect(sanitizeLogObject({ value: new Registered() })).toEqual({ value: '[NO_INSPECCIONABLE]' });
  credentials.dispose();
});
it('primitivos, funciones y fechas', () => {
  expect(sanitizeLogObject({ nil: null, missing: undefined, fn: () => {}, symbol: Symbol(), big: 42n, date: new Date(0), invalid: new Date(NaN) })).toEqual({
    nil: null, missing: undefined, fn: '[NO_INSPECCIONABLE]', symbol: '[NO_INSPECCIONABLE]', big: '42', date: '1970-01-01T00:00:00.000Z', invalid: '[NO_INSPECCIONABLE]',
  });
});
it.each(['safe.Context:1', 'bad\n    at trace', 'x'.repeat(65), 42, {}])('context estricto %#', context => {
  const expected = context === 'safe.Context:1' ? context : '[CONTEXTO_OMITIDO]';
  expect(safeContext(context)).toBe(expected);
  expect(sanitizeLogObject({ context, nested: { context } })).toEqual({ context: expected, nested: { context: expected } });
});
it('req/res reales pasan a serializadores de lista blanca sin sockets abiertos', () => {
  const req = new IncomingMessage(new Socket());
  Object.assign(req, { id: 'test-id', method: 'GET', url: '/safe?secret=CANARIO_URL', headers: { authorization: 'CANARIO_AUTH' }, body: 'CANARIO_BODY' });
  const res = new ServerResponse(req); res.statusCode = 201;
  const formatted = sanitizeLogObject({ req, res });
  expect(formatted.req).toBe(req); expect(formatted.res).toBe(res);
  expect(serializeRequest(formatted.req)).toEqual({ id: 'test-id', method: 'GET', url: '/safe' });
  expect(serializeResponse(formatted.res)).toEqual({ statusCode: 201 });
  const fake = sanitizeLogObject({ req: { body: { secret: 'password=CANARIO_BODY' }, headers: { authorization: 'Bearer CANARIO_AUTH' } } });
  expect(JSON.stringify(fake)).not.toContain('CANARIO_');
});
it('fallo interno global devuelve marcador fijo', () => {
  jest.spyOn(Object, 'keys').mockImplementationOnce(() => { throw new Error('CANARIO_FAILURE'); });
  expect(sanitizeLogObject({})).toEqual({ saneado: '[NO_INSPECCIONABLE]' });
  jest.spyOn(Object, 'getOwnPropertyDescriptor').mockImplementationOnce(() => { throw new Error('CANARIO_FAILURE'); });
  expect(sanitizeError(new Error())).toEqual({ type: 'Error', message: '[NO_INSPECCIONABLE]' });
});

it('permite exclusivamente el getter nativo de stack en errores reales', () => {
  class CustomError extends Error {}
  for (const e of [new Error('CANARIO_FIRST'), new TypeError('CANARIO_FIRST'), new CustomError('CANARIO_FIRST'), database()]) {
    const output = sanitizeError(e) as { stack: string };
    expect(output.stack).toMatch(/^\s+at\s/);
    expect(output.stack).not.toContain('CANARIO_');
  }
});
it.each(['stack', 'name', 'message'])('rechaza accesor propio hostil de %s sin ejecutarlo', key => {
  const get = jest.fn(() => { throw new Error('CANARIO_ACCESSOR'); });
  const e = new Error('safe');
  Object.defineProperty(e, key, { get, configurable: true });
  expect(() => sanitizeError(e)).not.toThrow();
  expect(sanitizeError(e)).toHaveProperty('stack', '[ACCESOR]');
  expect(get).not.toHaveBeenCalled();
});
it('stack de datos pasa por framesOnly y el getter ajeno no se ejecuta aunque devuelva string', () => {
  const e = new Error();
  Object.defineProperty(e, 'stack', { value: 'x\n    at safe.ts:1:2', configurable: true });
  expect(sanitizeError(e)).toHaveProperty('stack', '    at safe.ts:1:2');
  Object.defineProperty(e, 'stack', { value: 'x', configurable: true });
  expect(sanitizeError(e)).toHaveProperty('stack', '');
  const get = jest.fn(() => 'x\n    at CANARIO_FRAME');
  Object.defineProperty(e, 'stack', { get, configurable: true });
  expect(sanitizeError(e)).toHaveProperty('stack', '[ACCESOR]');
  expect(get).not.toHaveBeenCalled();
});
it('preserva las salidas HTTP ya saneadas, incluso remoteAddress', () => {
  const req = serializeRequest({ id: 'safe-id', method: 'GET', url: '/safe', socket: { remoteAddress: '127.0.0.1' } });
  const res = serializeResponse({ statusCode: 204 });
  const output = sanitizeLogObject({ req, res });
  expect(output.req).toBe(req); expect(output.res).toBe(res);
});
it('el límite global cuenta también campos err y accesores', () => {
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [i, Array.from({ length: 50 }, () => ({ err: new Error('safe') }))]));
  const output = JSON.stringify(sanitizeLogObject(many));
  expect(output).toContain('[LIMITE]');
  expect((output.match(/"type":"Error"/g) ?? []).length).toBeLessThan(500);
});
it('valores no válidos no entran en la lista blanca genérica', () => {
  const e = Object.assign(new Error('safe'), { code: 'bad code', status: 99, statusCode: 600, headers: 'CANARIO_HEADERS', data: 'CANARIO_DATA' });
  const result = sanitizeError(e);
  for (const key of ['code', 'status', 'statusCode', 'headers', 'data']) expect(result).not.toHaveProperty(key);
});

it('resolveDescriptor respeta sombreado, ausencias, proxies y límite de prototipos', () => {
  const hostile = jest.fn(() => { throw new Error('CANARIO_DESCRIPTOR'); });
  const proto = Object.defineProperty({}, 'name', { get: hostile });
  const value = Object.create(proto) as object;
  Object.defineProperty(value, 'name', { value: 'safe' });
  expect(resolveDescriptor(value, 'name')).toMatchObject({ value: 'safe' });
  expect(resolveDescriptor(value, 'absent')).toBeUndefined();
  expect(resolveDescriptor(proto, 'name')?.get).toBe(hostile);
  const proxy = new Proxy({}, { getPrototypeOf: hostile, getOwnPropertyDescriptor: hostile });
  expect(resolveDescriptor(proxy, 'name')).toBeNull();
  expect(resolveDescriptor(Object.create(proxy), 'name')).toBeNull();
  let deep: object = Object.create(null) as object;
  for (let i = 0; i < 100; i++) deep = Object.create(deep) as object;
  expect(resolveDescriptor(deep, 'name')).toBeNull();
  expect(hostile).not.toHaveBeenCalled();
});

describe('claves reservadas en todos los niveles inspeccionados', () => {
  const keys = ['detail', 'hint', 'where', 'query', 'parameters', 'internalQuery', 'driverError'];
  function logged(value: object): Record<string, unknown> {
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const logger = pino(createLoggerOptions({ logLevel: 'info' }, stream), stream);
    expect(() => logger.info(value)).not.toThrow();
    expect(output).not.toContain('CANARIO_');
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]) as Record<string, unknown>;
  }
  function wrap(value: object, count: number): object {
    for (let i = 0; i < count; i++) value = { a: value };
    return value;
  }
  it('exporta exactamente los siete nombres reservados', () => {
    expect([...SENSITIVE_LOG_KEYS]).toEqual(keys);
  });
  const values: [string, unknown][] = [
    ['string', 'CANARIO_STRING'], ['array', ['CANARIO_ARRAY']],
    ['objeto', { value: 'CANARIO_OBJECT' }], ['anidado', { a: [{ b: 'CANARIO_NESTED' }] }],
  ];
  it.each(keys.flatMap(key => values.map(([label, value]) => [key, label, value] as const)))('%s con %s en raíz y profundidades 0–3', (key, _label, value) => {
    for (let wrappers = 0; wrappers <= 4; wrappers++) {
      const input = wrap({ [key]: value }, wrappers);
      const leaf = wrappers === 4 ? '[PROFUNDIDAD]' : key === 'driverError' && wrappers > 0
        ? { type: 'Object', database: true, message: 'Error de base de datos.' } : { [key]: '[REDACTED]' };
      let expected: unknown = leaf;
      for (let i = 0; i < wrappers; i++) expected = { a: expected };
      const sanitized = sanitizeLogObject(input);
      expect(sanitized).toEqual(expected);
      expect(sanitizeLogObject(sanitized)).toBe(sanitized);
      if (key === 'driverError' && wrappers === 0) expect(logged(input)).toHaveProperty('err.database', true);
      else expect(logged(input)).toMatchObject(expected as object);
    }
  });
  it('arrays, arrays de arrays y objetos mixtos preservan campos legítimos', () => {
    const input = { lista: [{ detail: 'CANARIO_DETAIL', name: 'uno' }, { a: { hint: 'CANARIO_HINT', n: 2 } }, [{ where: 'CANARIO_WHERE', active: true }]],
      mixed: { list: [{ query: 'CANARIO_QUERY', queryId: 'q1' }] },
      deep: [{ a: [{ internalQuery: 'CANARIO_DEEP' }] }] };
    const expected = { lista: [{ detail: '[REDACTED]', name: 'uno' }, { a: { hint: '[REDACTED]', n: 2 } }, [{ where: '[REDACTED]', active: true }]],
      mixed: { list: [{ query: '[REDACTED]', queryId: 'q1' }] }, deep: [{ a: ['[PROFUNDIDAD]'] }] };
    expect(sanitizeLogObject(input)).toEqual(expected);
    expect(logged(input)).toMatchObject(expected);
  });
  it('copias parciales de pg y copia JSON de QueryFailedError no filtran', () => {
    const driverErrorSinCodeNiSeverity = { message: 'Mensaje seguro.', detail: 'CANARIO_DETAIL', hint: 'CANARIO_HINT', where: 'CANARIO_WHERE', internalQuery: 'CANARIO_QUERY' };
    const partial = { message: 'Mensaje seguro.', detail: 'CANARIO_PARTIAL' };
    const copy: unknown = JSON.parse(JSON.stringify(database()));
    const input = { a: { b: { partial, copied: { ...driverErrorSinCodeNiSeverity }, queryError: copy } } };
    const output = logged(input);
    expect(output).toHaveProperty('a.b.partial', { message: 'Mensaje seguro.', detail: '[REDACTED]' });
    expect(output).toHaveProperty('a.b.copied', { message: 'Mensaje seguro.', detail: '[REDACTED]', hint: '[REDACTED]', where: '[REDACTED]', internalQuery: '[REDACTED]' });
    expect(output).toHaveProperty('a.b.queryError.sqlState', '23505');
    expect(logged({ a: { query: 'CANARIO_SQL', parameters: ['CANARIO_PARAM'] } })).toHaveProperty('a.database', true);
    expect(logged({ err: database(), error: database() })).toMatchObject({ err: { sqlState: '23505' }, error: { sqlState: '23505' } });
  });
  it.each(keys)('%s oculta accesores, getters que lanzan y proxies sin invocarlos', key => {
    const get = jest.fn(() => 'CANARIO_ACCESSOR');
    const throws = jest.fn(() => { throw new Error('CANARIO_THROW'); });
    const proxy = new Proxy({}, { get: throws, getPrototypeOf: throws, ownKeys: throws, getOwnPropertyDescriptor: throws });
    const inputs = [Object.defineProperty({}, key, { get, enumerable: true }), Object.defineProperty({}, key, { get: throws, enumerable: true }), { [key]: proxy }];
    for (const input of inputs) {
      expect(sanitizeLogObject(input)).toEqual({ [key]: '[REDACTED]' });
      if (key === 'driverError') expect(logged(input)).toHaveProperty('err.database', true);
      else expect(logged(input)).toHaveProperty(key, '[REDACTED]');
      if (key !== 'driverError') expect(logged({ a: { b: input } })).toHaveProperty(`a.b.${key}`, '[REDACTED]');
      else expect(logged({ a: input })).toHaveProperty('a.database', true);
    }
    expect(get).not.toHaveBeenCalled(); expect(throws).not.toHaveBeenCalled();
  });
  it('mantiene límites de tamaño, profundidad y nodos sin emitir canarios', () => {
    const huge = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [String(i), 'CANARIO_LARGE']));
    const input = { big: huge, list: Array(51).fill('CANARIO_ARRAY'), deep: wrap({ detail: 'CANARIO_DEEP' }, 4), detail: huge };
    expect(logged(input)).toMatchObject({ big: '[LIMITE]', list: '[LIMITE]', deep: { a: { a: { a: '[PROFUNDIDAD]' } } }, detail: '[REDACTED]' });
    expect(logged(huge)).toHaveProperty('saneado', '[LIMITE]');
    const many = { list: Array.from({ length: 50 }, () => Array.from({ length: 50 }, () => ({ detail: 'CANARIO_NODE' }))) };
    expect(JSON.stringify(logged(many))).toContain('[LIMITE]');
  });
  it('conserva campos legítimos, homónimos e idempotencia del log típico', () => {
    const typical = { requestId: 'request-123', code: 'internal_error', status: 500, context: 'AppModule', extra: { a: 'texto', n: [1, 2, 3] } };
    const legitimate = { ...typical, text: 'valor', number: 7, bool: true, nil: null, values: ['texto', 2, false, null],
      queryId: 'q1', details: 'detalles', detailLevel: 2, parametersCount: 3, Hint: 'mayúscula', wherever: 'allí', userId: 'u1', name: 'nombre' };
    expect(sanitizeLogObject(typical)).toEqual(typical);
    expect(sanitizeLogObject(legitimate)).toEqual(legitimate);
    expect(sanitizeLogObject(sanitizeLogObject(legitimate))).toEqual(legitimate);
    const { level, time, pid, hostname, ...record } = logged(legitimate);
    void level; void time; void pid; void hostname;
    expect(record).toEqual(legitimate);
  });
});
