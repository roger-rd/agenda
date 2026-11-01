'use strict';
const MATRIX = Object.freeze({ testFast: 60000, testSlow: 120000, hookFast: 30000, hookSlow: 60000,
  grace: 10000, postKill: 2000, watchdog: 1200000, tokenTtl: 1500000, skew: 5000,
  preflightConnection: 5000, preflightStatement: 5000, preflightTotal: 30000,
  sweepAge: 3600000, sweepCap: 10, sweepTotal: 30000, cleanupQuiescence: 5000,
  cleanupPoll: 250, cleanupBudget: 30000, appStatement: 5000, appLock: 2000, appIdleInTx: 15000,
  ownerStatement: 10000, ownerLock: 2000, ownerIdleInTx: 15000, poolAcquire: 3000,
  poolIdle: 30000, fixtureSleep: 3000, l0Wait: 0 });
/** Matriz cerrada: cambios de valores requieren aprobar de nuevo el presupuesto.
 * @param {Record<string,number>} [value] */
function validate(value = MATRIX) {
  if (Object.keys(value).length !== Object.keys(MATRIX).length) throw new Error('timeouts_invalid');
  for (const key of Object.keys(MATRIX)) {
    const n = value[key];
    if (!Number.isSafeInteger(n) || n < 0 || n !== MATRIX[/** @type {keyof typeof MATRIX} */ (key)]) throw new Error('timeouts_invalid');
  }
  if (!(value.hookFast < value.testFast && value.hookSlow < value.testSlow && value.grace < value.watchdog &&
    value.watchdog + value.grace + value.postKill + value.skew < value.tokenTtl &&
    value.preflightConnection + value.preflightStatement <= value.preflightTotal &&
    value.cleanupPoll < value.cleanupQuiescence && value.cleanupQuiescence < value.cleanupBudget &&
    value.fixtureSleep < value.appStatement && value.ownerLock < value.ownerStatement &&
    value.appLock < value.appStatement && value.poolAcquire < value.preflightConnection && value.l0Wait === 0)) throw new Error('timeouts_invalid');
  return true;
}
module.exports = Object.freeze({ MATRIX, validate });
