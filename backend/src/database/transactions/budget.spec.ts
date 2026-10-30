import { Budget, systemMonotonicClock, type MonotonicClock } from './budget';
import { DEFAULT_TRANSACTION_TIMEOUTS as defaults, resolveTransactionTimeouts, TransactionTimeoutsError, type TransactionTimeouts } from './transaction-timeouts';

function seeded(seed: number): () => number {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
function fixture(start = 100): { budget: Budget; set: (time: number) => void; now: jest.Mock<number, []> } {
  let time = start;
  const now = jest.fn(() => time);
  return { budget: Budget.start(defaults, { now }), set: value => { time = value; }, now };
}

describe('Presupuesto monotónico', () => {
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
  it('calcula el restante, el origen y el plazo absoluto', () => {
    const { budget, set } = fixture();
    expect(budget.startedAtMs).toBe(100);
    expect(budget.deadlineAtMs).toBe(8100);
    expect(budget.remainingMs()).toBe(8000);
    set(1100);
    expect(budget.remainingMs()).toBe(7000);
    set(9000);
    expect(budget.remainingMs()).toBe(0);
  });
  it.each([[3499, false], [3499.999, false], [3500, true], [3500.001, true]] as const)('con restante %p permite iniciar: %p', (remaining, allowed) => {
    const { budget, set } = fixture();
    set(budget.deadlineAtMs - remaining);
    expect(budget.canStartAttempt()).toBe(allowed);
  });
  it.each([[0, 5000], [3000, 8000], [4000, 9000], [7999, 9000], [8000, 9000], [9000, 10000], [20000, 21000]])('calcula la espera en %i como %i', (time, expected) => {
    const { budget, set } = fixture(0);
    set(time);
    expect(budget.inFlightWaitUntilMs()).toBe(expected);
    expect(expected).toBeLessThanOrEqual(time + defaults.inFlightWaitCapMs);
  });
  it.each([[7999, false], [8000, true], [8001, true]] as const)('expira en %i: %p', (time, expired) => {
    const { budget, set } = fixture(0);
    set(time);
    expect(budget.isExpired()).toBe(expired);
  });
  it('cada método realiza exactamente una lectura, incluso tras romperse', () => {
    const { budget, set, now } = fixture();
    expect(now).toHaveBeenCalledTimes(1);
    const operations = [() => budget.remainingMs(), () => budget.isExpired(), () => budget.canStartAttempt(), () => budget.retryDelayMs(() => 0), () => budget.inFlightWaitUntilMs()];
    for (const time of [100, NaN, 200]) {
      set(time);
      for (const operation of operations) {
        now.mockClear();
        operation();
        expect(now).toHaveBeenCalledTimes(1);
      }
    }
  });
  it('mantiene el máximo al subir, retroceder y expirar', () => {
    const { budget, set } = fixture(0);
    const snapshots = [1000, 500, 6000, 1000, 8000, 7000, 9000, 0].map(time => {
      set(time);
      return [budget.remainingMs(), budget.isExpired(), budget.inFlightWaitUntilMs()];
    });
    expect(snapshots).toEqual([
      [7000, false, 6000], [7000, false, 6000], [2000, false, 9000], [2000, false, 9000],
      [0, true, 9000], [0, true, 9000], [0, true, 10000], [0, true, 10000],
    ]);
  });
  it('conserva las propiedades monotónicas con semilla 0xC10C', () => {
    const random = seeded(0xC10C);
    for (let sequence = 0; sequence < 40; sequence++) {
      const { budget, set } = fixture(0);
      let high = 0;
      let previousRemaining = 8000;
      let previousWait = 5000;
      let expired = false;
      for (let index = 0; index < 100; index++) {
        const time = Math.floor(random() * 20000) - 1000;
        high = Math.max(high, time);
        set(time);
        const remaining = budget.remainingMs();
        const wait = budget.inFlightWaitUntilMs();
        expect(remaining).toBe(Math.max(0, 8000 - high));
        expect(remaining).toBeLessThanOrEqual(previousRemaining);
        expect(wait).toBeGreaterThanOrEqual(previousWait);
        expect(wait).toBeLessThanOrEqual(high + 5000);
        expect(budget.isExpired()).toBe(expired || high >= 8000);
        expired = budget.isExpired();
        previousRemaining = remaining;
        previousWait = wait;
      }
    }
  });
  it.each([NaN, Infinity, -Infinity, 'excepción'])('queda roto permanentemente con %p', failure => {
    let broken = false;
    const clock: MonotonicClock = { now: () => {
      if (!broken) return 0;
      if (typeof failure === 'string') throw new Error('Reloj roto.');
      return failure;
    } };
    const budget = Budget.start(defaults, clock);
    broken = true;
    expect(budget.remainingMs()).toBe(0);
    broken = false;
    expect(budget.remainingMs()).toBe(0);
    expect(budget.isExpired()).toBe(true);
    expect(budget.canStartAttempt()).toBe(false);
    expect(budget.retryDelayMs()).toBeUndefined();
  });
  it.each([NaN, Infinity, -Infinity, 'excepción'])('rechaza el reloj inicial %p', failure => {
    expect(() => Budget.start(defaults, { now: () => {
      if (typeof failure === 'string') throw new Error('Reloj roto.');
      return failure;
    } })).toThrow(new TypeError('Reloj monotónico inválido.'));
  });
  it.each([[0, 25], [1 - Number.EPSILON, 200], [1, 200], [-1, 25], [NaN, 25], [Infinity, 25], [-Infinity, 25], [2, 200]])('acota el jitter %p a %i', (random, expected) => {
    const { budget } = fixture();
    expect(budget.retryDelayMs(() => random)).toBe(expected);
  });
  it.each([[3524, 0, undefined], [3525, 0, 25], [3699, 1, undefined], [3700, 1, 200], [3500, 0, undefined]])('evalúa el restante %i después del jitter %i', (remaining, random, expected) => {
    const { budget, set } = fixture(0);
    set(8000 - remaining);
    expect(budget.retryDelayMs(() => random)).toBe(expected);
  });
  it('resuelve Math.random al llamar', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(fixture().budget.retryDelayMs()).toBe(25);
  });
  it('ignora saltos del reloj de pared tanto con reloj inyectado como por defecto', () => {
    jest.useFakeTimers();
    const { budget: injected } = fixture();
    const budget = Budget.start(defaults);
    expect(systemMonotonicClock.now()).toBe(0);
    for (const wallTime of [2000000000000, 1000, 3000000000000, -1000000]) {
      jest.setSystemTime(wallTime);
      expect(injected.remainingMs()).toBe(8000);
      expect(budget.remainingMs()).toBe(8000);
      expect(budget.isExpired()).toBe(false);
    }
    jest.advanceTimersByTime(1000);
    expect(budget.remainingMs()).toBe(7000);
    expect(injected.remainingMs()).toBe(8000);
  });
  it('verifica la fórmula y la planificación aritmética con semilla 0xB3C1', () => {
    // Propiedad aritmética; la ejecución completa corresponde a C4, C6 y C9.
    const random = seeded(0xB3C1);
    let accepted = 0;
    let rejected = 0;
    let waits = 0;
    let attempts = 0;
    for (let sample = 0; sample < 600; sample++) {
      let timeouts: Readonly<TransactionTimeouts>;
      try {
        timeouts = resolveTransactionTimeouts({
          acquireMs: 1000 + Math.floor(random() * 4000), deadlineMs: 6000 + Math.floor(random() * 4000),
          lockMs: 1 + Math.floor(random() * 6000), hookMs: 1 + Math.floor(random() * 5000),
          cleanupMs: 500 + Math.floor(random() * 1500),
        });
      } catch (error) {
        if (!(error instanceof TransactionTimeoutsError)) throw error;
        rejected++;
        continue;
      }
      accepted++;
      expect(timeouts.executionCeilingMs).toBe(timeouts.deadlineMs + timeouts.commitWatchdogMs + timeouts.cleanupMs + timeouts.hooksTotalMs);
      let time = 100;
      const budget = Budget.start(timeouts, { now: () => time });
      const latest = budget.deadlineAtMs - timeouts.attemptStartMinMs;
      for (let step = 0; step < 30; step++) {
        if (!budget.canStartAttempt()) break;
        attempts++;
        expect(time).toBeLessThanOrEqual(latest);
        time += Math.floor(random() * 1000);
        const delay = budget.retryDelayMs(random);
        if (delay === undefined) break;
        expect(delay).toBeGreaterThanOrEqual(25);
        expect(delay).toBeLessThanOrEqual(200);
        time += delay;
        waits++;
        expect(time).toBeLessThanOrEqual(latest);
        expect(time).toBeLessThan(budget.deadlineAtMs);
      }
    }
    expect(accepted).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(0);
    expect(waits).toBeGreaterThan(100);
    expect(attempts).toBeGreaterThan(100);
  });
});
