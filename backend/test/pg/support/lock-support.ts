/**
 * Lock holding and waiter detection for the acceptance phase. Only type imports, so it is testable offline with fakes. It repeats the
 * pattern proven in the invitations phase (whose file is not touched) and reuses its pure pieces: evaluateWaiters, the locker safety
 * statements and the backend pid query. In addition it checks WHERE each waiter is: the text of the statement it is blocked on.
 */
import { evaluateWaiters, invitationsSQL, LOCK_WAIT, type BlockingRow, type WaitVerdict } from './invitations-fixture';

export interface WaiterRow extends BlockingRow { query: string | null }
export interface RunnerLike {
  readonly isTransactionActive: boolean;
  connect(): Promise<unknown>; startTransaction(): Promise<void>; rollbackTransaction(): Promise<void>; release(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<unknown>;
}
export interface LockerLike { createQueryRunner(): RunnerLike }

/** Pids and their blockers, plus the statement each one is running (own application role, same database). */
export const WAITERS_SQL = "SELECT a.pid, a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid) AS blockers, a.query FROM pg_stat_activity a WHERE a.datname = current_database() AND a.usename = current_user AND a.application_name = 'agenda-backend' AND a.pid = ANY($1::int[])";

/** Every expected pattern must be matched by a different waiter, and no waiter may be left unexplained. */
function assigns(queries: readonly (string | null)[], patterns: readonly RegExp[]): boolean {
  if (queries.length !== patterns.length) return false;
  if (!queries.length) return true;
  return patterns.some((pattern, index) => pattern.test(queries[0] ?? '') && assigns(queries.slice(1), patterns.filter((_, i) => i !== index)));
}

/**
 * `ready` only when exactly patterns.length backends of this run wait, every chain ends at the locker, and each one is blocked on one of
 * the expected statements (one each). A wait on an unexpected statement is `invalid`: the request is not where the scenario needs it.
 */
export function matchWaiters(rows: readonly WaiterRow[], options: { locker: number; own: readonly number[]; patterns: readonly RegExp[] }): WaitVerdict {
  const verdict = evaluateWaiters(rows, { locker: options.locker, own: options.own, expected: options.patterns.length });
  if (verdict.state !== 'ready') return verdict;
  const waiting = rows.filter(row => options.own.includes(row.pid) && row.wait_event_type === 'Lock');
  return assigns(waiting.map(row => row.query), options.patterns)
    ? verdict
    : { state: 'invalid', reason: 'las esperas no están en las sentencias previstas' };
}

/** Regular expression anchored at the start of a statement text, tolerant to pg_stat_activity truncation. */
export function startsLike(sql: string): RegExp {
  return new RegExp(`^${sql.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
}

export interface WaitIo {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  appPids(): Promise<number[]>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
/** Polls until the expected waiters are observed; throws on an invalid observation or when the deadline passes. Messages carry pids only. */
export async function waitForWaiters(io: WaitIo, options: { blocker: number; patterns: readonly RegExp[]; deadlineMs?: number }): Promise<void> {
  const now = io.now ?? (() => Date.now());
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.deadlineMs ?? LOCK_WAIT.briefObserveMs);
  let last = 'sin lectura';
  for (;;) {
    const own = await io.appPids();
    const rows = own.length ? await io.query(WAITERS_SQL, [own]) as WaiterRow[] : [];
    const verdict = matchWaiters(rows, { locker: options.blocker, own, patterns: options.patterns });
    if (verdict.state === 'ready') return;
    if (verdict.state === 'invalid') throw new Error(`[b2b] espera inválida: ${verdict.reason}`);
    last = verdict.reason;
    if (now() >= deadline) throw new Error(`[b2b] las esperas no se observaron a tiempo: ${last}`);
    await sleep(LOCK_WAIT.pollMs);
  }
}

export interface Hold {
  pid: number;
  /** Rolls the locker transaction back (idempotent): the waiting requests proceed. */
  release: () => Promise<void>;
  /** Registers a request so that it is always awaited, even if the body fails. */
  track: <T>(promise: Promise<T>) => Promise<T>;
}
/** Holds locks in the locker's own transaction: bounded lock wait and idleness, always rolled back, never committed. */
export async function holding<T>(locker: LockerLike, statements: readonly { sql: string; values?: unknown[] }[], body: (hold: Hold) => Promise<T>): Promise<T> {
  const runner = locker.createQueryRunner();
  const pending: Promise<unknown>[] = [];
  const release = async () => { if (runner.isTransactionActive) await runner.rollbackTransaction(); };
  try {
    await runner.connect();
    await runner.startTransaction();
    await runner.query(invitationsSQL.lockerLockTimeout);
    await runner.query(invitationsSQL.lockerIdleTimeout);
    const pid = (await runner.query(invitationsSQL.backendPid) as { pid: number }[])[0].pid;
    for (const statement of statements) await runner.query(statement.sql, statement.values);
    return await body({ pid, release, track: promise => { pending.push(promise); return promise; } });
  } finally {
    try { await release(); }
    finally { try { await runner.release(); } finally { await Promise.allSettled(pending); } }
  }
}
