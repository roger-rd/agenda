import { scrubText } from '../logging/secret-registry';
import type { Logger } from 'typeorm';

interface LogSink {
  warn(data: object, message: string): void;
  error(data: object, message: string): void;
  debug(data: object, message: string): void;
}
const verbs = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'WITH', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'SET', 'SHOW']);
function verb(query: unknown): string {
  const first = typeof query === 'string' ? /^\s*([a-z]+)\b/i.exec(query)?.[1].toUpperCase() : undefined;
  return first && verbs.has(first) ? first : 'OTHER';
}
function property(value: unknown, key: string): unknown {
  try { return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined; }
  catch { return undefined; }
}
function identifier(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

export class SafeTypeOrmLogger implements Logger {
  constructor(private readonly sink: LogSink) {}
  logQuery(_query: unknown, _parameters?: unknown): void { void _query; void _parameters; }
  logQueryError(error: unknown, query: unknown, _parameters?: unknown): void {
    void _parameters;
    // PostgresQueryRunner 1.x entrega el error de pg directamente; también aceptamos QueryFailedError.
    const driver = property(error, 'driverError') ?? error;
    const code = identifier(property(driver, 'code'), /^[0-9A-Z]{5}$(?![\s\S])/);
    const constraint = identifier(property(driver, 'constraint'), /^[a-z0-9_]{1,63}$(?![\s\S])/);
    const table = identifier(property(driver, 'table'), /^[a-z0-9_]{1,63}$(?![\s\S])/);
    this.sink[code?.startsWith('23') ? 'warn' : 'error']({ context: 'TypeORM', event: 'query_error',
      ...(code ? { code } : {}), ...(constraint ? { constraint } : {}), ...(table ? { table } : {}), verb: verb(query) }, 'Error de consulta de base de datos.');
  }
  logQuerySlow(time: number, query: unknown, _parameters?: unknown): void {
    void _parameters;
    this.sink.warn({ context: 'TypeORM', durationMs: typeof time === 'number' && Number.isFinite(time) ? time : 0, verb: verb(query) }, 'Consulta lenta de base de datos.');
  }
  logSchemaBuild(message: unknown): void { this.debug(message); }
  logMigration(message: unknown): void { this.debug(message); }
  log(_level: unknown, message: unknown): void { void _level; this.debug(message); }
  private debug(message: unknown): void {
    this.sink.debug({ context: 'TypeORM', ...(typeof message === 'string' ? { message: scrubText(message, 200) } : { type: typeof message }) }, 'Evento interno de TypeORM.');
  }
}
