import { normalizePersonName, organizationNameKey } from '../../../src/identity/person-name';
import { markers } from './markers';

export const actors = ['cmA', 'cmB', 'wA1', 'cA1', 'wA0', 'cA0', 'wB', 'cB', 'multi'] as const;
export type Actor = typeof actors[number];
export type Org = 'A' | 'B';
export function companiesMarkers(id: string) {
  const reserved = actors.map((actor, n) => markers(id, 20 + n, `companies-${actor}`));
  return { reserved, byActor: Object.fromEntries(actors.map((actor, n) => [actor, reserved[n]])) as Record<Actor, ReturnType<typeof markers>> };
}
export function companiesCleanupTargets(id: string) {
  const { reserved } = companiesMarkers(id);
  return { emails: reserved.map(m => m.email), organizationNames: reserved.map(m => m.organizationName) };
}
export const companiesCleanupSQL = {
  invitationCompanies: 'DELETE FROM public.invitation_companies WHERE organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($1::text[]))',
  invitations: 'DELETE FROM public.invitations WHERE organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($1::text[]))',
  sessions: 'DELETE FROM public.user_sessions WHERE user_id IN (SELECT id FROM public.users WHERE email = ANY($1::text[]))',
  accesses: 'DELETE FROM public.company_accesses WHERE membership_id IN (SELECT id FROM public.organization_memberships WHERE user_id IN (SELECT id FROM public.users WHERE email = ANY($1::text[])) OR organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($2::text[])))',
  companies: 'DELETE FROM public.companies WHERE organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($1::text[]))',
  memberships: 'DELETE FROM public.organization_memberships WHERE user_id IN (SELECT id FROM public.users WHERE email = ANY($1::text[])) OR organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($2::text[]))',
  users: 'DELETE FROM public.users WHERE email = ANY($1::text[])',
  organizations: 'DELETE FROM public.organizations WHERE name = ANY($1::text[])',
} as const;
export type CompaniesSaved = { users: string[]; memberships: string[]; companies: string[] };
export function companiesFixture() {
  const names = {
    A: ['Álvaro Sur', 'Ñandú Studio', 'Café Central', 'Москва Media', 'Αθήνα Labs', '東京 Studio', 'Zeta Norte', 'Apex'],
    B: ['Café Central', 'Москва Media', 'Delta Sur', 'Ωμέγα Co'],
  };
  const companies = (['A', 'B'] as const).flatMap(org => names[org].map((input, index) => {
    const name = normalizePersonName(input);
    const nameKey = name && organizationNameKey(name);
    if (!name || !nameKey) throw new Error('Nombre de fixture inválido');
    return { key: `${org}${index}`, org, name, nameKey, color: '#123abc' };
  }));
  const memberships: { actor: Actor; org: Org; role: 'community_manager' | 'worker' | 'client'; access: string[] }[] = [
    { actor: 'cmA', org: 'A', role: 'community_manager', access: [] },
    { actor: 'cmB', org: 'B', role: 'community_manager', access: [] },
    { actor: 'wA1', org: 'A', role: 'worker', access: ['A0', 'A2', 'A4', 'A6'] },
    { actor: 'cA1', org: 'A', role: 'client', access: ['A1', 'A3'] },
    { actor: 'wA0', org: 'A', role: 'worker', access: [] },
    { actor: 'cA0', org: 'A', role: 'client', access: [] },
    { actor: 'wB', org: 'B', role: 'worker', access: ['B0', 'B1', 'B2'] },
    { actor: 'cB', org: 'B', role: 'client', access: ['B0', 'B3'] },
    { actor: 'multi', org: 'A', role: 'worker', access: ['A7'] },
    { actor: 'multi', org: 'B', role: 'worker', access: ['B3'] },
  ];
  const accesses = memberships.flatMap(m => m.access.map(company => ({ actor: m.actor, org: m.org, role: m.role, company })));
  const expected = (actor: Actor, org: Org) => memberships.filter(m => m.actor === actor && m.org === org)
    .flatMap(m => m.role === 'community_manager' ? companies.filter(c => c.org === org).map(c => c.key) : m.access);
  return { companies, memberships, accesses, expected };
}
