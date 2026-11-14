export function assertAuthOrigin(value: unknown): void {
  if (value !== 'https://app.agenda.test') throw new Error('auth exige APP_ALLOWED_ORIGINS exactamente https://app.agenda.test antes de conectar');
}
export const DAY = 86400000;
export const renewalDays = [6, 12, 18, 24, 29] as const;
export function expiry(created: number, now: number): number { return Math.min(created + 30 * DAY, now + 7 * DAY); }
export class ControlledClock {
  constructor(private value: number = Date.now()) {}
  now(): Date { return new Date(this.value); }
  set(value: number): void {
    if (!Number.isFinite(value) || value < this.value) throw new Error('El reloj solo avanza');
    this.value = value;
  }
  advance(milliseconds: number): void { this.set(this.value + milliseconds); }
}
