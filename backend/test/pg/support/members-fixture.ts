// Pure module: no database, Nest or TypeORM imports.
import { markers } from './markers';
import { MEMBERS_TIME_ZONES, type MembersTimeZone } from './phase';

export const MEMBERS_INVITEES = 10;

/** Organizations, community manager addresses and invitee addresses (they become users) are all reserved before anything is written. */
export function membersMarkers(id: string) {
  const cmA = markers(id, 600, 'members-cmA'), cmB = markers(id, 601, 'members-cmB');
  const invitees = Array.from({ length: MEMBERS_INVITEES }, (_, n) => markers(id, 700 + n, 'members-invitee').email);
  return { cmA, cmB, invitees };
}
export function membersCleanupTargets(id: string) {
  const { cmA, cmB, invitees } = membersMarkers(id);
  return { emails: [cmA.email, cmB.email, ...invitees], organizationNames: [cmA.organizationName, cmB.organizationName] };
}
export function membersInvitee(id: string, n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= MEMBERS_INVITEES) throw new Error('Invitado fuera de las reservas');
  return membersMarkers(id).invitees[n];
}

/** Observer reads. Timestamps as text (session zone UTC) so that a snapshot compares exact microseconds. */
export const membersSQL = {
  membership: 'SELECT id, organization_id, user_id, role, version, deactivated_at::text AS deactivated_at, created_at::text AS created_at, updated_at::text AS updated_at FROM public.organization_memberships WHERE id = $1',
  accesses: 'SELECT company_id, organization_id, membership_role, created_at::text AS created_at FROM public.company_accesses WHERE membership_id = $1 ORDER BY company_id',
} as const;
/**
 * THE ONLY manual modification of this phase (authorized): there is no endpoint to deactivate a member yet, so the observer simulates it,
 * once, on a membership created by this run and scoped to its organization. It does not touch version (the later 409 is by state, not by
 * version), keeps deactivated_at >= created_at, and must affect exactly one row. It is a test simulation, not a policy of any endpoint.
 */
export const DEACTIVATE_MEMBER_SQL = 'UPDATE public.organization_memberships SET deactivated_at = $2, updated_at = $2 WHERE id = $1 AND organization_id = $3 RETURNING id';
/** Locker: locks only, inside a transaction that is always rolled back. */
export const membersLocks = {
  row: 'SELECT id FROM public.organization_memberships WHERE id = $1 AND organization_id = $2 FOR UPDATE',
  memberships: 'LOCK TABLE public.organization_memberships IN SHARE MODE',
  accesses: 'LOCK TABLE public.company_accesses IN SHARE MODE',
} as const;

export const MEMBERS_ZONE: MembersTimeZone = MEMBERS_TIME_ZONES[0];
export const DEFAULT_MEMBERS_JEST = 'node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config jest.pg.config.cjs --runInBand test/pg/registration.pg.spec.ts';
/**
 * Shell text (zsh or bash): the members phase in UTC and then readonly, stopping at the first failure with a non-zero status.
 * `status` is read-only in zsh, hence b2b_rc. `jest` and `loadEnv` are injectable to exercise the control flow offline.
 */
export function membersRunCommand(options: { backend: string; jest?: string; loadEnv?: string } = { backend: '.' }): string {
  const jest = options.jest ?? DEFAULT_MEMBERS_JEST;
  const loadEnv = options.loadEnv ?? 'set -a && . ./.env.test && set +a';
  return [
    '(',
    '  set -e',
    `  cd "${options.backend}" || exit 1`,
    `  ${loadEnv}`,
    '  echo "[b2b] members: fase members (UTC)"',
    `  env NODE_ENV=test AGENDA_B2B_PHASE=members AGENDA_B2B_TIMEZONE=${MEMBERS_ZONE} LOG_LEVEL=info DATABASE_POOL_MAX=10 APP_ALLOWED_ORIGINS=https://app.agenda.test ${jest} \\`,
    '    || { echo "[b2b] members FALLÓ: fase members" >&2; exit 1; }',
    '  echo "[b2b] members: readonly posterior"',
    `  env NODE_ENV=test AGENDA_B2B_PHASE=readonly DATABASE_POOL_MAX=10 ${jest} \\`,
    '    || { echo "[b2b] members FALLÓ: readonly" >&2; exit 1; }',
    '  echo "[b2b] members: todo terminó bien"',
    ')',
    'b2b_rc=$?',
    'echo "[b2b] members: código de salida=$b2b_rc"',
    '(exit $b2b_rc)',
  ].join('\n');
}
