import { randomBytes } from 'node:crypto';
import type { Phase } from './phase';
export function runId(): string { return randomBytes(6).toString('hex'); }
export function validateRunId(id: string): void {
  if (!/^[0-9a-f]{12}$/.test(id) || id.length !== 12) throw new Error('runId inválido');
}
export function markers(id: string, n: number, suffix: string) {
  validateRunId(id);
  if (!Number.isSafeInteger(n) || n < 0 || !/^[\p{L}\p{N} -]+$/u.test(suffix)) throw new Error('Marcador inválido');
  const email = `b2b-${id}-${n}@agenda-b2b.test`, organizationName = `B2B-${id}-${suffix}`;
  if (email.length > 120 || [...organizationName].length > 80) throw new Error('Marcador demasiado largo');
  return { email, organizationName };
}
export class DeleteGate {
  private armed = false;
  private readonly passed = new Set<string>();
  constructor(private readonly phase: Phase) {}
  mark(check: 'identity' | 'schema' | 'baseline'): void { this.passed.add(check); }
  arm(): void {
    if (this.phase !== 'dml' || this.passed.size !== 3) throw new Error('Armado requiere dml, identidad, esquema y línea base');
    this.armed = true;
  }
  assertArmed(): void {
    if (this.phase !== 'dml' || !this.armed) throw new Error('Borrado requiere dml y gate armado');
  }
  get isArmed(): boolean { return this.armed; }
}
