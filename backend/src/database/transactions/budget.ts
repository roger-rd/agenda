import type { TransactionTimeouts } from './transaction-timeouts';

export interface MonotonicClock { now(): number }
export const systemMonotonicClock: MonotonicClock = Object.freeze({ now: () => performance.now() });

export class Budget {
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  private readonly timeouts: Readonly<TransactionTimeouts>;
  private readonly clock: MonotonicClock;
  private high: number;
  private broken = false;

  private constructor(timeouts: Readonly<TransactionTimeouts>, clock: MonotonicClock, start: number) {
    this.timeouts = timeouts;
    this.clock = clock;
    this.startedAtMs = start;
    this.deadlineAtMs = start + timeouts.deadlineMs;
    this.high = start;
  }
  static start(timeouts: Readonly<TransactionTimeouts>, clock: MonotonicClock = systemMonotonicClock): Budget {
    let start: number;
    try { start = clock.now(); } catch { throw new TypeError('Reloj monotónico inválido.'); }
    if (!Number.isFinite(start)) throw new TypeError('Reloj monotónico inválido.');
    return new Budget(timeouts, clock, start);
  }
  private observe(): void {
    try {
      const time = this.clock.now();
      if (!Number.isFinite(time)) this.broken = true;
      else if (time > this.high) this.high = time;
    } catch { this.broken = true; }
  }
  private remaining(): number { return this.broken ? 0 : Math.max(0, this.deadlineAtMs - this.high); }
  remainingMs(): number { this.observe(); return this.remaining(); }
  isExpired(): boolean { this.observe(); return this.broken || this.high >= this.deadlineAtMs; }
  canStartAttempt(): boolean { this.observe(); return this.remaining() >= this.timeouts.attemptStartMinMs; }
  retryDelayMs(random: () => number = Math.random): number | undefined {
    this.observe();
    if (this.broken) return undefined;
    const value = random();
    const ratio = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1 - Number.EPSILON) : 0;
    const delay = this.timeouts.retryJitterMinMs + Math.floor(ratio * (this.timeouts.retryJitterMaxMs - this.timeouts.retryJitterMinMs + 1));
    return this.remaining() - delay >= this.timeouts.attemptStartMinMs ? delay : undefined;
  }
  inFlightWaitUntilMs(): number {
    this.observe();
    return Math.min(Math.max(this.high, this.deadlineAtMs) + this.timeouts.inFlightGraceMs, this.high + this.timeouts.inFlightWaitCapMs);
  }
}
