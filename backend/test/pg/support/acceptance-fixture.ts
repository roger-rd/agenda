// Pure module: no database, Nest or TypeORM imports.
import { markers } from './markers';
import { ACCEPTANCE_TIME_ZONES, type AcceptanceTimeZone } from './phase';

export const ACCEPTANCE_INVITEES = 30;
export const ACCEPTANCE_COMPETITORS = 4;

/**
 * Everything the phase can create is reserved up front: the two organizations, the four organization names of the competing
 * registrations and thirty invitee addresses (here invitees DO become users), so cleanup works even if a response is lost.
 */
export function acceptanceMarkers(id: string) {
  const cmA = markers(id, 400, 'accept-cmA'), cmB = markers(id, 401, 'accept-cmB');
  const competitors = Array.from({ length: ACCEPTANCE_COMPETITORS }, (_, n) => markers(id, 410 + n, `accept-reg-${n}`).organizationName);
  const invitees = Array.from({ length: ACCEPTANCE_INVITEES }, (_, n) => markers(id, 500 + n, 'accept-invitee').email);
  return { cmA, cmB, competitors, invitees };
}
export function acceptanceCleanupTargets(id: string) {
  const { cmA, cmB, competitors, invitees } = acceptanceMarkers(id);
  return { emails: [cmA.email, cmB.email, ...invitees], organizationNames: [cmA.organizationName, cmB.organizationName, ...competitors] };
}
export function acceptanceInvitee(id: string, n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= ACCEPTANCE_INVITEES) throw new Error('Invitado fuera de las reservas');
  return acceptanceMarkers(id).invitees[n];
}

/** Observer: reads only. */
export const acceptanceSQL = {
  userByEmail: 'SELECT id, email, name, password_hash FROM public.users WHERE email = $1',
  membershipsOfUser: 'SELECT id, organization_id, role, deactivated_at FROM public.organization_memberships WHERE user_id = $1 ORDER BY id',
  accessesOfMembership: 'SELECT company_id, organization_id, membership_role FROM public.company_accesses WHERE membership_id = $1 ORDER BY company_id',
  accessCountByOrg: 'SELECT count(*)::int AS n FROM public.company_accesses WHERE organization_id = $1',
  sessionsOfUser: 'SELECT id, encode(token_hash, \'hex\') AS token_hash_hex, active_organization_id, created_at, last_seen_at, expires_at, revoked_at FROM public.user_sessions WHERE user_id = $1 ORDER BY created_at, id',
  sessionCount: 'SELECT count(*)::int AS n FROM public.user_sessions',
  invitationById: 'SELECT id, organization_id, email, role, created_at, expires_at, revoked_at, accepted_at, accepted_by_user_id FROM public.invitations WHERE id = $1',
  invitationsByEmail: 'SELECT id, created_at, expires_at, revoked_at, accepted_at, accepted_by_user_id FROM public.invitations WHERE organization_id = $1 AND email = $2 ORDER BY created_at, id',
  organizationByName: 'SELECT id FROM public.organizations WHERE name = $1',
} as const;
/** Locker: locks only, inside a transaction that is always rolled back. */
export const acceptanceLocks = {
  row: 'SELECT id FROM public.invitations WHERE id = $1 AND organization_id = $2 FOR UPDATE',
  users: 'LOCK TABLE public.users IN SHARE MODE',
  accesses: 'LOCK TABLE public.company_accesses IN SHARE MODE',
  sessions: 'LOCK TABLE public.user_sessions IN SHARE MODE',
} as const;

export const DEFAULT_ACCEPTANCE_JEST = 'node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config jest.pg.config.cjs --runInBand test/pg/registration.pg.spec.ts';
export const ACCEPTANCE_ZONE_CELLS: readonly AcceptanceTimeZone[] = ACCEPTANCE_TIME_ZONES;
/**
 * Shell text (zsh or bash): one full phase per zone, stops at the first failure with a non-zero status. Same structure as the invitations
 * command; `status` is read-only in zsh, hence b2b_rc. `jest` and `loadEnv` are injectable to exercise the control flow offline.
 */
export function acceptanceRunCommand(options: { backend: string; jest?: string; loadEnv?: string } = { backend: '.' }): string {
  const jest = options.jest ?? DEFAULT_ACCEPTANCE_JEST;
  const loadEnv = options.loadEnv ?? 'set -a && . ./.env.test && set +a';
  return [
    '(',
    '  set -e',
    `  cd "${options.backend}" || exit 1`,
    `  ${loadEnv}`,
    '  cell() {',
    '    echo "[b2b] acceptance: PostgreSQL=$1"',
    `    env NODE_ENV=test AGENDA_B2B_PHASE=acceptance AGENDA_B2B_TIMEZONE="$1" LOG_LEVEL=info DATABASE_POOL_MAX=10 APP_ALLOWED_ORIGINS=https://app.agenda.test ${jest} \\`,
    '      || { echo "[b2b] acceptance FALLÓ: PostgreSQL=$1" >&2; exit 1; }',
    '  }',
    ...ACCEPTANCE_ZONE_CELLS.map(zone => `  cell ${zone}`),
    '  echo "[b2b] acceptance: todas las ejecuciones terminaron bien"',
    ')',
    'b2b_rc=$?',
    'echo "[b2b] acceptance: código de salida=$b2b_rc"',
    '(exit $b2b_rc)',
  ].join('\n');
}
