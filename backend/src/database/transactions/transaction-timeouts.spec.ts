import {
  DEFAULT_TRANSACTION_TIMEOUTS as defaults, resolveTransactionTimeouts,
  TRANSACTION_TIMEOUTS_ERROR_CODE, TRANSACTION_TIMEOUTS_MESSAGES,
  TransactionTimeoutsError, type TransactionTimeoutsOverrides, type TransactionTimeoutsRelation,
} from './transaction-timeouts';

function expectRelation(overrides: TransactionTimeoutsOverrides, relation: TransactionTimeoutsRelation): void {
  expect(() => resolveTransactionTimeouts(overrides)).toThrow(TransactionTimeoutsError);
  try { resolveTransactionTimeouts(overrides); } catch (error) {
    expect(error).toMatchObject({ relation, message: TRANSACTION_TIMEOUTS_MESSAGES[relation] });
  }
}

describe('Configuración de tiempos de transacción', () => {
  afterEach(() => jest.restoreAllMocks());
  it('cumple R1–R10 con los valores por defecto y calcula los derivados', () => {
    expect(resolveTransactionTimeouts()).toEqual(defaults);
    expect(defaults).toMatchObject({ attemptStartMinMs: 3500, retentionWatchdogMs: 9000, retentionCloseMaxMs: 10000, shutdownCommitDeadlineMs: 15000, executionCeilingMs: 22000 });
    expect(defaults.lockMs).toBeLessThan(defaults.statementMs);
    expect(defaults.attemptStartMinMs).toBeLessThan(defaults.deadlineMs);
    expect(defaults.statementMs).toBeLessThan(defaults.deadlineMs);
    expect(defaults.deadlineMs).toBeLessThan(defaults.idleInTransactionMs);
    expect(defaults.retentionCloseMaxMs).toBeLessThan(defaults.idleInTransactionMs);
    expect(defaults.commitWatchdogMs).toBeGreaterThan(defaults.statementMs);
    expect(defaults.drainMs).toBe(defaults.retentionCloseMaxMs + defaults.cleanupMs);
    expect(defaults.hookMs).toBeLessThanOrEqual(defaults.hooksTotalMs);
    expect(defaults.globalWatchdogMs).toBe(defaults.shutdownCommitDeadlineMs + defaults.shutdownMarginMs);
    expect(defaults.finalInvalidationMs).toBeLessThan(defaults.shutdownMarginMs);
    // Techo teórico DERIVADO de la configuración (plazo + vigilante de COMMIT + limpieza + hooks).
    // No es una garantía de tiempo máximo de ejecución: no incluye retrasos del bucle de eventos,
    // de la recolección de basura ni de procesos externos.
    expect(defaults.executionCeilingMs).toBe(defaults.deadlineMs + defaults.commitWatchdogMs + defaults.cleanupMs + defaults.hooksTotalMs);
  });
  it.each<[TransactionTimeoutsRelation, TransactionTimeoutsOverrides]>([
    ['R1', { lockMs: 5001 }], ['R2', { acquireMs: 7501 }],
    ['R3', { statementMs: 8001 }], ['R3', { idleInTransactionMs: 7999 }],
    ['R4', { idleInTransactionMs: 9999 }], ['R5', { commitWatchdogMs: 4999 }],
    ['R6', { drainMs: 11999 }], ['R7', { hookMs: 4001 }],
    ['R8', { globalWatchdogMs: 15999 }], ['R9', { finalInvalidationMs: 1001 }],
  ])('detecta la mutación de 1 ms de %s: %p', (relation, overrides) => expectRelation(overrides, relation));
  it.each<TransactionTimeoutsOverrides>([
    { lockMs: 5000 }, { acquireMs: 7500 }, { statementMs: 8000 },
    { idleInTransactionMs: 8000 }, { idleInTransactionMs: 10000 },
    { commitWatchdogMs: 5000 }, { finalInvalidationMs: 1000 },
  ])('rechaza también las igualdades estrictas %p', overrides => expect(() => resolveTransactionTimeouts(overrides)).toThrow(TransactionTimeoutsError));
  it.each([
    { unknown: 1 }, { attemptStartMinMs: 3500 }, { retentionWatchdogMs: 9000 },
    { retentionCloseMaxMs: 10000 }, { shutdownCommitDeadlineMs: 15000 }, { executionCeilingMs: 22000 },
    { lockMs: 1.5 }, { lockMs: -1 }, { lockMs: 0 }, { lockMs: NaN }, { lockMs: Infinity },
    { lockMs: 2147483648 }, { lockMs: undefined }, { lockMs: '1' },
    { maxAttempts: 0 }, { maxAttempts: 4 }, { maxAttempts: 1.5 },
    { retryJitterMinMs: 201 }, { invalidationDelaysMs: [] }, { invalidationDelaysMs: [1, 0] },
    { invalidationDelaysMs: [-1] }, { invalidationDelaysMs: [0, 1, 2, 3, 4, 5] },
    { invalidationDelaysMs: [NaN] }, { invalidationDelaysMs: [Infinity] },
    { invalidationDelaysMs: [0.5] }, { invalidationDelaysMs: Array<number>(2) }, { invalidationDelaysMs: null },
    { [Symbol('desconocida')]: 1 },
  ])('rechaza la forma inválida %p con R10', overrides => expectRelation(overrides as TransactionTimeoutsOverrides, 'R10'));
  it('prioriza R10 frente a R1', () => expectRelation({ lockMs: 6000, maxAttempts: 4 }, 'R10'));
  it('acepta derivados seguros aun con todos los primarios en su máximo', () => {
    const extreme = Object.fromEntries(Object.keys(defaults)
      .filter(key => !['attemptStartMinMs', 'retentionWatchdogMs', 'retentionCloseMaxMs', 'shutdownCommitDeadlineMs', 'executionCeilingMs'].includes(key))
      .map(key => [key, key === 'maxAttempts' ? 3 : key === 'invalidationDelaysMs' ? [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE] : 2147483647]));
    const safe = jest.spyOn(Number, 'isSafeInteger');
    expectRelation(extreme, 'R1');
    expect(safe).toHaveBeenCalledWith(4 * 2147483647);
    expect(safe.mock.results.every(result => result.value === true)).toBe(true);
  });
  it.each([3500, 9000, 10000, 15000, 22000])('rechaza defensivamente el derivado %i si no es seguro', value => {
    const original = Number.isSafeInteger;
    jest.spyOn(Number, 'isSafeInteger').mockImplementation(candidate => candidate !== value && original(candidate));
    expectRelation({}, 'R10');
  });
  it('congela el resultado y copia los overrides sin mutarlos', () => {
    const overrides = { lockMs: 1999, invalidationDelaysMs: [0, 10] };
    const before = structuredClone(overrides);
    const result = resolveTransactionTimeouts(overrides);
    expect(overrides).toEqual(before);
    expect(result.lockMs).toBe(1999);
    expect(result.invalidationDelaysMs).not.toBe(overrides.invalidationDelaysMs);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.invalidationDelaysMs)).toBe(true);
    expect(Object.isFrozen(defaults)).toBe(true);
    expect(Object.isFrozen(defaults.invalidationDelaysMs)).toBe(true);
    overrides.invalidationDelaysMs.push(20);
    expect(result.invalidationDelaysMs).toEqual([0, 10]);
    expect(() => Object.assign(result, { deadlineMs: 1 })).toThrow(TypeError);
  });
  it('mantiene el catálogo completo, congelado y el contrato de los errores', () => {
    expect(Object.isFrozen(TRANSACTION_TIMEOUTS_MESSAGES)).toBe(true);
    expect(Object.keys(TRANSACTION_TIMEOUTS_MESSAGES)).toEqual(Array.from({ length: 10 }, (_, index) => `R${index + 1}`));
    for (const relation of Object.keys(TRANSACTION_TIMEOUTS_MESSAGES) as TransactionTimeoutsRelation[]) {
      const error = new TransactionTimeoutsError(relation);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(TransactionTimeoutsError);
      expect(error).toMatchObject({ name: 'TransactionTimeoutsError', code: TRANSACTION_TIMEOUTS_ERROR_CODE, relation, message: `Configuración de tiempos de transacción inválida (${relation}).` });
    }
  });
});
