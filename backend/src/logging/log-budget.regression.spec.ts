import { Writable } from 'node:stream';
import { pino, type LogFn } from 'pino';
import * as registry from './secret-registry';
import { sanitizeLogObject, sanitizeError, framesOnly, MAX_STACK_INPUT, registerSafeSerializer } from './error-sanitizer';
import { safeLogging } from './safe-logging';
import { createLoggerOptions } from './logger-options';
import { SafeTypeOrmLogger } from '../database/safe-typeorm-logger';

afterEach(() => { jest.restoreAllMocks(); });

it('sonda del espía: intercepta llamadas internas del saneador y del gancho', () => {
  const spy = jest.spyOn(registry, 'scrubText');
  sanitizeLogObject({ a: 'x' });
  expect(spy).toHaveBeenCalledWith('x', 4000, expect.any(registry.RecordBudget));
  spy.mockClear();
  const stream = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const logger = pino(safeLogging, stream);
  logger.info('sonda');
  expect(spy).toHaveBeenCalledWith('sonda', 4000, expect.any(registry.RecordBudget));
});

function capture() {
  let output = '';
  const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const logger = pino(createLoggerOptions({ logLevel: 'info' }, stream), stream);
  return { logger, output: () => output, logs: () => output.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) };
}
function dataError(message = 'fallo', stack = 'Error\n    at safe.ts:1:2', cause?: Error): Error {
  return Object.defineProperty(new Error(message, cause ? { cause } : undefined), 'stack', { value: stack, writable: true });
}
function aggregate(message: string, errors: Error[], cause?: Error): AggregateError {
  return Object.defineProperty(new AggregateError(errors, message, cause ? { cause } : undefined), 'stack', { value: '' });
}
const large = 'x'.repeat(16000);
const clipped = 'x'.repeat(4000) + '…';
function fields(count: number) { return Object.fromEntries(Array.from({ length: count }, (_, i) => [`a${i}`, large])); }

// Conteos del flujo real: cada error aporta mensaje y un marco. O-4 cobra
// dos veces el mensaje explícito; sin él vuelve a sanear el error completo.
it.each<[string, () => unknown[], number]>([
  ['error y texto', () => [dataError(), 'texto'], 4],
  ['error sin texto', () => [dataError()], 5],
  ['objeto con mensaje derivado', () => [{ err: dataError() }], 5],
  ['objeto mixto', () => [{ top: 'a', nested: { a: 'b' }, array: ['c'], err: dataError('e', 'Error\n    at e', dataError()), error: 'lanzado', agg: aggregate('grupo', [dataError()]) }, 'texto'], 12],
  ['interpolación y argumentos', () => ['%j %j %s', { a: 'x' }, () => {}, Symbol('s')], 2],
  ['función inicial', () => [() => {}, '%s', 'x'], 3],
  ['símbolo inicial', () => [Symbol('s'), 'x'], 2],
  ['pila de datos', () => [dataError('e', 'Error\n    at uno\n    at dos'), 'texto'], 5],
])('comparte identidad sin trabajo extra de Pino: %s', (_name, args, count) => {
  const c = capture();
  const spy = jest.spyOn(registry, 'scrubText');
  const budgets: unknown[] = [];
  for (let i = 0; i < 2; i++) {
    spy.mockClear();
    c.logger.info(...args() as Parameters<LogFn>);
    expect(spy).toHaveBeenCalledTimes(count);
    const budget = spy.mock.calls[0][2];
    expect(registry.RecordBudget.is(budget)).toBe(true);
    expect(spy.mock.calls.every(call => call[2] === budget)).toBe(true);
    budgets.push(budget);
  }
  expect(budgets[0]).not.toBe(budgets[1]);
  expect(c.logs()).toHaveLength(2);
});

it('agota en orden entre campos, error, pila, mensaje e interpolación', () => {
  const c = capture();
  const spy = jest.spyOn(registry, 'scrubText');
  const frame = '    at ' + 'x'.repeat(15993);
  c.logger.info({ ...fields(3), err: dataError(large, `Error\n${frame}\n${frame}\n${frame}`) }, '%s ' + 'm'.repeat(10000), large);
  expect(c.logs()[0]).toMatchObject({ a0: clipped, a1: clipped, a2: clipped, err: { message: 'x'.repeat(500) + '…', stack: Array(3).fill(frame.slice(0, 300) + '…').join('\n') } });
  expect(c.logs()[0].msg).toBe('[LIMITE] ' + 'm'.repeat(3997) + '…');
  expect(spy.mock.results.at(-1)?.value).toBe('[LIMITE]');
  const total = spy.mock.calls.reduce((sum, call, i) => sum + (['[LIMITE]', '[CADENA_LARGA]'].includes(spy.mock.results[i].value as string) ? 0 : call[0].length), 0);
  expect(total).toBeLessThanOrEqual(131072);
  expect(total).toBe(122003);
});

it('las entradas directas renuevan presupuesto y lo agotan permanentemente', () => {
  for (let i = 0; i < 2; i++) {
    const result = sanitizeLogObject({ ...fields(20), empty: '', short: 'x' });
    for (let j = 0; j < 20; j++) expect(result[`a${j}`]).toBe(j < 8 ? clipped : '[LIMITE]');
    expect(result.empty).toBe('[LIMITE]');
    expect(result.short).toBe('[LIMITE]');
  }
  // El índice de map es ajeno al presupuesto; la firma pública sigue siendo opcional.
  const callback = sanitizeLogObject as unknown as (value: unknown, index: number) => Record<string, unknown>;
  expect([{ a: 'x' }, { a: 'y' }].map(callback)).toEqual([{ a: 'x' }, { a: 'y' }]);
});

it('sanitizeError comparte presupuesto entre AggregateError y cadena de cause', () => {
  const chain = dataError(large, '', dataError(large, '', dataError(large, '')));
  const value = aggregate(large, Array.from({ length: 5 }, () => dataError(large, '')), chain);
  for (let i = 0; i < 2; i++) {
    const result = sanitizeError(value);
    expect(result).toHaveProperty('cause.cause.cause.message', 'x'.repeat(500) + '…');
    for (let j = 0; j < 5; j++) expect(result).toHaveProperty(`errors.${j}.message`, j < 4 ? 'x'.repeat(500) + '…' : '[LIMITE]');
  }
});

it('aísla la reentrada de un serializador del registro exterior', () => {
  class Nested {}
  const c = capture();
  registerSafeSerializer(Nested, () => { c.logger.info(fields(9)); return 'retorno'; });
  const spy = jest.spyOn(registry, 'scrubText');
  c.logger.info({ before: 'antes', nested: new Nested(), after: large });
  const calls = spy.mock.calls;
  const outer = calls[0][2];
  const inner = calls[1][2];
  expect(registry.RecordBudget.is(outer)).toBe(true);
  expect(registry.RecordBudget.is(inner)).toBe(true);
  expect(outer).not.toBe(inner);
  expect(calls.slice(1, 10).every(call => call[2] === inner)).toBe(true);
  expect(calls.slice(10).every(call => call[2] === outer)).toBe(true);
  expect(c.logs()[0]).toHaveProperty('a8', '[LIMITE]');
  expect(c.logs()[1]).toMatchObject({ before: 'antes', nested: 'retorno', after: clipped });
});

it('se recupera de serializador que lanza y renueva el presupuesto', () => {
  class Broken {}
  registerSafeSerializer(Broken, () => { throw new Error('fallo'); });
  const c = capture();
  expect(() => c.logger.info({ ...fields(9), broken: new Broken() })).not.toThrow();
  c.logger.info(fields(8));
  expect(c.logs()[0].broken).toBe('[NO_INSPECCIONABLE]');
  expect(c.logs()[1]).toMatchObject(Object.fromEntries(Object.keys(fields(8)).map(key => [key, clipped])));
});

it('aísla registros async entrelazados', async () => {
  const c = capture();
  const spy = jest.spyOn(registry, 'scrubText');
  await Promise.all([1, 2].map(async i => { await Promise.resolve(); c.logger.info({ id: i, ...fields(8) }); await Promise.resolve(); }));
  expect(spy).toHaveBeenCalledTimes(16);
  const first = spy.mock.calls[0][2], second = spy.mock.calls[8][2];
  expect(registry.RecordBudget.is(first) && registry.RecordBudget.is(second)).toBe(true);
  expect(first).not.toBe(second);
  expect(spy.mock.calls.slice(0, 8).every(call => call[2] === first)).toBe(true);
  expect(spy.mock.calls.slice(8).every(call => call[2] === second)).toBe(true);
});

it('limita la pila antes de split y permite exactamente 64 KiB', () => {
  const over = 'x'.repeat(MAX_STACK_INPUT + 1);
  const split = jest.spyOn(String.prototype, 'split');
  try {
    expect(framesOnly(over)).toBe('[CADENA_LARGA]');
    expect(split).not.toHaveBeenCalled();
  } finally { split.mockRestore(); }
  const exact = 'x'.repeat(MAX_STACK_INPUT - 9) + '\n    at z';
  expect(exact).toHaveLength(MAX_STACK_INPUT);
  expect(framesOnly(exact)).toBe('    at z');
  expect(framesOnly('Error\n    at ' + 'x'.repeat(20000) + '\n    at normal')).toBe('[CADENA_LARGA]\n    at normal');
  expect(sanitizeError(dataError('safe', 'x'.repeat(5 * 1024 * 1024)))).toHaveProperty('stack', '[CADENA_LARGA]');
});

const canary = 'CANARIO_INICIO' + 'z'.repeat(9000) + 'CANARIO_MEDIO' + 'z'.repeat(9000) + 'CANARIO_FINAL';
it.each<[string, (text: string) => unknown[]]>([
  ['mensaje con error', t => [dataError(), t]],
  ['texto', t => [t]],
  ['interpolación', t => ['%s', t]],
  ['argumento objeto', t => ['%j', { value: t }]],
  ['campos', t => [{ top: t, nested: { value: t }, array: [t] }]],
  ['err cadena', t => [{ err: t }]],
  ['mensaje y cause', t => [{ err: dataError(t, '', dataError(t, '')) }]],
  ['AggregateError', t => [{ err: aggregate(t, [dataError(t, '')]) }]],
  ['pila', t => [{ err: dataError('safe', 'Error\n    at ' + t) }]],
])('rechaza cadenas grandes sin fragmentos: %s', (_name, args) => {
  const c = capture();
  c.logger.info(...args(canary) as Parameters<LogFn>);
  expect(c.output()).toContain('[CADENA_LARGA]');
  expect(c.output()).not.toMatch(/CANARIO_|zzz/);
  if (_name === 'err cadena') expect(c.logs()[0].err).toEqual({ type: 'string', message: '[CADENA_LARGA]' });
});

it('TypeORM conserva su umbral por llamada sin presupuesto de registro', () => {
  const sink = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const spy = jest.spyOn(registry, 'scrubText');
  new SafeTypeOrmLogger(sink).logMigration(canary);
  expect(spy).toHaveBeenCalledWith(canary, 200);
  expect(sink.debug).toHaveBeenCalledWith({ context: 'TypeORM', message: '[CADENA_LARGA]' }, 'Evento interno de TypeORM.');
});

it('mantiene referencias públicas e idempotencia sin consumir de nuevo', () => {
  expect(safeLogging.formatters.log).toBe(sanitizeLogObject);
  expect(safeLogging.serializers.err).toBe(sanitizeError);
  expect(safeLogging.serializers.error).toBe(sanitizeError);
  const result = sanitizeLogObject({ a: 'x', err: dataError() });
  const spy = jest.spyOn(registry, 'scrubText');
  expect(sanitizeLogObject(result)).toBe(result);
  expect(sanitizeError(result.err)).toBe(result.err);
  expect(spy).not.toHaveBeenCalled();
});

it('cumple los tiempos máximos tras calentar, con cinco repeticiones', () => {
  const adversarial = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`a${i}`, Array<string>(9).fill(large)]));
  const hugeError = dataError('x'.repeat(1024 * 1024), 'x'.repeat(5 * 1024 * 1024));
  const c = capture();
  const hugeField = { value: 'x'.repeat(1024 * 1024) };
  const cases: [string, () => void, number][] = [
    ['500 nodos', () => { sanitizeLogObject(adversarial); }, 50],
    ['error grande', () => { sanitizeError(hugeError); }, 20],
    ['Pino completo', () => { c.logger.info(hugeField); }, 10],
  ];
  const measured: Record<string, number[]> = {};
  for (const [name, run, limit] of cases) {
    for (let i = 0; i < 5; i++) run();
    const times = Array.from({ length: 5 }, () => { const start = performance.now(); run(); return performance.now() - start; });
    measured[name] = times.map(ms => Number(ms.toFixed(3)));
    expect(Math.max(...times)).toBeLessThanOrEqual(limit);
  }
  const result = sanitizeLogObject(adversarial);
  const strings = Object.values(result).flat() as string[];
  expect(strings.filter(value => value === clipped)).toHaveLength(8);
  expect(strings.slice(8).every(value => value === '[LIMITE]')).toBe(true);
  expect(sanitizeError(hugeError)).toMatchObject({ message: '[CADENA_LARGA]', stack: '[CADENA_LARGA]' });
  expect(c.logs().every(log => log.value === '[CADENA_LARGA]')).toBe(true);
  console.info('Tiempos (ms, cinco repeticiones):', JSON.stringify(measured));
});


it('Pino llama formatter y serializadores con un solo argumento ya saneado', () => {
  const formatter = jest.fn(sanitizeLogObject);
  const serializer = jest.fn(sanitizeError);
  const stream = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const logger = pino({ ...safeLogging, formatters: { log: formatter }, serializers: { err: serializer, error: serializer } }, stream);
  const spy = jest.spyOn(registry, 'scrubText');
  logger.info({ err: dataError(), error: 'lanzado', a: 'x' }, 'normal');
  expect(formatter).toHaveBeenCalledTimes(1);
  expect(serializer).toHaveBeenCalledTimes(2);
  expect(formatter.mock.calls.every(call => call.length === 1)).toBe(true);
  expect(serializer.mock.calls.every(call => call.length === 1)).toBe(true);
  expect(spy).toHaveBeenCalledTimes(5);
});
