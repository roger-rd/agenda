// Pure module: no database, Nest or TypeORM imports, so the whole fixture is testable offline.
import { markers } from './markers';
import type { InvitationTimeZone } from './phase';
import { INVITATION_TIME_ZONES, NODE_TIME_ZONE_EXTRA } from './phase';

export const invitationActors = ['cmA', 'cmB', 'wA', 'mA', 'dA'] as const;
export type InvitationActor = (typeof invitationActors)[number];
export type InvitationsSaved = { users: string[]; memberships: string[]; companies: string[]; invitations: string[] };

/** cmA/cmB register through the API (organizations A and B); wA (worker), mA (active member) and dA (deactivated member) are seeded in A. */
export function invitationsMarkers(id: string) {
  const reserved = invitationActors.map((actor, n) => markers(id, 60 + n, `invitations-${actor}`));
  return { reserved, byActor: Object.fromEntries(invitationActors.map((actor, n) => [actor, reserved[n]])) as Record<InvitationActor, ReturnType<typeof markers>> };
}
export function invitationsCleanupTargets(id: string) {
  const { reserved, byActor } = invitationsMarkers(id);
  return { emails: reserved.map(m => m.email), organizationNames: [byActor.cmA.organizationName, byActor.cmB.organizationName] };
}
/** Invitee addresses are never users: they exist only inside invitations, which are removed through the organizations. */
export function inviteeEmail(id: string, n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 99) throw new Error('Invitado fuera de rango');
  return markers(id, 200 + n, 'invitee').email;
}

/** Exact markers. Run after the exact-id statements as a backup for committed requests whose response was lost. */
export const invitationsCleanupSQL = {
  invitationCompanies: 'DELETE FROM public.invitation_companies WHERE organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($1::text[]))',
  invitations: 'DELETE FROM public.invitations WHERE organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($1::text[]))',
  sessions: 'DELETE FROM public.user_sessions WHERE user_id IN (SELECT id FROM public.users WHERE email = ANY($1::text[]))',
  accesses: 'DELETE FROM public.company_accesses WHERE membership_id IN (SELECT id FROM public.organization_memberships WHERE user_id IN (SELECT id FROM public.users WHERE email = ANY($1::text[])) OR organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($2::text[])))',
  companies: 'DELETE FROM public.companies WHERE organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($1::text[]))',
  memberships: 'DELETE FROM public.organization_memberships WHERE user_id IN (SELECT id FROM public.users WHERE email = ANY($1::text[])) OR organization_id IN (SELECT id FROM public.organizations WHERE name = ANY($2::text[]))',
  users: 'DELETE FROM public.users WHERE email = ANY($1::text[])',
  organizations: 'DELETE FROM public.organizations WHERE name = ANY($1::text[])',
} as const;
/** Exact ids first (every id returned by the application or seeded by the observer). Children before parents. */
export const invitationsCleanupByIdSQL = {
  invitationCompanies: 'DELETE FROM public.invitation_companies WHERE invitation_id = ANY($1::uuid[]) OR organization_id = ANY($2::uuid[])',
  invitations: 'DELETE FROM public.invitations WHERE id = ANY($1::uuid[]) OR organization_id = ANY($2::uuid[])',
  sessions: 'DELETE FROM public.user_sessions WHERE user_id = ANY($1::uuid[])',
  accesses: 'DELETE FROM public.company_accesses WHERE membership_id = ANY($1::uuid[]) OR company_id = ANY($2::uuid[])',
  companies: 'DELETE FROM public.companies WHERE id = ANY($1::uuid[]) OR organization_id = ANY($2::uuid[])',
  memberships: 'DELETE FROM public.organization_memberships WHERE id = ANY($1::uuid[]) OR user_id = ANY($2::uuid[]) OR organization_id = ANY($3::uuid[])',
  users: 'DELETE FROM public.users WHERE id = ANY($1::uuid[])',
  organizations: 'DELETE FROM public.organizations WHERE id = ANY($1::uuid[])',
} as const;

/** Statements of the observer and of the locker (a second connection that only holds locks). None writes accepted_at or accepted_by_user_id. */
export const invitationsSQL = {
  backendPid: 'SELECT pg_backend_pid() AS pid',
  /** One concurrent batch over the application pool: distinct backends, each reporting its own session TimeZone. */
  poolTimeZone: "SELECT pg_backend_pid() AS pid, current_setting('TimeZone') AS tz, pg_sleep(0.2) AS slept",
  sessionTimeZone: "SELECT current_setting('TimeZone') AS tz",
  /** Session-only: the observer reads under a zone different from the application's. */
  observerZone: "SET TimeZone = 'Asia/Tokyo'",
  /** Locker safety net, inside its transaction: bounded lock wait and bounded idleness, so a stuck run cannot hold locks. */
  lockerLockTimeout: "SET LOCAL lock_timeout = '1s'",
  lockerIdleTimeout: "SET LOCAL idle_in_transaction_session_timeout = '10s'",
  lockRow: 'SELECT id FROM public.invitations WHERE id = $1 AND organization_id = $2 FOR UPDATE',
  lockCompanies: 'LOCK TABLE public.invitation_companies IN SHARE MODE',
  /** Backends of the application, with what blocks each one. Filtered afterwards by the pids of THIS run. */
  appBlocking: 'SELECT a.pid, a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid) AS blockers FROM pg_stat_activity a WHERE a.datname = current_database() AND a.usename = current_user AND a.application_name = \'agenda-backend\' AND a.pid = ANY($1::int[])',
  appSessions: 'SELECT pid, backend_start FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND application_name = \'agenda-backend\'',
  invitationsByEmail: 'SELECT id, email, role, created_at, expires_at, revoked_at, accepted_at, created_by_membership_id FROM public.invitations WHERE organization_id = $1 AND email = $2 ORDER BY created_at, id',
  invitationById: 'SELECT id, organization_id, email, created_at, expires_at, revoked_at, accepted_at FROM public.invitations WHERE id = $1',
  invitationCompaniesOf: 'SELECT company_id FROM public.invitation_companies WHERE invitation_id = $1 ORDER BY company_id',
  invitationCompaniesCount: 'SELECT count(*)::int AS n FROM public.invitation_companies WHERE invitation_id = $1',
  tokenHash: 'SELECT encode(token_hash, \'hex\') AS hex, octet_length(token_hash) AS bytes FROM public.invitations WHERE id = $1',
  tokenHashHolders: 'SELECT id FROM public.invitations WHERE token_hash = decode($1, \'hex\') AND revoked_at IS NULL',
  rowText: 'SELECT i::text AS text FROM public.invitations i WHERE id = ANY($1::uuid[])',
  /** Pagination fixture only: exact microsecond values on rows the application created in this run. */
  setCreatedAt: 'UPDATE public.invitations SET created_at = $3::timestamptz WHERE id = $1 AND organization_id = $2',
  createdAtText: 'SELECT id, to_char(created_at AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS created_at_us FROM public.invitations WHERE organization_id = $1 ORDER BY created_at DESC, id DESC',
  /** What a millisecond cursor would skip: rows below the true cursor but not below its millisecond-truncated bound. */
  millisecondLoss: 'SELECT id FROM public.invitations WHERE organization_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid) AND NOT ((created_at, id) < (date_trunc(\'milliseconds\', $2::timestamptz), $3::uuid)) ORDER BY id',
  /** Cross-organization insert attempts; each runs in its own transaction and is rolled back. Exactly one foreign key fails in each. */
  crossCompany: 'INSERT INTO public.invitation_companies (invitation_id, company_id, organization_id) VALUES ($1, $2, $3)',
} as const;

/* ---------------------------------------- lock waiters, by pid ---------------------------------------- */

export interface BlockingRow { pid: number; wait_event_type: string | null; wait_event: string | null; blockers: number[] }
export type WaitVerdict = { state: 'ready' } | { state: 'waiting'; reason: string } | { state: 'invalid'; reason: string };
/**
 * Decides from pg_blocking_pids whether exactly `expected` backends of THIS run are waiting on a lock and every wait chain ends at
 * the locker. Only the pids in `own` count; any blocker that is neither the locker nor another waiter of this run invalidates the
 * observation (a session of another process, or an unexpected holder), and so does an extra waiter.
 */
export function evaluateWaiters(rows: readonly BlockingRow[], options: { locker: number; own: readonly number[]; expected: number }): WaitVerdict {
  const { locker, own, expected } = options;
  const mine = rows.filter(row => own.includes(row.pid));
  const waiting = mine.filter(row => row.wait_event_type === 'Lock');
  const waitingPids = new Set(waiting.map(row => row.pid));
  for (const row of waiting) {
    const foreign = row.blockers.filter(pid => pid !== locker && !waitingPids.has(pid));
    if (foreign.length) return { state: 'invalid', reason: `pid ${row.pid} bloqueado por pids ajenos a esta prueba: ${foreign.join(',')}` };
  }
  if (waiting.length > expected) return { state: 'invalid', reason: `hay ${waiting.length} esperas y se esperaban ${expected}` };
  if (waiting.length < expected) return { state: 'waiting', reason: `${waiting.length} de ${expected} esperas` };
  const reachesLocker = (pid: number, seen: Set<number> = new Set()): boolean => {
    if (seen.has(pid)) return false;
    seen.add(pid);
    const row = waiting.find(candidate => candidate.pid === pid);
    return !!row && row.blockers.some(blocker => blocker === locker || reachesLocker(blocker, seen));
  };
  const orphan = waiting.find(row => !reachesLocker(row.pid));
  return orphan ? { state: 'invalid', reason: `pid ${orphan.pid} espera pero su cadena no termina en el bloqueador` } : { state: 'ready' };
}

/** Bounded waits. Short holds must end well inside the application's lock_timeout (2000 ms); the timeout scenario waits for it. */
export const LOCK_WAIT = Object.freeze({
  pollMs: 25,
  /** Deadline to observe the expected waiters in a brief concurrency hold. */
  briefObserveMs: 1200,
  /** Rollback-by-timeout scenario: expected lock_timeout of the application transaction (DEFAULT_TRANSACTION_TIMEOUTS.lockMs). */
  timeoutExpectedMs: 2000,
  timeoutMinMs: 1500,
  timeoutMaxMs: 7000,
});

/* ------------------------------------- pagination fixture (exact values) ------------------------------------- */

/**
 * Eight invitations of organization B. Six share the millisecond .123 and differ only in microseconds; three of them have exactly the
 * same instant (a tie that only the id breaks). All are far before expires_at (clock + 7 days), so every date CHECK holds.
 */
export const PAGINATION_ROWS = Object.freeze([
  { key: 'r0', at: '2026-03-01T10:00:00.123999Z' },
  { key: 'r1', at: '2026-03-01T10:00:00.123500Z' },
  { key: 'r2', at: '2026-03-01T10:00:00.123001Z' },
  { key: 'r3', at: '2026-03-01T10:00:00.123000Z' },
  { key: 'r4', at: '2026-03-01T10:00:00.122999Z' },
  { key: 'r5', at: '2026-03-01T10:00:00.123500Z' },
  { key: 'r6', at: '2026-03-01T10:00:00.123500Z' },
  { key: 'r7', at: '2026-03-01T09:59:59.999999Z' },
] as const);
export const PAGINATION_TIE_KEYS = ['r1', 'r5', 'r6'] as const;
export const PAGINATION_LIMITS = [1, 2, 3, 5, 8] as const;

const MICRO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})(\d{3})Z$/;
/** Microseconds since the epoch of a six-digit instant, as a BigInt (exact). */
export function microsOf(instant: string): bigint {
  const match = MICRO.exec(instant);
  if (!match) throw new Error('Instante sin seis decimales');
  const ms = Date.parse(`${match[1]}Z`);
  if (Number.isNaN(ms)) throw new Error('Instante inválido');
  return BigInt(ms) * 1000n + BigInt(match[2]);
}
/** The order PostgreSQL must return: created_at descending, then id descending (uuid text compares like bytes). */
export function expectedPaginationOrder(rows: readonly { id: string; at: string }[]): string[] {
  return [...rows].sort((a, b) => {
    const x = microsOf(a.at), y = microsOf(b.at);
    return x !== y ? (x < y ? 1 : -1) : (a.id < b.id ? 1 : -1);
  }).map(row => row.id);
}
/** Indexes after which a page of `limit` rows ends. */
export function pageCuts(total: number, limit: number): number[] {
  const cuts: number[] = [];
  for (let index = limit; index < total; index += limit) cuts.push(index);
  return cuts;
}
/** True when some cut falls strictly inside a run of rows with the same instant (the next page must continue by id). */
export function cutInsideTie(order: readonly { at: string }[], limit: number): boolean {
  return pageCuts(order.length, limit).some(cut => microsOf(order[cut - 1].at) === microsOf(order[cut].at));
}
/** What a millisecond-truncated cursor bound would lose, computed offline for the same data (the connected run checks it in PostgreSQL). */
export function lostByMillisecondBound(rows: readonly { id: string; at: string }[], cursor: { id: string; at: string }): string[] {
  const bound = `${cursor.at.slice(0, 23)}000Z`;
  const before = (row: { id: string; at: string }, at: string, id: string) => { const a = microsOf(row.at), b = microsOf(at); return a < b || (a === b && row.id < id); };
  return rows.filter(row => before(row, cursor.at, cursor.id) && !before(row, bound, cursor.id)).map(row => row.id).sort();
}
export interface DatedRow { expires_at: Date; revoked_at: Date | null; accepted_at: Date | null }
/**
 * CK_invitations_times: expires_at > created_at, revoked_at >= created_at, accepted_at >= created_at and < expires_at. The harness only
 * moves created_at of rows that are open (never accepted), and refuses a value that would break any of them.
 */
export function canSetCreatedAt(row: DatedRow, createdAt: string): boolean {
  if (row.accepted_at !== null) return false;
  const value = microsOf(createdAt);
  const micros = (date: Date) => BigInt(date.getTime()) * 1000n;
  return value < micros(row.expires_at) && (row.revoked_at === null || micros(row.revoked_at) >= value);
}

/* ----------------------------------------------- commands ----------------------------------------------- */

export const INVITATIONS_ZONE_CELLS: readonly { zone: InvitationTimeZone; nodeZone?: string }[] = [
  ...INVITATION_TIME_ZONES.map(zone => ({ zone })),
  { zone: 'Asia/Kolkata', nodeZone: NODE_TIME_ZONE_EXTRA },
];
export const DEFAULT_JEST = 'node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config jest.pg.config.cjs --runInBand test/pg/registration.pg.spec.ts';
/**
 * Shell text (zsh or bash) that runs one full phase per cell and stops with a non-zero status at the first failure: it runs in a
 * subshell, `set -e` plus an explicit `exit 1` in the failure branch, no loop and no `break`. `jest` and `loadEnv` are injectable so the
 * control flow can be exercised offline with stubs; the real command loads the credentials from .env.test.
 */
export function invitationsRunCommand(options: { backend: string; jest?: string; loadEnv?: string } = { backend: '.' }): string {
  const jest = options.jest ?? DEFAULT_JEST;
  const loadEnv = options.loadEnv ?? 'set -a && . ./.env.test && set +a';
  const cells = INVITATIONS_ZONE_CELLS.map(cell => `  cell ${cell.zone}${cell.nodeZone ? ` ${cell.nodeZone}` : ''}`).join('\n');
  return [
    '(',
    '  set -e',
    `  cd "${options.backend}" || exit 1`,
    `  ${loadEnv}`,
    '  cell() {',
    '    echo "[b2b] invitations: PostgreSQL=$1 Node=${2:-por defecto}"',
    `    env NODE_ENV=test AGENDA_B2B_PHASE=invitations AGENDA_B2B_TIMEZONE="$1" LOG_LEVEL=info APP_ALLOWED_ORIGINS=https://app.agenda.test \${2:+TZ=$2} \${2:+AGENDA_B2B_EXPECT_NODE_TZ=$2} ${jest} \\`,
    '      || { echo "[b2b] invitations FALLÓ: PostgreSQL=$1 Node=${2:-por defecto}" >&2; exit 1; }',
    '  }',
    cells,
    '  echo "[b2b] invitations: todas las ejecuciones terminaron bien"',
    ')',
    // `status` is a read-only variable in zsh: use another name.
    'b2b_rc=$?',
    'echo "[b2b] invitations: código de salida=$b2b_rc"',
    '(exit $b2b_rc)',
  ].join('\n');
}
