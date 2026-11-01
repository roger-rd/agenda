import { MATRIX, validate } from '../../scripts/harness/c8-timeouts.cjs';
describe('C8 tiempos', () => {
  it('matriz normativa y relaciones', () => {
    expect(validate()).toBe(true);
    expect(MATRIX).toEqual({ testFast: 60000, testSlow: 120000, hookFast: 30000, hookSlow: 60000,
      grace: 10000, postKill: 2000, watchdog: 1200000, tokenTtl: 1500000, skew: 5000,
      preflightConnection: 5000, preflightStatement: 5000, preflightTotal: 30000,
      sweepAge: 3600000, sweepCap: 10, sweepTotal: 30000, cleanupQuiescence: 5000,
      cleanupPoll: 250, cleanupBudget: 30000, appStatement: 5000, appLock: 2000, appIdleInTx: 15000,
      ownerStatement: 10000, ownerLock: 2000, ownerIdleInTx: 15000, poolAcquire: 3000,
      poolIdle: 30000, fixtureSleep: 3000, l0Wait: 0 });
    expect(MATRIX.hookFast).toBeLessThan(MATRIX.testFast); expect(MATRIX.hookSlow).toBeLessThan(MATRIX.testSlow);
  });
  it.each(Object.keys(MATRIX))('rechaza tiempos alterados %s', key => {
    for (const value of [-1, 0.5, NaN, Infinity, 99999999]) expect(() => validate({ ...MATRIX, [key]: value })).toThrow('timeouts_invalid');
  });
  it('rechaza idle_session_timeout y campos ausentes', () => {
    expect(() => validate({ ...MATRIX, idle_session_timeout: 1 })).toThrow(); expect(() => validate({})).toThrow();
  });
});
