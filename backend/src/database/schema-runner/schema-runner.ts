import { TABLE_ORDER } from '../migrations/initial-schema.statements';
import { SCHEMA_MANIFEST } from '../migrations/schema-manifest';
import {
  classifyState, decideAction, evaluateApplicationPrivileges, evaluateEmpty, evaluateIdentity, evaluateLock, evaluateMigrationsTablePrivileges,
  evaluateMigrationsTableShape, evaluateTransactionClosed, evaluateUnlock, type SchemaState, type TransactionEvidence,
} from './schema-guards';
import {
  APPLICATION_PRIVILEGES_SQL, EXECUTED_SQL, FOREIGN_OBJECTS_SQL, IDENTITY_SQL, LOCK_SQL, MIGRATIONS_COLUMNS_SQL, MIGRATIONS_PRIVILEGES_SQL,
  RELATIONS_SQL, REVOKE_MIGRATIONS_SEQUENCE_SQL, REVOKE_MIGRATIONS_TABLE_SQL, TABLE_LOCK_SQL, TABLES_EMPTY_SQL, TRANSACTION_CLOSED_SQL, UNLOCK_SQL,
} from './schema-sql';
import { BUDGET, ERROR_CODES, EXIT, LOCK_KEY, MIGRATIONS_TABLE, SchemaRunnerError, TARGET, type SchemaCommand, type SchemaErrorCode } from './schema-target';

/**
 * Orchestration of plan / apply / revert over a narrow port. This module knows nothing about TypeORM, pg, files or the
 * process: the port, the clock, the timers and the abort flag are injected, so every stage, failure and budget can be
 * exercised offline. Errors are reduced to a closed code (plus an optional SQLSTATE); no message, stack or value of the
 * driver ever reaches a result.
 *
 * Sequence of apply/revert: connect, session lock, identity, state, decision, BEGIN, migration, REVOKE, verification,
 * COMMIT, proof that no transaction is open, unlock, close. The lock is held until after COMMIT/ROLLBACK and is released
 * only when the session is proven to be outside a transaction.
 */
export type { SchemaCommand };

/** What the runner needs from a session. The real implementation is typeorm-session.ts. */
export interface SchemaPort {
  connect(): Promise<void>;
  /** Only pinned read-only statements and the advisory lock calls. */
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
  /** Only the pinned REVOKE statements. */
  exec(sql: string): Promise<void>;
  begin(isolation?: 'REPEATABLE READ'): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** Runs the manifest migrations inside the already open transaction; returns the names applied. */
  applyMigrations(): Promise<readonly string[]>;
  /** Reverts the last recorded migration inside the already open transaction. */
  revertLast(): Promise<void>;
  transactionEvidence(): { readonly clientStatus?: unknown; readonly queryRunnerActive?: unknown };
  close(): Promise<void>;
  /** True only when the connection and the data source are provably gone. */
  isClosed(): boolean;
}

export interface Timers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

export type RunnerCode = SchemaErrorCode | 'timeout' | 'aborted_by_signal' | 'connect_failed' | 'query_failed' | 'migration_failed'
  | 'commit_unconfirmed' | 'executor_contract' | 'rollback_failed' | 'internal_error' | 'hard_timeout';
export type Outcome = 'planned' | 'applied' | 'reverted' | 'already_applied' | 'nothing_to_revert' | 'refused' | 'failed' | 'commit_unconfirmed';
export type Closure = 'verified' | 'unverified';

export interface RunResult {
  readonly command: SchemaCommand | null;
  readonly target: typeof TARGET.database;
  readonly outcome: Outcome;
  readonly ok: boolean;
  readonly code: RunnerCode | null;
  readonly sqlstate: string | null;
  readonly state: SchemaState | null;
  readonly stage: string;
  readonly executed: readonly string[];
  readonly pending: readonly string[];
  readonly findings: readonly RunnerCode[];
  readonly committed: boolean;
  readonly transaction: 'none' | 'committed' | 'rolled_back' | 'unverified' | 'commit_unconfirmed';
  readonly lock: 'not_acquired' | 'released' | 'unverified';
  readonly closure: Closure;
  readonly resources: 'closed' | 'unverified';
  readonly elapsedMs: number;
  readonly exit: 0 | 2 | 3;
}

/** The port or the executor broke the contract (second query runner, early commit, statement outside the pinned set...). */
export class SessionContractError extends Error {
  readonly code = 'executor_contract';
  constructor() { super('executor_contract'); this.name = 'SessionContractError'; }
}
class StageTimeout extends Error { constructor() { super('timeout'); } }
class Aborted extends Error { constructor() { super('aborted_by_signal'); } }
class CommitUnconfirmed extends Error { constructor() { super('commit_unconfirmed'); } }

const RUNNER_CODES: readonly string[] = [...ERROR_CODES, 'timeout', 'aborted_by_signal', 'connect_failed', 'query_failed', 'migration_failed',
  'commit_unconfirmed', 'executor_contract', 'rollback_failed', 'internal_error', 'hard_timeout'];

function readCode(error: unknown): string | undefined {
  try {
    if (error === null || typeof error !== 'object') return undefined;
    const direct = Reflect.get(error, 'code');
    const driver = Reflect.get(error, 'driverError');
    const nested = driver !== null && typeof driver === 'object' ? Reflect.get(driver, 'code') : undefined;
    const value = typeof nested === 'string' ? nested : direct;
    return typeof value === 'string' ? value : undefined;
  } catch { return undefined; }
}
/** Only a five-character SQLSTATE can travel; anything else is dropped. */
const sqlstateOf = (error: unknown): string | null => { const c = readCode(error); return c !== undefined && /^[0-9A-Z]{5}$/.test(c) ? c : null; };

function failureOf(error: unknown, stage: string): { code: RunnerCode; sqlstate: string | null } {
  if (error instanceof SchemaRunnerError) return { code: error.code, sqlstate: null };
  if (error instanceof StageTimeout) return { code: 'timeout', sqlstate: null };
  if (error instanceof Aborted) return { code: 'aborted_by_signal', sqlstate: null };
  if (error instanceof CommitUnconfirmed) return { code: 'commit_unconfirmed', sqlstate: null };
  if (error instanceof SessionContractError) return { code: 'executor_contract', sqlstate: null };
  const sqlstate = sqlstateOf(error);
  if (stage === 'connect') return { code: 'connect_failed', sqlstate };
  if (stage === 'migrate' || stage === 'revert') return { code: 'migration_failed', sqlstate };
  return { code: 'query_failed', sqlstate };
}

function bounded<T>(timers: Timers, fn: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const handle = timers.set(() => { if (!settled) { settled = true; reject(new StageTimeout()); } }, ms);
    const finish = (apply: () => void) => { if (!settled) { settled = true; timers.clear(handle); apply(); } };
    let promise: Promise<T>;
    try { promise = fn(); } catch (error) { finish(() => reject(error)); return; }
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

export interface RunInput {
  readonly command: SchemaCommand;
  readonly port: SchemaPort;
  readonly clock: () => number;
  readonly timers: Timers;
  /** True once an interrupt signal arrived. Honored at every stage boundary until COMMIT has been sent. */
  readonly aborted: () => boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const manifestNames = (): string[] => SCHEMA_MANIFEST.map(entry => entry.name);
const sameNames = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((n, i) => n === b[i]);

export async function runSchema(input: RunInput): Promise<RunResult> {
  const { command, port, clock, timers, aborted } = input;
  const started = clock();
  const out = {
    stage: 'start', state: null as SchemaState | null, executed: [] as string[], pending: [] as string[], findings: [] as RunnerCode[],
    committed: false, transaction: 'none' as RunResult['transaction'], lock: 'not_acquired' as RunResult['lock'], code: null as RunnerCode | null,
    sqlstate: null as string | null, outcome: 'failed' as Outcome, closure: 'verified' as Closure, resources: 'closed' as RunResult['resources'],
  };
  let txOpen = false; let commitSent = false; let commitAmbiguous = false; let lockMaybe = false;

  const left = () => BUDGET.executionMs - (clock() - started);
  const step = async <T>(stage: string, fn: () => Promise<T>, cap: number = BUDGET.statementMs): Promise<T> => {
    if (aborted() && !commitSent) throw new Aborted();
    const budget = Math.min(cap, left());
    if (budget <= 0) throw new StageTimeout();
    out.stage = stage;
    return bounded(timers, fn, budget);
  };
  const read = (stage: string, sql: string, params?: readonly unknown[]) => step(stage, () => port.query(sql, params));
  const must = (verdict: SchemaErrorCode | null) => { if (verdict !== null) throw new SchemaRunnerError(verdict); };

  async function inspect() {
    const relations = await read('state', RELATIONS_SQL);
    const foreignObjects = await read('state', FOREIGN_OBJECTS_SQL);
    const hasMigrations = Array.isArray(relations) && relations.some(r => isRecord(r) && r.name === MIGRATIONS_TABLE && r.kind === 'r');
    let executed: unknown = null;
    if (hasMigrations) {
      must(evaluateMigrationsTableShape(await read('state', MIGRATIONS_COLUMNS_SQL)));
      executed = await read('state', EXECUTED_SQL);
    }
    const state = classifyState({ relations, foreignObjects, executed });
    const names = Array.isArray(executed) ? executed.map(r => (isRecord(r) ? String(r.name) : '')) : [];
    out.state = state; out.executed = names;
    out.pending = manifestNames().filter(n => !names.includes(n));
    return { state, hasMigrations };
  }
  const checkMigrationsPrivileges = async () => evaluateMigrationsTablePrivileges(await read('privileges', MIGRATIONS_PRIVILEGES_SQL, [TARGET.app]));
  const checkApplicationPrivileges = async () => evaluateApplicationPrivileges(await read('privileges', APPLICATION_PRIVILEGES_SQL, [TARGET.app, [...TABLE_ORDER]]));

  async function planFlow() {
    await step('begin', () => port.begin('REPEATABLE READ')); txOpen = true;
    must(evaluateIdentity(await read('identity', IDENTITY_SQL, [TARGET.app]), 'plan'));
    const { state, hasMigrations } = await inspect();
    if (hasMigrations) { const v = await checkMigrationsPrivileges(); if (v) out.findings.push(v); }
    if (state === 'applied') { const v = await checkApplicationPrivileges(); if (v) out.findings.push(v); }
    if (state === 'partial' || state === 'foreign') out.code = state === 'partial' ? 'state_partial' : 'state_foreign';
    else if (out.findings.length > 0) out.code = out.findings[0];
    out.outcome = 'planned';
  }

  async function changeFlow() {
    must(evaluateIdentity(await read('identity', IDENTITY_SQL, [TARGET.app]), command));
    const { state } = await inspect();
    const decision = decideAction(command, state);
    if (decision.action === 'refuse') throw new SchemaRunnerError(decision.code as SchemaErrorCode);
    if (decision.action === 'noop') {
      if (command === 'apply') { must(await checkMigrationsPrivileges()); must(await checkApplicationPrivileges()); out.outcome = 'already_applied'; }
      else out.outcome = 'nothing_to_revert';
      return;
    }
    await step('begin', () => port.begin()); txOpen = true;
    if (command === 'revert') {
      // The eight tables are locked first (held until COMMIT/ROLLBACK); only then is the state re-read and the emptiness checked.
      await step('lock_tables', () => port.exec(TABLE_LOCK_SQL));
      const locked = await inspect();
      if (locked.state !== 'applied') throw new SchemaRunnerError('state_partial');
      must(evaluateEmpty(await read('empty', TABLES_EMPTY_SQL)));
      await step('revert', () => port.revertLast(), Math.max(1, left()));
      must(await checkMigrationsPrivileges());
      const after = await inspect();
      if (after.state !== 'fresh') throw new SchemaRunnerError('state_partial');
    } else {
      const applied = await step('migrate', () => port.applyMigrations(), Math.max(1, left()));
      if (!sameNames(applied, manifestNames())) throw new SchemaRunnerError('executed_unexpected');
      await step('revoke', () => port.exec(REVOKE_MIGRATIONS_TABLE_SQL));
      await step('revoke', () => port.exec(REVOKE_MIGRATIONS_SEQUENCE_SQL));
      must(await checkMigrationsPrivileges());
      must(await checkApplicationPrivileges());
      const after = await inspect();
      if (after.state !== 'applied') throw new SchemaRunnerError('state_partial');
    }
    // Last point at which a signal can stop the run: from COMMIT on, the outcome is whatever the server decides.
    if (aborted()) throw new Aborted();
    commitSent = true; out.stage = 'commit';
    try { await bounded(timers, () => port.commit(), Math.max(1, Math.min(BUDGET.statementMs, left()))); }
    catch { commitAmbiguous = true; out.transaction = 'commit_unconfirmed'; throw new CommitUnconfirmed(); }
    txOpen = false; out.transaction = 'committed'; out.committed = true;
    out.outcome = command === 'apply' ? 'applied' : 'reverted';
  }

  try {
    await step('connect', () => port.connect(), BUDGET.connectMs);
    lockMaybe = true;
    const verdict = evaluateLock(await read('lock', LOCK_SQL, [LOCK_KEY]));
    if (verdict === 'lock_unavailable') lockMaybe = false;
    must(verdict);
    out.lock = 'unverified';
    if (command === 'plan') await planFlow(); else await changeFlow();
  } catch (error) {
    const failure = failureOf(error, out.stage);
    out.code = failure.code; out.sqlstate = failure.sqlstate;
    out.outcome = commitAmbiguous ? 'commit_unconfirmed' : 'failed';
  }

  // Closure: rollback what is open, prove the session is outside any transaction, then (and only then) release the lock.
  let usable = !commitAmbiguous;
  if (commitAmbiguous) { out.closure = 'unverified'; }
  if (usable && txOpen) {
    try { await bounded(timers, () => port.rollback(), BUDGET.statementMs); txOpen = false; out.transaction = 'rolled_back'; }
    catch { out.transaction = 'unverified'; out.closure = 'unverified'; usable = false; }
  }
  if (usable && lockMaybe) {
    try {
      const evidence: TransactionEvidence = { ...port.transactionEvidence(), server: await bounded(timers, () => port.query(TRANSACTION_CLOSED_SQL), BUDGET.statementMs) };
      if (evaluateTransactionClosed(evidence) !== null) throw new SchemaRunnerError('transaction_unverified');
      const unlocked = evaluateUnlock(await bounded(timers, () => port.query(UNLOCK_SQL, [LOCK_KEY]), BUDGET.statementMs));
      if (unlocked !== null) throw new SchemaRunnerError('unlock_failed');
      out.lock = 'released';
    } catch { out.lock = 'unverified'; out.closure = 'unverified'; }
  } else if (lockMaybe) { out.lock = 'unverified'; out.closure = 'unverified'; }

  try { await bounded(timers, () => port.close(), BUDGET.closeMs); } catch { /* verified through isClosed() below */ }
  let closed = false; try { closed = port.isClosed() === true; } catch { closed = false; }
  if (!closed) { out.resources = 'unverified'; out.closure = 'unverified'; }

  const elapsedMs = Math.max(0, Math.round(clock() - started));
  const clean = out.code === null && out.closure === 'verified' && out.resources === 'closed';
  const exit = clean ? EXIT.ok : (commitAmbiguous || out.closure === 'unverified' ? EXIT.unconfirmed : EXIT.refused);
  return Object.freeze({
    command, target: TARGET.database, outcome: out.outcome, ok: exit === 0, code: out.code, sqlstate: out.sqlstate, state: out.state, stage: out.stage,
    executed: Object.freeze([...out.executed]), pending: Object.freeze([...out.pending]), findings: Object.freeze([...out.findings]),
    committed: out.committed, transaction: out.transaction, lock: out.lock, closure: out.closure, resources: out.resources, elapsedMs, exit,
  } as RunResult);
}

/** A run refused before any connection: arguments, credentials, options. */
export function refusal(command: SchemaCommand | null, code: RunnerCode, elapsedMs = 0, exit: 2 | 3 = 2): RunResult {
  return Object.freeze({
    command, target: TARGET.database, outcome: 'refused', ok: false, code, sqlstate: null, state: null, stage: 'start', executed: Object.freeze([]),
    pending: Object.freeze([]), findings: Object.freeze([]), committed: false, transaction: 'none', lock: 'not_acquired',
    closure: exit === 3 ? 'unverified' : 'verified', resources: exit === 3 ? 'unverified' : 'closed', elapsedMs, exit,
  } as RunResult);
}

const SAFE_NAME = /^[A-Za-z0-9_]{1,80}$/;
const safe = (value: string | null): string | null => (value !== null && SAFE_NAME.test(value) ? value : null);
const safeCode = (value: string | null): string | null => (value !== null && RUNNER_CODES.includes(value) ? value : null);

/** The single line printed for a result: a closed projection built field by field, never a spread of the result. */
export function summaryOf(result: RunResult): Record<string, unknown> {
  return {
    command: result.command, target: result.target, outcome: result.outcome, ok: result.ok === true, code: safeCode(result.code),
    sqlstate: result.sqlstate !== null && /^[0-9A-Z]{5}$/.test(result.sqlstate) ? result.sqlstate : null, state: result.state, stage: safe(result.stage),
    executed: result.executed.filter(n => SAFE_NAME.test(n)), pending: result.pending.filter(n => SAFE_NAME.test(n)),
    findings: result.findings.filter(c => RUNNER_CODES.includes(c)), committed: result.committed === true, transaction: result.transaction,
    lock: result.lock, closure: result.closure, resources: result.resources, elapsedMs: Number.isFinite(result.elapsedMs) ? result.elapsedMs : 0, exit: result.exit,
  };
}
