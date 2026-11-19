import { markers } from './markers';
import { DAY, expiry, renewalDays } from './auth-controls';

export const writeActors = ['cmA', 'cmB', 'wA', 'cA'] as const;
export type WriteActor = typeof writeActors[number];
export function companiesWriteMarkers(id: string) {
  const reserved = writeActors.map((actor, n) => markers(id, 40 + n, `companies-write-${actor}`));
  return { reserved, byActor: Object.fromEntries(writeActors.map((actor, n) => [actor, reserved[n]])) as Record<WriteActor, ReturnType<typeof markers>> };
}
export function companiesWriteCleanupTargets(id: string) {
  const { reserved } = companiesWriteMarkers(id);
  return { emails: reserved.map(m => m.email), organizationNames: reserved.slice(0, 2).map(m => m.organizationName) };
}
export const companiesWriteCleanupSQL = {
  sessions: 'DELETE FROM public.user_sessions WHERE user_id IN (SELECT id FROM public.users WHERE email = ANY($1::text[]))',
  accesses: 'DELETE FROM public.company_accesses WHERE membership_id IN (SELECT id FROM public.organization_memberships WHERE user_id IN (SELECT id FROM public.users WHERE email = ANY($1::text[])) OR organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($2::text[])))',
  companies: 'DELETE FROM public.companies WHERE organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($1::text[]))',
  memberships: 'DELETE FROM public.organization_memberships WHERE user_id IN (SELECT id FROM public.users WHERE email = ANY($1::text[])) OR organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($2::text[]))',
  users: 'DELETE FROM public.users WHERE email = ANY($1::text[])',
  organizations: 'DELETE FROM public.organizations WHERE name = ANY($1::text[])',
} as const;
export const duplicateNames = ['Café Central', 'cafe central', '  CAFÉ   CENTRAL  '] as const;
export const collisionNames = ['Zeta Norte', 'zeta norte', 'ZETA  NORTE', 'Zetá Norte', 'ZETA NORTE'] as const;
export const alphabetNames = ['Москва Media', 'Ñandú Studio', '東京 Studio'] as const;
export const ligatureNames = ['Oficina', 'Oﬁcina'] as const;
export const raceRounds = Array.from({ length: 5 }, (_, n) => ({
  initial: { name: `Ronda ${n + 1} Inicial`, color: '#abcdef' },
  changes: [{ version: 1, name: `Ronda ${n + 1} Nombre` }, { version: 1, color: '#0a0b0c' }],
}));
export const identicalRace = { initial: { name: 'Identico Inicial', color: '#abcdef' }, change: { version: 1, name: 'Identico Uno' } };
// Upper bound enforced by every first-part company request, including rejected writes.
export const firstPartWriteLimit = 80;
export function companiesWriteTimeline(created: number) {
  return [6 * 60000, ...renewalDays.map(day => day * DAY)].map(delta => {
    const now = created + delta, expires = expiry(created, now);
    return { now, expires, maxAge: Math.floor((expires - now) / 1000) };
  });
}
export type ErrorView = { status: number; body: { error: { code: string; message: string; requestId?: string } } };
export function sameCompanyError(a: ErrorView, b: ErrorView): boolean {
  return a.status === b.status && a.body.error.code === b.body.error.code && a.body.error.message === b.body.error.message;
}
