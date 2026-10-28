export function sqlstateClass(code: unknown): string | undefined {
  return typeof code === 'string' && /^[0-9A-Z]{5}$(?![\s\S])/.test(code) ? code.slice(0, 2) : undefined;
}
export const TRANSACTION_CONFLICTS = ['40001', '40P01'] as const;
export const CONNECTION_MESSAGES = Object.freeze({
  'timeout exceeded when trying to connect': 'not_started',
  'Connection terminated due to connection timeout': 'not_started',
  'Client has encountered a connection error and is not queryable': 'not_started',
  'Client was closed and is not queryable': 'not_started',
  'Cannot use a pool after calling end on the pool': 'not_started',
  'Connection terminated unexpectedly': 'unknown',
  'Connection terminated': 'unknown',
} as const);
export const CONNECTION_CODES = Object.freeze({ ECONNREFUSED: 'not_started', ENOTFOUND: 'not_started', EAI_AGAIN: 'not_started',
  ECONNRESET: 'unknown', EPIPE: 'unknown', ETIMEDOUT: 'unknown', ECONNABORTED: 'unknown' } as const);
