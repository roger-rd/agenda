export const TRANSACTION_TIMEOUTS_ERROR_CODE = 'TRANSACTION_TIMEOUTS_INVALID' as const;
export type TransactionTimeoutsRelation = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10';
export const TRANSACTION_TIMEOUTS_MESSAGES: Readonly<Record<TransactionTimeoutsRelation, string>> = Object.freeze({
  R1: 'Configuración de tiempos de transacción inválida (R1).',
  R2: 'Configuración de tiempos de transacción inválida (R2).',
  R3: 'Configuración de tiempos de transacción inválida (R3).',
  R4: 'Configuración de tiempos de transacción inválida (R4).',
  R5: 'Configuración de tiempos de transacción inválida (R5).',
  R6: 'Configuración de tiempos de transacción inválida (R6).',
  R7: 'Configuración de tiempos de transacción inválida (R7).',
  R8: 'Configuración de tiempos de transacción inválida (R8).',
  R9: 'Configuración de tiempos de transacción inválida (R9).',
  R10: 'Configuración de tiempos de transacción inválida (R10).',
});
export class TransactionTimeoutsError extends Error {
  readonly code = TRANSACTION_TIMEOUTS_ERROR_CODE;
  readonly relation: TransactionTimeoutsRelation;
  constructor(relation: TransactionTimeoutsRelation) {
    super(TRANSACTION_TIMEOUTS_MESSAGES[relation]);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'TransactionTimeoutsError';
    this.relation = relation;
  }
}
export interface PrimaryTransactionTimeouts {
  readonly lockMs: number;
  readonly statementMs: number;
  readonly idleInTransactionMs: number;
  readonly acquireMs: number;
  readonly deadlineMs: number;
  readonly attemptMarginMs: number;
  readonly retentionOffsetMs: number;
  readonly inFlightGraceMs: number;
  readonly inFlightWaitCapMs: number;
  readonly cancelGraceMs: number;
  readonly commitWatchdogMs: number;
  readonly cleanupMs: number;
  readonly hookMs: number;
  readonly hooksTotalMs: number;
  readonly drainMs: number;
  readonly shutdownCommitWindowMs: number;
  readonly finalInvalidationMs: number;
  readonly shutdownMarginMs: number;
  readonly globalWatchdogMs: number;
  readonly maxAttempts: number;
  readonly retryJitterMinMs: number;
  readonly retryJitterMaxMs: number;
  readonly invalidationAttemptMs: number;
  readonly invalidationDelaysMs: readonly number[];
}
export interface TransactionTimeouts extends PrimaryTransactionTimeouts {
  readonly attemptStartMinMs: number;
  readonly retentionWatchdogMs: number;
  readonly retentionCloseMaxMs: number;
  readonly shutdownCommitDeadlineMs: number;
  /** Techo teórico DERIVADO de la configuración (plazo + vigilante de COMMIT + limpieza + hooks).
   * No es una garantía de tiempo máximo de ejecución: no incluye retrasos del bucle de eventos,
   * de la recolección de basura ni de procesos externos.
   */
  readonly executionCeilingMs: number;
}
export type TransactionTimeoutsOverrides = Partial<PrimaryTransactionTimeouts>;
const PRIMARY_DEFAULTS: Readonly<PrimaryTransactionTimeouts> = Object.freeze({
  lockMs: 2000, statementMs: 5000, idleInTransactionMs: 15000, acquireMs: 3000,
  deadlineMs: 8000, attemptMarginMs: 500, retentionOffsetMs: 1000,
  inFlightGraceMs: 1000, inFlightWaitCapMs: 5000, cancelGraceMs: 1000,
  commitWatchdogMs: 8000, cleanupMs: 2000, hookMs: 2000, hooksTotalMs: 4000,
  drainMs: 12000, shutdownCommitWindowMs: 3000, finalInvalidationMs: 800,
  shutdownMarginMs: 1000, globalWatchdogMs: 16000, maxAttempts: 3,
  retryJitterMinMs: 25, retryJitterMaxMs: 200, invalidationAttemptMs: 2000,
  invalidationDelaysMs: Object.freeze([0, 1000, 5000]),
});
function requireRelation(valid: boolean, relation: TransactionTimeoutsRelation): void {
  if (!valid) throw new TransactionTimeoutsError(relation);
}
/** Techo teórico DERIVADO de la configuración (plazo + vigilante de COMMIT + limpieza + hooks).
 * No es una garantía de tiempo máximo de ejecución: no incluye retrasos del bucle de eventos,
 * de la recolección de basura ni de procesos externos.
 */
export function resolveTransactionTimeouts(overrides: TransactionTimeoutsOverrides = {}): Readonly<TransactionTimeouts> {
  requireRelation(overrides !== null && typeof overrides === 'object', 'R10');
  requireRelation(Reflect.ownKeys(overrides).every(key => Object.hasOwn(PRIMARY_DEFAULTS, key)), 'R10');
  const primary = { ...PRIMARY_DEFAULTS, ...overrides };
  for (const [key, value] of Object.entries(primary)) {
    if (key === 'invalidationDelaysMs') continue;
    requireRelation(typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= (key === 'maxAttempts' ? 3 : 2147483647), 'R10');
  }
  requireRelation(primary.retryJitterMinMs <= primary.retryJitterMaxMs, 'R10');
  const delays = primary.invalidationDelaysMs;
  requireRelation(Array.isArray(delays) && delays.length >= 1 && delays.length <= 5, 'R10');
  for (let index = 0; index < delays.length; index++) {
    requireRelation(Number.isInteger(delays[index]) && delays[index] >= 0 && (index === 0 || delays[index] >= delays[index - 1]), 'R10');
  }
  const derived = {
    attemptStartMinMs: primary.acquireMs + primary.attemptMarginMs,
    retentionWatchdogMs: primary.deadlineMs + primary.retentionOffsetMs,
    retentionCloseMaxMs: primary.deadlineMs + primary.retentionOffsetMs + primary.inFlightGraceMs,
    shutdownCommitDeadlineMs: primary.drainMs + primary.shutdownCommitWindowMs,
    executionCeilingMs: primary.deadlineMs + primary.commitWatchdogMs + primary.cleanupMs + primary.hooksTotalMs,
  };
  requireRelation(Object.values(derived).every(value => Number.isFinite(value) && Number.isSafeInteger(value)), 'R10');
  const result = { ...primary, ...derived, invalidationDelaysMs: Object.freeze([...delays]) };
  requireRelation(result.lockMs < result.statementMs, 'R1');
  requireRelation(result.attemptStartMinMs < result.deadlineMs, 'R2');
  requireRelation(result.statementMs < result.deadlineMs && result.deadlineMs < result.idleInTransactionMs, 'R3');
  requireRelation(result.retentionCloseMaxMs < result.idleInTransactionMs, 'R4');
  requireRelation(result.commitWatchdogMs > result.statementMs, 'R5');
  requireRelation(result.drainMs >= result.retentionCloseMaxMs + result.cleanupMs, 'R6');
  requireRelation(result.hookMs <= result.hooksTotalMs, 'R7');
  requireRelation(result.globalWatchdogMs >= result.shutdownCommitDeadlineMs + result.shutdownMarginMs, 'R8');
  requireRelation(result.finalInvalidationMs < result.shutdownMarginMs, 'R9');
  return Object.freeze(result);
}
export const DEFAULT_TRANSACTION_TIMEOUTS: Readonly<TransactionTimeouts> = resolveTransactionTimeouts();
