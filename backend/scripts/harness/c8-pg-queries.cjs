'use strict';
const { QUERY_CONTRACT } = require('./c8-gate.cjs');
const { valid } = require('./c8-names.cjs');
/** Closed literal vocabulary. SQL syntax is inspected outside SQL strings;
 * strings themselves must be EXACT members (SQL doubled quotes are decoded).
 * Privilege names are data, not executable DDL/DML. */
const LITERALS = Object.freeze(['schema', 'table', 'column', 'sequence', 'routine',
  'USAGE', 'CREATE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
  'EXECUTE', 'EXECUTE WITH GRANT OPTION', ' WITH GRANT OPTION', 'MEMBER', 'SET',
  'r', 'p', 'v', 'm', 'f', 'S', 'CONNECT', 'TEMPORARY', 'agenda_test', 'agenda_test_owner', 'agenda_test_app',
  'transaction_read_only', 'server_version_num', 'max_connections', 'statement_timeout', 'lock_timeout',
  'idle_in_transaction_session_timeout', 'idle_session_timeout', 'search_path', 'pg_catalog',
  'information_schema', 'client backend', 'pg_%', 'public', 'pg_namespace', 'pg_catalog.pg_class', 'advisory']);
const SYSTEM = Object.freeze({ begin: 'BEGIN READ ONLY', rollback: 'ROLLBACK', savepoint: 'SAVEPOINT c8_probe',
  rollbackProbe: 'ROLLBACK TO SAVEPOINT c8_probe', releaseProbe: 'RELEASE SAVEPOINT c8_probe' });
/** @typedef {{id:string,level:'A'|'B',sql:string,paramTypes:readonly string[],roles:readonly string[]}} Query */
/** @param {string} id @param {string} sql @param {string[]} [paramTypes] @param {'A'|'B'} [level] @returns {Query} */
function entry(id, sql, paramTypes = [], level = 'A') {
  return Object.freeze({ id, level, sql, paramTypes: Object.freeze(paramTypes), roles: Object.freeze(['owner', 'app']) });
}
const CATALOG = Object.freeze([
  entry('identity', `SELECT pg_catalog.current_database() AS database, current_user AS current_user, session_user AS session_user, pg_catalog.current_setting('transaction_read_only') AS read_only, pg_catalog.pg_is_in_recovery() AS recovery, pg_catalog.pg_backend_pid() AS pid`),
  entry('server', `SELECT pg_catalog.current_setting('server_version_num') AS version, pg_catalog.current_setting('max_connections') AS max_connections, pg_catalog.current_setting('statement_timeout') AS statement_timeout, pg_catalog.current_setting('lock_timeout') AS lock_timeout, pg_catalog.current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout, pg_catalog.current_setting('idle_session_timeout') AS idle_session_timeout, pg_catalog.current_setting('search_path') AS search_path`),
  entry('role_attrs', `SELECT oid, rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin, rolconnlimit, rolconfig FROM pg_catalog.pg_roles WHERE rolname IN ('agenda_test_owner', 'agenda_test_app')`),
  entry('role_membership', QUERY_CONTRACT.roles, ['app']),
  entry('auth_members', `SELECT roleid, member, inherit_option, set_option, admin_option FROM pg_catalog.pg_auth_members`),
  entry('database', `SELECT oid, datname, datdba, pg_catalog.has_database_privilege($1::name, oid, 'CONNECT') AS can_connect, pg_catalog.has_database_privilege($1::name, oid, 'CREATE') AS can_create, pg_catalog.has_database_privilege($1::name, oid, 'TEMPORARY') AS can_temporary FROM pg_catalog.pg_database WHERE datname = 'agenda_test'`, ['app']),
  entry('schemas', `SELECT nspname AS name, pg_catalog.pg_get_userbyid(nspowner) AS owner, pg_catalog.obj_description(oid, 'pg_namespace') AS comment, nspacl FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'`),
  entry('public_schema', `SELECT oid, nspname, nspowner, nspacl FROM pg_catalog.pg_namespace WHERE nspname = 'public'`),
  entry('effective', QUERY_CONTRACT.materialized, ['schema', 'app']),
  entry('effective_coverage', `SELECT n.oid AS schema_oid, (SELECT count(*)::text FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f')) AS tables, (SELECT count(*)::text FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid AND c.relkind = 'S') AS sequences, (SELECT count(*)::text FROM pg_catalog.pg_proc p WHERE p.pronamespace = n.oid) AS routines FROM pg_catalog.pg_namespace n WHERE n.nspname = $1`, ['schema']),
  entry('schema_empty_hint', `SELECT (SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid)::text AS relations, (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = n.oid)::text AS routines, (SELECT count(*) FROM pg_catalog.pg_type t WHERE t.typnamespace = n.oid)::text AS types, (SELECT count(*) FROM pg_catalog.pg_operator o WHERE o.oprnamespace = n.oid)::text AS operators, (SELECT count(*) FROM pg_catalog.pg_collation c WHERE c.collnamespace = n.oid)::text AS collations, (SELECT count(*) FROM pg_catalog.pg_conversion c WHERE c.connamespace = n.oid)::text AS conversions, (SELECT count(*) FROM pg_catalog.pg_opclass c WHERE c.opcnamespace = n.oid)::text AS opclasses, (SELECT count(*) FROM pg_catalog.pg_opfamily f WHERE f.opfnamespace = n.oid)::text AS opfamilies, (SELECT count(*) FROM pg_catalog.pg_ts_config c WHERE c.cfgnamespace = n.oid)::text AS text_configs, (SELECT count(*) FROM pg_catalog.pg_ts_dict d WHERE d.dictnamespace = n.oid)::text AS text_dicts, (SELECT count(*) FROM pg_catalog.pg_ts_parser p WHERE p.prsnamespace = n.oid)::text AS text_parsers, (SELECT count(*) FROM pg_catalog.pg_ts_template t WHERE t.tmplnamespace = n.oid)::text AS text_templates, (SELECT count(*) FROM pg_catalog.pg_default_acl d WHERE d.defaclnamespace = n.oid)::text AS defaults FROM pg_catalog.pg_namespace n WHERE n.nspname = $1`, ['schema']),
  entry('default_acl_schema', QUERY_CONTRACT.defaultsQuery, ['schema']),
  entry('default_acl_global', QUERY_CONTRACT.globalDefaultsQuery),
  entry('acl_diagnostic', `SELECT a.* FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a WHERE n.nspname = $1`, ['schema']),
  entry('probe_42809', `SELECT pg_catalog.has_sequence_privilege($1::name, 'pg_catalog.pg_class'::regclass, 'USAGE')`, ['app']),
  entry('sessions', `SELECT pid, usename, application_name, datname, backend_type FROM pg_catalog.pg_stat_activity WHERE datname = 'agenda_test' AND backend_type = 'client backend' AND (usename IN ('agenda_test_owner', 'agenda_test_app') OR usename IS NULL)`),
  entry('numbackends', `SELECT numbackends FROM pg_catalog.pg_stat_database WHERE datname = 'agenda_test'`),
  entry('relation_locks', `SELECT l.pid, l.database, l.relation, l.granted, n.nspname AS name FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_class c ON c.oid = l.relation JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE l.locktype <> 'advisory' AND l.database = $1::oid AND n.nspname = ANY($2::text[])`, ['oid', 'schemas']),
  entry('key_roundtrip', `SELECT $1::bigint::text AS key, (($1::bigint >> 32) & 4294967295)::text AS classid, ($1::bigint & 4294967295)::text AS objid, (((($1::bigint >> 32) & 4294967295) << 32) | ($1::bigint & 4294967295))::text AS reconstructed`, ['key']),
  entry('timeout_probe', `SELECT pg_catalog.pg_sleep($1::double precision)`, ['sleep']),
  entry('advisory_try_lock', `SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS acquired`, ['key'], 'B'),
  entry('advisory_unlock', `SELECT pg_catalog.pg_advisory_unlock($1::bigint) AS unlocked`, ['key'], 'B'),
  entry('advisory_holders', `SELECT l.locktype, l.pid, l.database, l.objsubid, l.granted, a.usename, ((l.classid::bigint << 32) | l.objid::bigint)::text AS key FROM pg_catalog.pg_locks l LEFT JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND ((l.classid::bigint << 32) | l.objid::bigint) = $1::bigint`, ['key'], 'B'),
]);
/** @param {string} sql */
function validateSql(sql) {
  if (typeof sql !== 'string' || /;|--|\/\*|\*\//.test(sql)) throw new Error('query_invalid');
  const stripped = sql.replace(/'(?:[^']|'')*'/g, literal => {
    if (!LITERALS.includes(literal.slice(1, -1).replace(/''/g, "'"))) throw new Error('query_invalid');
    return ' ';
  });
  if (stripped.includes("'") || !/^(SELECT|WITH)\b/.test(stripped) ||
    /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|COPY|pg_terminate_backend|pg_cancel_backend|set_config|pg_advisory_lock|pg_advisory_xact\w*|nextval|setval|lo_\w*|pg_read_file|dblink\w*)\b/i.test(stripped)) throw new Error('query_invalid');
  if (/\bpg_sleep\b/i.test(stripped) && sql !== CATALOG.find(q => q.id === 'timeout_probe')?.sql) throw new Error('query_invalid');
  return true;
}
/** @param {string} id */
function lookup(id) { const q = CATALOG.find(q => q.id === id); if (!q) throw new Error('query_unknown'); return q; }
/** @param {string} id @param {{levelB?:boolean}} [options] */
function getQuery(id, options = {}) {
  const q = lookup(id); if (q.level === 'B' && options.levelB !== true) throw new Error('query_disabled'); return q;
}
/** @param {unknown} value @param {string} type */
function parameter(value, type) {
  if (type === 'app') return value === 'agenda_test_app';
  if (type === 'schema') return valid(value);
  if (type === 'schemas') return Array.isArray(value) && value.length <= 10 && value.every(valid) && new Set(value).size === value.length;
  if (type === 'oid') return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 4294967295;
  if (type === 'sleep') return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 3;
  if (type === 'key') return typeof value === 'string' && /^-?(0|[1-9][0-9]*)$(?![\s\S])/.test(value) &&
    BigInt(value).toString() === value && BigInt(value) >= -(1n << 63n) && BigInt(value) < (1n << 63n);
  return false;
}
/** Exact equality, no whitespace/case normalization. @param {string} sql @param {unknown[]} [params] @param {{levelB?:boolean}} [options] */
function assertAllowed(sql, params = [], options = {}) {
  const found = CATALOG.find(q => q.sql === sql);
  if (!found) throw new Error('query_unknown');
  const q = getQuery(found.id, options); validateSql(sql);
  if (!Array.isArray(params) || params.length !== q.paramTypes.length || !q.paramTypes.every((type, i) => parameter(params[i], type))) throw new Error('query_params');
  return q;
}
module.exports = Object.freeze({ CATALOG, SYSTEM, LITERALS, lookup, getQuery, assertAllowed, validateSql });
