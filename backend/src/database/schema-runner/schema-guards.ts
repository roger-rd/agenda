import { createHash } from 'node:crypto';
import { TABLE_ORDER } from '../migrations/initial-schema.statements';
import { SCHEMA_MANIFEST, verifyManifest, type ManifestEntry } from '../migrations/schema-manifest';
import {
  BUDGET, COMMANDS, MIGRATIONS_SEQUENCE, MIGRATIONS_TABLE, SchemaRunnerError, TARGET, APPLICATION_NAME, asServerSeconds,
  type SchemaCommand, type SchemaErrorCode,
} from './schema-target';

/**
 * Pure decisions. Nothing here touches a connection, a file or the environment: evaluators receive rows already read
 * and answer with the code of the first failed check, or null when all pass. They never trust a missing or mistyped
 * value: anything that is not exactly what was expected is a failure, and "not verified" is a failure too.
 */
export type Row = Readonly<Record<string, unknown>>;
export type Verdict = SchemaErrorCode | null;

const isRow = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const rowsOf = (value: unknown): Row[] | null => (Array.isArray(value) && value.every(isRow) ? (value as Row[]) : null);

/* ----------------------------- arguments and confirmation ----------------------------- */

export interface ParsedArguments { readonly command: SchemaCommand; readonly confirm: string; readonly showDefinitions: boolean; readonly showDrift: boolean }

/** Opciones exactas; --show-definitions y --show-drift son opcionales, sin valor y exclusivas de plan. */
export function parseArguments(argv: readonly string[]): ParsedArguments {
  if (!Array.isArray(argv) || argv.some(a => typeof a !== 'string')) throw new SchemaRunnerError('args_invalid');
  const [command, ...flags] = argv;
  if (!(COMMANDS as readonly string[]).includes(command)) throw new SchemaRunnerError('args_invalid');
  const found: Record<'env' | 'target' | 'confirm', string[]> = { env: [], target: [], confirm: [] };
  let showDefinitions = false;
  let showDrift = false;
  for (const flag of flags) {
    if (flag === '--show-drift') {
      if (command !== 'plan' || showDrift) throw new SchemaRunnerError('args_invalid');
      showDrift = true; continue;
    }
    if (flag === '--show-definitions') {
      if (command !== 'plan' || showDefinitions) throw new SchemaRunnerError('args_invalid');
      showDefinitions = true; continue;
    }
    const match = /^--(env|target|confirm)=([\s\S]*)$/.exec(flag);
    if (!match) throw new SchemaRunnerError('args_invalid');
    found[match[1] as 'env' | 'target' | 'confirm'].push(match[2]);
  }
  if (found.env.length !== 1 || found.target.length !== 1 || found.confirm.length !== 1) throw new SchemaRunnerError('args_invalid');
  if (found.env[0] === 'production' || found.env[0] === 'development') throw new SchemaRunnerError('env_forbidden');
  if (found.env[0] !== TARGET.env) throw new SchemaRunnerError('args_invalid');
  if (found.target[0] !== TARGET.database) throw new SchemaRunnerError('target_invalid');
  return Object.freeze({ command: command as SchemaCommand, confirm: found.confirm[0], showDefinitions, showDrift });
}

/** Digest of what the manifest is: names and pinned digests, in order. */
export function manifestDigest(manifest: readonly ManifestEntry[] = SCHEMA_MANIFEST): string {
  return createHash('sha256').update(JSON.stringify(manifest.map(e => [e.name, e.sha256]))).digest('hex');
}

/** The token that authorizes a command. Apply and revert are bound to the exact manifest; plan only to the target. */
export function confirmationFor(command: SchemaCommand, manifest: readonly ManifestEntry[] = SCHEMA_MANIFEST): string {
  if (command === 'plan') return `PLAN:${TARGET.database}`;
  return `${command === 'apply' ? 'APPLY' : 'REVERT'}:${TARGET.database}:${manifestDigest(manifest).slice(0, 8)}`;
}

/** Full authorization: arguments, manifest integrity and the exact token. */
export function authorize(argv: readonly string[], manifest: readonly ManifestEntry[] = SCHEMA_MANIFEST): SchemaCommand {
  const parsed = parseArguments(argv);
  if (verifyManifest(manifest).length > 0) throw new SchemaRunnerError('manifest_invalid');
  if (parsed.confirm !== confirmationFor(parsed.command, manifest)) throw new SchemaRunnerError('confirmation_invalid');
  return parsed.command;
}

/* ----------------------------- identity ----------------------------- */

const SESSION_BOOLEANS = ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls'] as const;

/** Identity row of the session before any DDL. Mode decides read-only expectations. */
export function evaluateIdentity(input: unknown, mode: SchemaCommand): Verdict {
  const rows = rowsOf(input);
  if (rows === null || rows.length !== 1) return 'identity_unreadable';
  const r = rows[0];
  if (r.database !== TARGET.database) return 'identity_database';
  if (r.current_user !== TARGET.owner || r.session_user !== TARGET.owner) return 'identity_user';
  if (typeof r.version_num !== 'number' || r.version_num < TARGET.major * 10000 || r.version_num >= (TARGET.major + 1) * 10000) return 'identity_version';
  if (r.in_recovery !== false) return 'identity_recovery';
  const readOnly = mode === 'plan' ? 'on' : 'off';
  if (r.transaction_read_only !== readOnly || r.default_read_only !== readOnly) return 'identity_read_only';
  if (r.standard_conforming_strings !== 'on') return 'standard_conforming_strings_off';
  if (r.current_schema !== TARGET.schema || r.effective_search_path !== TARGET.schema) return 'identity_search_path';
  if (SESSION_BOOLEANS.some(k => r[k] !== false) || r.rolcanlogin !== true) return 'identity_role_privileged';
  if (r.can_use_public !== true || r.can_create_public !== true) return 'identity_schema_privilege';
  if (r.owns_database !== true) return 'identity_database_owner';
  if (r.event_triggers !== 0) return 'identity_event_triggers';
  if (r.owner_memberships !== 0) return 'identity_role_memberships';
  if (r.app_role_exists !== true) return 'identity_app_role';
  if (r.statement_timeout !== asServerSeconds(BUDGET.statementMs) || r.lock_timeout !== asServerSeconds(BUDGET.lockMs) ||
    r.idle_in_transaction_session_timeout !== asServerSeconds(BUDGET.idleInTransactionMs) || r.application_name !== APPLICATION_NAME) return 'identity_timeouts';
  return null;
}

/* ----------------------------- schema state ----------------------------- */

export type SchemaState = 'fresh' | 'applied' | 'upgradable' | 'partial' | 'foreign';
export type Action = 'proceed' | 'noop' | 'refuse';

export interface StateSnapshot {
  readonly relations: unknown;
  readonly foreignObjects: unknown;
  /** Names recorded in the migrations table, or null when that table does not exist. */
  readonly executed: unknown;
}

const RELATION_CAP = 200;
const countOf = (row: Row | undefined, key: string): number | null => (row && typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && (row[key] as number) >= 0 ? (row[key] as number) : null);

export type ExecutedState = 'none' | { readonly kind: 'prefix'; readonly applied: number } | 'all' | 'diverged' | 'unreadable';

/** PostgreSQL bigint travels as decimal text; no coercion of other values is allowed. */
export function evaluateExecuted(input: unknown, manifest: readonly ManifestEntry[] = SCHEMA_MANIFEST): ExecutedState {
  const rows = rowsOf(input);
  if (rows === null || rows.some(r => typeof r.name !== 'string')) return 'unreadable';
  if (rows.length === 0) return 'none';
  if (rows.length > manifest.length || rows.some((r, i) => r.name !== manifest[i].name ||
    !(r.timestamp === manifest[i].timestamp || r.timestamp === String(manifest[i].timestamp)))) return 'diverged';
  return rows.length === manifest.length ? 'all' : { kind: 'prefix', applied: rows.length };
}

/** Deterministic creation order, with no silently discarded duplicates. */
export function tablesOfPrefix(manifest: readonly ManifestEntry[], k: number): readonly string[] {
  if (!Number.isInteger(k) || k < 0 || k > manifest.length) throw new SchemaRunnerError('manifest_invalid');
  const tables: string[] = [];
  const seen = new Set<string>();
  for (const entry of manifest) {
    if (!Array.isArray(entry.tables)) throw new SchemaRunnerError('manifest_invalid');
    for (const table of entry.tables) {
      if (typeof table !== 'string' || table !== table.trim() || !/^[a-z][a-z0-9_]{0,62}$/.test(table) || seen.has(table)) throw new SchemaRunnerError('manifest_invalid');
      seen.add(table);
    }
  }
  for (const entry of manifest.slice(0, k)) tables.push(...entry.tables);
  return Object.freeze(tables);
}

/**
 * fresh: nothing of ours exists (the migrations table alone may exist, empty).
 * applied/upgradable: exactly the accumulated prefix tables, migration table and sequence, with that prefix recorded.
 * partial: ours, but incomplete or inconsistent. foreign: anything that is not ours, which is never touched.
 */
export function classifyState(snapshot: StateSnapshot, manifest: readonly ManifestEntry[] = SCHEMA_MANIFEST): SchemaState {
  const relations = rowsOf(snapshot.relations);
  const objects = rowsOf(snapshot.foreignObjects);
  if (relations === null || objects === null || objects.length !== 1) throw new SchemaRunnerError('state_unreadable');
  if (relations.length > RELATION_CAP) throw new SchemaRunnerError('state_truncated');
  const routines = countOf(objects[0], 'routines'); const types = countOf(objects[0], 'types'); const extensions = countOf(objects[0], 'extensions');
  if (routines === null || types === null || extensions === null) throw new SchemaRunnerError('state_unreadable');
  if (routines + types + extensions > 0) return 'foreign';

  const tables = new Set<string>(tablesOfPrefix(manifest, manifest.length));
  const ours = new Set<string>([...tables, MIGRATIONS_TABLE]);
  const present = { tables: new Set<string>(), migrations: false, sequence: false };
  for (const rel of relations) {
    const { name, kind, table_name: owner } = rel;
    if (typeof name !== 'string' || typeof kind !== 'string') throw new SchemaRunnerError('state_unreadable');
    if (kind === 'r' && ours.has(name)) { if (name === MIGRATIONS_TABLE) present.migrations = true; else present.tables.add(name); }
    else if (kind === 'S' && name === MIGRATIONS_SEQUENCE) present.sequence = true;
    else if (kind === 'i' && typeof owner === 'string' && ours.has(owner)) continue;
    else return 'foreign';
  }
  const executed = present.migrations ? evaluateExecuted(snapshot.executed, manifest) : (snapshot.executed === null ? 'none' : 'unreadable');
  if (executed === 'diverged') throw new SchemaRunnerError('history_diverged');
  if (executed === 'unreadable') throw new SchemaRunnerError('executed_unreadable');
  if (present.tables.size === 0 && !present.sequence && executed === 'none') return 'fresh';
  if (present.tables.size === 0 && present.migrations && present.sequence && executed === 'none') return 'fresh';
  const k = executed === 'all' ? manifest.length : typeof executed === 'object' ? executed.applied : 0;
  const expected = tablesOfPrefix(manifest, k);
  if (k > 0 && present.tables.size === expected.length && expected.every(t => present.tables.has(t)) && present.migrations && present.sequence) return k === manifest.length ? 'applied' : 'upgradable';
  return 'partial';
}

/** What a command does with a state. Partial and foreign are never touched by apply or revert. */
export function decideAction(command: SchemaCommand, state: SchemaState): { action: Action; code: SchemaErrorCode | null } {
  if (state === 'foreign') return { action: 'refuse', code: 'state_foreign' };
  if (command === 'plan') return { action: 'proceed', code: null };
  if (state === 'partial') return { action: 'refuse', code: 'state_partial' };
  if (command === 'apply') return state === 'fresh' || state === 'upgradable' ? { action: 'proceed', code: null } : { action: 'noop', code: null };
  return state === 'applied' || state === 'upgradable' ? { action: 'proceed', code: null } : { action: 'noop', code: null };
}

/** The recorded migrations table must have exactly the columns TypeORM creates. */
export function evaluateMigrationsTableShape(input: unknown): Verdict {
  const rows = rowsOf(input);
  const expected = [['id', 'integer'], ['timestamp', 'bigint'], ['name', 'character varying']];
  if (rows === null || rows.length !== expected.length) return 'migrations_table_shape';
  return expected.every(([n, t], i) => rows[i].name === n && rows[i].type === t) ? null : 'migrations_table_shape';
}

/* ----------------------------- privileges ----------------------------- */

const MIGRATIONS_PRIVILEGES: readonly (readonly [string, string])[] = [
  ...['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'].map(p => ['table', p] as const),
  ...['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].map(p => ['column', p] as const),
  ...['USAGE', 'SELECT', 'UPDATE'].map(p => ['sequence', p] as const),
];

/**
 * The application role must hold NO effective privilege over the migrations table and its sequence, directly, by
 * inheritance or through PUBLIC, with or without grant option. Complete coverage is required: a missing row, a
 * duplicate, a NULL or an unknown privilege is "not verified".
 */
export function evaluateMigrationsTablePrivileges(input: unknown): Verdict {
  const rows = rowsOf(input);
  if (rows === null || rows.length !== MIGRATIONS_PRIVILEGES.length) return 'migrations_privileges_unverified';
  const seen = new Set<string>();
  for (const r of rows) {
    if (typeof r.kind !== 'string' || typeof r.privilege !== 'string') return 'migrations_privileges_unverified';
    if (typeof r.effective !== 'boolean' || typeof r.grantable !== 'boolean') return 'migrations_privileges_unverified';
    seen.add(`${r.kind}:${r.privilege}`);
  }
  if (seen.size !== rows.length || !MIGRATIONS_PRIVILEGES.every(([k, p]) => seen.has(`${k}:${p}`))) return 'migrations_privileges_unverified';
  return rows.some(r => r.effective === true || r.grantable === true) ? 'migrations_table_exposed' : null;
}

const DML = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

/** After apply: the application role has DML on every business table and nothing else; no grant option anywhere. */
export function evaluateApplicationPrivileges(input: unknown, tables: readonly string[] = TABLE_ORDER): Verdict {
  const rows = rowsOf(input);
  if (rows === null || rows.length !== tables.length * TABLE_PRIVILEGES.length) return 'app_privileges_unverified';
  const seen = new Set<string>();
  for (const r of rows) {
    if (typeof r.name !== 'string' || typeof r.privilege !== 'string' || typeof r.effective !== 'boolean' || typeof r.grantable !== 'boolean') return 'app_privileges_unverified';
    seen.add(`${r.name}:${r.privilege}`);
  }
  if (seen.size !== rows.length || !tables.every(t => TABLE_PRIVILEGES.every(p => seen.has(`${t}:${p}`)))) return 'app_privileges_unverified';
  return rows.every(r => r.effective === DML.has(r.privilege as string) && r.grantable === false) ? null : 'app_privileges_wrong';
}

/* ----------------------------- lock, emptiness, transaction ----------------------------- */

export function evaluateLock(input: unknown): Verdict {
  const rows = rowsOf(input);
  if (rows === null || rows.length !== 1 || typeof rows[0].locked !== 'boolean') return 'lock_unverified';
  return rows[0].locked ? null : 'lock_unavailable';
}
export function evaluateUnlock(input: unknown): Verdict {
  const rows = rowsOf(input);
  return rows !== null && rows.length === 1 && rows[0].unlocked === true ? null : 'unlock_failed';
}

/** Revert is allowed only when every business table is empty (true = empty); anything unreadable counts as not verified. */
export function evaluateEmpty(input: unknown, tables: readonly string[] = TABLE_ORDER): Verdict {
  const rows = rowsOf(input);
  if (rows === null || rows.length !== 1) return 'tables_unverified';
  const keys = Object.keys(rows[0]);
  if (keys.length !== tables.length || !tables.every(t => typeof rows[0][t] === 'boolean')) return 'tables_unverified';
  return tables.every(t => rows[0][t] === true) ? null : 'tables_not_empty';
}

export interface TransactionEvidence {
  /** pg Client.getTransactionStatus(): 'I' idle, 'T' in transaction, 'E' failed transaction; absent when unavailable. */
  readonly clientStatus?: unknown;
  /** TypeORM QueryRunner.isTransactionActive, when available. */
  readonly queryRunnerActive?: unknown;
  /** Rows of TRANSACTION_CLOSED_SQL. */
  readonly server?: unknown;
}

/**
 * Proves the session is outside any transaction (needed before COMMIT is reported or the lock is released). Every
 * signal must agree and none stands alone: the absence of an assigned transaction id says nothing about a transaction
 * that has not written yet. Missing evidence is "unverified", never "closed".
 */
export function evaluateTransactionClosed(evidence: TransactionEvidence): Verdict {
  const { clientStatus, queryRunnerActive, server } = evidence;
  if (clientStatus === 'T' || clientStatus === 'E' || queryRunnerActive === true) return 'transaction_open';
  if (clientStatus !== 'I' || queryRunnerActive !== false) return 'transaction_unverified';
  const rows = rowsOf(server);
  if (rows === null || rows.length !== 1) return 'transaction_unverified';
  const { no_xid: noXid, no_backend_xid: noBackendXid, implicit_transaction: implicit } = rows[0];
  if (typeof noXid !== 'boolean' || typeof noBackendXid !== 'boolean' || typeof implicit !== 'boolean') return 'transaction_unverified';
  return noXid && noBackendXid && implicit ? null : 'transaction_open';
}
