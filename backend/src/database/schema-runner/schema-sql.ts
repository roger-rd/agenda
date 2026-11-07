import { TABLE_ORDER } from '../migrations/initial-schema.statements';
import { MIGRATIONS_SEQUENCE, MIGRATIONS_TABLE, TARGET } from './schema-target';

/**
 * Every statement the runner may send of its own, as constant text. Nothing here is executed by this module and none is
 * built from input: roles and table names travel as parameters, identifiers that are fixed are written literally.
 * Queries are separate from the evaluators in schema-guards.ts, which only look at rows. The pinned digests in the spec
 * make any edit deliberate.
 */

/** Single-row identity of the session, the role and the database. $1 = application role name. */
export const IDENTITY_SQL = `SELECT
  current_database() AS database,
  current_user::text AS current_user,
  session_user::text AS session_user,
  current_setting('server_version_num')::int AS version_num,
  pg_is_in_recovery() AS in_recovery,
  current_setting('transaction_read_only') AS transaction_read_only,
  current_setting('default_transaction_read_only') AS default_read_only,
  current_setting('standard_conforming_strings') AS standard_conforming_strings,
  current_schema()::text AS current_schema,
  array_to_string(current_schemas(false), ',') AS effective_search_path,
  current_setting('statement_timeout') AS statement_timeout,
  current_setting('lock_timeout') AS lock_timeout,
  current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout,
  current_setting('application_name') AS application_name,
  r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls, r.rolcanlogin,
  has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_public,
  has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public,
  (d.datdba = r.oid) AS owns_database,
  (SELECT count(*) FROM pg_event_trigger)::int AS event_triggers,
  (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)::int AS owner_memberships,
  EXISTS (SELECT 1 FROM pg_roles a WHERE a.rolname = $1::name) AS app_role_exists
FROM pg_roles r
JOIN pg_database d ON d.datname = current_database()
WHERE r.rolname = current_user`;

/** Relations living in "public" (tables, indexes, sequences, views...) with the table each index belongs to. */
export const RELATIONS_SQL = `SELECT c.relname::text AS name, c.relkind::text AS kind, t.relname::text AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_index i ON i.indexrelid = c.oid
LEFT JOIN pg_class t ON t.oid = i.indrelid
WHERE n.nspname = 'public'
ORDER BY c.relname
LIMIT 201`;

/** Routines, stand-alone types and extensions in "public": any of them makes the schema foreign. */
export const FOREIGN_OBJECTS_SQL = `SELECT
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')::int AS routines,
  (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype IN ('b', 'd', 'e', 'r', 'm') AND t.typcategory <> 'A')::int AS types,
  (SELECT count(*) FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE n.nspname = 'public')::int AS extensions`;

/** Shape of the migrations table. Only valid when it exists. */
export const MIGRATIONS_COLUMNS_SQL = `SELECT a.attname::text AS name, format_type(a.atttypid, a.atttypmod) AS type
FROM pg_attribute a
WHERE a.attrelid = to_regclass('"public"."schema_migrations"') AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`;

/** Migrations already recorded. Only valid when the migrations table exists. */
export const EXECUTED_SQL = `SELECT name::text AS name FROM "public"."schema_migrations" ORDER BY id LIMIT 201`;

/**
 * Effective privileges of the application role over the migrations table and its sequence, inheritance and PUBLIC
 * included (has_*_privilege resolves both). $1 = application role name. One row per privilege, with and without grant option.
 */
export const MIGRATIONS_PRIVILEGES_SQL = `SELECT 'table' AS kind, p.privilege,
  has_table_privilege($1::name, t.oid, p.privilege) AS effective,
  has_table_privilege($1::name, t.oid, p.privilege || ' WITH GRANT OPTION') AS grantable
FROM (SELECT to_regclass('"public"."schema_migrations"') AS oid) t
CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(privilege)
UNION ALL
SELECT 'column', p.privilege,
  has_any_column_privilege($1::name, t.oid, p.privilege),
  has_any_column_privilege($1::name, t.oid, p.privilege || ' WITH GRANT OPTION')
FROM (SELECT to_regclass('"public"."schema_migrations"') AS oid) t
CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(privilege)
UNION ALL
SELECT 'sequence', p.privilege,
  has_sequence_privilege($1::name, s.oid, p.privilege),
  has_sequence_privilege($1::name, s.oid, p.privilege || ' WITH GRANT OPTION')
FROM (SELECT to_regclass('"public"."schema_migrations_id_seq"') AS oid) s
CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p(privilege)`;

/** Diagnostic only (never decides): who holds an explicit ACL entry on the migrations table. */
export const MIGRATIONS_ACL_SQL = `SELECT COALESCE(g.rolname, 'PUBLIC')::text AS grantee, x.privilege_type::text AS privilege, x.is_grantable
FROM pg_class c
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) x
LEFT JOIN pg_roles g ON g.oid = x.grantee
WHERE c.oid = to_regclass('"public"."schema_migrations"')
ORDER BY 1, 2`;

/** Effective privileges of the application role over the business tables. $1 = role, $2 = table names. */
export const APPLICATION_PRIVILEGES_SQL = `SELECT t.name, p.privilege,
  has_table_privilege($1::name, to_regclass(format('%I.%I', 'public', t.name)), p.privilege) AS effective,
  has_table_privilege($1::name, to_regclass(format('%I.%I', 'public', t.name)), p.privilege || ' WITH GRANT OPTION') AS grantable
FROM unnest($2::text[]) AS t(name)
CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(privilege)
ORDER BY t.name, p.privilege`;

/** One boolean per business table: true when it has no rows. Built once from the frozen table list. */
export const TABLES_EMPTY_SQL = `SELECT ${TABLE_ORDER.map(t => `NOT EXISTS (SELECT 1 FROM "public"."${t}") AS "${t}"`).join(', ')}`;

/**
 * Revert only. Taken right after BEGIN, before the emptiness check, and held until COMMIT or ROLLBACK: it stops every
 * other session (cooperative or not) from writing to, or reading, the eight tables while they are checked and dropped.
 * ACCESS EXCLUSIVE from the start, so the later DROP TABLE never has to upgrade a weaker lock. Same fixed order as the
 * migration; $-free, built only from the frozen table list. lock_timeout (5 s) makes it fail instead of waiting.
 */
export const TABLE_LOCK_SQL = `LOCK TABLE ${TABLE_ORDER.map(t => `"${TARGET.schema}"."${t}"`).join(', ')} IN ACCESS EXCLUSIVE MODE`;

export const LOCK_SQL = 'SELECT pg_try_advisory_lock($1::bigint) AS locked';
export const UNLOCK_SQL = 'SELECT pg_advisory_unlock($1::bigint) AS unlocked';

/**
 * Independent signals that the session is outside any transaction. None is sufficient alone: the client status and the
 * query runner flag are read by the runner; this row adds what the server says about itself.
 */
export const TRANSACTION_CLOSED_SQL = `SELECT (pg_current_xact_id_if_assigned() IS NULL) AS no_xid,
  (a.backend_xid IS NULL) AS no_backend_xid,
  (a.xact_start IS NOT DISTINCT FROM a.query_start) AS implicit_transaction
FROM pg_stat_activity a WHERE a.pid = pg_backend_pid()`;

export const BEGIN_READ_ONLY_SQL = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
export const ROLLBACK_SQL = 'ROLLBACK';

/**
 * The only two writes of the runner besides the DDL of the manifest. They stay apart from every verification: the
 * verification is MIGRATIONS_PRIVILEGES_SQL, never an assumption that these statements removed inherited or PUBLIC grants.
 */
export const REVOKE_MIGRATIONS_TABLE_SQL = `REVOKE ALL ON TABLE "${TARGET.schema}"."${MIGRATIONS_TABLE}" FROM "${TARGET.app}"`;
export const REVOKE_MIGRATIONS_SEQUENCE_SQL = `REVOKE ALL ON SEQUENCE "${TARGET.schema}"."${MIGRATIONS_SEQUENCE}" FROM "${TARGET.app}"`;

export const READ_ONLY_QUERIES = Object.freeze({
  IDENTITY_SQL, RELATIONS_SQL, FOREIGN_OBJECTS_SQL, MIGRATIONS_COLUMNS_SQL, EXECUTED_SQL, MIGRATIONS_PRIVILEGES_SQL,
  MIGRATIONS_ACL_SQL, APPLICATION_PRIVILEGES_SQL, TABLES_EMPTY_SQL, TRANSACTION_CLOSED_SQL,
});
export const LOCK_STATEMENTS = Object.freeze({ LOCK_SQL, UNLOCK_SQL });
export const CONTROL_STATEMENTS = Object.freeze({ BEGIN_READ_ONLY_SQL, ROLLBACK_SQL });
export const TABLE_LOCK_STATEMENTS = Object.freeze({ TABLE_LOCK_SQL });
export const WRITE_STATEMENTS = Object.freeze({ REVOKE_MIGRATIONS_TABLE_SQL, REVOKE_MIGRATIONS_SEQUENCE_SQL });
export const ALL_STATEMENTS: Readonly<Record<string, string>> = Object.freeze({
  ...READ_ONLY_QUERIES, ...LOCK_STATEMENTS, ...CONTROL_STATEMENTS, ...TABLE_LOCK_STATEMENTS, ...WRITE_STATEMENTS,
});
