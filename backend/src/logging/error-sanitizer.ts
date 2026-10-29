import { types } from 'node:util';
import { IncomingMessage, ServerResponse } from 'node:http';
import { TypeORMError } from 'typeorm';
import { scrubText, RecordBudget, CADENA_LARGA } from './secret-registry';

// El presupuesto de 128 KiB limita el TEXTO ANALIZADO por las rutas conectadas,
// no el tamaño ni el coste absoluto del registro. Quedan fuera: serializadores
// req/res (con sus guardas), TypeORM (umbral de 16 KiB por llamada), claves y
// bindings de logger.child(). Tras agotarlo, las cadenas siguientes son '[LIMITE]'
// en orden de recorrido. Las entradas directas reciben un presupuesto propio.
// Registros normales (cadenas ≤ 16 KiB, total < 128 KiB, pilas ≤ 64 KiB)
// conservan exactamente su salida; pilas mayores producen '[CADENA_LARGA]'.
export const MAX_STACK_INPUT = 64 * 1024;
function budgetOf(value: unknown): RecordBudget {
  return RecordBudget.is(value) ? value : new RecordBudget();
}

export const CICLO = '[CICLO]';
export const PROFUNDIDAD = '[PROFUNDIDAD]';
export const ACCESOR = '[ACCESOR]';
export const PROXY = '[PROXY]';
export const NO_INSPECCIONABLE = '[NO_INSPECCIONABLE]';
export const LIMITE = '[LIMITE]';
export const CONTEXTO_OMITIDO = '[CONTEXTO_OMITIDO]';
// Nombres reservados para datos sensibles: no usarlos para datos legítimos.
export const SENSITIVE_LOG_KEYS: ReadonlySet<string> = new Set([
  'detail', 'hint', 'where', 'query', 'parameters', 'internalQuery', 'driverError',
]);
// El getter nativo de stack también formatea name/message. Solo lo invocamos
// si la cabecera completa se resuelve a datos o al getter verificado de TypeORM.
const NATIVE_STACK_GET = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
const TRUSTED_NAME_GET = Object.getOwnPropertyDescriptor(TypeORMError.prototype, 'name')?.get;
export function resolveDescriptor(obj: unknown, key: PropertyKey): PropertyDescriptor | undefined | null {
  try {
    let current: unknown = obj;
    for (let depth = 0; current !== null && current !== undefined; depth++) {
      if (depth >= 100 || (typeof current !== 'object' && typeof current !== 'function') || types.isProxy(current)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return descriptor;
      current = Object.getPrototypeOf(current) as unknown;
    }
    return undefined;
  } catch { return null; }
}
function headerSafe(value: object): boolean {
  for (const key of ['name', 'message']) {
    const d = resolveDescriptor(value, key);
    if (d === null) return false;
    if (d === undefined) continue;
    if ('value' in d) {
      if (d.value !== undefined && typeof d.value !== 'string') return false;
      continue;
    }
    if (key !== 'name' || typeof TRUSTED_NAME_GET !== 'function' || d.get !== TRUSTED_NAME_GET) return false;
    const constructor = resolveDescriptor(value, 'constructor');
    if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function') return false;
    const name = resolveDescriptor(constructor.value, 'name');
    if (!name || !('value' in name) || typeof name.value !== 'string') return false;
  }
  return true;
}
export function readStack(value: unknown): string | undefined {
  try {
    if (!value || typeof value !== 'object') return undefined;
    if (types.isProxy(value) || !inspectable(value)) return ACCESOR;
    const d = Object.getOwnPropertyDescriptor(value, 'stack');
    if (!d) return undefined;
    if ('value' in d) return typeof d.value === 'string' ? d.value : ACCESOR;
    if (typeof NATIVE_STACK_GET !== 'function' || d.get !== NATIVE_STACK_GET) return ACCESOR;
    if (!headerSafe(value)) return ACCESOR;
    const stack: unknown = NATIVE_STACK_GET.call(value);
    return typeof stack === 'string' ? stack : ACCESOR;
  } catch { return ACCESOR; }
}
const httpOutputs = new WeakSet<object>();
// Compartido exclusivamente por los serializadores HTTP de lista blanca.
export function markSafeHttpOutput(value: object): object {
  Object.freeze(value);
  httpOutputs.add(value);
  return value;
}
const produced = new WeakSet<object>();
const logs = new WeakSet<object>();
const serializers = new Map<abstract new (...args: never[]) => object, (value: never) => unknown>();

export function own(value: unknown, key: PropertyKey): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function has(value: object, key: string): boolean { return !!Object.getOwnPropertyDescriptor(value, key); }
function valid(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value) && !/[\r\n]/.test(value);
}
// Comprueba también los prototipos antes de usar instanceof: pueden ser proxies.
export function inspectable(value: object): boolean {
  let current: object | null = value;
  for (let i = 0; current && i < 100; i++) {
    if (types.isProxy(current)) return false;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return current === null;
}
function typeName(value: object): string {
  const proto = Object.getPrototypeOf(value) as unknown;
  const ctor = own(proto, 'constructor');
  const name = own(ctor, 'name');
  return valid(name, /^[A-Za-z0-9_$]{1,60}$/) ? name : 'Object';
}
export function isDatabaseError(value: unknown): boolean {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return false;
  return has(value, 'driverError') || (has(value, 'query') && has(value, 'parameters')) ||
    (valid(own(value, 'code'), /^[0-9A-Z]{5}$/) && (has(value, 'severity') || has(value, 'routine')));
}
export interface DatabaseFields {
  sqlState?: string; constraint?: string; table?: string; column?: string;
  schema?: string; routine?: string; severity?: string;
}
export function extractDatabaseFields(value: unknown): DatabaseFields {
  const result: DatabaseFields = {};
  const driver = own(value, 'driverError') ?? value;
  const sqlState = own(driver, 'code');
  if (valid(sqlState, /^[0-9A-Z]{5}$/)) result.sqlState = sqlState;
  for (const key of ['constraint', 'table', 'column', 'schema', 'routine', 'severity'] as const) {
    const field = own(driver, key);
    const pattern = key === 'severity' ? /^(ERROR|FATAL|PANIC)$/ : key === 'routine' ? /^[A-Za-z0-9_]{1,64}$/ : /^[a-z0-9_]{1,63}$/;
    if (valid(field, pattern)) result[key] = field;
  }
  return result;
}
export function databaseVerb(value: unknown): 'INSERT' | 'UPDATE' | 'DELETE' | 'SELECT' | 'WITH' | 'OTHER' | undefined {
  const query = own(value, 'query');
  if (typeof query !== 'string') return undefined;
  const first = /^\s*([a-z]+)\b/i.exec(query)?.[1].toUpperCase();
  switch (first) {
    case 'INSERT': case 'UPDATE': case 'DELETE': case 'SELECT': case 'WITH': return first;
    default: return 'OTHER';
  }
}
export function isErrorLike(value: unknown): boolean {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !inspectable(value)) return false;
  return types.isNativeError(value) || value instanceof Error || isDatabaseError(value);
}
export function framesOnly(stack: unknown, budget?: RecordBudget): string | undefined {
  if (typeof stack !== 'string') return undefined;
  if (stack.length > MAX_STACK_INPUT) return CADENA_LARGA;
  return stack.split('\n').slice(1).filter(line => /^\s+at\s/.test(line)).slice(0, 30).map(line => scrubText(line, 300, budget)).join('\n');
}
function finish(value: Record<string, unknown>): object {
  Object.freeze(value);
  produced.add(value);
  return value;
}
const families: Record<string, string> = {
  '22': 'dato inválido', '23': 'violación de integridad', '40': 'conflicto de transacción',
  '42': 'error de sintaxis o permisos', '08': 'error de conexión', '53': 'recursos insuficientes',
  '55': 'estado de objeto inválido', '57': 'operación cancelada',
};
function error(value: unknown, path: WeakSet<object>, depth: number, budget: RecordBudget): object {
  if (typeof value === 'string') return finish({ type: 'string', message: scrubText(value, 500, budget) });
  if (value === null || typeof value !== 'object') return finish({ type: typeof value });
  if (types.isProxy(value)) return finish({ type: 'Error', message: PROXY });
  if (produced.has(value)) return value;
  if (path.has(value)) return finish({ type: 'Error', message: CICLO });
  if (depth > 3) return finish({ type: 'Error', message: PROFUNDIDAD });
  if (!inspectable(value)) return finish({ type: 'Error', message: PROXY });
  const type = typeName(value);
  const database = isDatabaseError(value);
  if (!types.isNativeError(value) && !(value instanceof Error) && !database) return finish({ type });
  path.add(value);
  try {
    const result: Record<string, unknown> = { type };
    if (database) {
      result.database = true;
      Object.assign(result, extractDatabaseFields(value));
      const sqlState = result.sqlState;
      if (sqlState === '40001' || sqlState === '40P01') result.retryable = true;
      result.message = typeof result.sqlState === 'string'
        ? `Error de base de datos ${result.sqlState} (${families[result.sqlState.slice(0, 2)] ?? 'otro'}).` : 'Error de base de datos.';
    } else {
      const message = own(value, 'message');
      result.message = value instanceof TypeORMError ? `Error de ORM (${type}).`
        : typeof message === 'string' ? scrubText(message, 500, budget) : NO_INSPECCIONABLE;
      const code = own(value, 'code');
      if (valid(code, /^[A-Za-z0-9_.-]{1,40}$/)) result.code = code;
      for (const key of ['status', 'statusCode']) {
        const status = own(value, key);
        if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) result[key] = status;
      }
      if (has(value, 'cause')) result.cause = error(own(value, 'cause'), path, depth + 1, budget);
      const errors = own(value, 'errors');
      if (value instanceof AggregateError && Array.isArray(errors) && !types.isProxy(errors)) {
        const length = own(errors, 'length') as number;
        result.errors = Object.freeze(Array.from({ length: Math.min(length, 5) }, (_, i) => error(own(errors, String(i)), path, depth + 1, budget)));
      }
    }
    const rawStack = readStack(value);
    const stack = rawStack === ACCESOR ? ACCESOR : framesOnly(rawStack, budget);
    if (stack !== undefined) result.stack = stack;
    return finish(result);
  } finally { path.delete(value); }
}
export function sanitizeError(value: unknown, budget?: RecordBudget): object {
  try { return error(value, new WeakSet(), 0, budgetOf(budget)); }
  catch { return finish({ type: 'Error', message: NO_INSPECCIONABLE }); }
}
export function safeContext(value: unknown): string {
  return valid(value, /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/) ? value : CONTEXTO_OMITIDO;
}
export function registerSafeSerializer(ctor: abstract new (...args: never[]) => object, fn: (value: never) => unknown): void {
  serializers.set(ctor, fn);
}
const urlGet = (key: string) => Object.getOwnPropertyDescriptor(URL.prototype, key)!.get!;
const protocol = urlGet('protocol'), host = urlGet('host'), pathname = urlGet('pathname');
registerSafeSerializer(URL, value => `${protocol.call(value)}//${host.call(value)}${pathname.call(value)}`);

interface State { path: WeakSet<object>; nodes: number; budget: RecordBudget }
function field(value: object, key: string, state: State, depth: number): unknown {
  if (state.nodes >= 500) return LIMITE;
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (SENSITIVE_LOG_KEYS.has(key)) { state.nodes++; return '[REDACTED]'; }
  if (!d || !('value' in d)) { state.nodes++; return ACCESOR; }
  const v: unknown = d.value;
  if (key === 'context') { state.nodes++; return safeContext(v); }
  if (key === 'err' || key === 'error') { state.nodes++; return sanitizeError(v, state.budget); }
  if (depth === 0 && (key === 'req' || key === 'res') && v && typeof v === 'object' && inspectable(v) &&
    (httpOutputs.has(v) || (key === 'req' ? v instanceof IncomingMessage : v instanceof ServerResponse))) { state.nodes++; return v; }
  return walk(v, state, depth);
}
function walk(value: unknown, state: State, depth: number): unknown {
  if (++state.nodes > 500) return LIMITE;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubText(value, 4000, state.budget);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (types.isProxy(value)) return PROXY;
  if (typeof value !== 'object') return NO_INSPECCIONABLE;
  if (!inspectable(value)) return PROXY;
  if (state.path.has(value)) return CICLO;
  if (depth >= 3) return PROFUNDIDAD;
  if (types.isNativeError(value) || value instanceof Error || isDatabaseError(value)) return sanitizeError(value, state.budget);
  if (types.isDate(value)) {
    const time = Date.prototype.getTime.call(value);
    return Number.isFinite(time) ? Date.prototype.toISOString.call(value) : NO_INSPECCIONABLE;
  }
  if (ArrayBuffer.isView(value) || types.isAnyArrayBuffer(value)) {
    const proto = types.isDataView(value) ? DataView.prototype : ArrayBuffer.isView(value)
      ? Object.getPrototypeOf(Uint8Array.prototype) as object : types.isSharedArrayBuffer(value) ? SharedArrayBuffer.prototype : ArrayBuffer.prototype;
    const byteLength: unknown = Object.getOwnPropertyDescriptor(proto, 'byteLength')!.get!.call(value);
    return Object.freeze({ type: typeName(value), byteLength });
  }
  state.path.add(value);
  try {
    if (Array.isArray(value)) {
      const length = own(value, 'length') as number;
      if (length > 50) return LIMITE;
      return Object.freeze(Array.from({ length }, (_, i) => field(value, String(i), state, depth + 1)));
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto === null || proto === Object.prototype) {
      const keys = Object.keys(value);
      if (keys.length > 50) return LIMITE;
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of keys) result[key] = field(value, key, state, depth + 1);
      return Object.freeze(result);
    }
    for (const [ctor, serialize] of serializers) {
      if (value instanceof ctor) {
        try { return walk(serialize(value as never), state, depth + 1); }
        catch { return NO_INSPECCIONABLE; }
      }
    }
    return Object.freeze({ type: typeName(value) });
  } finally { state.path.delete(value); }
}
export function sanitizeLogObject(value: unknown, budget?: RecordBudget): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object') return { saneado: NO_INSPECCIONABLE };
    if (types.isProxy(value) || !inspectable(value)) return { saneado: PROXY };
    if (logs.has(value)) return value as Record<string, unknown>;
    const keys = Object.keys(value);
    if (keys.length > 50) return { saneado: LIMITE };
    const state: State = { path: new WeakSet([value]), nodes: 0, budget: budgetOf(budget) };
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) result[key] = field(value, key, state, 0);
    logs.add(result);
    return Object.freeze(result);
  } catch { return { saneado: NO_INSPECCIONABLE }; }
}
