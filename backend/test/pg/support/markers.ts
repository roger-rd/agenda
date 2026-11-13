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
    if ((this.phase !== 'dml' && this.phase !== 'http') || this.passed.size !== 3) throw new Error('Armado requiere dml o http, identidad, esquema y línea base');
    this.armed = true;
  }
  assertArmed(): void {
    if ((this.phase !== 'dml' && this.phase !== 'http') || !this.armed) throw new Error('Borrado requiere dml o http y gate armado');
  }
  get isArmed(): boolean { return this.armed; }
}

// Reserve all attempts before any request; shared conflicting values remain run-scoped.
export function httpMarkers(id: string) {
  const success = markers(id, 0, 'http');
  const email = markers(id, 1, 'http-email');
  const organization = markers(id, 2, 'http-organization');
  return {
    reserved: [success, email, organization],
    success,
    emailConflict: { ...email, email: success.email },
    organizationConflict: { ...organization, organizationName: success.organizationName },
  };
}

export function httpCleanupTargets(id: string): { emails: string[]; organizationNames: string[] } {
  const { reserved } = httpMarkers(id);
  return {
    emails: [...new Set(reserved.map(marker => marker.email))],
    organizationNames: [...new Set(reserved.map(marker => marker.organizationName))],
  };
}

export const httpCleanupSQL = {
  memberships: 'DELETE FROM public.organization_memberships WHERE user_id IN (SELECT id FROM public.users WHERE email = ANY($1::text[])) OR organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($2::text[]))',
  users: 'DELETE FROM public.users WHERE email = ANY($1::text[])',
  organizations: 'DELETE FROM public.organizations WHERE name = ANY($1::text[])',
} as const;
