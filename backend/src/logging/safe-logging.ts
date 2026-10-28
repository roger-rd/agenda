import { pino, type Logger, type LogFn } from 'pino';
import { isErrorLike, NO_INSPECCIONABLE, own, sanitizeError, sanitizeLogObject } from './error-sanitizer';
import { scrubText } from './secret-registry';

export function logMethodHook(this: Logger, args: Parameters<LogFn>, method: LogFn, level: number): void {
  void level;
  let safe: unknown[];
  try {
    const first: unknown = args[0];
    const message = (v: unknown) => own(sanitizeError(v), 'message') ?? NO_INSPECCIONABLE;
    if (isErrorLike(first)) {
      safe = [{ err: sanitizeError(first) }, typeof args[1] === 'string' ? scrubText(args[1], 4000) : message(first), ...args.slice(2)];
    } else if (first && typeof first === 'object') {
      const err = own(first, 'err');
      safe = [sanitizeLogObject(first), ...(isErrorLike(err) && typeof args[1] !== 'string' ? [message(err), ...args.slice(1)] : args.slice(1))];
    } else if (typeof first === 'function' || typeof first === 'symbol') {
      safe = [sanitizeLogObject({ value: first }).value, ...args.slice(1)];
    } else safe = [...args];
    // También los argumentos de interpolación: quick-format los procesa antes del formatter.
    safe = safe.map((v: unknown, i: number) => typeof v === 'string' ? scrubText(v, 4000)
      : i === 0 ? v : sanitizeLogObject({ value: v }).value) as Parameters<LogFn>;
  } catch { safe = [{ saneado: NO_INSPECCIONABLE }, NO_INSPECCIONABLE]; }
  try { method.apply(this, safe as Parameters<LogFn>); }
  catch {
    try { method.call(this, { saneado: NO_INSPECCIONABLE }, NO_INSPECCIONABLE); }
    catch { /* Un fallo del destino tampoco debe interrumpir al llamador. */ }
  }
}
// Cobertura medida no equivalente sin comodines (p. ej. { x: { detail } }).
// Conservamos la defensa adicional: coste medido ≈ +4 µs/registro.
export const extraRedactPaths = [
  'err.query', 'err.parameters', 'err.driverError', 'err.detail', 'err.hint', 'err.where', 'err.internalQuery',
  '*.query', '*.parameters', '*.driverError', '*.detail', '*.hint', '*.where', '*.internalQuery',
];
export const safeLogging = {
  formatters: { log: sanitizeLogObject },
  serializers: { err: sanitizeError, error: sanitizeError },
  hooks: { logMethod: logMethodHook },
};
export function createBootstrapLogger(): Logger {
  return pino({ level: 'fatal', ...safeLogging, redact: { paths: extraRedactPaths, censor: '[REDACTED]' } }, pino.destination(2));
}
