import { createHash } from 'node:crypto';

/**
 * Fixed target of the schema runner. There is exactly one: the local test database. No environment variable, option or
 * file can widen it; every other value is refused by the guards before any connection is attempted.
 */
export const TARGET = Object.freeze({
  env: 'test',
  database: 'agenda_test',
  port: 5433,
  owner: 'agenda_test_owner',
  app: 'agenda_test_app',
  schema: 'public',
  major: 16,
} as const);

/** Hosts accepted for the target: loopback only, so no TLS is configured (nothing crosses a network). */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze(['127.0.0.1', '::1', 'localhost']);

export const MIGRATIONS_TABLE = 'schema_migrations';
export const MIGRATIONS_SEQUENCE = 'schema_migrations_id_seq';
export const APPLICATION_NAME = 'agenda-schema-runner';
export const COMMANDS = Object.freeze(['plan', 'apply', 'revert'] as const);
export type SchemaCommand = (typeof COMMANDS)[number];

/** Time budgets in milliseconds. Every one is enforced by the (future) runner; here they are only declared. */
export const BUDGET = Object.freeze({
  connectMs: 5_000, statementMs: 15_000, lockMs: 5_000, idleInTransactionMs: 30_000,
  executionMs: 60_000, closeMs: 10_000, hardExitMs: 90_000,
} as const);

/** Format in which PostgreSQL reports a whole number of seconds (`SHOW` output). */
export const asServerSeconds = (ms: number): string => `${ms / 1000}s`;

export const SUMMARY_PREFIX = 'AGENDA_SCHEMA_RUNNER ';
export const EXIT = Object.freeze({ ok: 0, refused: 2, unconfirmed: 3 } as const);

/**
 * Session advisory lock key. Derived from a fixed seed; the top nibble is the tag 4, which keeps it apart from the
 * C8 tool tags (1 to 3). Stored as a decimal string because it exceeds Number.MAX_SAFE_INTEGER and travels as a
 * `bigint` parameter.
 */
export const LOCK_SEED = 'agenda-cm/schema-runner/v1';
export const LOCK_TAG = 4n;
export function deriveLockKey(seed: string = LOCK_SEED): string {
  const unsigned = createHash('sha256').update(seed).digest().readBigUInt64BE(0);
  const tagged = (unsigned & 0x0fff_ffff_ffff_ffffn) | (LOCK_TAG << 60n);
  return BigInt.asIntN(64, tagged).toString();
}
/** Literal pin: a change of seed, tag or derivation must be deliberate. */
export const LOCK_KEY = '4620462443122130743';

/** Closed set of reasons a run can be refused. The message of a SchemaRunnerError is its code and nothing else. */
export const ERROR_CODES = Object.freeze([
  'args_invalid', 'env_forbidden', 'target_invalid', 'confirmation_invalid', 'manifest_invalid',
  'credential_platform', 'credential_dir_unsafe', 'credential_file_unreadable', 'credential_file_unsafe', 'credential_invalid',
  'target_mismatch', 'options_unsafe',
  'identity_unreadable', 'identity_database', 'identity_user', 'identity_version', 'identity_recovery', 'identity_read_only',
  'standard_conforming_strings_off', 'identity_search_path', 'identity_role_privileged', 'identity_schema_privilege',
  'identity_database_owner', 'identity_event_triggers', 'identity_role_memberships', 'identity_app_role', 'identity_timeouts',
  'state_unreadable', 'state_truncated', 'state_foreign', 'state_partial',
  'lock_unavailable', 'lock_unverified', 'unlock_failed',
  'migrations_table_exposed', 'migrations_privileges_unverified', 'migrations_table_shape',
  'app_privileges_wrong', 'app_privileges_unverified',
  'tables_not_empty', 'tables_unverified', 'executed_unexpected', 'executed_unreadable',
  'transaction_open', 'transaction_unverified',
] as const);
export type SchemaErrorCode = (typeof ERROR_CODES)[number];

export class SchemaRunnerError extends Error {
  constructor(readonly code: SchemaErrorCode) {
    super(code);
    this.name = 'SchemaRunnerError';
  }
}
